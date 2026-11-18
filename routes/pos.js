const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool } = require('../db/pool');
const { authenticateToken, requirePermission, requireRole, PAGE_ROLES, MANAGER_ROLES } = require('../middleware/auth');
const { logActivity } = require('../services/audit');
const { DEFAULT_BRANCH_NAME } = require('../services/branches');

async function runOptional(client, spName, fn) {
    await client.query(`SAVEPOINT ${spName}`);
    try {
        const res = await fn();
        await client.query(`RELEASE SAVEPOINT ${spName}`);
        return res;
    } catch (err) {
        await client.query(`ROLLBACK TO SAVEPOINT ${spName}`).catch(() => {});
        await client.query(`RELEASE SAVEPOINT ${spName}`).catch(() => {});
        return null;
    }
}

async function issueApprovalToken({ tenantId = 1, approverId, approverName, approverRole, reason, maxDiscount = null }) {
    const token = crypto.randomBytes(24).toString('hex');
    await pool.query(
        `INSERT INTO pos_approval_tokens (tenant_id, token, approver_id, approver_name, approver_role, reason, max_discount, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '10 minutes')`,
        [tenantId, token, approverId, approverName, approverRole, reason, maxDiscount !== null ? Number(maxDiscount) : null]
    );
    return token;
}

async function consumeApprovalToken(db, token, requestedDiscount = null, tenantId = null) {
    if (!token || typeof token !== 'string') return null;
    const res = await db.query(
        `UPDATE pos_approval_tokens
         SET used_at = NOW()
         WHERE token = $1
           AND used_at IS NULL
           AND expires_at > NOW()
           AND ($2::numeric IS NULL OR max_discount IS NULL OR $2::numeric <= max_discount + 0.01)
           AND ($3::int IS NULL OR COALESCE(tenant_id, 1) = $3::int)
         RETURNING *`,
        [token, requestedDiscount !== null ? Number(requestedDiscount) : null, tenantId]
    );
    if (!res.rows.length) return null;
    const row = res.rows[0];
    return {
        approverId: row.approver_id,
        approverName: row.approver_name,
        approverRole: row.approver_role,
        reason: row.reason
    };
}

function computeServerUnitPrice(product, priceGroup, unitName, qty) {
    let basePrice = Number(product.price || 0);
    const pg = product.price_groups || {};
    if (priceGroup === 'contractor' && Number(pg.contractor) > 0) basePrice = Number(pg.contractor);
    else if (priceGroup === 'wholesale' && Number(pg.wholesale) > 0) basePrice = Number(pg.wholesale);
    else if (priceGroup === 'retail' && Number(pg.retail) > 0) basePrice = Number(pg.retail);

    const breaks = Array.isArray(product.quantity_breaks) ? product.quantity_breaks : [];
    let bestBreak = null;
    for (const br of breaks) {
        if (Number(qty) >= Number(br.min_qty || 0) && Number(br.price) > 0) {
            if (!bestBreak || Number(br.min_qty) > Number(bestBreak.min_qty)) bestBreak = br;
        }
    }
    if (bestBreak) basePrice = Number(bestBreak.price);

    let factor = 1;
    let resolvedUnit = product.selling_unit || 'Unit';
    if (unitName && unitName !== resolvedUnit) {
        const units = Array.isArray(product.units) ? product.units : [];
        const match = units.find(u => String(u.name).toLowerCase() === String(unitName).toLowerCase());
        if (match && Number(match.factor) > 0) {
            factor = Number(match.factor);
            resolvedUnit = match.name;
            if (Number(match.price) > 0) {
                return { unitPrice: Number(Number(match.price).toFixed(2)), factor, unitName: resolvedUnit };
            }
        }
    }
    return { unitPrice: Number((basePrice * factor).toFixed(2)), factor, unitName: resolvedUnit };
}

let posSchemaReady = false;
async function ensurePosPhase2Schema() {
    if (posSchemaReady || !pool) return;
    try {
        await pool.query(`
            ALTER TABLE products ADD COLUMN IF NOT EXISTS brand VARCHAR(120) DEFAULT '';
            ALTER TABLE products ADD COLUMN IF NOT EXISTS units JSONB DEFAULT '[]'::jsonb;
            ALTER TABLE products ADD COLUMN IF NOT EXISTS price_groups JSONB DEFAULT '{}'::jsonb;
            ALTER TABLE products ADD COLUMN IF NOT EXISTS quantity_breaks JSONB DEFAULT '[]'::jsonb;

            ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_type VARCHAR(40) DEFAULT 'Walk-in';
            ALTER TABLE customers ADD COLUMN IF NOT EXISTS company_name VARCHAR(200) DEFAULT '';
            ALTER TABLE customers ADD COLUMN IF NOT EXISTS site_location VARCHAR(255) DEFAULT '';
            ALTER TABLE customers ADD COLUMN IF NOT EXISTS price_group VARCHAR(40) DEFAULT 'retail';
            ALTER TABLE customers ADD COLUMN IF NOT EXISTS store_credit DECIMAL(12,2) DEFAULT 0.00;

            ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_splits JSONB DEFAULT '[]'::jsonb;
            ALTER TABLE transactions ADD COLUMN IF NOT EXISTS paid_amount DECIMAL(12,2) DEFAULT 0.00;
            ALTER TABLE transactions ADD COLUMN IF NOT EXISTS balance_due DECIMAL(12,2) DEFAULT 0.00;
            ALTER TABLE transactions ADD COLUMN IF NOT EXISTS change_amount DECIMAL(12,2) DEFAULT 0.00;
            ALTER TABLE transactions ADD COLUMN IF NOT EXISTS discount_amount DECIMAL(12,2) DEFAULT 0.00;
            ALTER TABLE transactions ADD COLUMN IF NOT EXISTS discount_approved_by INTEGER NULL;
            ALTER TABLE transactions ADD COLUMN IF NOT EXISTS price_group VARCHAR(40) DEFAULT 'retail';
            ALTER TABLE transactions ADD COLUMN IF NOT EXISTS delivery_info JSONB DEFAULT NULL;
            ALTER TABLE transactions ADD COLUMN IF NOT EXISTS tenant_id INTEGER DEFAULT 1;
            ALTER TABLE transactions ADD COLUMN IF NOT EXISTS tax_breakdown JSONB DEFAULT '[]'::jsonb;

            CREATE TABLE IF NOT EXISTS pos_holds (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER DEFAULT 1,
                label VARCHAR(160) NOT NULL,
                customer_id INTEGER NULL,
                customer_name VARCHAR(200) DEFAULT 'Walk-in',
                price_group VARCHAR(40) DEFAULT 'retail',
                items JSONB NOT NULL DEFAULT '[]'::jsonb,
                discount_amount DECIMAL(12,2) DEFAULT 0.00,
                notes TEXT DEFAULT '',
                store_location VARCHAR(120) DEFAULT '',
                created_by INTEGER NULL,
                created_by_name VARCHAR(120) DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
            -- Parked POS orders keep their discount rate and promo code here
            ALTER TABLE pos_holds ADD COLUMN IF NOT EXISTS meta JSONB DEFAULT '{}'::jsonb;

            CREATE TABLE IF NOT EXISTS pos_quotations (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER DEFAULT 1,
                quote_number VARCHAR(60) NOT NULL,
                customer_id INTEGER NULL,
                customer_name VARCHAR(200) DEFAULT 'Walk-in',
                customer_phone VARCHAR(60) DEFAULT '',
                price_group VARCHAR(40) DEFAULT 'retail',
                items JSONB NOT NULL DEFAULT '[]'::jsonb,
                subtotal DECIMAL(12,2) DEFAULT 0.00,
                discount_amount DECIMAL(12,2) DEFAULT 0.00,
                total_amount DECIMAL(12,2) DEFAULT 0.00,
                valid_until DATE NOT NULL,
                status VARCHAR(30) DEFAULT 'open',
                converted_transaction_id INTEGER NULL,
                notes TEXT DEFAULT '',
                store_location VARCHAR(120) DEFAULT '',
                created_by INTEGER NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
            ALTER TABLE pos_quotations DROP CONSTRAINT IF EXISTS pos_quotations_quote_number_key;
            CREATE UNIQUE INDEX IF NOT EXISTS pos_quotations_tenant_number_idx ON pos_quotations (tenant_id, quote_number);

            CREATE TABLE IF NOT EXISTS delivery_notes (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER DEFAULT 1,
                delivery_number VARCHAR(60) NOT NULL,
                transaction_id INTEGER NULL,
                receipt_number VARCHAR(100) DEFAULT '',
                customer_id INTEGER NULL,
                customer_name VARCHAR(200) DEFAULT '',
                site_address VARCHAR(255) NOT NULL,
                truck_number VARCHAR(80) DEFAULT '',
                driver_name VARCHAR(120) DEFAULT '',
                delivery_fee DECIMAL(12,2) DEFAULT 0.00,
                status VARCHAR(30) DEFAULT 'Loading',
                store_location VARCHAR(120) DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
            ALTER TABLE delivery_notes ADD COLUMN IF NOT EXISTS store_location VARCHAR(120) DEFAULT '';
            ALTER TABLE delivery_notes DROP CONSTRAINT IF EXISTS delivery_notes_delivery_number_key;
            CREATE UNIQUE INDEX IF NOT EXISTS delivery_notes_tenant_number_idx ON delivery_notes (tenant_id, delivery_number);

            CREATE TABLE IF NOT EXISTS pos_approval_tokens (
                token VARCHAR(80) PRIMARY KEY,
                tenant_id INTEGER DEFAULT 1,
                approver_id INTEGER NULL,
                approver_name VARCHAR(120) DEFAULT '',
                approver_role VARCHAR(40) DEFAULT '',
                reason TEXT DEFAULT '',
                max_discount NUMERIC(12,2) NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                used_at TIMESTAMPTZ NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
            ALTER TABLE pos_approval_tokens ADD COLUMN IF NOT EXISTS tenant_id INTEGER DEFAULT 1;

            CREATE TABLE IF NOT EXISTS pos_pin_attempts (
                attempt_key VARCHAR(120) PRIMARY KEY,
                fail_count INTEGER NOT NULL DEFAULT 0,
                reset_at TIMESTAMPTZ NOT NULL
            );
        `);
        posSchemaReady = true;
    } catch (e) {
        console.warn('Phase 2 POS schema notice:', e.message);
    }
}

// 1. Fast POS product search
router.get('/api/pos/search', authenticateToken, async (req, res) => {
    try {
        await ensurePosPhase2Schema();
        const q = (req.query.q || '').trim();
        const limit = Math.min(parseInt(req.query.limit, 10) || 25, 60);
        const tenantId = req.user.tenant_id || 1;
        const params = [tenantId];
        let where = 'COALESCE(tenant_id, 1) = $1';
        let orderClause = 'name ASC';
        if (q) {
            params.push(`%${q}%`);
            params.push(q);
            where += ` AND (LOWER(name) LIKE LOWER($2) OR LOWER(COALESCE(brand,'')) LIKE LOWER($2) OR LOWER(barcode) LIKE LOWER($2) OR LOWER(COALESCE(category,'')) LIKE LOWER($2))`;
            orderClause = 'CASE WHEN LOWER(barcode) = LOWER($3) THEN 0 ELSE 1 END, name ASC';
        }
        params.push(limit);

        const result = await pool.query(
            `SELECT id, barcode, name, COALESCE(brand, '') AS brand, COALESCE(category, '') AS category,
                    price, cost_price, COALESCE(stock, 0) AS stock,
                    COALESCE(stock_levels, '{}'::jsonb) AS stock_levels,
                    COALESCE(selling_unit, 'Unit') AS selling_unit,
                    COALESCE(packaging_unit, 'Box') AS packaging_unit,
                    COALESCE(conversion_rate, 1) AS conversion_rate,
                    COALESCE(reorder_level, 10) AS reorder_level,
                    COALESCE(units, '[]'::jsonb) AS units,
                    COALESCE(price_groups, '{}'::jsonb) AS price_groups,
                    COALESCE(quantity_breaks, '[]'::jsonb) AS quantity_breaks
             FROM products
             WHERE ${where}
             ORDER BY ${orderClause}
             LIMIT $${params.length}`,
            params
        );
        res.json({ products: result.rows });
    } catch (err) {
        console.error('GET /api/pos/search error:', err);
        res.status(500).json({ message: 'Failed to search products' });
    }
});

// 2. Customer search & quick-add
router.get('/api/pos/customers/search', authenticateToken, requireRole(PAGE_ROLES.STAFF_ALL), async (req, res) => {
    try {
        await ensurePosPhase2Schema();
        const q = (req.query.q || '').trim();
        const params = [req.user.tenant_id || 1];
        let where = `WHERE COALESCE(tenant_id, 1) = $1 AND deleted_at IS NULL`;
        if (q) {
            params.push(`%${q}%`);
            where += ` AND (LOWER(name) LIKE LOWER($2) OR LOWER(COALESCE(phone,'')) LIKE LOWER($2) OR LOWER(COALESCE(company_name,'')) LIKE LOWER($2))`;
        }
        const result = await pool.query(
            `SELECT id, name, phone, email, account_number, credit_limit, current_balance,
                    COALESCE(customer_type, 'Walk-in') AS customer_type,
                    COALESCE(company_name, '') AS company_name,
                    COALESCE(site_location, '') AS site_location,
                    COALESCE(price_group, 'retail') AS price_group,
                    COALESCE(store_credit, 0) AS store_credit
             FROM customers ${where}
             ORDER BY name ASC LIMIT 25`,
            params
        );
        res.json({ customers: result.rows });
    } catch (err) {
        res.status(500).json({ message: 'Failed to search customers' });
    }
});

router.post('/api/pos/customers/quick', authenticateToken, async (req, res) => {
    try {
        const callerRole = (req.user.role || '').toLowerCase();
        if (req.user.type === 'company' || ['business_client', 'company'].includes(callerRole)) {
            return res.status(403).json({ message: 'Company accounts cannot create POS customers' });
        }
        await ensurePosPhase2Schema();
        const tenantId = req.user.tenant_id || 1;
        const { name, phone = '', company_name = '', site_location = '', customer_type = 'Walk-in' } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ message: 'Customer name is required' });
        const priceGroup = customer_type.toLowerCase() === 'contractor' ? 'contractor'
            : (customer_type.toLowerCase() === 'company' ? 'wholesale' : 'retail');
        const acctNo = 'OKW' + crypto.randomInt(100000, 999999);
        const result = await pool.query(
            `INSERT INTO customers (tenant_id, name, phone, company_name, site_location, customer_type, price_group, account_number, status, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Active', $9)
             RETURNING *`,
            [tenantId, name.trim(), phone.trim(), company_name.trim(), site_location.trim(), customer_type, priceGroup, acctNo, req.user.id || null]
        );
        await logActivity(req, 'QUICK_CUSTOMER_ADDED', { customer_id: result.rows[0].id, name: name.trim(), type: customer_type });
        res.status(201).json({ success: true, customer: result.rows[0] });
    } catch (err) {
        res.status(500).json({ message: 'Failed to create customer' });
    }
});

router.get('/api/pos/customers/:id/recent-orders', authenticateToken, requireRole(PAGE_ROLES.STAFF_ALL), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, receipt_number, total_amount, items, created_at
             FROM transactions
             WHERE customer_id = $1 AND COALESCE(is_return, false) = false AND COALESCE(tenant_id, 1) = $2
             ORDER BY created_at DESC LIMIT 10`,
            [req.params.id, req.user.tenant_id || 1]
        );
        res.json({ orders: result.rows });
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch customer orders' });
    }
});

// 3. Manager PIN Approval (DB-backed rate limit, issues single-use server approval_token)
router.post('/api/pos/approve-pin', authenticateToken, async (req, res) => {
    const callerRole = (req.user.role || '').toLowerCase();
    if (req.user.type === 'company' || ['business_client', 'company'].includes(callerRole)) {
        return res.status(403).json({ success: false, message: 'Company accounts cannot request manager PIN approvals' });
    }
    const key = `${req.user.id || req.ip}`;
    try {
        await ensurePosPhase2Schema();
        const attRes = await pool.query('SELECT fail_count, reset_at FROM pos_pin_attempts WHERE attempt_key = $1', [key]);
        const att = attRes.rows[0];
        if (att && new Date(att.reset_at) > new Date() && att.fail_count >= 5) {
            return res.status(429).json({ success: false, message: 'Too many failed PIN attempts. Try again in 15 minutes.' });
        }

        const { pin, manager_id = null, reason = 'Manager override', discount_amount = null } = req.body;
        if (!pin || String(pin).trim().length < 4) {
            return res.status(400).json({ message: 'Enter a valid 4+ digit manager PIN or code' });
        }
        const rawPin = String(pin).trim();

        const tenantId = req.user.tenant_id || 1;
        const params = [tenantId];
        let extraWhere = '';
        if (manager_id) {
            params.push(parseInt(manager_id, 10));
            extraWhere = 'AND id = $2';
        }
        const managers = await pool.query(
            `SELECT id, name, email, role, password
             FROM users
             WHERE COALESCE(tenant_id, 1) = $1
               AND LOWER(role) IN ('ceo', 'admin', 'manager', 'store_manager')
               AND status = 'Active' ${extraWhere}`,
            params
        );

        let approver = null;
        for (const m of managers.rows) {
            if (m.password && (await bcrypt.compare(rawPin, m.password))) {
                approver = m;
                break;
            }
        }

        if (!approver) {
            await pool.query(
                `INSERT INTO pos_pin_attempts (attempt_key, fail_count, reset_at)
                 VALUES ($1, 1, NOW() + INTERVAL '15 minutes')
                 ON CONFLICT (attempt_key) DO UPDATE SET
                    fail_count = CASE WHEN pos_pin_attempts.reset_at <= NOW() THEN 1 ELSE pos_pin_attempts.fail_count + 1 END,
                    reset_at = CASE WHEN pos_pin_attempts.reset_at <= NOW() THEN NOW() + INTERVAL '15 minutes' ELSE pos_pin_attempts.reset_at END`,
                [key]
            );
            return res.status(403).json({ success: false, message: 'Invalid manager PIN' });
        }

        await pool.query('DELETE FROM pos_pin_attempts WHERE attempt_key = $1', [key]);
        const approval_token = await issueApprovalToken({
            tenantId,
            approverId: approver.id,
            approverName: approver.name,
            approverRole: approver.role,
            reason,
            maxDiscount: discount_amount !== null && discount_amount !== undefined ? Number(discount_amount) : null
        });

        await logActivity(req, 'MANAGER_PIN_APPROVED', {
            approver_id: approver.id,
            approver_name: approver.name,
            reason,
            teller_id: req.user.id
        });

        res.json({
            success: true,
            approval_token,
            approver: { id: approver.id, name: approver.name, role: approver.role }
        });
    } catch (err) {
        console.error('POST /api/pos/approve-pin error:', err);
        res.status(500).json({ message: 'PIN verification failed' });
    }
});

// 4. Draft & Hold (F8)
router.get('/api/pos/holds', authenticateToken, async (req, res) => {
    try {
        await ensurePosPhase2Schema();
        const params = [req.user.tenant_id || 1];
        let branchFilter = '';
        if (req.query.store_location) {
            params.push(String(req.query.store_location));
            branchFilter = ' AND store_location = $2';
        }
        const result = await pool.query(
            `SELECT * FROM pos_holds WHERE tenant_id = $1${branchFilter} ORDER BY created_at DESC LIMIT 50`,
            params
        );
        res.json({ holds: result.rows });
    } catch (err) {
        res.status(500).json({ message: 'Failed to load held sales' });
    }
});

router.post('/api/pos/holds', authenticateToken, async (req, res) => {
    try {
        await ensurePosPhase2Schema();
        const { label, customer_id = null, customer_name = 'Walk-in', price_group = 'retail', items = [], discount_amount = 0, notes = '', store_location = '', meta = {} } = req.body;
        if (!Array.isArray(items) || !items.length) return res.status(400).json({ message: 'Cannot hold an empty cart' });
        const holdLabel = (label && label.trim()) ? label.trim() : `${customer_name} (${items.length} items)`;
        const result = await pool.query(
            `INSERT INTO pos_holds (tenant_id, label, customer_id, customer_name, price_group, items, discount_amount, notes, store_location, created_by, created_by_name, meta)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
            [req.user.tenant_id || 1, holdLabel, customer_id, customer_name, price_group, JSON.stringify(items), Math.max(0, Number(discount_amount || 0)), notes, store_location, req.user.id || null, req.user.name || 'Teller', JSON.stringify(meta && typeof meta === 'object' ? meta : {})]
        );
        res.status(201).json({ success: true, hold: result.rows[0] });
    } catch (err) {
        res.status(500).json({ message: 'Failed to hold sale' });
    }
});

router.delete('/api/pos/holds/:id', authenticateToken, async (req, res) => {
    try {
        await pool.query('DELETE FROM pos_holds WHERE id = $1 AND tenant_id = $2', [req.params.id, req.user.tenant_id || 1]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ message: 'Failed to delete hold' });
    }
});

// 5. Quotations (F10), Discounts History & Split Payments History
router.get('/api/pos/quotations', authenticateToken, async (req, res) => {
    try {
        await ensurePosPhase2Schema();
        const result = await pool.query(
            'SELECT * FROM pos_quotations WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100',
            [req.user.tenant_id || 1]
        );
        res.json({ quotations: result.rows });
    } catch (err) {
        res.status(500).json({ message: 'Failed to load quotations' });
    }
});

router.get('/api/pos/discounts-history', authenticateToken, async (req, res) => {
    try {
        await ensurePosPhase2Schema();
        const tenantId = req.user.tenant_id || 1;
        const [trxRes, appRes] = await Promise.all([
            pool.query(
                `SELECT t.id, t.receipt_number, t.customer_name, t.store_location, t.total_amount,
                        COALESCE(t.discount_amount, 0) AS discount_amount,
                        t.payment_method, t.price_group, t.status, t.created_at,
                        COALESCE(u.name, u.email, 'Staff') AS seller_name,
                        COALESCE(ap.name, '') AS approver_name
                 FROM transactions t
                 LEFT JOIN users u ON u.id = t.user_id
                 LEFT JOIN users ap ON ap.id = t.discount_approved_by
                 WHERE COALESCE(t.tenant_id, 1) = $1
                   AND COALESCE(t.discount_amount, 0) > 0
                 ORDER BY t.created_at DESC
                 LIMIT 100`,
                [tenantId]
            ),
            pool.query(
                `SELECT token, approver_id, approver_name, approver_role, reason, max_discount, used_at, expires_at, created_at
                 FROM pos_approval_tokens
                 WHERE COALESCE(tenant_id, 1) = $1
                 ORDER BY created_at DESC
                 LIMIT 50`,
                [tenantId]
            )
        ]);
        res.json({ discounts: trxRes.rows, approvals: appRes.rows });
    } catch (err) {
        console.error('GET /api/pos/discounts-history error:', err);
        res.status(500).json({ message: 'Failed to load discounts history' });
    }
});

router.get('/api/pos/splits-history', authenticateToken, async (req, res) => {
    try {
        await ensurePosPhase2Schema();
        const tenantId = req.user.tenant_id || 1;
        const trxRes = await pool.query(
            `SELECT t.id, t.receipt_number, t.customer_name, t.store_location, t.total_amount,
                    t.paid_amount, t.balance_due, t.change_amount, t.payment_method,
                    COALESCE(t.payment_splits, '[]'::jsonb) AS payment_splits,
                    t.items, t.status, t.created_at,
                    COALESCE(u.name, u.email, 'Staff') AS seller_name
             FROM transactions t
             LEFT JOIN users u ON u.id = t.user_id
             WHERE COALESCE(t.tenant_id, 1) = $1
               AND (LOWER(COALESCE(t.payment_method, '')) = 'split'
                    OR jsonb_array_length(COALESCE(t.payment_splits, '[]'::jsonb)) >= 1)
             ORDER BY t.created_at DESC
             LIMIT 100`,
            [tenantId]
        );
        res.json({ splits: trxRes.rows });
    } catch (err) {
        console.error('GET /api/pos/splits-history error:', err);
        res.status(500).json({ message: 'Failed to load split payments history' });
    }
});

router.post('/api/pos/quotations', authenticateToken, requirePermission('quotations', 'create'), async (req, res) => {
    try {
        await ensurePosPhase2Schema();
        const {
            customer_id = null, customer_name = 'Walk-in', customer_phone = '',
            price_group = 'retail', items = [], discount_amount = 0,
            valid_until, notes = '', store_location = ''
        } = req.body;
        if (!items.length) return res.status(400).json({ message: 'Quotation requires at least one item' });

        const tenantId = req.user.tenant_id || 1;
        // Recalculate quote totals server-side
        let subtotal = 0;
        const verifiedItems = [];
        for (const it of items) {
            if (!it.barcode || Number(it.qty) <= 0) return res.status(400).json({ message: 'Invalid item or quantity' });
            const pRes = await pool.query('SELECT * FROM products WHERE barcode = $1 AND COALESCE(tenant_id, 1) = $2 LIMIT 1', [it.barcode, tenantId]);
            if (!pRes.rows.length) return res.status(400).json({ message: `Product ${it.barcode} not found` });
            const prod = pRes.rows[0];
            const { unitPrice, factor, unitName } = computeServerUnitPrice(prod, price_group, it.unit_name, it.qty);
            subtotal += unitPrice * Number(it.qty);
            verifiedItems.push({ barcode: prod.barcode, name: prod.name, qty: Number(it.qty), unit_name: unitName, unit_factor: factor, price: unitPrice });
        }
        const safeDisc = Math.max(0, Math.min(subtotal, Number(discount_amount || 0)));
        const total = Number((subtotal - safeDisc).toFixed(2));
        const quoteNumber = 'QT-' + Date.now() + '-' + crypto.randomInt(100, 999);
        const expiry = valid_until || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

        const result = await pool.query(
            `INSERT INTO pos_quotations (tenant_id, quote_number, customer_id, customer_name, customer_phone, price_group, items, subtotal, discount_amount, total_amount, valid_until, notes, store_location, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
            [req.user.tenant_id || 1, quoteNumber, customer_id, customer_name, customer_phone, price_group, JSON.stringify(verifiedItems), subtotal, safeDisc, total, expiry, notes, store_location, req.user.id || null]
        );
        await logActivity(req, 'QUOTATION_CREATED', { quote_number: quoteNumber, total_amount: total });
        res.status(201).json({ success: true, quotation: result.rows[0] });
    } catch (err) {
        console.error('POST /api/pos/quotations error:', err);
        res.status(500).json({ message: 'Failed to save quotation' });
    }
});

router.post('/api/pos/quotations/:id/convert', authenticateToken, async (req, res) => {
    try {
        await ensurePosPhase2Schema();
        const tenantId = req.user.tenant_id || 1;
        const txId = req.body?.transaction_id ? Number(req.body.transaction_id) : null;
        const qRes = await pool.query(
            `SELECT * FROM pos_quotations WHERE id = $1 AND COALESCE(tenant_id, 1) = $2`,
            [req.params.id, tenantId]
        );
        if (!qRes.rows.length) return res.status(404).json({ message: 'Quotation not found' });
        const q = qRes.rows[0];
        if (q.status === 'converted') return res.status(409).json({ message: 'Quotation has already been converted' });
        if (q.valid_until && new Date(q.valid_until) < new Date(new Date().toISOString().slice(0, 10))) {
            return res.status(400).json({ message: 'Quotation has expired' });
        }
        const upd = await pool.query(
            `UPDATE pos_quotations
             SET status = 'converted',
                 converted_transaction_id = COALESCE($3, converted_transaction_id)
             WHERE id = $1 AND COALESCE(tenant_id, 1) = $2
             RETURNING *`,
            [req.params.id, tenantId, txId]
        );
        await logActivity(req, 'QUOTATION_CONVERTED', { quotation_id: q.id, quote_number: q.quote_number, transaction_id: txId });
        res.json({ success: true, quotation: upd.rows[0] });
    } catch (err) {
        res.status(500).json({ message: 'Failed to convert quotation' });
    }
});

// 6. Hardened Split-Payment Checkout (Server-Authoritative Prices, Credit & Stock)
router.post('/api/pos/checkout', authenticateToken, requirePermission('sales', 'create'), async (req, res) => {
    const client = await pool.connect();
    try {
        await ensurePosPhase2Schema();
        const {
            items = [],
            payments = [],
            customer_id = null,
            price_group = 'retail',
            discount_amount = 0,
            approval_token = null,
            idempotency_key = null,
            store_location = req.user.store_location || DEFAULT_BRANCH_NAME,
            delivery = null,
            quotation_id = null
        } = req.body;

        if (!Array.isArray(items) || !items.length) {
            return res.status(400).json({ message: 'Cart is empty' });
        }

        // Validate payment splits strictly (no negative or NaN amounts)
        const cleanPayments = [];
        for (const p of (Array.isArray(payments) ? payments : [])) {
            const amt = Number(p.amount);
            if (!Number.isFinite(amt) || amt <= 0) {
                return res.status(400).json({ message: 'All payment amounts must be greater than zero' });
            }
            cleanPayments.push({
                method: String(p.method || 'cash').toLowerCase(),
                amount: Number(amt.toFixed(2)),
                reference: String(p.reference || '').slice(0, 120)
            });
        }

        const tenantId = req.user.tenant_id || 1;
        const scopedIdemKey = idempotency_key ? `${tenantId}:${String(idempotency_key)}` : null;
        await client.query('BEGIN');

        // Idempotency claim to prevent double-click duplicate sales
        if (scopedIdemKey) {
            const claim = await runOptional(client, 'sp_idem_claim', () => client.query(
                `INSERT INTO idempotency_claims (key, user_id) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key`,
                [scopedIdemKey, req.user.id || 0]
            ));
            if (claim && claim.rows.length === 0) {
                const prior = await runOptional(client, 'sp_idem_prior', () => client.query(
                    'SELECT receipt_number, transaction_id FROM idempotency_claims WHERE key = $1',
                    [scopedIdemKey]
                ));
                await client.query('ROLLBACK');
                return res.json({
                    success: true,
                    isReplay: true,
                    receipt_number: prior?.rows?.[0]?.receipt_number || null
                });
            }
        }

        // Resolve seller identity & canonical branch inside SAVEPOINT so manager/teller sales tag their store & user
        const sellerRes = req.user?.id
            ? await runOptional(client, 'sp_seller_lookup', () =>
                client.query('SELECT id, username, name, role, store_id, store_location FROM users WHERE id = $1 LIMIT 1', [req.user.id])
              )
            : null;
        const sellerRow = sellerRes?.rows?.[0] || {};
        const sellerName = sellerRow.name || req.user.name || 'Staff';
        const sellerUsername = sellerRow.username || req.user.username || (req.user.email ? req.user.email.split('@')[0] : 'staff');
        const sellerRole = (sellerRow.role || req.user.role || 'teller').toLowerCase();
        let branchId = sellerRow.store_id || req.user.store_id || req.user.branch_id || null;
        let storeLoc = sellerRow.store_location || req.user.store_location || store_location || DEFAULT_BRANCH_NAME;

        const branchRes = await runOptional(client, 'sp_branch_lookup', () =>
            client.query(
                `SELECT id, name FROM branches
                 WHERE COALESCE(tenant_id, 1) = $1
                 ORDER BY CASE
                     WHEN ($2::int IS NOT NULL AND id = $2::int) THEN 0
                     WHEN ($3::text IS NOT NULL AND (LOWER(name) = LOWER($3::text) OR LOWER(location) = LOWER($3::text))) THEN 1
                     ELSE 2
                 END, is_main DESC NULLS LAST, id ASC
                 LIMIT 1`,
                [tenantId, branchId, storeLoc]
            )
        );
        if (branchRes && branchRes.rows.length > 0) {
            storeLoc = branchRes.rows[0].name;
            branchId = branchRes.rows[0].id;
        }

        // Server-authoritative item lookup & price calculation
        const verifiedItems = [];
        let itemsSubtotal = 0;
        for (const it of items) {
            const qty = Number(it.qty);
            if (!it.barcode || !Number.isFinite(qty) || qty <= 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'Each item must have a valid barcode and positive quantity' });
            }
            const pRes = await client.query(
                'SELECT * FROM products WHERE barcode = $1 AND COALESCE(tenant_id, 1) = $2 FOR UPDATE',
                [it.barcode, tenantId]
            );
            if (!pRes.rows.length) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: `Product ${it.barcode} not found` });
            }
            const prod = pRes.rows[0];
            const { unitPrice, factor, unitName } = computeServerUnitPrice(prod, price_group, it.unit_name, qty);
            // each line is rounded to the pesewa as it is added, so rounding never drifts across a long sale
            itemsSubtotal = Math.round((itemsSubtotal + Math.round((unitPrice * qty + Number.EPSILON) * 100) / 100) * 100) / 100;
            verifiedItems.push({
                id: prod.id,
                barcode: prod.barcode,
                name: prod.name,
                qty,
                unit_name: unitName,
                unit_factor: factor,
                price: unitPrice,
                stock_before: Number(prod.stock || 0)
            });
        }

        // Discount cap & server-verified Manager PIN token
        const requestedDiscount = Math.round((Number(discount_amount || 0) + Number.EPSILON) * 100) / 100;
        if (!Number.isFinite(requestedDiscount) || requestedDiscount < 0 || requestedDiscount > itemsSubtotal) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Invalid discount amount' });
        }

        const userRole = (req.user.role || '').toLowerCase();
        const roleCapPct = (userRole === 'super_admin' || userRole === 'ceo' || userRole === 'admin') ? 100
            : (MANAGER_ROLES.includes(userRole) ? 20 : 5);
        const discountPct = itemsSubtotal > 0 ? (requestedDiscount / itemsSubtotal) * 100 : 0;

        let approverId = null;
        if (discountPct > roleCapPct) {
            const approval = await consumeApprovalToken(client, approval_token, requestedDiscount, req.user.tenant_id || 1);
            if (!approval) {
                await client.query('ROLLBACK');
                return res.status(403).json({ message: `Discount (${discountPct.toFixed(1)}%) exceeds ${roleCapPct}% cap and requires valid Manager PIN approval` });
            }
            approverId = approval.approverId;
        }

        // Active tax rules (wrapped in SAVEPOINT so schema differences never abort checkout)
        let taxRows = await runOptional(client, 'sp_tax_rules', () =>
            client.query(
                `SELECT name, rate FROM tax_rules
                 WHERE status = 'Active' AND deleted_at IS NULL
                   AND (branch_id IS NULL OR branch_id = $1)`,
                [branchId]
            )
        );
        if (!taxRows) {
            taxRows = await runOptional(client, 'sp_tax_rules_legacy', () =>
                client.query(`SELECT name, rate FROM tax_rules WHERE status = 'Active'`)
            ) || { rows: [] };
        }
        const deliveryFee = delivery && delivery.enabled ? Math.max(0, Number(delivery.fee || 0)) : 0;
        const taxableBase = Math.round(Math.max(0, itemsSubtotal - requestedDiscount) * 100) / 100;
        // Shelf prices are tax-inclusive: extract included tax via base * rate / (100 + totalRate)
        const totalTaxRate = taxRows.rows.reduce((s, t) => s + Math.max(0, Number(t.rate || 0)), 0);
        const taxBreakdown = taxRows.rows.map(t => {
            const rate = Math.max(0, Number(t.rate || 0));
            const amount = totalTaxRate > 0 ? Number(((taxableBase * rate) / (100 + totalTaxRate)).toFixed(2)) : 0;
            return { name: t.name, rate, amount, inclusive: true };
        });

        const grandTotal = Math.max(0, Number((taxableBase + deliveryFee).toFixed(2)));
        const totalPaid = cleanPayments.reduce((s, p) => s + p.amount, 0);
        const cashPaid = cleanPayments.filter(p => p.method === 'cash').reduce((s, p) => s + p.amount, 0);
        const nonCashPaid = totalPaid - cashPaid;
        const remainingAfterNonCash = Math.max(0, grandTotal - nonCashPaid);
        const changeAmount = Number(Math.max(0, cashPaid - remainingAfterNonCash).toFixed(2));
        const balanceDue = Number(Math.max(0, grandTotal - totalPaid).toFixed(2));

        const creditSplitUsed = cleanPayments.filter(p => p.method === 'customer_credit').reduce((s, p) => s + p.amount, 0);
        const storeCreditUsed = cleanPayments.filter(p => p.method === 'store_credit').reduce((s, p) => s + p.amount, 0);
        const totalCreditIncurred = creditSplitUsed + balanceDue;

        // Customer credit & store credit checks (never allow walk-in part-paid or negative store credit)
        let customerName = 'Walk-in';
        const parsedCustId = customer_id ? parseInt(customer_id, 10) : null;
        if ((totalCreditIncurred > 0.009 || storeCreditUsed > 0) && !parsedCustId) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'A customer account is required for credit, store credit, or part-paid sales' });
        }
        if (parsedCustId) {
            const cRes = await client.query(
                'SELECT id, name, credit_limit, current_balance, COALESCE(store_credit,0) AS store_credit FROM customers WHERE id = $1 FOR UPDATE',
                [parsedCustId]
            );
            if (!cRes.rows.length) {
                await client.query('ROLLBACK');
                return res.status(404).json({ message: 'Customer not found' });
            }
            const cust = cRes.rows[0];
            customerName = cust.name;

            if (storeCreditUsed > Number(cust.store_credit || 0)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: `Insufficient store credit (available: GH₵ ${Number(cust.store_credit || 0).toFixed(2)})` });
            }
            if (totalCreditIncurred > 0.009) {
                const newBal = Number(cust.current_balance || 0) + totalCreditIncurred;
                if (newBal > Number(cust.credit_limit || 0)) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: `Credit limit exceeded (limit: GH₵ ${Number(cust.credit_limit || 0).toFixed(2)})` });
                }
                await client.query('UPDATE customers SET current_balance = $1 WHERE id = $2', [newBal, parsedCustId]);
            }
            if (storeCreditUsed > 0) {
                await client.query('UPDATE customers SET store_credit = store_credit - $1 WHERE id = $2', [storeCreditUsed, parsedCustId]);
            }
        }

        // Deduct stock + stock_levels + product_batches + inventory_audit_log
        for (const it of verifiedItems) {
            const baseQty = Number((it.qty * it.unit_factor).toFixed(3));
            await client.query(
                `UPDATE products
                 SET stock = COALESCE(stock, 0) - $1,
                     stock_levels = jsonb_set(
                         COALESCE(stock_levels, '{}'::jsonb),
                         ARRAY[$3::text],
                         to_jsonb(COALESCE((stock_levels->>$3::text)::numeric, 0) - $1)
                     )
                 WHERE barcode = $2 AND COALESCE(tenant_id, 1) = $4`,
                [baseQty, it.barcode, storeLoc, tenantId]
            );

            // FIFO batch deduction if batches exist (inside SAVEPOINT)
            const batches = await runOptional(client, 'sp_batches', () =>
                client.query(
                    'SELECT id, quantity FROM product_batches WHERE product_barcode = $1 AND quantity > 0 ORDER BY expiry_date ASC NULLS LAST FOR UPDATE',
                    [it.barcode]
                )
            );
            let rem = baseQty;
            for (const b of (batches?.rows || [])) {
                if (rem <= 0) break;
                const take = Math.min(rem, Number(b.quantity));
                await runOptional(client, 'sp_batch_upd', () =>
                    client.query('UPDATE product_batches SET quantity = quantity - $1 WHERE id = $2', [take, b.id])
                );
                rem -= take;
            }

            const qtyBefore = Math.round(Number(it.stock_before || 0));
            const qtyAfter = Math.round(Number(it.stock_before || 0) - baseQty);
            await runOptional(client, 'sp_inv_audit', () =>
                client.query(
                    `INSERT INTO inventory_audit_log (action_type, product_barcode, quantity_before, quantity_after, reference_type, user_id, branch_id, notes)
                     VALUES ('Sale', $1, $2, $3, 'POS Checkout', $4, $5, $6)`,
                    [it.barcode, qtyBefore, qtyAfter, req.user.id || null, branchId, `POS sale at ${storeLoc}`]
                )
            );
        }

        const primaryMethod = cleanPayments.length > 1
            ? 'split'
            : ((cleanPayments[0] && cleanPayments[0].method) || (balanceDue > 0 ? 'credit' : 'cash'));
        const status = balanceDue > 0.009 ? 'part-paid' : 'completed';
        const receiptNumber = 'OKW-' + Date.now() + '-' + crypto.randomInt(100, 999);

        const trxRes = await client.query(
            `INSERT INTO transactions
                (tenant_id, user_id, customer_id, customer_name, store_location, total_amount, original_total, current_total,
                 payment_method, payment_splits, paid_amount, balance_due, change_amount, discount_amount,
                 discount_approved_by, price_group, delivery_info, tax_breakdown, receipt_number, items, status)
             VALUES ($1,$2,$3,$4,$5,$6,$6,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
             RETURNING *`,
            [
                tenantId, req.user.id || null, parsedCustId, customerName, storeLoc,
                grandTotal, primaryMethod, JSON.stringify(cleanPayments), totalPaid, balanceDue, changeAmount,
                requestedDiscount, approverId, price_group,
                delivery && delivery.enabled ? JSON.stringify(delivery) : null,
                JSON.stringify(taxBreakdown), receiptNumber, JSON.stringify(verifiedItems), status
            ]
        );

        if (scopedIdemKey) {
            await runOptional(client, 'sp_idem_upd', () =>
                client.query(
                    'UPDATE idempotency_claims SET receipt_number = $1, transaction_id = $2 WHERE key = $3',
                    [receiptNumber, trxRes.rows[0].id, scopedIdemKey]
                )
            );
        }

        if (quotation_id) {
            await runOptional(client, 'sp_quote_conv', () =>
                client.query(`UPDATE pos_quotations SET status = 'converted' WHERE id = $1 AND tenant_id = $2`, [quotation_id, tenantId])
            );
        }

        let deliveryNote = null;
        if (delivery && delivery.enabled && delivery.site_address) {
            const dnNum = 'DN-' + Date.now() + '-' + crypto.randomInt(100, 999);
            const dnRes = await client.query(
                `INSERT INTO delivery_notes (tenant_id, delivery_number, transaction_id, receipt_number, customer_id, customer_name, site_address, truck_number, driver_name, delivery_fee, status, store_location)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Loading',$11) RETURNING *`,
                [tenantId, dnNum, trxRes.rows[0].id, receiptNumber, parsedCustId, customerName, delivery.site_address, delivery.truck || '', delivery.driver || '', deliveryFee, storeLoc || '']
            );
            deliveryNote = dnRes.rows[0];
        }

        await client.query('COMMIT');
        await logActivity(req, 'POS_SALE_COMPLETED', { receipt_number: receiptNumber, total: grandTotal, status, splits: cleanPayments.length });

        res.status(201).json({
            success: true,
            transaction: trxRes.rows[0],
            delivery_note: deliveryNote,
            receipt_number: receiptNumber,
            change_amount: changeAmount,
            balance_due: balanceDue,
            seller: {
                id: req.user.id,
                name: sellerName,
                username: sellerUsername,
                role: sellerRole,
                store_location: storeLoc
            }
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('POST /api/pos/checkout error:', err);
        res.status(500).json({ message: 'Checkout failed: ' + err.message });
    } finally {
        client.release();
    }
});

// 7. Verified POS Returns (enforces manager role or approval_token, original receipt quantities & prices)
router.post('/api/pos/returns', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
        await ensurePosPhase2Schema();
        const { receipt_number, items = [], refund_method = 'cash', approval_token = null, reason = '' } = req.body;
        if (!receipt_number || !Array.isArray(items) || !items.length) {
            return res.status(400).json({ message: 'Receipt number and return items are required' });
        }

        const role = (req.user.role || '').toLowerCase();
        let approverId = null;
        if (!MANAGER_ROLES.includes(role)) {
            const approval = await consumeApprovalToken(pool, approval_token, null, req.user.tenant_id || 1);
            if (!approval) {
                return res.status(403).json({ message: 'Returns require Manager role or valid Manager PIN approval' });
            }
            approverId = approval.approverId;
        } else {
            approverId = req.user.id;
        }

        const tenantId = req.user.tenant_id || 1;
        await client.query('BEGIN');
        const origRes = await client.query(
            'SELECT * FROM transactions WHERE receipt_number = $1 AND COALESCE(tenant_id, 1) = $2 FOR UPDATE',
            [receipt_number, tenantId]
        );
        if (!origRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Original receipt not found' });
        }
        const orig = origRes.rows[0];
        if (orig.is_return) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Cannot return a return receipt' });
        }

        const origItems = Array.isArray(orig.items) ? orig.items : JSON.parse(orig.items || '[]');
        const prevReturnsRes = await client.query(
            'SELECT items FROM transactions WHERE original_transaction_id = $1 AND is_return = true',
            [orig.id]
        );
        const alreadyReturnedMap = new Map();
        for (const rTx of prevReturnsRes.rows) {
            const rItems = Array.isArray(rTx.items) ? rTx.items : JSON.parse(rTx.items || '[]');
            for (const ri of rItems) {
                alreadyReturnedMap.set(ri.barcode, (alreadyReturnedMap.get(ri.barcode) || 0) + Number(ri.qty || 0));
            }
        }

        let refundTotal = 0;
        const verifiedReturnItems = [];
        for (const it of items) {
            const qty = Number(it.qty);
            if (!it.barcode || !Number.isFinite(qty) || qty <= 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'Invalid return item or quantity' });
            }
            const origItem = origItems.find(oi => oi.barcode === it.barcode);
            if (!origItem) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: `Item ${it.barcode} was not on receipt ${receipt_number}` });
            }
            const alreadyRet = alreadyReturnedMap.get(it.barcode) || 0;
            if (alreadyRet + qty > Number(origItem.qty)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: `Cannot return ${qty} of ${origItem.name} (only ${Number(origItem.qty) - alreadyRet} remaining)` });
            }
            const origPrice = Number(origItem.price);
            refundTotal += origPrice * qty;
            verifiedReturnItems.push({
                barcode: origItem.barcode,
                name: origItem.name,
                qty,
                unit_factor: Number(origItem.unit_factor || 1),
                price: origPrice
            });
        }

        refundTotal = Number(refundTotal.toFixed(2));
        if (refund_method === 'store_credit' && !orig.customer_id) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Store credit refund requires a customer on the original sale' });
        }

        const storeLoc = orig.store_location || req.user.store_location || DEFAULT_BRANCH_NAME;
        for (const it of verifiedReturnItems) {
            const baseQty = Number((it.qty * it.unit_factor).toFixed(3));
            await client.query(
                `UPDATE products
                 SET stock = COALESCE(stock, 0) + $1,
                     stock_levels = jsonb_set(
                         COALESCE(stock_levels, '{}'::jsonb),
                         ARRAY[$3::text],
                         to_jsonb(COALESCE((stock_levels->>$3::text)::numeric, 0) + $1)
                     )
                 WHERE barcode = $2 AND COALESCE(tenant_id, 1) = $4`,
                [baseQty, it.barcode, storeLoc, tenantId]
            );
        }

        if (refund_method === 'store_credit' && orig.customer_id) {
            await client.query(
                'UPDATE customers SET store_credit = COALESCE(store_credit, 0) + $1 WHERE id = $2 AND COALESCE(tenant_id, 1) = $3',
                [refundTotal, orig.customer_id, tenantId]
            );
        }

        const retReceipt = 'RET-' + Date.now() + '-' + crypto.randomInt(100, 999);
        const retRes = await client.query(
            `INSERT INTO transactions
                (tenant_id, user_id, customer_id, customer_name, store_location, total_amount, original_total, current_total,
                 payment_method, receipt_number, items, status, is_return, original_transaction_id, discount_approved_by)
             VALUES ($1,$2,$3,$4,$5,$6,$6,$6,$7,$8,$9,'completed',true,$10,$11) RETURNING *`,
            [orig.tenant_id || req.user.tenant_id || 1, req.user.id || null, orig.customer_id, orig.customer_name, storeLoc, -refundTotal, refund_method, retReceipt, JSON.stringify(verifiedReturnItems), orig.id, approverId]
        );

        await runOptional(client, 'sp_refund_insert', () =>
            client.query(
                `INSERT INTO refunds (transaction_id, original_receipt_number, refund_receipt_number, refund_amount, payment_method, processed_by)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [orig.id, orig.receipt_number, retReceipt, refundTotal, refund_method, req.user.id || null]
            )
        );

        await client.query('UPDATE transactions SET has_returns = true WHERE id = $1', [orig.id]);
        await client.query('COMMIT');

        await logActivity(req, 'POS_RETURN_PROCESSED', { original: receipt_number, return_receipt: retReceipt, refund_total: refundTotal, refund_method, reason });
        res.status(201).json({ success: true, return_transaction: retRes.rows[0], refund_total: refundTotal });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('POST /api/pos/returns error:', err);
        res.status(500).json({ message: 'Return failed: ' + err.message });
    } finally {
        client.release();
    }
});

module.exports = router;
