const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { authenticateToken, requireRole, requirePermission, MANAGER_ROLES } = require('../middleware/auth');
const { logActivity } = require('../services/audit');

let schemaReady = false;
async function ensurePhase4Schema() {
    if (schemaReady || !pool) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS brands (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER DEFAULT 1,
                name VARCHAR(120) NOT NULL,
                logo_url TEXT DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
            ALTER TABLE brands DROP CONSTRAINT IF EXISTS brands_name_key;
            CREATE UNIQUE INDEX IF NOT EXISTS brands_tenant_name_idx ON brands (tenant_id, name);

            CREATE TABLE IF NOT EXISTS unit_conversions (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER DEFAULT 1,
                base_unit VARCHAR(60) NOT NULL,
                alt_unit VARCHAR(60) NOT NULL,
                factor NUMERIC(12,4) NOT NULL,
                notes VARCHAR(200) DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS price_history (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER DEFAULT 1,
                product_barcode VARCHAR(60) NOT NULL,
                product_name VARCHAR(255) NOT NULL,
                brand VARCHAR(120) DEFAULT '',
                old_price DECIMAL(12,2) NOT NULL,
                new_price DECIMAL(12,2) NOT NULL,
                change_reason VARCHAR(200) DEFAULT '',
                changed_by INTEGER NULL,
                changed_by_name VARCHAR(120) DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS customer_groups (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER DEFAULT 1,
                name VARCHAR(80) NOT NULL,
                price_group VARCHAR(40) DEFAULT 'retail',
                discount_pct DECIMAL(5,2) DEFAULT 0.00,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
            ALTER TABLE customer_groups DROP CONSTRAINT IF EXISTS customer_groups_name_key;
            CREATE UNIQUE INDEX IF NOT EXISTS customer_groups_tenant_name_idx ON customer_groups (tenant_id, name);

            CREATE TABLE IF NOT EXISTS customer_sites (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER DEFAULT 1,
                customer_id INTEGER NOT NULL,
                site_name VARCHAR(200) NOT NULL,
                address VARCHAR(255) DEFAULT '',
                contact_phone VARCHAR(60) DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT NOW()
            );

            ALTER TABLE delivery_notes ADD COLUMN IF NOT EXISTS receiver_name VARCHAR(120) DEFAULT '';
            ALTER TABLE delivery_notes ADD COLUMN IF NOT EXISTS signature_data TEXT DEFAULT '';
            ALTER TABLE delivery_notes ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ NULL;
        `);

        // Seed default customer groups
        const cgCount = await pool.query('SELECT COUNT(*)::int AS cnt FROM customer_groups WHERE COALESCE(tenant_id, 1) = 1');
        if (cgCount.rows[0].cnt === 0) {
            await pool.query(`
                INSERT INTO customer_groups (tenant_id, name, price_group, discount_pct) VALUES
                (1, 'Walk-in', 'retail', 0),
                (1, 'Contractor', 'contractor', 5),
                (1, 'Company', 'wholesale', 8),
                (1, 'VIP', 'wholesale', 10)
                ON CONFLICT (tenant_id, name) DO NOTHING;
            `);
        }

        // Seed common building-materials unit conversions
        const ucCount = await pool.query('SELECT COUNT(*)::int AS cnt FROM unit_conversions');
        if (ucCount.rows[0].cnt === 0) {
            await pool.query(`
                INSERT INTO unit_conversions (base_unit, alt_unit, factor, notes) VALUES
                ('Bag', 'Pallet', 50, '1 pallet = 50 bags of cement'),
                ('Rod', 'Tonne', 80, '1 tonne = 80 rods of 12mm'),
                ('Piece', 'Bundle', 10, '1 bundle = 10 pieces'),
                ('Metre', 'Roll', 50, '1 roll = 50 metres')
            `);
        }
        schemaReady = true;
    } catch (e) {
        console.warn('Phase 4 schema notice:', e.message);
    }
}

async function safeQuery(sql, params = []) {
    try { const r = await pool.query(sql, params); return r.rows; } catch (e) { return []; }
}

// 1. Brands
router.get('/api/brands', authenticateToken, async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const brands = await safeQuery(`
        SELECT b.*,
               COUNT(p.barcode)::int AS product_count,
               COALESCE(SUM(p.stock), 0) AS total_stock,
               COALESCE(SUM(p.stock * p.cost_price), 0) AS stock_value
        FROM brands b
        LEFT JOIN products p ON LOWER(COALESCE(p.brand,'')) = LOWER(b.name) AND COALESCE(p.tenant_id, 1) = $1
        WHERE COALESCE(b.tenant_id, 1) = $1
        GROUP BY b.id
        ORDER BY b.name ASC
    `, [tenantId]);
    // Also include distinct brands from products not yet in brands table
    const prodBrands = await safeQuery(`SELECT DISTINCT COALESCE(brand,'') AS name FROM products WHERE COALESCE(tenant_id, 1) = $1 AND COALESCE(brand,'') <> ''`, [tenantId]);
    res.json({ brands, product_brands: prodBrands });
});

router.post('/api/brands', authenticateToken, requireRole(MANAGER_ROLES), requirePermission('products', 'edit'), async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const { name, logo_url = '' } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ message: 'Brand name is required' });
    const r = await pool.query(
        `INSERT INTO brands (tenant_id, name, logo_url) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, name) DO UPDATE SET logo_url = EXCLUDED.logo_url RETURNING *`,
        [tenantId, name.trim(), logo_url]
    );
    res.status(201).json({ success: true, brand: r.rows[0] });
});

// 2. Unit conversions
router.get('/api/units', authenticateToken, async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const units = await safeQuery('SELECT * FROM unit_conversions WHERE COALESCE(tenant_id, 1) = $1 ORDER BY id ASC', [tenantId]);
    res.json({ units });
});

router.post('/api/units', authenticateToken, requireRole(MANAGER_ROLES), requirePermission('products', 'edit'), async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const { base_unit, alt_unit, factor, notes = '' } = req.body;
    if (!base_unit || !alt_unit || !factor) return res.status(400).json({ message: 'Base unit, alt unit, and factor are required' });
    const r = await pool.query(
        `INSERT INTO unit_conversions (tenant_id, base_unit, alt_unit, factor, notes) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [tenantId, base_unit.trim(), alt_unit.trim(), Number(factor), notes]
    );
    res.status(201).json({ success: true, unit: r.rows[0] });
});

// 3. Bulk Price Update (Preview + Apply + History)
router.post('/api/prices/bulk-preview', authenticateToken, async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const { brand = '', category = '', mode = 'percent', value = 0 } = req.body;
    const params = [tenantId];
    const conds = ['COALESCE(tenant_id, 1) = $1'];
    if (brand) { params.push(brand); conds.push(`LOWER(COALESCE(brand,'')) = LOWER($${params.length})`); }
    if (category) { params.push(category); conds.push(`LOWER(COALESCE(category,'')) = LOWER($${params.length})`); }
    const where = `WHERE ${conds.join(' AND ')}`;
    const rows = await safeQuery(`SELECT barcode, name, brand, category, price FROM products ${where} ORDER BY name ASC LIMIT 300`, params);
    const val = Number(value || 0);
    const preview = rows.map(r => {
        const oldP = Number(r.price || 0);
        const newP = mode === 'percent' ? oldP * (1 + val / 100) : oldP + val;
        return { ...r, old_price: Number(oldP.toFixed(2)), new_price: Number(Math.max(0, newP).toFixed(2)) };
    });
    res.json({ preview });
});

router.post('/api/prices/bulk-apply', authenticateToken, requireRole(MANAGER_ROLES), requirePermission('prices', 'edit'), async (req, res) => {
    if (!MANAGER_ROLES.includes((req.user.role || '').toLowerCase())) {
        return res.status(403).json({ message: 'Manager or CEO access required' });
    }
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const { items = [], reason = 'Bulk price update' } = req.body;
    if (!items.length) return res.status(400).json({ message: 'No items to update' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        let updated = 0;
        for (const it of items) {
            const upd = await client.query('UPDATE products SET price = $1 WHERE barcode = $2 AND COALESCE(tenant_id, 1) = $3', [it.new_price, it.barcode, tenantId]);
            if (upd.rowCount > 0) {
                updated++;
                await client.query(
                    `INSERT INTO price_history (tenant_id, product_barcode, product_name, brand, old_price, new_price, change_reason, changed_by, changed_by_name)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                    [tenantId, it.barcode, it.name || '', it.brand || '', it.old_price, it.new_price, reason, req.user.id || null, req.user.name || 'Staff']
                );
            }
        }
        await client.query('COMMIT');
        await logActivity(req, 'BULK_PRICE_UPDATE', { count: updated, reason });
        res.json({ success: true, updated });
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        res.status(500).json({ message: 'Bulk price update failed' });
    } finally {
        client.release();
    }
});

router.get('/api/prices/history', authenticateToken, async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const history = await safeQuery('SELECT * FROM price_history WHERE COALESCE(tenant_id, 1) = $1 ORDER BY created_at DESC LIMIT 200', [tenantId]);
    res.json({ history });
});

// 4. Customer Groups & Sites
router.get('/api/customer-groups', authenticateToken, async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const groups = await safeQuery('SELECT * FROM customer_groups WHERE COALESCE(tenant_id, 1) = $1 ORDER BY id ASC', [tenantId]);
    res.json({ groups });
});

router.post('/api/customer-groups', authenticateToken, requireRole(MANAGER_ROLES), requirePermission('customers', 'edit'), async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const { name, price_group = 'retail', discount_pct = 0 } = req.body;
    if (!name) return res.status(400).json({ message: 'Group name required' });
    const r = await pool.query(
        `INSERT INTO customer_groups (tenant_id, name, price_group, discount_pct) VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, name) DO UPDATE SET price_group = EXCLUDED.price_group, discount_pct = EXCLUDED.discount_pct RETURNING *`,
        [tenantId, name.trim(), price_group, Number(discount_pct || 0)]
    );
    res.status(201).json({ success: true, group: r.rows[0] });
});

router.get('/api/customer-sites', authenticateToken, async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const sites = await safeQuery(`
        SELECT s.*, c.name AS customer_name
        FROM customer_sites s
        LEFT JOIN customers c ON s.customer_id = c.id AND COALESCE(c.tenant_id, 1) = $1
        WHERE COALESCE(s.tenant_id, 1) = $1
        ORDER BY s.created_at DESC
    `, [tenantId]);
    res.json({ sites });
});

router.post('/api/customer-sites', authenticateToken, requireRole(MANAGER_ROLES), requirePermission('customers', 'edit'), async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const { customer_id, site_name, address = '', contact_phone = '' } = req.body;
    if (!customer_id || !site_name) return res.status(400).json({ message: 'Customer and site name are required' });
    const r = await pool.query(
        `INSERT INTO customer_sites (tenant_id, customer_id, site_name, address, contact_phone) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [tenantId, customer_id, site_name.trim(), address, contact_phone]
    );
    res.status(201).json({ success: true, site: r.rows[0] });
});

// 5. Deliveries (Loading -> On the way -> Delivered)
router.get('/api/deliveries', authenticateToken, async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const deliveries = await safeQuery('SELECT * FROM delivery_notes WHERE COALESCE(tenant_id, 1) = $1 ORDER BY created_at DESC LIMIT 100', [tenantId]);
    res.json({ deliveries });
});

router.patch('/api/deliveries/:id/status', authenticateToken, requirePermission('deliveries', 'edit'), async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const { status, receiver_name = '', signature_data = '' } = req.body;
    const allowed = ['Loading', 'On the way', 'Delivered'];
    if (!allowed.includes(status)) return res.status(400).json({ message: 'Invalid delivery status' });
    const r = await pool.query(
        `UPDATE delivery_notes
         SET status = $1,
             receiver_name = COALESCE(NULLIF($2,''), receiver_name),
             signature_data = COALESCE(NULLIF($3,''), signature_data),
             delivered_at = CASE WHEN $1 = 'Delivered' THEN NOW() ELSE delivered_at END
         WHERE id = $4 AND COALESCE(tenant_id, 1) = $5 RETURNING *`,
        [status, receiver_name, signature_data, req.params.id, tenantId]
    );
    if (!r.rows.length) return res.status(404).json({ message: 'Delivery not found' });
    await logActivity(req, 'DELIVERY_STATUS_UPDATED', { delivery_id: req.params.id, status });
    res.json({ success: true, delivery: r.rows[0] });
});

// 6. Automatic Reordering suggestions + 1-click Draft PO
router.get('/api/reorder/suggestions', authenticateToken, async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const lowItems = await safeQuery(`
        SELECT barcode, name, COALESCE(brand,'Unbranded') AS brand,
               COALESCE(selling_unit,'Unit') AS unit,
               COALESCE(stock,0) AS stock,
               COALESCE(reorder_level,10) AS reorder_level,
               COALESCE(cost_price,0) AS cost_price
        FROM products
        WHERE COALESCE(tenant_id, 1) = $1 AND COALESCE(stock,0) <= COALESCE(reorder_level,10)
        ORDER BY stock ASC, name ASC
        LIMIT 100
    `, [tenantId]);
    const suggestions = lowItems.map(p => {
        const suggested_qty = Math.max(10, Math.ceil(Number(p.reorder_level || 10) * 2 - Number(p.stock || 0)));
        return {
            ...p,
            suggested_qty,
            estimated_cost: Number((Number(p.cost_price || 0) * suggested_qty).toFixed(2))
        };
    });
    res.json({ suggestions });
});

router.post('/api/reorder/draft-po', authenticateToken, requireRole(MANAGER_ROLES), requirePermission('purchases', 'create'), async (req, res) => {
    const tenantId = req.user.tenant_id || 1;
    const { items = [], supplier_name = 'Primary Supplier', supplier_id = null } = req.body;
    if (!items.length) return res.status(400).json({ message: 'No items selected' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        let resolvedSupplierId = supplier_id ? Number(supplier_id) : null;
        if (resolvedSupplierId) {
            const checkSup = await client.query('SELECT id FROM suppliers WHERE id = $1 AND COALESCE(tenant_id, 1) = $2 LIMIT 1', [resolvedSupplierId, tenantId]);
            if (!checkSup.rows.length) resolvedSupplierId = null;
        }
        if (!resolvedSupplierId) {
            const supRes = await client.query('SELECT id FROM suppliers WHERE LOWER(name) = LOWER($1) AND COALESCE(tenant_id, 1) = $2 LIMIT 1', [supplier_name.trim(), tenantId]);
            if (supRes.rows.length) {
                resolvedSupplierId = supRes.rows[0].id;
            } else {
                const newSup = await client.query('INSERT INTO suppliers (tenant_id, name, branch_id) VALUES ($1, $2, $3) RETURNING id', [tenantId, supplier_name.trim(), req.user.branch_id || 1]);
                resolvedSupplierId = newSup.rows[0].id;
            }
        }

        const total = Number(items.reduce((s, it) => s + Math.max(0, Number(it.cost_price || 0)) * Math.max(1, Number(it.suggested_qty || it.quantity || 1)), 0).toFixed(2));
        const poRes = await client.query(
            `INSERT INTO purchase_orders (tenant_id, supplier_id, status, total_amount, branch_id)
             VALUES ($1, $2, 'Draft', $3, $4) RETURNING *`,
            [tenantId, resolvedSupplierId, total, req.user.branch_id || 1]
        );
        const po = poRes.rows[0];

        for (const it of items) {
            const qty = Math.max(1, Number(it.suggested_qty || it.quantity || 1));
            const cost = Math.max(0, Number(it.cost_price || it.unit_cost || 0));
            await client.query(
                `INSERT INTO purchase_order_items (tenant_id, po_id, product_barcode, quantity, unit_cost)
                 VALUES ($1, $2, $3, $4, $5)`,
                [tenantId, po.id, it.barcode || it.product_barcode, qty, cost]
            );
        }

        await client.query('COMMIT');
        await logActivity(req, 'REORDER_DRAFT_PO', { po_id: po.id, supplier_id: resolvedSupplierId, items: items.length, total });
        res.status(201).json({ success: true, purchase_order: { ...po, po_number: `PO-${po.id}`, supplier_name }, items_count: items.length });
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('POST /api/reorder/draft-po error:', e);
        res.status(500).json({ message: 'Failed to draft purchase order' });
    } finally {
        client.release();
    }
});

module.exports = router;

