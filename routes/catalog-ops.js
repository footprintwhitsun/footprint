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
                price_calculation_type VARCHAR(40) DEFAULT 'percentage',
                selling_price_group_id INTEGER NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
            ALTER TABLE customer_groups ADD COLUMN IF NOT EXISTS price_calculation_type VARCHAR(40) DEFAULT 'percentage';
            ALTER TABLE customer_groups ADD COLUMN IF NOT EXISTS selling_price_group_id INTEGER NULL;
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

            CREATE TABLE IF NOT EXISTS product_variations (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER DEFAULT 1,
                name VARCHAR(120) NOT NULL,
                values_text TEXT DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS selling_price_groups (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER DEFAULT 1,
                name VARCHAR(120) NOT NULL,
                description TEXT DEFAULT '',
                adjustment_pct DECIMAL(6,2) DEFAULT 0.00,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS product_warranties (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER DEFAULT 1,
                name VARCHAR(120) NOT NULL,
                duration INTEGER NOT NULL DEFAULT 12,
                duration_type VARCHAR(20) NOT NULL DEFAULT 'Months',
                description TEXT DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
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
    const groups = await safeQuery(`
        SELECT cg.*, spg.name AS selling_price_group_name
        FROM customer_groups cg
        LEFT JOIN selling_price_groups spg ON spg.id = cg.selling_price_group_id AND COALESCE(spg.tenant_id, 1) = $1
        WHERE COALESCE(cg.tenant_id, 1) = $1
        ORDER BY cg.id ASC
    `, [tenantId]);
    res.json({ groups });
});

router.post('/api/customer-groups', authenticateToken, requireRole(MANAGER_ROLES), requirePermission('customers', 'edit'), async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const {
        name,
        price_group = 'retail',
        discount_pct = 0,
        price_calculation_type = 'percentage',
        selling_price_group_id = null
    } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ message: 'Customer Group Name is required' });
    const calcType = price_calculation_type === 'selling_price_group' ? 'selling_price_group' : 'percentage';
    const spgId = calcType === 'selling_price_group' && selling_price_group_id ? parseInt(selling_price_group_id, 10) : null;
    const pct = calcType === 'percentage' ? Number(discount_pct || 0) : 0;
    const r = await pool.query(
        `INSERT INTO customer_groups (tenant_id, name, price_group, discount_pct, price_calculation_type, selling_price_group_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, name) DO UPDATE SET
             price_group = EXCLUDED.price_group,
             discount_pct = EXCLUDED.discount_pct,
             price_calculation_type = EXCLUDED.price_calculation_type,
             selling_price_group_id = EXCLUDED.selling_price_group_id
         RETURNING *`,
        [tenantId, String(name).trim(), price_group, pct, calcType, spgId]
    );
    await logActivity(req, 'SAVE_CUSTOMER_GROUP', { name: String(name).trim(), price_calculation_type: calcType });
    res.status(201).json({ success: true, group: r.rows[0] });
});

router.put('/api/customer-groups/:id', authenticateToken, requireRole(MANAGER_ROLES), requirePermission('customers', 'edit'), async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const {
        name,
        discount_pct = 0,
        price_calculation_type = 'percentage',
        selling_price_group_id = null
    } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ message: 'Customer Group Name is required' });
    const calcType = price_calculation_type === 'selling_price_group' ? 'selling_price_group' : 'percentage';
    const spgId = calcType === 'selling_price_group' && selling_price_group_id ? parseInt(selling_price_group_id, 10) : null;
    const pct = calcType === 'percentage' ? Number(discount_pct || 0) : 0;
    const r = await pool.query(
        `UPDATE customer_groups
         SET name = $1, discount_pct = $2, price_calculation_type = $3, selling_price_group_id = $4
         WHERE id = $5 AND COALESCE(tenant_id, 1) = $6
         RETURNING *`,
        [String(name).trim(), pct, calcType, spgId, req.params.id, tenantId]
    );
    if (r.rowCount === 0) return res.status(404).json({ message: 'Customer group not found' });
    await logActivity(req, 'UPDATE_CUSTOMER_GROUP', { id: req.params.id, name: String(name).trim() });
    res.json({ success: true, group: r.rows[0] });
});

router.delete('/api/customer-groups/:id', authenticateToken, requireRole(MANAGER_ROLES), requirePermission('customers', 'edit'), async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const r = await pool.query('DELETE FROM customer_groups WHERE id = $1 AND COALESCE(tenant_id, 1) = $2', [req.params.id, tenantId]);
    if (r.rowCount === 0) return res.status(404).json({ message: 'Customer group not found' });
    await logActivity(req, 'DELETE_CUSTOMER_GROUP', { id: req.params.id });
    res.json({ success: true });
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

// --- VARIATIONS ---
router.get('/api/variations', authenticateToken, async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    try {
        const r = await pool.query(
            'SELECT * FROM product_variations WHERE COALESCE(tenant_id, 1) = $1 ORDER BY name ASC',
            [tenantId]
        );
        res.json({ variations: r.rows });
    } catch (e) {
        res.status(500).json({ message: 'Failed to load variations' });
    }
});

router.post('/api/variations', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const { name, values_text = '' } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ message: 'Variation name is required' });
    try {
        const r = await pool.query(
            'INSERT INTO product_variations (tenant_id, name, values_text) VALUES ($1, $2, $3) RETURNING *',
            [tenantId, String(name).trim(), String(values_text || '').trim()]
        );
        await logActivity(req, 'CREATE_VARIATION', { name: String(name).trim() });
        res.status(201).json({ variation: r.rows[0] });
    } catch (e) {
        res.status(500).json({ message: 'Failed to save variation' });
    }
});

router.delete('/api/variations/:id', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    try {
        await pool.query('DELETE FROM product_variations WHERE id = $1 AND COALESCE(tenant_id, 1) = $2', [req.params.id, tenantId]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ message: 'Failed to delete variation' });
    }
});

// --- SELLING PRICE GROUPS ---
router.get('/api/selling-price-groups', authenticateToken, async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    try {
        const r = await pool.query(
            'SELECT * FROM selling_price_groups WHERE COALESCE(tenant_id, 1) = $1 ORDER BY name ASC',
            [tenantId]
        );
        res.json({ price_groups: r.rows });
    } catch (e) {
        res.status(500).json({ message: 'Failed to load selling price groups' });
    }
});

router.post('/api/selling-price-groups', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const { name, description = '', adjustment_pct = 0 } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ message: 'Price group name is required' });
    try {
        const r = await pool.query(
            'INSERT INTO selling_price_groups (tenant_id, name, description, adjustment_pct) VALUES ($1, $2, $3, $4) RETURNING *',
            [tenantId, String(name).trim(), String(description || '').trim(), Number(adjustment_pct || 0)]
        );
        await logActivity(req, 'CREATE_SELLING_PRICE_GROUP', { name: String(name).trim() });
        res.status(201).json({ price_group: r.rows[0] });
    } catch (e) {
        res.status(500).json({ message: 'Failed to save selling price group' });
    }
});

router.delete('/api/selling-price-groups/:id', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    try {
        await pool.query('DELETE FROM selling_price_groups WHERE id = $1 AND COALESCE(tenant_id, 1) = $2', [req.params.id, tenantId]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ message: 'Failed to delete selling price group' });
    }
});

// --- WARRANTIES ---
router.get('/api/warranties', authenticateToken, async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    try {
        const r = await pool.query(
            'SELECT * FROM product_warranties WHERE COALESCE(tenant_id, 1) = $1 ORDER BY name ASC',
            [tenantId]
        );
        res.json({ warranties: r.rows });
    } catch (e) {
        res.status(500).json({ message: 'Failed to load warranties' });
    }
});

router.post('/api/warranties', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const { name, duration = 12, duration_type = 'Months', description = '' } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ message: 'Warranty name is required' });
    const dur = Math.max(1, parseInt(duration, 10) || 1);
    const unit = ['Days', 'Months', 'Years'].includes(duration_type) ? duration_type : 'Months';
    try {
        const r = await pool.query(
            'INSERT INTO product_warranties (tenant_id, name, duration, duration_type, description) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [tenantId, String(name).trim(), dur, unit, String(description || '').trim()]
        );
        await logActivity(req, 'CREATE_WARRANTY', { name: String(name).trim(), duration: dur, duration_type: unit });
        res.status(201).json({ warranty: r.rows[0] });
    } catch (e) {
        res.status(500).json({ message: 'Failed to save warranty' });
    }
});

router.delete('/api/warranties/:id', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    try {
        await pool.query('DELETE FROM product_warranties WHERE id = $1 AND COALESCE(tenant_id, 1) = $2', [req.params.id, tenantId]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ message: 'Failed to delete warranty' });
    }
});

// --- STOCK REPORT & PRODUCT STOCK HISTORY ---
router.get('/api/products/stock-report', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    const tenantId = req.user.tenant_id || 1;
    const locationFilter = String(req.query.location || '').trim();
    try {
        const [prodRes, branchRes] = await Promise.all([
            pool.query(
                `SELECT * FROM products
                 WHERE COALESCE(tenant_id, 1) = $1 AND deleted_at IS NULL
                 ORDER BY name ASC`,
                [tenantId]
            ),
            pool.query(
                `SELECT id, name, location FROM branches
                 WHERE COALESCE(tenant_id, 1) = $1 AND deleted_at IS NULL
                 ORDER BY id ASC`,
                [tenantId]
            ).catch(() => ({ rows: [] }))
        ]);

        const branches = branchRes.rows || [];
        const branchNameById = new Map(branches.map((b) => [Number(b.id), b.name]));
        const defaultBranchName = branches[0]?.name || 'Main Branch';

        // 1. Units sold per barcode (completed non-return sales)
        const soldByBarcode = new Map();
        try {
            const txParams = [tenantId];
            let locSql = '';
            if (locationFilter) {
                txParams.push(locationFilter);
                locSql = ` AND LOWER(COALESCE(store_location, '')) = LOWER($2)`;
            }
            const txRes = await pool.query(
                `SELECT items FROM transactions
                 WHERE COALESCE(tenant_id, 1) = $1
                   AND COALESCE(is_return, false) = false
                   AND COALESCE(status, 'completed') NOT IN ('void', 'cancelled', 'parked')${locSql}`,
                txParams
            );
            for (const row of txRes.rows) {
                let items = row.items;
                if (typeof items === 'string') {
                    try { items = JSON.parse(items); } catch (_) { items = []; }
                }
                if (!Array.isArray(items)) continue;
                for (const it of items) {
                    const bc = String(it.barcode || '').trim();
                    if (!bc) continue;
                    const q = Number(it.qty ?? it.quantity ?? 0) || 0;
                    soldByBarcode.set(bc, (soldByBarcode.get(bc) || 0) + q);
                }
            }
        } catch (_) { /* ignore */ }

        // 2. Units transferred per barcode
        const transferredByBarcode = new Map();
        try {
            const trRes = await pool.query(
                `SELECT sti.product_barcode, COALESCE(sti.quantity_received, sti.quantity_sent, 0) AS qty,
                        st.from_location, st.to_location, st.from_branch_id, st.to_branch_id
                 FROM stock_transfer_items sti
                 JOIN stock_transfers st ON st.id = sti.transfer_id
                 WHERE COALESCE(st.tenant_id, 1) = $1`,
                [tenantId]
            );
            for (const r of trRes.rows) {
                const bc = String(r.product_barcode || '').trim();
                if (!bc) continue;
                if (locationFilter) {
                    const fromName = r.from_location || branchNameById.get(Number(r.from_branch_id)) || '';
                    const toName = r.to_location || branchNameById.get(Number(r.to_branch_id)) || '';
                    if (fromName.toLowerCase() !== locationFilter.toLowerCase() && toName.toLowerCase() !== locationFilter.toLowerCase()) continue;
                }
                transferredByBarcode.set(bc, (transferredByBarcode.get(bc) || 0) + Math.abs(Number(r.qty || 0)));
            }
        } catch (_) { /* ignore */ }

        // 3. Units adjusted per barcode
        const adjustedByBarcode = new Map();
        try {
            const adjRes = await pool.query(
                `SELECT product_barcode, quantity_adjusted, branch_id
                 FROM stock_adjustments
                 WHERE COALESCE(tenant_id, 1) = $1`,
                [tenantId]
            );
            for (const r of adjRes.rows) {
                const bc = String(r.product_barcode || '').trim();
                if (!bc) continue;
                if (locationFilter) {
                    const bName = branchNameById.get(Number(r.branch_id)) || '';
                    if (bName.toLowerCase() !== locationFilter.toLowerCase()) continue;
                }
                adjustedByBarcode.set(bc, (adjustedByBarcode.get(bc) || 0) + Math.abs(Number(r.quantity_adjusted || 0)));
            }
        } catch (_) { /* ignore */ }

        let totalPurchaseVal = 0;
        let totalSaleVal = 0;
        let totalStockQty = 0;
        let totalUnitsSold = 0;
        let totalUnitsTransferred = 0;
        let totalUnitsAdjusted = 0;

        const rows = prodRes.rows.map((p) => {
            const bc = String(p.barcode || '').trim();
            const levels = (p.stock_levels && typeof p.stock_levels === 'object') ? p.stock_levels : {};
            let currentStock = Number(p.stock || 0);
            let locLabel = locationFilter || p.business_locations || defaultBranchName;
            if (locationFilter) {
                const matchKey = Object.keys(levels).find((k) => k.toLowerCase() === locationFilter.toLowerCase());
                currentStock = matchKey ? Number(levels[matchKey] || 0) : 0;
                locLabel = locationFilter;
            } else {
                const levelKeys = Object.keys(levels);
                if (levelKeys.length === 1) locLabel = levelKeys[0];
                else if (levelKeys.length > 1) locLabel = 'All Locations';
            }

            const unitPrice = Number(p.price || 0);
            const costPrice = Number(p.cost_price || 0);
            const purchaseVal = Number((currentStock * costPrice).toFixed(2));
            const saleVal = Number((currentStock * unitPrice).toFixed(2));
            const potentialProfit = Number((saleVal - purchaseVal).toFixed(2));
            const sold = Number((soldByBarcode.get(bc) || 0).toFixed(2));
            const transferred = Number((transferredByBarcode.get(bc) || 0).toFixed(2));
            const adjusted = Number((adjustedByBarcode.get(bc) || 0).toFixed(2));

            totalPurchaseVal += purchaseVal;
            totalSaleVal += saleVal;
            totalStockQty += currentStock;
            totalUnitsSold += sold;
            totalUnitsTransferred += transferred;
            totalUnitsAdjusted += adjusted;

            return {
                id: p.id,
                sku: bc || String(p.id),
                product: p.name || '',
                variation: p.variation || p.sub_category || '',
                category: p.category || '',
                brand: p.brand || '',
                unit: p.selling_unit || 'Pc(s)',
                location: locLabel,
                unit_selling_price: unitPrice,
                unit_cost_price: costPrice,
                current_stock: Number(currentStock.toFixed(2)),
                stock_value_purchase: purchaseVal,
                stock_value_sale: saleVal,
                potential_profit: potentialProfit,
                total_unit_sold: sold,
                total_unit_transferred: transferred,
                total_unit_adjusted: adjusted,
                manufacturing_stock: 0
            };
        });

        const totalProfit = Number((totalSaleVal - totalPurchaseVal).toFixed(2));
        const profitMarginPct = totalSaleVal > 0 ? Number(((totalProfit / totalSaleVal) * 100).toFixed(2)) : 0;

        res.json({
            branches,
            summary: {
                closing_stock_purchase: Number(totalPurchaseVal.toFixed(2)),
                closing_stock_sale: Number(totalSaleVal.toFixed(2)),
                potential_profit: totalProfit,
                profit_margin_pct: profitMarginPct,
                total_stock_qty: Number(totalStockQty.toFixed(2)),
                total_unit_sold: Number(totalUnitsSold.toFixed(2)),
                total_unit_transferred: Number(totalUnitsTransferred.toFixed(2)),
                total_unit_adjusted: Number(totalUnitsAdjusted.toFixed(2))
            },
            rows
        });
    } catch (err) {
        console.error('GET /api/products/stock-report error:', err);
        res.status(500).json({ message: 'Failed to load stock report' });
    }
});

router.get('/api/products/stock-report/:id/history', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    const tenantId = req.user.tenant_id || 1;
    const productId = parseInt(req.params.id, 10);
    const locationFilter = String(req.query.location || '').trim();
    if (!Number.isFinite(productId) || productId <= 0) {
        return res.status(400).json({ message: 'Invalid product ID' });
    }
    try {
        const [prodRes, branchRes] = await Promise.all([
            pool.query('SELECT * FROM products WHERE id = $1 AND COALESCE(tenant_id, 1) = $2 AND deleted_at IS NULL', [productId, tenantId]),
            pool.query('SELECT id, name FROM branches WHERE COALESCE(tenant_id, 1) = $1 AND deleted_at IS NULL ORDER BY id ASC', [tenantId]).catch(() => ({ rows: [] }))
        ]);
        if (prodRes.rows.length === 0) return res.status(404).json({ message: 'Product not found' });
        const product = prodRes.rows[0];
        const barcode = String(product.barcode || '').trim();
        const branchNameById = new Map((branchRes.rows || []).map((b) => [Number(b.id), b.name]));

        const levels = (product.stock_levels && typeof product.stock_levels === 'object') ? product.stock_levels : {};
        let currentStock = Number(product.stock || 0);
        if (locationFilter) {
            const matchKey = Object.keys(levels).find((k) => k.toLowerCase() === locationFilter.toLowerCase());
            currentStock = matchKey ? Number(levels[matchKey] || 0) : 0;
        }

        const events = [];
        let totalPurchase = 0;
        let openingStock = 0;
        let totalSellReturn = 0;
        let transfersIn = 0;
        let totalSold = 0;
        let totalStockAdjustment = 0;
        let totalPurchaseReturn = 0;
        let transfersOut = 0;

        // 1. Purchases (Purchase Orders Received)
        if (barcode) {
            try {
                const poRes = await pool.query(
                    `SELECT po.id, po.created_at, po.status, po.branch_id, b.name AS branch_name, s.name AS supplier_name,
                            poi.quantity
                     FROM purchase_order_items poi
                     JOIN purchase_orders po ON po.id = poi.po_id
                     LEFT JOIN suppliers s ON s.id = po.supplier_id
                     LEFT JOIN branches b ON b.id = po.branch_id
                     WHERE poi.product_barcode = $1 AND COALESCE(po.tenant_id, 1) = $2
                       AND LOWER(COALESCE(po.status, '')) = 'received'
                     ORDER BY po.created_at ASC`,
                    [barcode, tenantId]
                );
                for (const r of poRes.rows) {
                    const bName = r.branch_name || branchNameById.get(Number(r.branch_id)) || '';
                    if (locationFilter && bName.toLowerCase() !== locationFilter.toLowerCase()) continue;
                    const q = Math.abs(Number(r.quantity || 0));
                    totalPurchase += q;
                    events.push({
                        type: 'Purchase',
                        quantity_change: q,
                        date: r.created_at,
                        reference_no: `PO-${String(r.id).padStart(4, '0')}`,
                        party_info: r.supplier_name || 'Supplier'
                    });
                }
            } catch (_) { /* ignore */ }

            // 2. Sales & Sell Returns (Transactions)
            try {
                const txRes = await pool.query(
                    `SELECT id, receipt_number, created_at, store_location, customer_name, items, COALESCE(is_return, false) AS is_return
                     FROM transactions
                     WHERE COALESCE(tenant_id, 1) = $1
                       AND COALESCE(status, 'completed') NOT IN ('void', 'cancelled', 'parked')
                     ORDER BY created_at ASC`,
                    [tenantId]
                );
                for (const tx of txRes.rows) {
                    if (locationFilter && String(tx.store_location || '').toLowerCase() !== locationFilter.toLowerCase()) continue;
                    let items = tx.items;
                    if (typeof items === 'string') {
                        try { items = JSON.parse(items); } catch (_) { items = []; }
                    }
                    if (!Array.isArray(items)) continue;
                    let matchedQty = 0;
                    for (const it of items) {
                        if (String(it.barcode || '').trim() === barcode) {
                            matchedQty += Math.abs(Number(it.qty ?? it.quantity ?? 0) || 0);
                        }
                    }
                    if (matchedQty <= 0) continue;
                    if (tx.is_return) {
                        totalSellReturn += matchedQty;
                        events.push({
                            type: 'Sell Return',
                            quantity_change: matchedQty,
                            date: tx.created_at,
                            reference_no: tx.receipt_number || `REF-${tx.id}`,
                            party_info: tx.customer_name || 'Walk-in Customer'
                        });
                    } else {
                        totalSold += matchedQty;
                        events.push({
                            type: 'Sell',
                            quantity_change: -matchedQty,
                            date: tx.created_at,
                            reference_no: tx.receipt_number || `RCP-${tx.id}`,
                            party_info: tx.customer_name || 'Walk-in Customer'
                        });
                    }
                }
            } catch (_) { /* ignore */ }

            // 3. Stock Adjustments (including Opening Stock if marked)
            try {
                const adjRes = await pool.query(
                    `SELECT id, adjustment_type, quantity_adjusted, reason, branch_id, created_at
                     FROM stock_adjustments
                     WHERE product_barcode = $1 AND COALESCE(tenant_id, 1) = $2
                     ORDER BY created_at ASC`,
                    [barcode, tenantId]
                );
                for (const r of adjRes.rows) {
                    const bName = branchNameById.get(Number(r.branch_id)) || '';
                    if (locationFilter && bName.toLowerCase() !== locationFilter.toLowerCase()) continue;
                    const rawQty = Number(r.quantity_adjusted || 0);
                    const adjType = String(r.adjustment_type || '').toLowerCase();
                    if (adjType.includes('opening')) {
                        openingStock += Math.abs(rawQty);
                        events.push({
                            type: 'Opening Stock',
                            quantity_change: Math.abs(rawQty),
                            date: r.created_at,
                            reference_no: `OPEN-${r.id}`,
                            party_info: r.reason || bName || 'Opening Stock'
                        });
                    } else {
                        const signed = adjType.includes('add') || adjType.includes('in') || rawQty > 0 ? rawQty : -Math.abs(rawQty);
                        totalStockAdjustment += Math.abs(signed);
                        events.push({
                            type: 'Stock Adjustment',
                            quantity_change: signed,
                            date: r.created_at,
                            reference_no: `ADJ-${r.id}`,
                            party_info: r.reason || r.adjustment_type || 'Adjustment'
                        });
                    }
                }
            } catch (_) { /* ignore */ }

            // 4. Stock Transfers (In & Out)
            try {
                const trRes = await pool.query(
                    `SELECT sti.quantity_sent, sti.quantity_received, st.id, st.transfer_date,
                            st.from_location, st.to_location, st.from_branch_id, st.to_branch_id
                     FROM stock_transfer_items sti
                     JOIN stock_transfers st ON st.id = sti.transfer_id
                     WHERE sti.product_barcode = $1 AND COALESCE(st.tenant_id, 1) = $2
                     ORDER BY st.transfer_date ASC`,
                    [barcode, tenantId]
                );
                for (const r of trRes.rows) {
                    const fromName = r.from_location || branchNameById.get(Number(r.from_branch_id)) || '';
                    const toName = r.to_location || branchNameById.get(Number(r.to_branch_id)) || '';
                    const qty = Math.abs(Number(r.quantity_received || r.quantity_sent || 0));
                    if (qty <= 0) continue;
                    if (!locationFilter || toName.toLowerCase() === locationFilter.toLowerCase()) {
                        transfersIn += qty;
                        events.push({
                            type: 'Stock Transfer (In)',
                            quantity_change: qty,
                            date: r.transfer_date,
                            reference_no: `TRF-${String(r.id).padStart(4, '0')}`,
                            party_info: `From ${fromName || 'Branch'} → ${toName || 'Branch'}`
                        });
                    }
                    if (!locationFilter || fromName.toLowerCase() === locationFilter.toLowerCase()) {
                        transfersOut += qty;
                        events.push({
                            type: 'Stock Transfer (Out)',
                            quantity_change: -qty,
                            date: r.transfer_date,
                            reference_no: `TRF-${String(r.id).padStart(4, '0')}`,
                            party_info: `From ${fromName || 'Branch'} → ${toName || 'Branch'}`
                        });
                    }
                }
            } catch (_) { /* ignore */ }
        }

        // Sort chronologically and compute running New Quantity
        events.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
        const netDelta = events.reduce((s, e) => s + Number(e.quantity_change || 0), 0);
        // Reconcile implied opening balance if currentStock differs from sum of logged events
        const impliedOpening = Number((currentStock - netDelta).toFixed(2));
        let running = impliedOpening > 0 ? impliedOpening : 0;
        if (impliedOpening > 0 && openingStock === 0) {
            openingStock = impliedOpening;
        }
        const history = events.map((ev) => {
            running = Number((running + Number(ev.quantity_change || 0)).toFixed(2));
            return { ...ev, new_quantity: running };
        }).reverse();

        res.json({
            product: {
                id: product.id,
                name: product.name,
                sku: barcode || String(product.id),
                unit: product.selling_unit || 'Pc(s)'
            },
            location: locationFilter || 'All Locations',
            quantities_in: {
                total_purchase: Number(totalPurchase.toFixed(2)),
                opening_stock: Number(openingStock.toFixed(2)),
                total_sell_return: Number(totalSellReturn.toFixed(2)),
                transfers_in: Number(transfersIn.toFixed(2))
            },
            quantities_out: {
                total_sold: Number(totalSold.toFixed(2)),
                total_stock_adjustment: Number(totalStockAdjustment.toFixed(2)),
                total_purchase_return: Number(totalPurchaseReturn.toFixed(2)),
                transfers_out: Number(transfersOut.toFixed(2))
            },
            current_stock: Number(currentStock.toFixed(2)),
            history
        });
    } catch (err) {
        console.error('GET /api/products/:id/stock-history error:', err);
        res.status(500).json({ message: 'Failed to load product stock history' });
    }
});

module.exports = router;

