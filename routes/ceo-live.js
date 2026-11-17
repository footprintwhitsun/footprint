const express = require('express');
const router = express.Router();
const { safeQuery, withWarnings, warnings } = require('../services/safe-query');
router.use(withWarnings);
const { pool } = require('../db/pool');
const { authenticateToken, PAGE_ROLES } = require('../middleware/auth');
const { logActivity } = require('../services/audit');

let ceoSchemaReady = false;
async function ensureCeoLiveSchema() {
    if (ceoSchemaReady || !pool) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS branch_targets (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER DEFAULT 1,
                target_month VARCHAR(7) NOT NULL,
                branch_name VARCHAR(120) NOT NULL,
                target_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(tenant_id, target_month, branch_name)
            );
            CREATE TABLE IF NOT EXISTS cash_drops (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER DEFAULT 1,
                branch_name VARCHAR(120) DEFAULT 'Main Shop',
                amount DECIMAL(12,2) NOT NULL,
                collected_by VARCHAR(120) DEFAULT '',
                notes TEXT DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
            ALTER TABLE branch_targets ADD COLUMN IF NOT EXISTS target_month VARCHAR(7);
            ALTER TABLE branch_targets ADD COLUMN IF NOT EXISTS branch_name VARCHAR(120);
            ALTER TABLE branch_targets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
        `);
        ceoSchemaReady = true;
    } catch (e) { /* silent */ }
}


function isCeo(req) {
    return ['super_admin', 'ceo', 'admin'].includes((req.user?.role || '').toLowerCase());
}

router.get('/api/ceo-live/overview', authenticateToken, async (req, res) => {
    if (!isCeo(req)) return res.status(403).json({ message: 'CEO access required' });
    await ensureCeoLiveSchema();

    const tenantId = req.user.tenant_id || 1;
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const lastWeek = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const monthKey = today.slice(0, 7);

    const [todayRows, yestRows, lwRows, customersOwe, suppliersOwe, targets, cashDrops, closes, voids, lowStock, todayCashTxns, todayDrops] = await Promise.all([
        safeQuery(`SELECT COALESCE(store_location,'Main Shop') AS branch, SUM(total_amount) AS sales, COUNT(*)::int AS count FROM transactions WHERE COALESCE(tenant_id, 1) = $2 AND created_at::date = $1 AND COALESCE(is_return,false)=false GROUP BY store_location`, [today, tenantId]),
        safeQuery(`SELECT COALESCE(SUM(total_amount),0) AS sales FROM transactions WHERE COALESCE(tenant_id, 1) = $2 AND created_at::date = $1 AND COALESCE(is_return,false)=false`, [yesterday, tenantId]),
        safeQuery(`SELECT COALESCE(SUM(total_amount),0) AS sales FROM transactions WHERE COALESCE(tenant_id, 1) = $2 AND created_at::date = $1 AND COALESCE(is_return,false)=false`, [lastWeek, tenantId]),
        safeQuery(`SELECT COALESCE(SUM(current_balance),0) AS owed FROM customers WHERE COALESCE(tenant_id, 1) = $1 AND COALESCE(current_balance,0) > 0`, [tenantId]),
        safeQuery(`SELECT COALESCE(SUM(GREATEST(po.total_amount - COALESCE(sp.paid, 0), 0)), 0) AS owed
                   FROM purchase_orders po
                   LEFT JOIN (SELECT purchase_order_id, SUM(amount) AS paid FROM supplier_payments WHERE COALESCE(tenant_id, 1) = $1 GROUP BY purchase_order_id) sp
                          ON sp.purchase_order_id = po.id
                   WHERE COALESCE(po.tenant_id, 1) = $1 AND LOWER(COALESCE(po.status,'')) IN ('ordered','pending','received')`, [tenantId]),
        safeQuery(`SELECT *, COALESCE(target_month, period_month) AS target_month FROM branch_targets WHERE COALESCE(tenant_id, 1) = $2 AND COALESCE(target_month, period_month) = $1`, [monthKey, tenantId]),
        safeQuery(`SELECT * FROM cash_drops WHERE COALESCE(tenant_id, 1) = $1 ORDER BY created_at DESC LIMIT 20`, [tenantId]),
        safeQuery(`SELECT * FROM daily_closes WHERE COALESCE(tenant_id, 1) = $1 AND ABS(COALESCE(cash_difference,0)) > 0 ORDER BY created_at DESC LIMIT 10`, [tenantId]),
        safeQuery(`SELECT u.name AS teller, COUNT(*)::int AS returns_count FROM transactions t LEFT JOIN users u ON t.user_id = u.id WHERE COALESCE(t.tenant_id, 1) = $1 AND t.is_return = true AND t.created_at > NOW() - INTERVAL '30 days' GROUP BY u.name HAVING COUNT(*) >= 3`, [tenantId]),
        safeQuery(`SELECT name, stock, reorder_level FROM products WHERE COALESCE(tenant_id, 1) = $1 AND COALESCE(stock,0) <= COALESCE(reorder_level,10) ORDER BY stock ASC LIMIT 15`, [tenantId]),
        safeQuery(`SELECT COALESCE(store_location,'Main Shop') AS branch, payment_method, payment_splits, total_amount, change_amount, is_return FROM transactions WHERE COALESCE(tenant_id, 1) = $2 AND created_at::date = $1`, [today, tenantId]),
        safeQuery(`SELECT COALESCE(branch_name,'Main Shop') AS branch, COALESCE(SUM(amount),0) AS dropped FROM cash_drops WHERE COALESCE(tenant_id, 1) = $2 AND created_at::date = $1 GROUP BY branch_name`, [today, tenantId])
    ]);

    const todayTotal = todayRows.reduce((s, r) => s + Number(r.sales || 0), 0);
    const cashThreshold = Number(process.env.CASH_DROP_THRESHOLD || 20000);

    // If supplier_payments is not migrated yet, fall back to gross open PO totals (flagged in response)
    let payablesNetOfPayments = true;
    let payablesRows = suppliersOwe;
    if (!payablesRows.length) {
        payablesNetOfPayments = false;
        payablesRows = await safeQuery(`SELECT COALESCE(SUM(total_amount),0) AS owed FROM purchase_orders WHERE COALESCE(tenant_id, 1) = $1 AND LOWER(COALESCE(status,'')) IN ('ordered','pending','received')`, [tenantId]);
    }

    const drawerByBranch = new Map();
    for (const tx of todayCashTxns) {
        const b = tx.branch || 'Main Shop';
        const splits = Array.isArray(tx.payment_splits) && tx.payment_splits.length
            ? tx.payment_splits
            : [{ method: tx.payment_method || 'cash', amount: Number(tx.total_amount || 0) }];
        let cashAmt = 0;
        for (const sp of splits) {
            const m = String(sp.method || 'cash').toLowerCase();
            if (!m.includes('momo') && !m.includes('card') && !m.includes('bank') && !m.includes('cheque') && !m.includes('credit') && !m.includes('store_credit')) {
                cashAmt += Number(sp.amount || 0);
            }
        }
        if (!tx.is_return) {
            cashAmt = Math.max(0, cashAmt - Math.max(0, Number(tx.change_amount || 0)));
        }
        drawerByBranch.set(b, (drawerByBranch.get(b) || 0) + cashAmt);
    }
    for (const d of todayDrops) {
        const b = d.branch || 'Main Shop';
        drawerByBranch.set(b, (drawerByBranch.get(b) || 0) - Number(d.dropped || 0));
    }
    const maxDrawerCash = Math.max(0, ...Array.from(drawerByBranch.values()));

    res.json({
        warnings: warnings(),
        live: {
            today_total: Number(todayTotal.toFixed(2)),
            yesterday_total: Number((yestRows[0] && yestRows[0].sales) || 0),
            last_week_total: Number((lwRows[0] && lwRows[0].sales) || 0),
            by_branch: todayRows
        },
        receivables: Number((customersOwe[0] && customersOwe[0].owed) || 0),
        payables: Number((payablesRows[0] && payablesRows[0].owed) || 0),
        payables_net_of_payments: payablesNetOfPayments,
        targets,
        cash_drops: cashDrops,
        cash_in_drawer: Number(maxDrawerCash.toFixed(2)),
        cash_drop_alert: maxDrawerCash >= cashThreshold,
        cash_threshold: cashThreshold,
        controls: {
            blind_close_diffs: closes,
            staff_flags: voids,
            low_stock_alerts: lowStock
        }
    });
});

router.post('/api/ceo-live/targets', authenticateToken, async (req, res) => {
    if (!isCeo(req)) return res.status(403).json({ message: 'CEO access required' });
    await ensureCeoLiveSchema();
    const { branch_name = 'Main Shop', target_month = new Date().toISOString().slice(0, 7), target_amount = 0 } = req.body;
    const r = await pool.query(
        `INSERT INTO branch_targets (tenant_id, target_month, branch_name, target_amount)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, target_month, branch_name) DO UPDATE SET target_amount = EXCLUDED.target_amount, updated_at = NOW()
         RETURNING *`,
        [req.user.tenant_id || 1, target_month, branch_name, Number(target_amount)]
    );
    res.json({ success: true, target: r.rows[0] });
});

router.post('/api/ceo-live/cash-drop', authenticateToken, (req, res, next) => {
    const role = (req.user?.role || '').toLowerCase();
    if (!['super_admin', 'ceo', 'admin', 'manager', 'store_manager'].includes(role)) {
        return res.status(403).json({ message: 'Manager or CEO access required' });
    }
    next();
}, async (req, res) => {
    await ensureCeoLiveSchema();
    const { branch_name = 'Main Shop', amount = 0, collected_by = '', notes = '' } = req.body;
    if (Number(amount) <= 0) return res.status(400).json({ message: 'Drop amount must be positive' });
    const r = await pool.query(
        `INSERT INTO cash_drops (tenant_id, branch_name, amount, collected_by, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [req.user.tenant_id || 1, branch_name, Number(amount), collected_by || req.user.name || 'Manager', notes]
    );
    await logActivity(req, 'CASH_DROP_RECORDED', { branch_name, amount });
    res.status(201).json({ success: true, cash_drop: r.rows[0] });
});

// Record a payment to a supplier against a purchase order (reduces payables)
router.post('/api/supplier-payments', authenticateToken, async (req, res) => {
    const role = (req.user?.role || '').toLowerCase();
    if (!['super_admin', 'ceo', 'admin', 'manager', 'store_manager'].includes(role)) {
        return res.status(403).json({ message: 'Manager or CEO access required' });
    }
    const { purchase_order_id, amount, payment_method = 'bank', reference = '', notes = '' } = req.body;
    const amt = Number(amount);
    if (!purchase_order_id || !Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({ message: 'Purchase order and a positive amount are required' });
    }
    const tenantId = req.user.tenant_id || 1;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const poRes = await client.query('SELECT id, supplier_id, total_amount FROM purchase_orders WHERE id = $1 AND COALESCE(tenant_id, 1) = $2 FOR UPDATE', [purchase_order_id, tenantId]);
        if (!poRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Purchase order not found' });
        }
        const po = poRes.rows[0];
        const paidRes = await client.query('SELECT COALESCE(SUM(amount),0) AS paid FROM supplier_payments WHERE purchase_order_id = $1 AND COALESCE(tenant_id, 1) = $2', [po.id, tenantId]);
        const outstanding = Number(po.total_amount || 0) - Number(paidRes.rows[0].paid || 0);
        if (amt > outstanding + 0.01) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: `Payment exceeds outstanding amount (GH₵ ${Math.max(0, outstanding).toFixed(2)})` });
        }
        const ins = await client.query(
            `INSERT INTO supplier_payments (tenant_id, supplier_id, purchase_order_id, amount, payment_method, reference, notes, paid_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [req.user.tenant_id || 1, po.supplier_id, po.id, amt, payment_method, reference, notes, req.user.id || null]
        );
        await client.query('COMMIT');
        await logActivity(req, 'SUPPLIER_PAYMENT_RECORDED', { purchase_order_id: po.id, amount: amt });
        res.status(201).json({ success: true, payment: ins.rows[0], outstanding: Number((outstanding - amt).toFixed(2)) });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('POST /api/supplier-payments error:', err);
        res.status(500).json({ message: 'Failed to record supplier payment (has migration 005 been run?)' });
    } finally {
        client.release();
    }
});

module.exports = router;

