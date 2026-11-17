const express = require('express');
const router = express.Router();
const { safeQuery, withWarnings, warnings } = require('../services/safe-query');
router.use(withWarnings);
const { pool } = require('../db/pool');
const { authenticateToken, MANAGER_ROLES } = require('../middleware/auth');


router.get('/api/reports/core', authenticateToken, async (req, res) => {
    const role = (req.user.role || '').toLowerCase();
    if (!MANAGER_ROLES.includes(role)) {
        return res.status(403).json({ message: 'Manager or CEO access required' });
    }

    try {
        const tenantId = req.user.tenant_id || 1;
        const today = new Date().toISOString().slice(0, 10);
        const from = req.query.from || today.slice(0, 8) + '01';
        const to = req.query.to || today;
        const branch = req.query.branch || '';
        const brandFilter = (req.query.brand || '').trim().toLowerCase();
        const catFilter = (req.query.category || '').trim().toLowerCase();
        const itemSearch = (req.query.item || '').trim().toLowerCase();
        const methodFilter = (req.query.payment_method || '').trim().toLowerCase();

        const fromTs = `${from} 00:00:00`;
        const toTs = `${to} 23:59:59.999`;

        // Previous period for comparison
        const diffDays = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);
        const prevFrom = new Date(new Date(from).getTime() - diffDays * 86400000).toISOString().slice(0, 10) + ' 00:00:00';
        const prevTo = new Date(new Date(from).getTime() - 86400000).toISOString().slice(0, 10) + ' 23:59:59.999';

        const [products, txns, prevTxns, customers] = await Promise.all([
            safeQuery(`SELECT barcode, name, COALESCE(brand,'Unbranded') AS brand, COALESCE(category,'General') AS category,
                              COALESCE(selling_unit,'Unit') AS unit, COALESCE(price,0) AS price,
                              COALESCE(cost_price,0) AS cost_price, COALESCE(stock,0) AS stock,
                              COALESCE(stock_levels,'{}'::jsonb) AS stock_levels
                       FROM products WHERE COALESCE(tenant_id, 1) = $1 ORDER BY name ASC`, [tenantId]),
            safeQuery(`SELECT t.*,
                              CASE WHEN u.id IS NOT NULL THEN COALESCE(u.name, u.username, 'Staff') || ' (@' || COALESCE(u.username, SPLIT_PART(u.email, '@', 1)) || ' · ' || UPPER(COALESCE(u.role, 'staff')) || ')' ELSE NULL END AS teller_name,
                              u.username AS cashier_username, u.role AS cashier_role
                       FROM transactions t
                       LEFT JOIN users u ON t.user_id = u.id
                       WHERE COALESCE(t.tenant_id, 1) = $3 AND t.created_at >= $1 AND t.created_at <= $2 AND COALESCE(t.is_return, false) = false
                       ORDER BY t.created_at DESC`, [fromTs, toTs, tenantId]),
            safeQuery(`SELECT total_amount FROM transactions
                       WHERE COALESCE(tenant_id, 1) = $3 AND created_at >= $1 AND created_at <= $2 AND COALESCE(is_return, false) = false`, [prevFrom, prevTo, tenantId]),
            safeQuery(`SELECT id, name, phone, COALESCE(customer_type,'Walk-in') AS customer_type,
                              COALESCE(site_location,'') AS site_location,
                              COALESCE(credit_limit,0) AS credit_limit,
                              COALESCE(current_balance,0) AS current_balance
                       FROM customers WHERE COALESCE(tenant_id, 1) = $1 ORDER BY current_balance DESC`, [tenantId])
        ]);

        const prodMap = new Map(products.map(p => [p.barcode, p]));
        const itemsSoldRows = [];
        const brandAgg = new Map();
        const custAgg = new Map();

        let currentRevenue = 0;
        let currentProfit = 0;

        for (const tx of txns) {
            if (branch && String(tx.store_location || '').toLowerCase() !== branch.toLowerCase()) continue;
            const splits = Array.isArray(tx.payment_splits)
                ? tx.payment_splits
                : (typeof tx.payment_splits === 'string' && tx.payment_splits.trim() ? JSON.parse(tx.payment_splits) : []);
            if (methodFilter) {
                const matchTop = String(tx.payment_method || '').toLowerCase() === methodFilter;
                const matchSplit = splits.some(s => String(s.method || '').toLowerCase().includes(methodFilter));
                if (!matchTop && !matchSplit) continue;
            }

            const items = Array.isArray(tx.items) ? tx.items : (typeof tx.items === 'string' ? JSON.parse(tx.items || '[]') : []);
            const day = new Date(tx.created_at).toISOString().slice(0, 10);
            let txMatchedItems = 0;

            for (const it of items) {
                const prod = prodMap.get(it.barcode) || {};
                const brand = prod.brand || 'Unbranded';
                const category = prod.category || 'General';
                const name = it.name || prod.name || it.barcode || 'Item';

                if (brandFilter && brand.toLowerCase() !== brandFilter) continue;
                if (catFilter && category.toLowerCase() !== catFilter) continue;
                if (itemSearch && !name.toLowerCase().includes(itemSearch)) continue;

                const qty = Number(it.qty || 0);
                const rev = Number(it.price || 0) * qty;
                const cost = Number(prod.cost_price || 0) * qty * Number(it.unit_factor || 1);
                const profit = rev - cost;

                txMatchedItems++;
                currentRevenue += rev;
                currentProfit += profit;

                itemsSoldRows.push({
                    receipt_number: tx.receipt_number,
                    day,
                    branch: tx.store_location || 'Main Shop',
                    teller: tx.teller_name || 'Teller',
                    customer: tx.customer_name || 'Walk-in',
                    payment_method: tx.payment_method || 'cash',
                    brand,
                    category,
                    barcode: it.barcode || '',
                    item: name,
                    unit: it.unit_name || prod.unit || 'Unit',
                    qty,
                    revenue: Number(rev.toFixed(2)),
                    cost: Number(cost.toFixed(2)),
                    profit: Number(profit.toFixed(2))
                });

                const b = brandAgg.get(brand) || { brand, qty: 0, revenue: 0, cost: 0, profit: 0 };
                b.qty += qty; b.revenue += rev; b.cost += cost; b.profit += profit;
                brandAgg.set(brand, b);

                if (tx.customer_id) {
                    const ck = String(tx.customer_id);
                    const c = custAgg.get(ck) || { customer: tx.customer_name || `Customer #${ck}`, visits: new Set(), revenue: 0, profit: 0, brands: new Map() };
                    c.visits.add(tx.id);
                    c.revenue += rev;
                    c.profit += profit;
                    c.brands.set(brand, (c.brands.get(brand) || 0) + rev);
                    custAgg.set(ck, c);
                }
            }
            if (txMatchedItems > 0 && !brandFilter && !catFilter && !itemSearch) {
                const wholeDisc = Number(tx.discount_amount || 0);
                currentRevenue -= wholeDisc;
                currentProfit -= wholeDisc;
            }
        }

        const salesByBrand = Array.from(brandAgg.values()).map(b => ({
            ...b,
            revenue: Number(b.revenue.toFixed(2)),
            cost: Number(b.cost.toFixed(2)),
            profit: Number(b.profit.toFixed(2)),
            margin_pct: b.revenue > 0 ? Number(((b.profit / b.revenue) * 100).toFixed(1)) : 0
        })).sort((a, b) => b.revenue - a.revenue);

        const topCustomers = Array.from(custAgg.values()).map(c => {
            const favBrand = Array.from(c.brands.entries()).sort((a, b) => b[1] - a[1])[0];
            return {
                customer: c.customer,
                visits: c.visits.size,
                revenue: Number(c.revenue.toFixed(2)),
                profit: Number(c.profit.toFixed(2)),
                favourite_brand: favBrand ? favBrand[0] : '—'
            };
        }).sort((a, b) => b.revenue - a.revenue);

        // Customers Owing with 0-30, 31-60, 61-90, 90+ aging.
        // Payments clear the oldest debt first, so the customer's current balance is allocated to the
        // newest credit sales; the buckets always add up to the balance. Any balance older than the
        // recorded credit sales (e.g. an opening balance) goes into 90+.
        const owingTxns = await safeQuery(
            `SELECT customer_id, balance_due, total_amount, payment_method, payment_splits, created_at
             FROM transactions
             WHERE customer_id IS NOT NULL AND COALESCE(is_return, false) = false
               AND (COALESCE(balance_due, 0) > 0 OR LOWER(payment_method) IN ('credit', 'customer_credit', 'split'))
             ORDER BY created_at DESC`
        );
        const debtOf = (t) => {
            const splits = Array.isArray(t.payment_splits)
                ? t.payment_splits
                : (typeof t.payment_splits === 'string' && t.payment_splits.trim() ? JSON.parse(t.payment_splits) : []);
            const creditSplit = splits
                .filter(s => ['credit', 'customer_credit'].includes(String(s.method || '').toLowerCase()))
                .reduce((s, p) => s + Number(p.amount || 0), 0);
            let debt = Number(t.balance_due || 0) + creditSplit;
            if (debt <= 0 && !splits.length && String(t.payment_method || '').toLowerCase() === 'credit') {
                debt = Number(t.total_amount || 0);
            }
            return debt;
        };
        const nowMs = Date.now();
        const customersOwing = customers
            .filter(c => Number(c.current_balance || 0) > 0)
            .map(c => {
                const buckets = [0, 0, 0, 0];
                let remaining = Number(c.current_balance || 0);
                for (const t of owingTxns) { // newest first
                    if (remaining <= 0.005) break;
                    if (t.customer_id !== c.id) continue;
                    const debt = debtOf(t);
                    if (debt <= 0) continue;
                    const take = Math.min(remaining, debt);
                    const ageDays = Math.floor((nowMs - new Date(t.created_at).getTime()) / 86400000);
                    const idx = ageDays <= 30 ? 0 : ageDays <= 60 ? 1 : ageDays <= 90 ? 2 : 3;
                    buckets[idx] += take;
                    remaining -= take;
                }
                if (remaining > 0.005) buckets[3] += remaining;
                const [b0, b31, b61, b90] = buckets;
                return {
                    id: c.id,
                    name: c.name,
                    phone: c.phone || '',
                    customer_type: c.customer_type,
                    balance: Number(c.current_balance || 0),
                    days_0_30: Number(b0.toFixed(2)),
                    days_31_60: Number(b31.toFixed(2)),
                    days_61_90: Number(b61.toFixed(2)),
                    days_90_plus: Number(b90.toFixed(2))
                };
            });

        const stockOnHand = products.map(p => ({
            barcode: p.barcode,
            name: p.name,
            brand: p.brand,
            category: p.category,
            unit: p.unit,
            stock: Number(p.stock || 0),
            cost_price: Number(p.cost_price || 0),
            value_at_cost: Number((Number(p.stock || 0) * Number(p.cost_price || 0)).toFixed(2)),
            locations: Object.entries(p.stock_levels || {}).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'Main'
        }));

        const prevRevenue = prevTxns.reduce((s, t) => s + Number(t.total_amount || 0), 0);
        const pctChange = prevRevenue > 0 ? Number((((currentRevenue - prevRevenue) / prevRevenue) * 100).toFixed(1)) : null;

        res.json({
            warnings: warnings(),
            period: { from, to, prev_revenue: Number(prevRevenue.toFixed(2)), current_revenue: Number(currentRevenue.toFixed(2)), current_profit: Number(currentProfit.toFixed(2)), pct_change: pctChange },
            itemsSoldRows,
            salesByBrand,
            topCustomers,
            customersOwing,
            stockOnHand
        });
    } catch (err) {
        console.error('GET /api/reports/core error:', err);
        res.status(500).json({ message: 'Failed to load core reports' });
    }
});

// Saved filter sets ("views") for the drill-down reports. Per user, per tenant, stored in the database
// so they follow the person to any computer.
let savedViewsReady = false;
async function ensureSavedViewsTable() {
    if (savedViewsReady) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS saved_report_views (
            id SERIAL PRIMARY KEY,
            tenant_id INTEGER NOT NULL DEFAULT 1,
            user_id INTEGER NOT NULL,
            name VARCHAR(120) NOT NULL,
            filters JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_saved_report_views_owner ON saved_report_views (tenant_id, user_id);
    `);
    savedViewsReady = true;
}

function requireManager(req, res, next) {
    if (!MANAGER_ROLES.includes((req.user.role || '').toLowerCase())) {
        return res.status(403).json({ message: 'Manager or CEO access required' });
    }
    next();
}

router.get('/api/reports/saved-views', authenticateToken, requireManager, async (req, res) => {
    try {
        await ensureSavedViewsTable();
        const result = await pool.query(
            'SELECT id, name, filters FROM saved_report_views WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 100',
            [req.user.tenant_id || 1, req.user.id]
        );
        res.json({ views: result.rows });
    } catch (err) {
        console.error('GET /api/reports/saved-views error:', err);
        res.status(500).json({ message: 'Failed to load saved views' });
    }
});

router.post('/api/reports/saved-views', authenticateToken, requireManager, async (req, res) => {
    try {
        const name = String(req.body.name || '').trim().slice(0, 120);
        if (!name) return res.status(400).json({ message: 'Give the view a name.' });
        const f = req.body.filters && typeof req.body.filters === 'object' ? req.body.filters : {};
        const filters = {
            brand: String(f.brand || '').slice(0, 120),
            category: String(f.category || '').slice(0, 120),
            item: String(f.item || '').slice(0, 120),
            method: String(f.method || '').slice(0, 40)
        };
        await ensureSavedViewsTable();
        const result = await pool.query(
            'INSERT INTO saved_report_views (tenant_id, user_id, name, filters) VALUES ($1, $2, $3, $4) RETURNING id, name, filters',
            [req.user.tenant_id || 1, req.user.id, name, JSON.stringify(filters)]
        );
        res.status(201).json({ success: true, view: result.rows[0] });
    } catch (err) {
        console.error('POST /api/reports/saved-views error:', err);
        res.status(500).json({ message: 'Failed to save the view' });
    }
});

router.delete('/api/reports/saved-views/:id', authenticateToken, requireManager, async (req, res) => {
    try {
        await ensureSavedViewsTable();
        await pool.query(
            'DELETE FROM saved_report_views WHERE id = $1 AND tenant_id = $2 AND user_id = $3',
            [req.params.id, req.user.tenant_id || 1, req.user.id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('DELETE /api/reports/saved-views error:', err);
        res.status(500).json({ message: 'Failed to delete the view' });
    }
});

module.exports = router;

