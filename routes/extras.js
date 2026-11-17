const express = require('express');
const router = express.Router();
const { safeQuery, withWarnings, warnings } = require('../services/safe-query');
router.use(withWarnings);
const { pool } = require('../db/pool');
const { authenticateToken, MANAGER_ROLES } = require('../middleware/auth');
const { logActivity } = require('../services/audit');

let extrasReady = false;
async function ensurePhase6Schema() {
    if (extrasReady || !pool) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS layaways (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER DEFAULT 1,
                layaway_number VARCHAR(60) NOT NULL,
                customer_id INTEGER NULL,
                customer_name VARCHAR(200) NOT NULL,
                customer_phone VARCHAR(60) DEFAULT '',
                items JSONB NOT NULL DEFAULT '[]'::jsonb,
                total_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
                amount_paid DECIMAL(12,2) NOT NULL DEFAULT 0.00,
                balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
                due_date DATE NULL,
                status VARCHAR(30) DEFAULT 'open',
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
            ALTER TABLE layaways DROP CONSTRAINT IF EXISTS layaways_layaway_number_key;
            CREATE UNIQUE INDEX IF NOT EXISTS layaways_tenant_number_idx ON layaways (tenant_id, layaway_number);

            CREATE TABLE IF NOT EXISTS layaway_payments (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER DEFAULT 1,
                layaway_id INTEGER NOT NULL,
                amount DECIMAL(12,2) NOT NULL,
                payment_method VARCHAR(40) DEFAULT 'cash',
                store_location VARCHAR(120) DEFAULT 'Main Shop',
                received_by INTEGER NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
            ALTER TABLE layaway_payments ADD COLUMN IF NOT EXISTS tenant_id INTEGER DEFAULT 1;

            CREATE TABLE IF NOT EXISTS staff_attendance (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER DEFAULT 1,
                user_id INTEGER NULL,
                staff_name VARCHAR(120) NOT NULL,
                clock_in TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                clock_out TIMESTAMPTZ NULL,
                hours_worked NUMERIC(6,2) DEFAULT 0,
                is_late BOOLEAN DEFAULT false,
                notes VARCHAR(200) DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS cash_accounts (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER DEFAULT 1,
                name VARCHAR(120) NOT NULL,
                account_type VARCHAR(40) DEFAULT 'cash',
                balance DECIMAL(14,2) DEFAULT 0.00,
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);

        const acctCnt = await pool.query('SELECT COUNT(*)::int AS cnt FROM cash_accounts');
        if (acctCnt.rows[0].cnt === 0) {
            await pool.query(`
                INSERT INTO cash_accounts (name, account_type, balance) VALUES
                ('Main Shop Till Cash', 'cash', 0),
                ('OKWESIWA Business Bank', 'bank', 0),
                ('MTN MoMo Merchant', 'momo', 0)
            `);
        }
        extrasReady = true;
    } catch (e) {
        console.warn('Phase 6 schema notice:', e.message);
    }
}


// 1. Lay-away & Instalments
router.get('/api/layaways', authenticateToken, async (req, res) => {
    await ensurePhase6Schema();
    const tenantId = req.user.tenant_id || 1;
    const rows = await safeQuery('SELECT * FROM layaways WHERE COALESCE(tenant_id, 1) = $1 ORDER BY created_at DESC LIMIT 100', [tenantId]);
    res.json({ layaways: rows, warnings: warnings() });
});

router.post('/api/layaways', authenticateToken, async (req, res) => {
    await ensurePhase6Schema();
    const tenantId = req.user.tenant_id || 1;
    const { customer_name, customer_phone = '', due_date = null, items = [], payment_method = 'cash' } = req.body;
    let totalAmount = Number(req.body.total_amount || 0);
    const deposit = Number(req.body.deposit || 0);
    if (!customer_name) return res.status(400).json({ message: 'Customer name required' });
    if (!Number.isFinite(deposit) || deposit < 0) return res.status(400).json({ message: 'Deposit cannot be negative' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const heldItems = [];
        if (Array.isArray(items) && items.length) {
            // Server-priced items; stock is taken out of sale (held) until collected or cancelled
            totalAmount = 0;
            for (const it of items) {
                const qty = Number(it.qty);
                if (!it.barcode || !Number.isFinite(qty) || qty <= 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: 'Each lay-away item needs a barcode and positive quantity' });
                }
                const p = await client.query('SELECT barcode, name, price, stock FROM products WHERE barcode = $1 AND COALESCE(tenant_id, 1) = $2 FOR UPDATE', [it.barcode, tenantId]);
                if (!p.rows.length) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: `Product ${it.barcode} not found` });
                }
                const prod = p.rows[0];
                if (Number(prod.stock || 0) < qty) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: `Not enough stock to hold ${prod.name} (available: ${Number(prod.stock || 0)})` });
                }
                await client.query('UPDATE products SET stock = stock - $1 WHERE barcode = $2 AND COALESCE(tenant_id, 1) = $3', [qty, prod.barcode, tenantId]);
                const price = Number(prod.price || 0);
                totalAmount += price * qty;
                heldItems.push({ barcode: prod.barcode, name: prod.name, qty, price });
            }
            totalAmount = Number(totalAmount.toFixed(2));
        }
        if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Lay-away total must be greater than zero' });
        }
        if (deposit > totalAmount + 0.01) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Deposit cannot exceed the lay-away total' });
        }

        const num = 'LAY-' + Date.now() + '-' + require('crypto').randomInt(100, 999);
        const bal = Math.max(0, Number((totalAmount - deposit).toFixed(2)));
        const status = bal <= 0 ? 'paid' : 'open';
        const r = await client.query(
            `INSERT INTO layaways (tenant_id, layaway_number, customer_name, customer_phone, items, total_amount, amount_paid, balance, due_date, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [tenantId, num, customer_name.trim(), customer_phone, JSON.stringify(heldItems), totalAmount, deposit, bal, due_date, status]
        );
        if (deposit > 0) {
            await client.query(
                `INSERT INTO layaway_payments (tenant_id, layaway_id, amount, payment_method, store_location, received_by) VALUES ($1,$2,$3,$4,$5,$6)`,
                [tenantId, r.rows[0].id, deposit, String(payment_method).toLowerCase(), req.user.store_location || 'Main Shop', req.user.id || null]
            );
        }
        await client.query('COMMIT');
        await logActivity(req, 'LAYAWAY_CREATED', { layaway_number: num, total_amount: totalAmount, deposit, held_items: heldItems.length });
        res.status(201).json({ success: true, layaway: r.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('POST /api/layaways error:', err);
        res.status(500).json({ message: 'Failed to create lay-away' });
    } finally {
        client.release();
    }
});

// Cancel an open lay-away: held stock goes back on sale. Refund of payments is handled at the till.
router.post('/api/layaways/:id/cancel', authenticateToken, async (req, res) => {
    if (!MANAGER_ROLES.includes((req.user.role || '').toLowerCase())) {
        return res.status(403).json({ message: 'Manager or CEO access required' });
    }
    await ensurePhase6Schema();
    const tenantId = req.user.tenant_id || 1;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const cur = await client.query('SELECT * FROM layaways WHERE id = $1 AND COALESCE(tenant_id, 1) = $2 FOR UPDATE', [req.params.id, tenantId]);
        if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Lay-away not found' }); }
        const row = cur.rows[0];
        if (!['open', 'paid'].includes(row.status)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: `Lay-away is already ${row.status}` });
        }
        const its = Array.isArray(row.items) ? row.items : JSON.parse(row.items || '[]');
        for (const it of its) {
            if (it.barcode && Number(it.qty) > 0) {
                await client.query('UPDATE products SET stock = stock + $1 WHERE barcode = $2 AND COALESCE(tenant_id, 1) = $3', [Number(it.qty), it.barcode, tenantId]);
            }
        }
        const upd = await client.query(`UPDATE layaways SET status = 'cancelled' WHERE id = $1 AND COALESCE(tenant_id, 1) = $2 RETURNING *`, [row.id, tenantId]);
        await client.query('COMMIT');
        await logActivity(req, 'LAYAWAY_CANCELLED', { layaway_id: row.id, amount_paid: row.amount_paid });
        res.json({ success: true, layaway: upd.rows[0], refund_due: Number(row.amount_paid || 0) });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        res.status(500).json({ message: 'Failed to cancel lay-away' });
    } finally {
        client.release();
    }
});

router.post('/api/layaways/:id/payment', authenticateToken, async (req, res) => {
    await ensurePhase6Schema();
    const tenantId = req.user.tenant_id || 1;
    const amount = Number(req.body.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: 'Positive payment required' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const curr = await client.query('SELECT * FROM layaways WHERE id = $1 AND COALESCE(tenant_id, 1) = $2 FOR UPDATE', [req.params.id, tenantId]);
        if (!curr.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Lay-away not found' });
        }
        const row = curr.rows[0];
        const remaining = Number(row.balance || 0);
        if (remaining <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Lay-away is already paid in full' });
        }
        if (amount > remaining + 0.01) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: `Payment (GH₵ ${amount.toFixed(2)}) exceeds remaining balance (GH₵ ${remaining.toFixed(2)})` });
        }
        const nextPaid = Number((Number(row.amount_paid) + amount).toFixed(2));
        const nextBal = Math.max(0, Number((Number(row.total_amount) - nextPaid).toFixed(2)));
        const nextStatus = nextBal <= 0 ? 'paid' : 'open';
        const upd = await client.query(
            'UPDATE layaways SET amount_paid = $1, balance = $2, status = $3 WHERE id = $4 AND COALESCE(tenant_id, 1) = $5 RETURNING *',
            [nextPaid, nextBal, nextStatus, req.params.id, tenantId]
        );
        await client.query(
            `INSERT INTO layaway_payments (tenant_id, layaway_id, amount, payment_method, store_location, received_by) VALUES ($1,$2,$3,$4,$5,$6)`,
            [tenantId, row.id, amount, String(req.body.payment_method || 'cash').toLowerCase(), req.user.store_location || 'Main Shop', req.user.id || null]
        );
        await client.query('COMMIT');
        await logActivity(req, 'LAYAWAY_PAYMENT', { layaway_id: req.params.id, amount, balance: nextBal });
        res.json({ success: true, layaway: upd.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        res.status(500).json({ message: 'Failed to record lay-away payment' });
    } finally {
        client.release();
    }
});

// 2. Staff Attendance
router.get('/api/attendance', authenticateToken, async (req, res) => {
    await ensurePhase6Schema();
    const tenantId = req.user.tenant_id || 1;
    const rows = await safeQuery('SELECT * FROM staff_attendance WHERE COALESCE(tenant_id, 1) = $1 ORDER BY clock_in DESC LIMIT 100', [tenantId]);
    res.json({ attendance: rows, warnings: warnings() });
});

router.post('/api/attendance/clock-in', authenticateToken, async (req, res) => {
    await ensurePhase6Schema();
    const tenantId = req.user.tenant_id || 1;
    const isMgr = MANAGER_ROLES.includes((req.user.role || '').toLowerCase());
    const targetUserId = isMgr && req.body.user_id ? Number(req.body.user_id) : (req.user.id || null);
    const staffName = (isMgr && req.body.staff_name) ? req.body.staff_name : (req.user.name || 'Staff');
    const now = new Date();
    const isLate = now.getHours() > 8 || (now.getHours() === 8 && now.getMinutes() > 15);
    const r = await pool.query(
        'INSERT INTO staff_attendance (tenant_id, user_id, staff_name, is_late) VALUES ($1,$2,$3,$4) RETURNING *',
        [tenantId, targetUserId, staffName, isLate]
    );
    res.status(201).json({ success: true, record: r.rows[0] });
});

router.post('/api/attendance/:id/clock-out', authenticateToken, async (req, res) => {
    await ensurePhase6Schema();
    const tenantId = req.user.tenant_id || 1;
    const isMgr = MANAGER_ROLES.includes((req.user.role || '').toLowerCase());
    const r = await pool.query(
        `UPDATE staff_attendance
         SET clock_out = NOW(),
             hours_worked = ROUND(EXTRACT(EPOCH FROM (NOW() - clock_in)) / 3600.0, 2)
         WHERE id = $1 AND COALESCE(tenant_id, 1) = $4 AND ($2 = true OR user_id = $3) RETURNING *`,
        [req.params.id, isMgr, req.user.id || -1, tenantId]
    );
    if (!r.rows.length) return res.status(404).json({ message: 'Attendance record not found or unauthorized' });
    res.json({ success: true, record: r.rows[0] });
});

// 3. Cash & Bank Accounts (includes live accumulated balances by POS payment type)
router.get('/api/accounts', authenticateToken, async (req, res) => {
    if (!MANAGER_ROLES.includes((req.user.role || '').toLowerCase())) {
        return res.status(403).json({ message: 'Manager or CEO access required' });
    }
    await ensurePhase6Schema();
    const tenantId = req.user.tenant_id || 1;
    const typeFilter = String(req.query.type || '').trim().toLowerCase();
    const fromDate = req.query.from ? `${req.query.from} 00:00:00` : null;
    const toDate = req.query.to ? `${req.query.to} 23:59:59.999` : null;

    const accounts = await safeQuery('SELECT * FROM cash_accounts WHERE COALESCE(tenant_id, 1) = $1 ORDER BY id ASC', [tenantId]);

    const params = [tenantId];
    let dateSql = '';
    if (fromDate && toDate) {
        params.push(fromDate, toDate);
        dateSql = ' AND created_at >= $2 AND created_at <= $3';
    }
    const txSummary = await safeQuery(
        `SELECT LOWER(COALESCE(NULLIF(payment_method, ''), 'cash')) AS method,
                COUNT(*)::int AS txn_count,
                COALESCE(SUM(total_amount), 0) AS total_amount
         FROM transactions
         WHERE COALESCE(tenant_id, 1) = $1 AND COALESCE(is_return, false) = false${dateSql}
         GROUP BY 1 ORDER BY total_amount DESC`,
        params
    );

    const METHOD_MAP = {
        cash: { label: 'Cash Register / Drawer', account_type: 'Cash' },
        momo: { label: 'Mobile Money (MoMo)', account_type: 'Mobile Money' },
        mobile_money: { label: 'Mobile Money (MoMo)', account_type: 'Mobile Money' },
        card: { label: 'Card / POS Terminal', account_type: 'Bank / Card' },
        bank_transfer: { label: 'Bank Transfer', account_type: 'Bank / Card' },
        credit: { label: 'Credit Sales Receivable', account_type: 'Credit' }
    };

    const paymentAccounts = txSummary.map(row => {
        const meta = METHOD_MAP[row.method] || {
            label: `${row.method.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} Sales`,
            account_type: 'Other'
        };
        return {
            id: `pos-${row.method}`,
            name: meta.label,
            account_type: meta.account_type,
            payment_method: row.method,
            txn_count: row.txn_count,
            balance: Number(row.total_amount || 0),
            source: 'POS / Sales'
        };
    });

    const matchesTypeFilter = (acctType) => {
        if (!typeFilter) return true;
        const norm = String(acctType || '').toLowerCase();
        if (typeFilter === 'bank / card' || typeFilter === 'bank') return norm.includes('bank') || norm.includes('card');
        if (typeFilter === 'mobile money' || typeFilter === 'momo') return norm.includes('momo') || norm.includes('mobile');
        return norm === typeFilter;
    };

    const combined = [
        ...paymentAccounts,
        ...accounts.map(a => ({
            ...a,
            balance: Number(a.balance || 0),
            txn_count: null,
            source: 'Configured Account'
        }))
    ].filter(a => matchesTypeFilter(a.account_type));

    res.json({ accounts: combined, paymentSummary: paymentAccounts, warnings: warnings() });
});

router.post('/api/accounts', authenticateToken, async (req, res) => {
    if (!MANAGER_ROLES.includes((req.user.role || '').toLowerCase())) {
        return res.status(403).json({ message: 'Manager or CEO access required' });
    }
    await ensurePhase6Schema();
    const tenantId = req.user.tenant_id || 1;
    const name = String(req.body.name || '').trim();
    const accountType = String(req.body.account_type || 'Cash').trim();
    const balance = Number(req.body.balance || 0);
    if (!name) return res.status(400).json({ message: 'Account name is required' });
    const r = await pool.query(
        'INSERT INTO cash_accounts (tenant_id, name, account_type, balance) VALUES ($1,$2,$3,$4) RETURNING *',
        [tenantId, name, accountType, Number.isFinite(balance) ? balance : 0]
    );
    res.status(201).json({ success: true, account: r.rows[0] });
});

// 4. Plain-English CEO Q&A (Read-only analytics query engine)
router.post('/api/ceo-live/ask', authenticateToken, async (req, res) => {
    if (!MANAGER_ROLES.includes((req.user.role || '').toLowerCase())) {
        return res.status(403).json({ message: 'Manager or CEO access required' });
    }
    const tenantId = req.user.tenant_id || 1;
    const q = String(req.body.question || '').toLowerCase().trim();
    if (!q) return res.status(400).json({ message: 'Please enter a question' });

    try {
        if (/^(hi|hello|hey)\b/.test(q)) {
            return res.json({
                answer: 'Hello! Ask me about top-selling products, low stock, customer credit balances, cash/MoMo totals, expenses, or revenue growth tips.',
                link: '/dashboard',
                table: []
            });
        }

        if (q.includes('recommend') || q.includes('strategy') || q.includes('improve') || (q.includes('increase') && (q.includes('revenue') || q.includes('sales')))) {
            return res.json({
                answer: 'To grow revenue: 1) Run bundle or volume promotions on slow-moving stock, 2) Follow up on overdue credit balances, and 3) Keep top-selling tools stocked above reorder levels across all branches.',
                link: '/promotions',
                table: []
            });
        }

        if (q.includes('owe') || q.includes('owing') || q.includes('credit') || q.includes('debt')) {
            const rows = await safeQuery(
                `SELECT name, phone, COALESCE(customer_type,'Walk-in') AS type, current_balance
                 FROM customers WHERE COALESCE(tenant_id, 1) = $1 AND deleted_at IS NULL AND COALESCE(current_balance,0) > 0 ORDER BY current_balance DESC LIMIT 20`,
                [tenantId]
            );
            return res.json({
                answer: `Found ${rows.length} customer(s) with outstanding balances.`,
                link: '/credit-customers?tab=clients',
                table: rows
            });
        }

        if (q.includes('low') || q.includes('stock') || q.includes('out')) {
            const rows = await safeQuery(
                `SELECT name, COALESCE(brand,'') AS brand, stock, reorder_level
                 FROM products WHERE COALESCE(tenant_id, 1) = $1 AND deleted_at IS NULL AND COALESCE(stock,0) <= COALESCE(reorder_level,10) ORDER BY stock ASC LIMIT 20`,
                [tenantId]
            );
            return res.json({
                answer: `${rows.length} product(s) are at or below their reorder level.`,
                link: '/inventory?tab=stock&lowStock=true&outOfStock=true',
                table: rows
            });
        }

        if (q.includes('expense') || q.includes('spend') || q.includes('cost')) {
            const rows = await safeQuery(
                `SELECT category, description, amount, expense_date
                 FROM expenses WHERE COALESCE(tenant_id, 1) = $1 ORDER BY created_at DESC LIMIT 15`,
                [tenantId]
            );
            return res.json({
                answer: `Recent ${rows.length} expense record(s):`,
                link: '/expenses?tab=list',
                table: rows
            });
        }

        if (q.includes('profit') || q.includes('margin')) {
            return res.json({
                answer: 'Open Profitability Analysis for full gross margin, cost of goods, and net profit.',
                link: '/profitability',
                table: []
            });
        }

        if (q.includes('cash') || q.includes('account') || q.includes('momo') || q.includes('balance')) {
            const rows = await safeQuery(
                `SELECT LOWER(COALESCE(NULLIF(payment_method,''),'cash')) AS payment_type, COUNT(*)::int AS txns, COALESCE(SUM(total_amount),0) AS balance
                 FROM transactions WHERE COALESCE(tenant_id, 1) = $1 AND COALESCE(is_return,false)=false GROUP BY 1 ORDER BY balance DESC`,
                [tenantId]
            );
            return res.json({
                answer: `Accumulated balances across ${rows.length} payment channel(s):`,
                link: '/extras?tab=accounts',
                table: rows
            });
        }

        // Default: top selling products in the last 30 days
        const txns = await safeQuery(
            `SELECT items FROM transactions WHERE COALESCE(tenant_id, 1) = $1 AND created_at > NOW() - INTERVAL '30 days' AND COALESCE(is_return,false)=false`,
            [tenantId]
        );
        const agg = new Map();
        for (const t of txns) {
            const items = Array.isArray(t.items) ? t.items : [];
            for (const it of items) {
                const prev = agg.get(it.name) || { item: it.name, qty: 0, revenue: 0 };
                prev.qty += Number(it.qty || 0);
                prev.revenue += Number(it.price || 0) * Number(it.qty || 0);
                agg.set(it.name, prev);
            }
        }
        const top = Array.from(agg.values()).sort((a, b) => b.revenue - a.revenue).slice(0, 10);
        return res.json({
            answer: `Top ${top.length} selling items over the last 30 days:`,
            link: '/sales-dashboard',
            table: top
        });
    } catch (err) {
        res.status(500).json({ message: 'Could not answer question' });
    }
});

module.exports = router;

