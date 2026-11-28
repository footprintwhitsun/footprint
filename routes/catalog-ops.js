const express = require('express');
const router = express.Router();
const { pool, adminPool } = require('../db/pool');
const { authenticateToken, requireRole, requirePermission, MANAGER_ROLES } = require('../middleware/auth');
const { logActivity } = require('../services/audit');

let schemaReady = false;
async function ensurePhase4Schema() {
    if (schemaReady || !pool) return;
    const ddlPool = adminPool || pool;
    try {
        await ddlPool.query(`
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
                name VARCHAR(80) DEFAULT '',
                short_name VARCHAR(30) DEFAULT '',
                allow_decimal BOOLEAN DEFAULT FALSE,
                is_multiple BOOLEAN DEFAULT FALSE,
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

        // Ensure extended unit columns exist on legacy deployments
        for (const stmt of [
            `ALTER TABLE unit_conversions ADD COLUMN IF NOT EXISTS name VARCHAR(80) DEFAULT ''`,
            `ALTER TABLE unit_conversions ADD COLUMN IF NOT EXISTS short_name VARCHAR(30) DEFAULT ''`,
            `ALTER TABLE unit_conversions ADD COLUMN IF NOT EXISTS allow_decimal BOOLEAN DEFAULT FALSE`,
            `ALTER TABLE unit_conversions ADD COLUMN IF NOT EXISTS is_multiple BOOLEAN DEFAULT FALSE`
        ]) {
            try { await ddlPool.query(stmt); } catch (_) { }
        }

        // Seed common building-materials units & conversions
        const ucCount = await pool.query('SELECT COUNT(*)::int AS cnt FROM unit_conversions');
        if (ucCount.rows[0].cnt === 0) {
            await pool.query(`
                INSERT INTO unit_conversions (name, short_name, allow_decimal, is_multiple, base_unit, alt_unit, factor, notes) VALUES
                ('Piece', 'Pc(s)', FALSE, FALSE, 'Piece', 'Piece', 1, 'Standard single item unit'),
                ('Bag', 'Bag', FALSE, FALSE, 'Bag', 'Bag', 1, 'Standard bag unit'),
                ('Kilogram', 'kg', TRUE, FALSE, 'Kilogram', 'Kilogram', 1, 'Weight in kilograms (decimals allowed)'),
                ('Metre', 'm', TRUE, FALSE, 'Metre', 'Metre', 1, 'Length in metres (decimals allowed)'),
                ('Pallet', 'Plt', FALSE, TRUE, 'Bag', 'Pallet', 50, '1 pallet = 50 bags of cement'),
                ('Tonne', 't', TRUE, TRUE, 'Rod', 'Tonne', 80, '1 tonne = 80 rods of 12mm'),
                ('Bundle', 'Bdl', FALSE, TRUE, 'Piece', 'Bundle', 10, '1 bundle = 10 pieces'),
                ('Roll', 'Roll', TRUE, TRUE, 'Metre', 'Roll', 50, '1 roll = 50 metres')
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

// 1. Brands (with Supplier Purchase Evaluation & Date Filters)
router.get('/api/brands', authenticateToken, async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const startDate = req.query.startDate && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.startDate)) ? String(req.query.startDate) : null;
    const endDate = req.query.endDate && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.endDate)) ? String(req.query.endDate) : null;

    const poParams = [tenantId];
    let poDateCond = '';
    if (startDate) {
        poParams.push(startDate);
        poDateCond += ` AND po.created_at >= $${poParams.length}::date`;
    }
    if (endDate) {
        poParams.push(endDate);
        poDateCond += ` AND po.created_at < ($${poParams.length}::date + INTERVAL '1 day')`;
    }

    const [brandRows, prodBrandStats, purchaseStats] = await Promise.all([
        safeQuery(`SELECT id, name, logo_url, created_at FROM brands WHERE COALESCE(tenant_id, 1) = $1 ORDER BY name ASC`, [tenantId]),
        safeQuery(`
            SELECT LOWER(TRIM(COALESCE(p.brand, ''))) AS brand_key,
                   MAX(TRIM(COALESCE(p.brand, ''))) AS brand_name,
                   COUNT(p.barcode)::int AS product_count,
                   COALESCE(SUM(COALESCE(p.stock, 0)), 0) AS total_stock,
                   COALESCE(SUM(COALESCE(p.stock, 0) * COALESCE(p.cost_price, 0)), 0) AS stock_value
            FROM products p
            WHERE COALESCE(p.tenant_id, 1) = $1
              AND COALESCE(p.is_deleted, FALSE) = FALSE
              AND TRIM(COALESCE(p.brand, '')) <> ''
            GROUP BY LOWER(TRIM(COALESCE(p.brand, '')))
        `, [tenantId]),
        safeQuery(`
            SELECT LOWER(TRIM(COALESCE(p.brand, ''))) AS brand_key,
                   COUNT(DISTINCT po.id)::int AS po_count,
                   COALESCE(SUM(COALESCE(poi.quantity, 0)), 0) AS purchased_qty,
                   COALESCE(SUM(COALESCE(poi.quantity, 0) * COALESCE(poi.unit_cost, 0)), 0) AS purchase_spend,
                   COUNT(DISTINCT po.supplier_id)::int AS supplier_count,
                   STRING_AGG(DISTINCT NULLIF(TRIM(COALESCE(s.name, '')), ''), ', ') AS suppliers,
                   MAX(po.created_at) AS last_purchase_date
            FROM purchase_order_items poi
            JOIN purchase_orders po ON po.id = poi.po_id
            JOIN products p ON p.barcode = poi.product_barcode AND COALESCE(p.tenant_id, 1) = $1
            LEFT JOIN suppliers s ON s.id = po.supplier_id
            WHERE COALESCE(po.tenant_id, 1) = $1
              AND TRIM(COALESCE(p.brand, '')) <> ''
              ${poDateCond}
            GROUP BY LOWER(TRIM(COALESCE(p.brand, '')))
        `, poParams)
    ]);

    const prodMap = new Map(prodBrandStats.map(r => [r.brand_key, r]));
    const poMap = new Map(purchaseStats.map(r => [r.brand_key, r]));
    const mergedMap = new Map();

    for (const b of brandRows) {
        const key = String(b.name || '').trim().toLowerCase();
        if (!key) continue;
        const ps = prodMap.get(key) || {};
        const pur = poMap.get(key) || {};
        mergedMap.set(key, {
            id: b.id,
            name: b.name,
            logo_url: b.logo_url || '',
            created_at: b.created_at,
            product_count: Number(ps.product_count || 0),
            total_stock: Number(ps.total_stock || 0),
            stock_value: Number(ps.stock_value || 0),
            po_count: Number(pur.po_count || 0),
            purchased_qty: Number(pur.purchased_qty || 0),
            purchase_spend: Number(pur.purchase_spend || 0),
            supplier_count: Number(pur.supplier_count || 0),
            suppliers: pur.suppliers || '',
            last_purchase_date: pur.last_purchase_date || null
        });
    }

    // Include brands found on products that haven't been added to the brands table yet
    for (const ps of prodBrandStats) {
        if (!ps.brand_key || mergedMap.has(ps.brand_key)) continue;
        const pur = poMap.get(ps.brand_key) || {};
        mergedMap.set(ps.brand_key, {
            id: null,
            name: ps.brand_name,
            logo_url: '',
            created_at: null,
            product_count: Number(ps.product_count || 0),
            total_stock: Number(ps.total_stock || 0),
            stock_value: Number(ps.stock_value || 0),
            po_count: Number(pur.po_count || 0),
            purchased_qty: Number(pur.purchased_qty || 0),
            purchase_spend: Number(pur.purchase_spend || 0),
            supplier_count: Number(pur.supplier_count || 0),
            suppliers: pur.suppliers || '',
            last_purchase_date: pur.last_purchase_date || null
        });
    }

    const brands = Array.from(mergedMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    const prodBrands = prodBrandStats.map(r => ({ name: r.brand_name }));
    res.json({ brands, product_brands: prodBrands, startDate, endDate });
});

router.get('/api/brands/:brandName/purchases', authenticateToken, async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const brandName = decodeURIComponent(String(req.params.brandName || '')).trim();
    if (!brandName) return res.status(400).json({ message: 'Brand name is required' });

    const startDate = req.query.startDate && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.startDate)) ? String(req.query.startDate) : null;
    const endDate = req.query.endDate && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.endDate)) ? String(req.query.endDate) : null;

    const poParams = [tenantId, brandName];
    let poDateCond = '';
    if (startDate) {
        poParams.push(startDate);
        poDateCond += ` AND po.created_at >= $${poParams.length}::date`;
    }
    if (endDate) {
        poParams.push(endDate);
        poDateCond += ` AND po.created_at < ($${poParams.length}::date + INTERVAL '1 day')`;
    }

    const [products, purchases, suppliers] = await Promise.all([
        safeQuery(`
            SELECT p.barcode, p.name, p.category, COALESCE(p.stock, 0) AS stock,
                   COALESCE(p.cost_price, 0) AS cost_price, COALESCE(p.price, 0) AS price,
                   COALESCE(p.stock, 0) * COALESCE(p.cost_price, 0) AS stock_value
            FROM products p
            WHERE COALESCE(p.tenant_id, 1) = $1
              AND COALESCE(p.is_deleted, FALSE) = FALSE
              AND LOWER(TRIM(COALESCE(p.brand, ''))) = LOWER(TRIM($2))
            ORDER BY p.name ASC
        `, [tenantId, brandName]),
        safeQuery(`
            SELECT po.id AS po_id,
                   ('PO-' || po.id) AS po_number,
                   po.created_at AS po_date,
                   COALESCE(po.status, 'Pending') AS status,
                   po.supplier_id,
                   COALESCE(s.name, 'Unknown Supplier') AS supplier_name,
                   poi.product_barcode,
                   p.name AS product_name,
                   COALESCE(poi.quantity, 0) AS quantity,
                   COALESCE(poi.unit_cost, 0) AS unit_cost,
                   (COALESCE(poi.quantity, 0) * COALESCE(poi.unit_cost, 0)) AS line_total
            FROM purchase_order_items poi
            JOIN purchase_orders po ON po.id = poi.po_id
            JOIN products p ON p.barcode = poi.product_barcode AND COALESCE(p.tenant_id, 1) = $1
            LEFT JOIN suppliers s ON s.id = po.supplier_id
            WHERE COALESCE(po.tenant_id, 1) = $1
              AND LOWER(TRIM(COALESCE(p.brand, ''))) = LOWER(TRIM($2))
              ${poDateCond}
            ORDER BY po.created_at DESC, po.id DESC
            LIMIT 500
        `, poParams),
        safeQuery(`
            SELECT po.supplier_id,
                   COALESCE(s.name, 'Unknown Supplier') AS supplier_name,
                   COUNT(DISTINCT po.id)::int AS po_count,
                   COALESCE(SUM(COALESCE(poi.quantity, 0)), 0) AS purchased_qty,
                   COALESCE(SUM(COALESCE(poi.quantity, 0) * COALESCE(poi.unit_cost, 0)), 0) AS total_spend,
                   MAX(po.created_at) AS last_purchase_date
            FROM purchase_order_items poi
            JOIN purchase_orders po ON po.id = poi.po_id
            JOIN products p ON p.barcode = poi.product_barcode AND COALESCE(p.tenant_id, 1) = $1
            LEFT JOIN suppliers s ON s.id = po.supplier_id
            WHERE COALESCE(po.tenant_id, 1) = $1
              AND LOWER(TRIM(COALESCE(p.brand, ''))) = LOWER(TRIM($2))
              ${poDateCond}
            GROUP BY po.supplier_id, s.name
            ORDER BY total_spend DESC
        `, poParams)
    ]);

    const totalStock = products.reduce((s, p) => s + Number(p.stock || 0), 0);
    const stockValue = products.reduce((s, p) => s + Number(p.stock_value || 0), 0);
    const purchasedQty = purchases.reduce((s, p) => s + Number(p.quantity || 0), 0);
    const purchaseSpend = purchases.reduce((s, p) => s + Number(p.line_total || 0), 0);
    const poIds = new Set(purchases.map(p => p.po_id));

    res.json({
        brand: brandName,
        startDate,
        endDate,
        summary: {
            product_count: products.length,
            total_stock: totalStock,
            stock_value: stockValue,
            po_count: poIds.size,
            purchased_qty: purchasedQty,
            purchase_spend: purchaseSpend,
            supplier_count: suppliers.length
        },
        suppliers,
        purchases,
        products
    });
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

// 2. Units & Unit Conversions
function normalizeUnitRow(u) {
    const name = (u.name && String(u.name).trim()) || String(u.alt_unit || u.base_unit || '').trim();
    const shortName = (u.short_name && String(u.short_name).trim()) || name;
    const factor = Number(u.factor || 1);
    const baseUnit = String(u.base_unit || name).trim();
    const altUnit = String(u.alt_unit || name).trim();
    const inferredMultiple = factor !== 1 || (baseUnit.toLowerCase() !== altUnit.toLowerCase());
    const isMultiple = typeof u.is_multiple === 'boolean' ? (u.is_multiple || inferredMultiple) : inferredMultiple;
    return {
        ...u,
        name,
        short_name: shortName,
        allow_decimal: Boolean(u.allow_decimal),
        is_multiple: isMultiple,
        base_unit: baseUnit,
        alt_unit: altUnit,
        factor
    };
}

router.get('/api/units', authenticateToken, async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const raw = await safeQuery('SELECT * FROM unit_conversions WHERE COALESCE(tenant_id, 1) = $1 ORDER BY id ASC', [tenantId]);
    const units = raw.map(normalizeUnitRow);
    res.json({ units });
});

router.post('/api/units', authenticateToken, requireRole(MANAGER_ROLES), requirePermission('products', 'edit'), async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const body = req.body || {};
    const rawName = String(body.name || body.alt_unit || '').trim();
    const rawShort = String(body.short_name || rawName).trim();
    const allowDecimal = body.allow_decimal === true || body.allow_decimal === 'true' || body.allow_decimal === 'yes' || body.allow_decimal === 1 || body.allow_decimal === '1';
    const isConversionPayload = !body.name && body.base_unit && body.alt_unit;
    const isMultiple = isConversionPayload || body.is_multiple === true || body.is_multiple === 'true' || body.is_multiple === 1;
    const baseUnit = isMultiple ? String(body.base_unit || '').trim() : rawName;
    const altUnit = String(body.alt_unit || rawName).trim();
    const factor = isMultiple ? Number(body.factor) : 1;
    const notes = String(body.notes || '').trim();

    if (!rawName) return res.status(400).json({ message: 'Unit name is required' });
    if (!rawShort) return res.status(400).json({ message: 'Short name is required' });
    if (isMultiple && (!baseUnit || !Number.isFinite(factor) || factor <= 0)) {
        return res.status(400).json({ message: 'Base unit and a positive conversion factor are required' });
    }

    try {
        const r = await pool.query(
            `INSERT INTO unit_conversions (tenant_id, name, short_name, allow_decimal, is_multiple, base_unit, alt_unit, factor, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [tenantId, rawName, rawShort, allowDecimal, isMultiple, baseUnit, altUnit, factor, notes]
        );
        return res.status(201).json({ success: true, unit: normalizeUnitRow(r.rows[0]) });
    } catch (err) {
        // Fallback if live DB lacks extended columns on restricted role
        const r = await pool.query(
            `INSERT INTO unit_conversions (tenant_id, base_unit, alt_unit, factor, notes) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [tenantId, baseUnit, altUnit, factor, notes]
        );
        return res.status(201).json({ success: true, unit: normalizeUnitRow({ ...r.rows[0], name: rawName, short_name: rawShort, allow_decimal: allowDecimal, is_multiple: isMultiple }) });
    }
});

router.put('/api/units/:id', authenticateToken, requireRole(MANAGER_ROLES), requirePermission('products', 'edit'), async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid unit ID' });

    const body = req.body || {};
    const rawName = String(body.name || body.alt_unit || '').trim();
    const rawShort = String(body.short_name || rawName).trim();
    const allowDecimal = body.allow_decimal === true || body.allow_decimal === 'true' || body.allow_decimal === 'yes' || body.allow_decimal === 1 || body.allow_decimal === '1';
    const isMultiple = body.is_multiple === true || body.is_multiple === 'true' || body.is_multiple === 1;
    const baseUnit = isMultiple ? String(body.base_unit || '').trim() : rawName;
    const altUnit = String(body.alt_unit || rawName).trim();
    const factor = isMultiple ? Number(body.factor) : 1;
    const notes = String(body.notes || '').trim();

    if (!rawName) return res.status(400).json({ message: 'Unit name is required' });
    if (isMultiple && (!baseUnit || !Number.isFinite(factor) || factor <= 0)) {
        return res.status(400).json({ message: 'Base unit and a positive conversion factor are required' });
    }

    try {
        const r = await pool.query(
            `UPDATE unit_conversions
             SET name = $1, short_name = $2, allow_decimal = $3, is_multiple = $4, base_unit = $5, alt_unit = $6, factor = $7, notes = $8
             WHERE id = $9 AND COALESCE(tenant_id, 1) = $10 RETURNING *`,
            [rawName, rawShort, allowDecimal, isMultiple, baseUnit, altUnit, factor, notes, id, tenantId]
        );
        if (!r.rows.length) return res.status(404).json({ message: 'Unit not found' });
        return res.json({ success: true, unit: normalizeUnitRow(r.rows[0]) });
    } catch (err) {
        const r = await pool.query(
            `UPDATE unit_conversions SET base_unit = $1, alt_unit = $2, factor = $3, notes = $4
             WHERE id = $5 AND COALESCE(tenant_id, 1) = $6 RETURNING *`,
            [baseUnit, altUnit, factor, notes, id, tenantId]
        );
        if (!r.rows.length) return res.status(404).json({ message: 'Unit not found' });
        return res.json({ success: true, unit: normalizeUnitRow({ ...r.rows[0], name: rawName, short_name: rawShort, allow_decimal: allowDecimal, is_multiple: isMultiple }) });
    }
});

router.delete('/api/units/:id', authenticateToken, requireRole(MANAGER_ROLES), requirePermission('products', 'edit'), async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid unit ID' });
    const r = await pool.query('DELETE FROM unit_conversions WHERE id = $1 AND COALESCE(tenant_id, 1) = $2 RETURNING id', [id, tenantId]);
    if (!r.rows.length) return res.status(404).json({ message: 'Unit not found' });
    res.json({ success: true });
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

// 5. Deliveries / Shipments
router.get('/api/deliveries', authenticateToken, async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const deliveries = await safeQuery('SELECT * FROM delivery_notes WHERE COALESCE(tenant_id, 1) = $1 ORDER BY created_at DESC LIMIT 150', [tenantId]);
    res.json({ deliveries });
});

router.post('/api/deliveries', authenticateToken, requirePermission('deliveries', 'create'), async (req, res) => {
    try {
        await ensurePhase4Schema();
        const tenantId = req.user.tenant_id || 1;
        const {
            customer_name = 'Walk-In Customer',
            receipt_number = '',
            site_address = '',
            driver_name = '',
            truck_number = '',
            delivery_fee = 0,
            status = 'Ordered',
            receiver_name = ''
        } = req.body;
        if (!String(site_address || '').trim()) {
            return res.status(400).json({ message: 'Shipping address is required' });
        }
        const allowed = ['Ordered', 'Packed', 'Loading', 'On the way', 'Shipped', 'Delivered', 'Cancelled'];
        const safeStatus = allowed.includes(status) ? status : 'Ordered';
        const dnNum = 'SHP-' + Date.now().toString().slice(-6) + '-' + Math.floor(100 + Math.random() * 900);
        const storeLoc = req.user.store_location || 'Main Shop';
        const r = await pool.query(
            `INSERT INTO delivery_notes (tenant_id, delivery_number, receipt_number, customer_name, site_address, truck_number, driver_name, delivery_fee, status, receiver_name, store_location)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
            [tenantId, dnNum, String(receipt_number || '').trim(), String(customer_name || 'Walk-In Customer').trim(), String(site_address).trim(), String(truck_number || '').trim(), String(driver_name || '').trim(), Math.max(0, Number(delivery_fee || 0)), safeStatus, String(receiver_name || '').trim(), storeLoc]
        );
        await logActivity(req, 'SHIPMENT_CREATED', { delivery_id: r.rows[0].id, delivery_number: dnNum, customer_name, site_address, status: safeStatus });
        res.status(201).json({ success: true, delivery: r.rows[0] });
    } catch (err) {
        console.error('POST /api/deliveries error:', err);
        res.status(500).json({ message: 'Failed to record shipment' });
    }
});

router.patch('/api/deliveries/:id/status', authenticateToken, requirePermission('deliveries', 'edit'), async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const { status, receiver_name = '', signature_data = '' } = req.body;
    const allowed = ['Ordered', 'Packed', 'Loading', 'On the way', 'Shipped', 'Delivered', 'Cancelled'];
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
    const { name, values_text = '', values } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ message: 'Variation name is required' });
    const normalizedValues = Array.isArray(values)
        ? values.map((v) => String(v || '').trim()).filter(Boolean).join(', ')
        : String(values_text || '').split(',').map((v) => v.trim()).filter(Boolean).join(', ');
    if (!normalizedValues) return res.status(400).json({ message: 'At least one variation value is required' });
    try {
        const r = await pool.query(
            'INSERT INTO product_variations (tenant_id, name, values_text) VALUES ($1, $2, $3) RETURNING *',
            [tenantId, String(name).trim(), normalizedValues]
        );
        await logActivity(req, 'CREATE_VARIATION', { name: String(name).trim(), values: normalizedValues });
        res.status(201).json({ variation: r.rows[0] });
    } catch (e) {
        res.status(500).json({ message: 'Failed to save variation' });
    }
});

router.put('/api/variations/:id', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const { name, values_text = '', values } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ message: 'Variation name is required' });
    const normalizedValues = Array.isArray(values)
        ? values.map((v) => String(v || '').trim()).filter(Boolean).join(', ')
        : String(values_text || '').split(',').map((v) => v.trim()).filter(Boolean).join(', ');
    if (!normalizedValues) return res.status(400).json({ message: 'At least one variation value is required' });
    try {
        const r = await pool.query(
            'UPDATE product_variations SET name = $1, values_text = $2 WHERE id = $3 AND COALESCE(tenant_id, 1) = $4 RETURNING *',
            [String(name).trim(), normalizedValues, req.params.id, tenantId]
        );
        if (!r.rows.length) return res.status(404).json({ message: 'Variation not found' });
        await logActivity(req, 'UPDATE_VARIATION', { id: req.params.id, name: String(name).trim(), values: normalizedValues });
        res.json({ variation: r.rows[0] });
    } catch (e) {
        res.status(500).json({ message: 'Failed to update variation' });
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

router.put('/api/selling-price-groups/:id', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const { name, description = '', adjustment_pct = 0 } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ message: 'Price group name is required' });
    try {
        const r = await pool.query(
            'UPDATE selling_price_groups SET name = $1, description = $2, adjustment_pct = $3 WHERE id = $4 AND COALESCE(tenant_id, 1) = $5 RETURNING *',
            [String(name).trim(), String(description || '').trim(), Number(adjustment_pct || 0), req.params.id, tenantId]
        );
        if (!r.rows.length) return res.status(404).json({ message: 'Selling price group not found' });
        await logActivity(req, 'UPDATE_SELLING_PRICE_GROUP', { id: req.params.id, name: String(name).trim(), adjustment_pct: Number(adjustment_pct || 0) });
        res.json({ price_group: r.rows[0] });
    } catch (e) {
        res.status(500).json({ message: 'Failed to update selling price group' });
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

router.put('/api/warranties/:id', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid warranty ID' });
    const { name, duration = 12, duration_type = 'Months', description = '' } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ message: 'Warranty name is required' });
    const cleanName = String(name).trim();
    const dur = Math.max(1, parseInt(duration, 10) || 1);
    const unit = ['Days', 'Months', 'Years'].includes(duration_type) ? duration_type : 'Months';
    const cleanDesc = String(description || '').trim();
    try {
        const r = await pool.query(
            `UPDATE product_warranties
             SET name = $1, duration = $2, duration_type = $3, description = $4
             WHERE id = $5 AND COALESCE(tenant_id, 1) = $6 RETURNING *`,
            [cleanName, dur, unit, cleanDesc, id, tenantId]
        );
        if (!r.rows.length) return res.status(404).json({ message: 'Warranty not found' });
        // Keep product default warranty metadata in sync
        await pool.query(
            `UPDATE products
             SET warranty_name = $1, warranty_duration = $2, warranty_duration_type = $3
             WHERE warranty_id = $4 AND COALESCE(tenant_id, 1) = $5`,
            [cleanName, dur, unit, id, tenantId]
        ).catch(() => {});
        await logActivity(req, 'UPDATE_WARRANTY', { id, name: cleanName, duration: dur, duration_type: unit });
        res.json({ success: true, warranty: r.rows[0] });
    } catch (e) {
        res.status(500).json({ message: 'Failed to update warranty' });
    }
});

router.get('/api/warranties/report', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    await ensurePhase4Schema();
    const tenantId = req.user.tenant_id || 1;
    const startDate = req.query.startDate && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.startDate)) ? String(req.query.startDate) : null;
    const endDate = req.query.endDate && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.endDate)) ? String(req.query.endDate) : null;

    try {
        const txParams = [tenantId];
        let txDateCond = '';
        if (startDate) {
            txParams.push(startDate);
            txDateCond += ` AND created_at >= $${txParams.length}::date`;
        }
        if (endDate) {
            txParams.push(endDate);
            txDateCond += ` AND created_at < ($${txParams.length}::date + INTERVAL '1 day')`;
        }

        const [warranties, products, transactions] = await Promise.all([
            safeQuery('SELECT * FROM product_warranties WHERE COALESCE(tenant_id, 1) = $1 ORDER BY name ASC', [tenantId]),
            safeQuery(`SELECT id, barcode, name, warranty_id, warranty_name FROM products WHERE COALESCE(tenant_id, 1) = $1 AND deleted_at IS NULL`, [tenantId]),
            safeQuery(`
                SELECT id, receipt_number, created_at, customer_name, store_location, items
                FROM transactions
                WHERE COALESCE(tenant_id, 1) = $1
                  AND COALESCE(is_return, FALSE) = FALSE
                  AND COALESCE(status, '') <> 'deleted'
                  ${txDateCond}
                ORDER BY created_at DESC
                LIMIT 2000
            `, txParams)
        ]);

        const planById = new Map();
        const planByName = new Map();
        const planStats = warranties.map((w) => {
            const entry = {
                id: w.id,
                name: w.name,
                duration: Number(w.duration || 0),
                duration_type: w.duration_type || 'Months',
                duration_label: `${Number(w.duration || 0)} ${w.duration_type || 'Months'}`,
                description: w.description || '',
                created_at: w.created_at,
                products_assigned: 0,
                times_issued: 0,
                active_count: 0,
                expired_count: 0,
                usage_status: 'Unused'
            };
            planById.set(Number(w.id), entry);
            planByName.set(String(w.name || '').trim().toLowerCase(), entry);
            return entry;
        });

        let productsCovered = 0;
        for (const p of products) {
            const match = (p.warranty_id && planById.get(Number(p.warranty_id)))
                || (p.warranty_name && planByName.get(String(p.warranty_name).trim().toLowerCase()));
            if (match) {
                match.products_assigned++;
                productsCovered++;
            } else if (p.warranty_name) {
                productsCovered++;
            }
        }

        const now = Date.now();
        const issued = [];
        let activeIssued = 0;
        let expiringSoon = 0;
        let expiredIssued = 0;

        for (const tx of transactions) {
            let arr = tx.items;
            if (typeof arr === 'string') {
                try { arr = JSON.parse(arr); } catch (_) { arr = []; }
            }
            if (!Array.isArray(arr)) continue;
            for (const it of arr) {
                if (!it || (!it.warranty_name && !it.warranty_id && !it.warranty_expires_at)) continue;
                const expMs = it.warranty_expires_at ? new Date(it.warranty_expires_at).getTime() : null;
                const daysLeft = expMs && Number.isFinite(expMs) ? Math.ceil((expMs - now) / 86400000) : null;
                let status = 'Active';
                if (daysLeft !== null && daysLeft < 0) {
                    status = 'Expired';
                    expiredIssued++;
                } else if (daysLeft !== null && daysLeft <= 30) {
                    status = 'Expiring Soon';
                    activeIssued++;
                    expiringSoon++;
                } else {
                    activeIssued++;
                }

                const match = (it.warranty_id && planById.get(Number(it.warranty_id)))
                    || (it.warranty_name && planByName.get(String(it.warranty_name).trim().toLowerCase()));
                if (match) {
                    match.times_issued += Math.max(1, Number(it.qty || 1));
                    if (status === 'Expired') match.expired_count++;
                    else match.active_count++;
                }

                issued.push({
                    sale_date: tx.created_at,
                    receipt_number: tx.receipt_number || `RCP${String(tx.id).padStart(6, '0')}`,
                    customer_name: tx.customer_name || 'Walk-in Customer',
                    store_location: tx.store_location || 'Main',
                    product_name: it.name || 'Item',
                    product_barcode: it.barcode || '',
                    qty: Number(it.qty || 1),
                    warranty_name: it.warranty_name || (match ? match.name : 'Warranty'),
                    serial_no: it.serial_no || '',
                    expires_at: it.warranty_expires_at || null,
                    days_left: daysLeft,
                    status
                });
            }
        }

        let usedWarranties = 0;
        for (const pl of planStats) {
            if (pl.products_assigned > 0 || pl.times_issued > 0) {
                pl.usage_status = 'Used';
                usedWarranties++;
            } else {
                pl.usage_status = 'Unused';
            }
        }

        res.json({
            summary: {
                total_defined: planStats.length,
                used_warranties: usedWarranties,
                unused_warranties: planStats.length - usedWarranties,
                products_covered: productsCovered,
                total_issued: issued.length,
                active_issued: activeIssued,
                expiring_soon: expiringSoon,
                expired_issued: expiredIssued
            },
            plans: planStats,
            issued
        });
    } catch (e) {
        console.error('Warranty report error:', e);
        res.status(500).json({ message: 'Failed to load warranty report' });
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

// --- PURCHASE RETURNS ---
router.get('/api/purchase-returns', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    const tenantId = req.user.tenant_id || 1;
    try {
        const r = await pool.query(`
            SELECT sa.id,
                   ('PR-' || LPAD(sa.id::text, 5, '0')) AS return_ref,
                   sa.product_barcode,
                   COALESCE(p.name, sa.product_barcode) AS product_name,
                   ABS(COALESCE(sa.quantity_adjusted, 0)) AS quantity,
                   COALESCE(p.cost_price, 0) AS unit_cost,
                   (ABS(COALESCE(sa.quantity_adjusted, 0)) * COALESCE(p.cost_price, 0)) AS return_total,
                   COALESCE(sa.reason, '') AS reason,
                   COALESCE(b.name, 'Main') AS branch_name,
                   COALESCE(u.name, u.username, 'Manager') AS recorded_by,
                   COALESCE(sa.approved_at, sa.created_at) AS created_at
            FROM stock_adjustments sa
            LEFT JOIN products p ON p.barcode = sa.product_barcode AND COALESCE(p.tenant_id, 1) = $1
            LEFT JOIN branches b ON b.id = sa.branch_id
            LEFT JOIN users u ON u.id = sa.approver_id
            WHERE COALESCE(sa.tenant_id, 1) = $1
              AND sa.adjustment_type = 'Purchase Return'
            ORDER BY COALESCE(sa.approved_at, sa.created_at) DESC, sa.id DESC
            LIMIT 500
        `, [tenantId]);
        res.json({ returns: r.rows });
    } catch (e) {
        console.error('GET /api/purchase-returns error:', e);
        res.status(500).json({ message: 'Failed to load purchase returns' });
    }
});

router.post('/api/purchase-returns', authenticateToken, requireRole(MANAGER_ROLES), requirePermission('stock', 'create'), async (req, res) => {
    const tenantId = req.user.tenant_id || 1;
    const { product_barcode, supplier_name = '', quantity, unit_cost = 0, reason = '' } = req.body || {};
    const qty = Number(quantity || 0);
    if (!product_barcode || !Number.isFinite(qty) || qty <= 0) {
        return res.status(400).json({ message: 'Product and a positive return quantity are required' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const pRes = await client.query(
            'SELECT id, name, barcode, stock, cost_price, stock_levels FROM products WHERE barcode = $1 AND COALESCE(tenant_id, 1) = $2 FOR UPDATE',
            [String(product_barcode).trim(), tenantId]
        );
        if (!pRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Product not found' });
        }
        const prod = pRes.rows[0];
        const branchId = req.user.store_id || null;
        const brRes = branchId
            ? await client.query('SELECT name FROM branches WHERE id = $1 AND COALESCE(tenant_id, 1) = $2 LIMIT 1', [branchId, tenantId])
            : await client.query('SELECT id, name FROM branches WHERE COALESCE(tenant_id, 1) = $1 ORDER BY is_main DESC NULLS LAST, id ASC LIMIT 1', [tenantId]);
        const branchName = (brRes.rows[0] && brRes.rows[0].name) || req.user.store_location || 'Main';
        const effBranchId = branchId || (brRes.rows[0] && brRes.rows[0].id) || null;

        const levels = (prod.stock_levels && typeof prod.stock_levels === 'object') ? prod.stock_levels : {};
        const prevBranchQty = Object.prototype.hasOwnProperty.call(levels, branchName) ? Number(levels[branchName] || 0) : Number(prod.stock || 0);
        const newBranchQty = Math.max(0, Number((prevBranchQty - qty).toFixed(3)));
        const newTotalStock = Math.max(0, Number((Number(prod.stock || 0) - qty).toFixed(3)));

        await client.query(
            `UPDATE products
             SET stock = $1::numeric,
                 stock_levels = jsonb_set(COALESCE(stock_levels, '{}'::jsonb), ARRAY[$2::text], to_jsonb($3::numeric))
             WHERE id = $4 AND COALESCE(tenant_id, 1) = $5`,
            [newTotalStock, branchName, newBranchQty, prod.id, tenantId]
        );

        const fullReason = [supplier_name ? `Supplier: ${String(supplier_name).trim()}` : '', String(reason || '').trim()].filter(Boolean).join(' · ') || 'Returned to supplier';
        const ins = await client.query(
            `INSERT INTO stock_adjustments (tenant_id, product_barcode, adjustment_type, quantity_adjusted, reason, approver_id, branch_id, approved_at)
             VALUES ($1, $2, 'Purchase Return', $3, $4, $5, $6, CURRENT_TIMESTAMP) RETURNING id`,
            [tenantId, prod.barcode, -qty, fullReason, req.user.id || null, effBranchId]
        );
        await client.query('COMMIT');

        const cost = Number(unit_cost || prod.cost_price || 0);
        await logActivity(req, 'PURCHASE_RETURN', {
            return_ref: `PR-${String(ins.rows[0].id).padStart(5, '0')}`,
            supplier_name: String(supplier_name || '').trim(),
            product: prod.name,
            sku: prod.barcode,
            branch: branchName,
            previousQty: prevBranchQty,
            newQty: newBranchQty,
            change: `-${qty}`,
            total: Number((qty * cost).toFixed(2)),
            reason: fullReason,
            items: [{ name: prod.name, barcode: prod.barcode, old_qty: prevBranchQty, new_qty: newBranchQty, variance: -qty, qty, price: cost, line_total: Number((qty * cost).toFixed(2)) }]
        });
        res.status(201).json({ success: true, id: ins.rows[0].id });
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('POST /api/purchase-returns error:', e);
        res.status(500).json({ message: 'Failed to record purchase return' });
    } finally {
        client.release();
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

