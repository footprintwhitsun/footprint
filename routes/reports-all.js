const express = require('express');
const router = express.Router();
const { safeQuery, withWarnings, warnings } = require('../services/safe-query');
router.use(withWarnings);
const { pool } = require('../db/pool');
const { authenticateToken, MANAGER_ROLES } = require('../middleware/auth');


router.get('/api/reports/all', authenticateToken, async (req, res) => {
    if (!MANAGER_ROLES.includes((req.user.role || '').toLowerCase())) {
        return res.status(403).json({ message: 'Manager or CEO access required' });
    }
    try {
        const tenantId = req.user.tenant_id || 1;
        const today = new Date().toISOString().slice(0, 10);
        const from = req.query.from || today.slice(0, 8) + '01';
        const to = req.query.to || today;
        const branch = req.query.branch && req.query.branch !== 'All Branches' ? String(req.query.branch).trim() : null;
        const fromTs = `${from} 00:00:00`;
        const toTs = `${to} 23:59:59.999`;

        const branchClause = branch ? ` AND LOWER(COALESCE(store_location, '')) = LOWER($4)` : '';
        const branchParams = branch ? [fromTs, toTs, tenantId, branch] : [fromTs, toTs, tenantId];

        const [products, txns, quotes, deliveries, customers, suppliers, expenses, adjustments, taxes, locations, dailyCloses, poRows, poItems, supplierPays, custGroups, activityLogs, deletedTxns] = await Promise.all([
            safeQuery(`SELECT barcode, name, COALESCE(brand,'Unbranded') AS brand, COALESCE(category,'General') AS category,
                              COALESCE(price,0) AS price, COALESCE(cost_price,0) AS cost_price, COALESCE(stock,0) AS stock, COALESCE(reorder_level,10) AS reorder_level
                       FROM products WHERE COALESCE(tenant_id, 1) = $1 AND deleted_at IS NULL`, [tenantId]),
            safeQuery(`SELECT t.*,
                              CASE WHEN u.id IS NOT NULL THEN COALESCE(u.name, u.username, 'Staff') || ' (@' || COALESCE(u.username, SPLIT_PART(u.email, '@', 1)) || ' · ' || UPPER(COALESCE(u.role, 'staff')) || ')' ELSE NULL END AS teller_name,
                              u.username AS cashier_username, u.role AS cashier_role
                       FROM transactions t LEFT JOIN users u ON t.user_id = u.id
                       WHERE COALESCE(t.tenant_id, 1) = $3 AND t.created_at >= $1 AND t.created_at <= $2${branch ? ` AND LOWER(COALESCE(t.store_location, '')) = LOWER($4)` : ''} ORDER BY t.created_at DESC`, branchParams),
            safeQuery(`SELECT * FROM pos_quotations WHERE COALESCE(tenant_id, 1) = $3 AND created_at >= $1 AND created_at <= $2${branchClause}`, branchParams),
            safeQuery(`SELECT * FROM delivery_notes WHERE COALESCE(tenant_id, 1) = $3 AND created_at >= $1 AND created_at <= $2${branchClause}`, branchParams),
            safeQuery(`SELECT id, name, phone, COALESCE(customer_type,'Walk-in') AS customer_type, COALESCE(current_balance,0) AS current_balance, created_at FROM customers WHERE COALESCE(tenant_id, 1) = $1`, [tenantId]),
            safeQuery(`SELECT id, name, 0::numeric AS balance_owed FROM suppliers WHERE COALESCE(tenant_id, 1) = $1 AND deleted_at IS NULL`, [tenantId]),
            safeQuery(`SELECT * FROM expenses WHERE COALESCE(tenant_id, 1) = $3 AND created_at >= $1 AND created_at <= $2${branchClause} ORDER BY created_at DESC`, branchParams),
            safeQuery(`SELECT * FROM stock_adjustments WHERE COALESCE(tenant_id, 1) = $3 AND created_at >= $1 AND created_at <= $2 ORDER BY created_at DESC`, [fromTs, toTs, tenantId]),
            safeQuery(`SELECT name, rate FROM tax_rules WHERE COALESCE(tenant_id, 1) = $1 AND deleted_at IS NULL AND LOWER(COALESCE(status, 'active')) = 'active'`, [tenantId]),
            safeQuery(`SELECT name FROM branches WHERE COALESCE(tenant_id, 1) = $1 AND deleted_at IS NULL ORDER BY name ASC`, [tenantId]),
            safeQuery(`SELECT * FROM daily_closes WHERE COALESCE(tenant_id, 1) = $1 AND close_date >= $2::date AND close_date <= $3::date ORDER BY close_date DESC, created_at DESC`, [tenantId, from, to]),
            safeQuery(`SELECT po.*, s.name AS supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE COALESCE(po.tenant_id, 1) = $1 AND po.created_at >= $2 AND po.created_at <= $3 ORDER BY po.created_at DESC`, [tenantId, fromTs, toTs]),
            safeQuery(`SELECT poi.*, po.created_at, po.status AS po_status, s.name AS supplier_name, p.name AS product_name
                       FROM purchase_order_items poi
                       JOIN purchase_orders po ON po.id = poi.po_id
                       LEFT JOIN suppliers s ON s.id = po.supplier_id
                       LEFT JOIN products p ON p.barcode = poi.product_barcode AND COALESCE(p.tenant_id, 1) = $1
                       WHERE COALESCE(po.tenant_id, 1) = $1 AND po.created_at >= $2 AND po.created_at <= $3
                       ORDER BY po.created_at DESC`, [tenantId, fromTs, toTs]),
            safeQuery(`SELECT sp.*, s.name AS supplier_name FROM supplier_payments sp LEFT JOIN suppliers s ON s.id = sp.supplier_id WHERE COALESCE(sp.tenant_id, 1) = $1 AND sp.created_at >= $2 AND sp.created_at <= $3 ORDER BY sp.created_at DESC`, [tenantId, fromTs, toTs]),
            safeQuery(`SELECT * FROM customer_groups WHERE COALESCE(tenant_id, 1) = $1 ORDER BY id ASC`, [tenantId]),
            safeQuery(`SELECT a.*, COALESCE(u.name, u.username, 'Staff') AS user_name FROM activity_logs a LEFT JOIN users u ON u.id = a.user_id WHERE COALESCE(a.tenant_id, 1) = $1 AND a.created_at >= $2 AND a.created_at <= $3 ORDER BY a.created_at DESC LIMIT 200`, [tenantId, fromTs, toTs]),
            safeQuery(`SELECT t.id, t.receipt_number, COALESCE(t.customer_name, 'Walk-in') AS customer_name,
                              t.total_amount, t.status, COALESCE(t.store_location, '') AS store_location,
                              t.created_at, COALESCE(t.created_at) AS deleted_on,
                              CASE WHEN COALESCE(t.is_return, false) THEN 'Sell Return' ELSE 'Sell' END AS txn_type,
                              COALESCE(u.name, u.username, 'Staff') AS created_by_name,
                              COALESCE(ap.name, u.name, u.username, 'Manager') AS deleted_by_name
                       FROM transactions t
                       LEFT JOIN users u ON u.id = t.user_id
                       LEFT JOIN users ap ON ap.id = t.discount_approved_by
                       WHERE COALESCE(t.tenant_id, 1) = $1
                         AND LOWER(COALESCE(t.status,'')) IN ('deleted','voided','cancelled')
                         AND t.created_at >= $2 AND t.created_at <= $3
                       ORDER BY t.created_at DESC LIMIT 150`, [tenantId, fromTs, toTs])
        ]);

        const prodMap = new Map(products.map(p => [p.barcode, p]));
        const catMap = new Map();
        const dailyMap = new Map();
        const tellerMap = new Map();
        const methodDailyMap = new Map();
        const hourlyMap = new Map();
        const itemPerfMap = new Map();
        const lastSoldMap = new Map();

        let totalSales = 0;
        let totalCost = 0;

        for (const tx of txns) {
            const isRet = Boolean(tx.is_return);
            const amt = Number(tx.total_amount || 0);
            const disc = Number(tx.discount_amount || 0);
            const dt = new Date(tx.created_at);
            const day = dt.toISOString().slice(0, 10);
            const hr = `${String(dt.getHours()).padStart(2, '0')}:00`;
            const teller = tx.teller_name || 'Teller';

            // Teller summary
            const tel = tellerMap.get(teller) || { teller, sales: 0, receipts: 0, discounts: 0, voids: 0 };
            if (isRet) tel.voids += 1;
            else { tel.sales += amt; tel.receipts += 1; tel.discounts += disc; }
            tellerMap.set(teller, tel);

            if (isRet) continue;
            totalSales += amt;

            // Hourly
            const hRow = hourlyMap.get(hr) || { hour: hr, receipts: 0, sales: 0 };
            hRow.receipts += 1; hRow.sales += amt;
            hourlyMap.set(hr, hRow);

            // Payment Method per day (supports split payments)
            const pmKey = day;
            const pm = methodDailyMap.get(pmKey) || { day, cash: 0, momo: 0, card: 0, bank: 0, credit: 0 };
            const rawSplits = Array.isArray(tx.payment_splits)
                ? tx.payment_splits
                : (typeof tx.payment_splits === 'string' && tx.payment_splits.trim() ? JSON.parse(tx.payment_splits) : []);
            const splits = rawSplits.length ? rawSplits : [{ method: tx.payment_method || 'cash', amount: amt }];
            let changeLeft = Math.max(0, Number(tx.change_amount || 0));
            for (const sp of splits) {
                const m = String(sp.method || 'cash').toLowerCase();
                let spAmt = Number(sp.amount || 0);
                if (m.includes('momo')) pm.momo += spAmt;
                else if (m.includes('card')) pm.card += spAmt;
                else if (m.includes('bank') || m.includes('cheque')) pm.bank += spAmt;
                else if (m.includes('credit')) pm.credit += spAmt;
                else {
                    const deducted = Math.min(spAmt, changeLeft);
                    spAmt -= deducted;
                    changeLeft -= deducted;
                    pm.cash += spAmt;
                }
            }
            methodDailyMap.set(pmKey, pm);

            // Items
            const items = Array.isArray(tx.items) ? tx.items : (typeof tx.items === 'string' ? JSON.parse(tx.items || '[]') : []);
            let txCost = 0;
            for (const it of items) {
                const p = prodMap.get(it.barcode) || {};
                const cat = p.category || 'General';
                const qty = Number(it.qty || 0);
                const rev = Number(it.price || 0) * qty;
                const c = Number(p.cost_price || 0) * qty * Number(it.unit_factor || 1);
                txCost += c;

                const cRow = catMap.get(cat) || { category: cat, qty: 0, revenue: 0, cost: 0, profit: 0 };
                cRow.qty += qty; cRow.revenue += rev; cRow.cost += c; cRow.profit = cRow.revenue - cRow.cost;
                catMap.set(cat, cRow);

                const ip = itemPerfMap.get(it.barcode || it.name) || { name: it.name || p.name || it.barcode, brand: p.brand || 'Unbranded', qty: 0, revenue: 0, cost: 0 };
                ip.qty += qty; ip.revenue += rev; ip.cost += c;
                itemPerfMap.set(it.barcode || it.name, ip);

                if (it.barcode) lastSoldMap.set(it.barcode, dt.getTime());
            }
            totalCost += txCost;

            const dRow = dailyMap.get(day) || { day, sales: 0, profit: 0, receipts: 0 };
            dRow.sales += amt; dRow.profit += (amt - txCost); dRow.receipts += 1;
            dailyMap.set(day, dRow);
        }

        const totalExpenses = expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
        const grossProfit = totalSales - totalCost;
        const netProfit = grossProfit - totalExpenses;

        // Lapsed customers & slow movers (30/60/90 days)
        const nowMs = Date.now();
        const slowMovers = products.filter(p => {
            const last = lastSoldMap.get(p.barcode);
            return !last || (nowMs - last) > 30 * 86400000;
        }).map(p => ({
            ...p,
            stock_value: Number((Math.max(0, Number(p.stock || 0)) * Number(p.cost_price || 0)).toFixed(2))
        })).slice(0, 100);
        const slowMoverCapital = Number(slowMovers.reduce((s, p) => s + Number(p.stock_value || 0), 0).toFixed(2));

        const enrichedAdjustments = adjustments.map(a => {
            const prod = prodMap.get(a.product_barcode) || {};
            const qtyAdj = Number(a.quantity_adjusted ?? a.quantity_change ?? 0);
            const costPrice = Number(prod.cost_price || 0);
            return {
                ...a,
                product_name: prod.name || a.product_barcode || 'Unknown Item',
                qty_adjusted: qtyAdj,
                cost_price: costPrice,
                variance_value: Number((qtyAdj * costPrice).toFixed(2))
            };
        });

        const profitByItem = Array.from(itemPerfMap.values()).map(i => {
            const profit = i.revenue - i.cost;
            const margin = i.revenue > 0 ? (profit / i.revenue) * 100 : 0;
            return { ...i, profit: Number(profit.toFixed(2)), margin_pct: Number(margin.toFixed(1)) };
        }).sort((a, b) => a.margin_pct - b.margin_pct);

        const quoteStats = {
            total: quotes.length,
            converted: quotes.filter(q => q.status === 'converted').length,
            open: quotes.filter(q => q.status === 'open').length,
            conversion_rate: quotes.length ? Number(((quotes.filter(q => q.status === 'converted').length / quotes.length) * 100).toFixed(1)) : 0
        };

        // Tax Report from real recorded tax_breakdown
        const taxAgg = new Map();
        for (const tx of txns) {
            if (tx.is_return) continue;
            const tb = tx.tax_breakdown && typeof tx.tax_breakdown === 'object'
                ? tx.tax_breakdown
                : (typeof tx.tax_breakdown === 'string' && tx.tax_breakdown.trim() ? JSON.parse(tx.tax_breakdown) : null);
            if (tb && Object.keys(tb).length) {
                for (const [k, v] of Object.entries(tb)) {
                    const prev = taxAgg.get(k) || 0;
                    taxAgg.set(k, prev + Number(v || 0));
                }
            } else if (Number(tx.tax_amount || 0) > 0) {
                taxAgg.set('Tax', (taxAgg.get('Tax') || 0) + Number(tx.tax_amount || 0));
            }
        }
        const taxReport = taxAgg.size
            ? Array.from(taxAgg.entries()).map(([tax, collected]) => ({ tax, rate: null, collected: Number(collected.toFixed(2)) }))
            : [
                { tax: 'VAT', rate: 0, collected: 0 },
                { tax: 'NHIL', rate: 0, collected: 0 },
                { tax: 'GETFund', rate: 0, collected: 0 }
            ];

        // Build extended report datasets
        const totalPurchaseAmt = poRows.filter(p => !['cancelled','returned','return'].includes(String(p.status||'').toLowerCase())).reduce((s, p) => s + Number(p.total_amount || 0), 0);
        const totalPurchaseReturnAmt = poRows.filter(p => ['returned','return'].includes(String(p.status||'').toLowerCase())).reduce((s, p) => s + Number(p.total_amount || 0), 0);
        const totalPurchasePaid = supplierPays.reduce((s, p) => s + Number(p.amount || 0), 0);
        const totalSellReturnAmt = txns.filter(t => t.is_return).reduce((s, t) => s + Math.abs(Number(t.total_amount || 0)), 0);
        const totalSaleDueAmt = txns.filter(t => !t.is_return).reduce((s, t) => s + Math.max(0, Number(t.balance_due || 0)), 0);

        const purchaseSaleSummary = [
            { metric: 'Total Purchase', amount: Number(totalPurchaseAmt.toFixed(2)) },
            { metric: 'Purchase Including Return', amount: Number((totalPurchaseAmt - totalPurchaseReturnAmt).toFixed(2)) },
            { metric: 'Total Purchase Return', amount: Number(totalPurchaseReturnAmt.toFixed(2)) },
            { metric: 'Purchase Due', amount: Number(Math.max(0, totalPurchaseAmt - totalPurchasePaid).toFixed(2)) },
            { metric: 'Total Sale', amount: Number(totalSales.toFixed(2)) },
            { metric: 'Total Sell Return', amount: Number(totalSellReturnAmt.toFixed(2)) },
            { metric: 'Sale Due', amount: Number(totalSaleDueAmt.toFixed(2)) },
            { metric: 'Net (Sale - Purchase - Expense)', amount: Number((totalSales - totalSellReturnAmt - totalPurchaseAmt - totalExpenses).toFixed(2)) }
        ];

        const supplierCustomerReport = [
            ...suppliers.map(s => ({ contact: s.name, type: 'Supplier', total: Number(poRows.filter(p => p.supplier_id === s.id).reduce((sum, p) => sum + Number(p.total_amount || 0), 0).toFixed(2)), due: Number(s.balance_owed || 0) })),
            ...customers.map(c => ({ contact: c.name, type: 'Customer', total: Number(txns.filter(t => t.customer_id === c.id && !t.is_return).reduce((sum, t) => sum + Number(t.total_amount || 0), 0).toFixed(2)), due: Number(c.current_balance || 0) }))
        ];

        const customerGroupsReport = custGroups.map(g => {
            const groupCusts = customers.filter(c => String(c.customer_type || '').toLowerCase() === String(g.name || '').toLowerCase());
            const ids = new Set(groupCusts.map(c => c.id));
            const salesSum = txns.filter(t => !t.is_return && ids.has(t.customer_id)).reduce((s, t) => s + Number(t.total_amount || 0), 0);
            return { name: g.name, price_group: g.price_group, discount_pct: Number(g.discount_pct || 0), customers: groupCusts.length, total_sales: Number(salesSum.toFixed(2)) };
        });

        const stockReport = products.map(p => ({
            barcode: p.barcode, name: p.name, category: p.category, brand: p.brand,
            stock: Number(p.stock || 0), reorder_level: Number(p.reorder_level || 10),
            cost_price: Number(p.cost_price || 0), price: Number(p.price || 0),
            stock_value: Number((Math.max(0, Number(p.stock || 0)) * Number(p.cost_price || 0)).toFixed(2))
        }));

        const productPurchaseReport = poItems.map(it => ({
            date: new Date(it.created_at).toLocaleDateString(),
            po_number: 'PO-' + it.po_id,
            supplier: it.supplier_name || 'Supplier',
            barcode: it.product_barcode,
            name: it.product_name || it.product_barcode,
            qty: Number(it.quantity || 0),
            unit_cost: Number(it.unit_cost || 0),
            total: Number((Number(it.quantity || 0) * Number(it.unit_cost || 0)).toFixed(2))
        }));

        const productSellReport = [];
        const dailySalesByProductMap = new Map();
        const purchMap = new Map();
        for (const it of poItems) {
            const k = it.product_barcode;
            const prev = purchMap.get(k) || { qty: 0, val: 0 };
            prev.qty += Number(it.quantity || 0);
            prev.val += Number(it.quantity || 0) * Number(it.unit_cost || 0);
            purchMap.set(k, prev);
        }
        for (const tx of txns) {
            if (tx.is_return) continue;
            const day = new Date(tx.created_at).toISOString().slice(0, 10);
            const items = Array.isArray(tx.items) ? tx.items : (typeof tx.items === 'string' ? JSON.parse(tx.items || '[]') : []);
            for (const it of items) {
                const qty = Number(it.qty || 0);
                const price = Number(it.price || 0);
                const lineTotal = Number((qty * price).toFixed(2));
                productSellReport.push({
                    date: new Date(tx.created_at).toLocaleDateString(),
                    receipt: tx.receipt_number || ('#' + tx.id),
                    customer: tx.customer_name || 'Walk-in',
                    barcode: it.barcode || '',
                    name: it.name || it.barcode,
                    qty, unit_price: price, total: lineTotal
                });
                const dk = `${day}|${it.barcode || it.name}`;
                const dp = dailySalesByProductMap.get(dk) || { day, barcode: it.barcode || '', name: it.name || it.barcode, qty: 0, sales: 0 };
                dp.qty += qty; dp.sales = Number((dp.sales + lineTotal).toFixed(2));
                dailySalesByProductMap.set(dk, dp);
            }
        }

        const itemsReport = products.map(p => {
            const pInfo = purchMap.get(p.barcode) || { qty: 0, val: 0 };
            const sInfo = itemPerfMap.get(p.barcode) || { qty: 0, revenue: 0, cost: 0 };
            return {
                barcode: p.barcode, name: p.name, category: p.category,
                purchased_qty: pInfo.qty, sold_qty: sInfo.qty, stock: Number(p.stock || 0),
                revenue: Number(sInfo.revenue.toFixed(2)), cost: Number(sInfo.cost.toFixed(2))
            };
        });

        const purchaseSaleProduct = products.map(p => {
            const pInfo = purchMap.get(p.barcode) || { qty: 0, val: 0 };
            const sInfo = itemPerfMap.get(p.barcode) || { qty: 0, revenue: 0, cost: 0 };
            return {
                name: p.name, barcode: p.barcode,
                purchased_qty: pInfo.qty, purchased_value: Number(pInfo.val.toFixed(2)),
                sold_qty: sInfo.qty, sold_value: Number(sInfo.revenue.toFixed(2)),
                net_margin: Number((sInfo.revenue - sInfo.cost).toFixed(2))
            };
        }).filter(r => r.purchased_qty > 0 || r.sold_qty > 0);

        const sellPaymentReport = txns.filter(t => !t.is_return).map(t => ({
            date: new Date(t.created_at).toLocaleDateString(),
            receipt: t.receipt_number || ('#' + t.id),
            customer: t.customer_name || 'Walk-in',
            method: t.payment_method || 'cash',
            paid_amount: Number(t.paid_amount ?? t.total_amount ?? 0),
            balance_due: Number(t.balance_due || 0)
        }));

        const nowDate = Date.now();
        const paymentByAge = txns.filter(t => !t.is_return && Number(t.balance_due || 0) > 0).map(t => {
            const ageDays = Math.floor((nowDate - new Date(t.created_at).getTime()) / 86400000);
            const due = Number(t.balance_due || 0);
            return {
                customer: t.customer_name || 'Walk-in',
                receipt: t.receipt_number || ('#' + t.id),
                total_due: due,
                days_0_30: ageDays <= 30 ? due : 0,
                days_31_60: ageDays > 30 && ageDays <= 60 ? due : 0,
                days_61_90: ageDays > 60 && ageDays <= 90 ? due : 0,
                days_90_plus: ageDays > 90 ? due : 0
            };
        });

        res.json({
            warnings: warnings(),
            salesByCategory: Array.from(catMap.values()).sort((a, b) => b.revenue - a.revenue),
            dailySummary: Array.from(dailyMap.values()).map(d => ({ ...d, avg_sale: d.receipts ? Number((d.sales / d.receipts).toFixed(2)) : 0 })),
            salesByTeller: Array.from(tellerMap.values()),
            salesByPaymentMethod: Array.from(methodDailyMap.values()),
            hourlySales: Array.from(hourlyMap.values()).sort((a, b) => a.hour.localeCompare(b.hour)),
            quotations: { stats: quoteStats, rows: quotes },
            deliveries,
            fastMovers: [...profitByItem].sort((a, b) => b.qty - a.qty).slice(0, 50),
            slowMovers,
            slowMoverCapital,
            profitAndLoss: {
                sales: Number(totalSales.toFixed(2)),
                cost_of_goods: Number(totalCost.toFixed(2)),
                gross_profit: Number(grossProfit.toFixed(2)),
                expenses: Number(totalExpenses.toFixed(2)),
                net_profit: Number(netProfit.toFixed(2))
            },
            profitByItem,
            purchasesBySupplier: suppliers,
            taxReport,
            stockAdjustments: enrichedAdjustments,
            stockVariance: enrichedAdjustments,
            zReport: dailyCloses,
            purchaseSaleSummary,
            supplierCustomerReport,
            customerGroupsReport,
            stockReport,
            itemsReport,
            productPurchaseReport,
            productSellReport,
            dailySalesByProduct: Array.from(dailySalesByProductMap.values()),
            purchaseSaleProduct,
            purchasePaymentReport: supplierPays,
            sellPaymentReport,
            paymentByAge,
            expenseReport: expenses,
            activityLogReport: activityLogs,
            deletedTransactions: deletedTxns,
            branches: locations.map(l => l.name).filter(Boolean),
            customerCount: customers.length
        });
    } catch (err) {
        console.error('GET /api/reports/all error:', err);
        res.status(500).json({ message: 'Failed to load reports' });
    }
});

router.get('/api/reports/today-profit', authenticateToken, async (req, res) => {
    if (!MANAGER_ROLES.includes((req.user.role || '').toLowerCase())) {
        return res.status(403).json({ message: 'Manager or CEO access required' });
    }
    try {
        const tenantId = req.user.tenant_id || 1;
        const today = new Date().toISOString().slice(0, 10);
        const fromTs = `${today} 00:00:00`;
        const toTs = `${today} 23:59:59.999`;

        const [products, txns, pos, expenses, adjustments, transfers] = await Promise.all([
            safeQuery(`SELECT barcode, COALESCE(price,0) AS price, COALESCE(cost_price,0) AS cost_price, COALESCE(stock,0) AS stock
                       FROM products WHERE COALESCE(tenant_id, 1) = $1 AND deleted_at IS NULL`, [tenantId]),
            safeQuery(`SELECT total_amount, discount_amount, tax_amount, is_return, items
                       FROM transactions
                       WHERE COALESCE(tenant_id, 1) = $1 AND created_at >= $2 AND created_at <= $3 AND LOWER(COALESCE(status,'')) = 'completed'`, [tenantId, fromTs, toTs]),
            safeQuery(`SELECT total_amount, status
                       FROM purchase_orders
                       WHERE COALESCE(tenant_id, 1) = $1 AND created_at >= $2 AND created_at <= $3`, [tenantId, fromTs, toTs]),
            safeQuery(`SELECT amount
                       FROM expenses
                       WHERE COALESCE(tenant_id, 1) = $1 AND created_at >= $2 AND created_at <= $3`, [tenantId, fromTs, toTs]),
            safeQuery(`SELECT product_barcode, quantity_adjusted
                       FROM stock_adjustments
                       WHERE COALESCE(tenant_id, 1) = $1 AND created_at >= $2 AND created_at <= $3`, [tenantId, fromTs, toTs]),
            safeQuery(`SELECT 0::numeric AS shipping_charge FROM stock_transfers WHERE COALESCE(tenant_id, 1) = $1 AND created_at >= $2 AND created_at <= $3`, [tenantId, fromTs, toTs])
        ]);

        const prodMap = new Map(products.map(p => [p.barcode, p]));
        let closingStockPurchase = 0;
        let closingStockSale = 0;
        for (const p of products) {
            const stk = Math.max(0, Number(p.stock || 0));
            closingStockPurchase += stk * Number(p.cost_price || 0);
            closingStockSale += stk * Number(p.price || 0);
        }

        let totalSales = 0;
        let totalSellReturn = 0;
        let totalSellDiscount = 0;
        let soldCost = 0;
        for (const tx of txns) {
            const amt = Math.max(0, Number(tx.total_amount || 0) - Number(tx.tax_amount || 0));
            if (tx.is_return) {
                totalSellReturn += amt;
            } else {
                totalSales += amt;
                totalSellDiscount += Number(tx.discount_amount || 0);
                const items = Array.isArray(tx.items) ? tx.items : (typeof tx.items === 'string' ? JSON.parse(tx.items || '[]') : []);
                for (const it of items) {
                    const p = prodMap.get(it.barcode) || {};
                    soldCost += Number(p.cost_price || 0) * Number(it.qty || 0) * Number(it.unit_factor || 1);
                }
            }
        }

        let totalPurchase = 0;
        let totalPurchaseReturn = 0;
        for (const po of pos) {
            const st = String(po.status || '').toLowerCase();
            if (st === 'returned' || st === 'return') totalPurchaseReturn += Number(po.total_amount || 0);
            else if (st !== 'cancelled') totalPurchase += Number(po.total_amount || 0);
        }

        const totalExpense = expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
        let totalStockAdjustment = 0;
        let totalStockRecovered = 0;
        for (const a of adjustments) {
            const p = prodMap.get(a.product_barcode) || {};
            const val = Number(a.quantity_adjusted || 0) * Number(p.cost_price || 0);
            if (val < 0) totalStockAdjustment += Math.abs(val);
            else totalStockRecovered += val;
        }

        const openingStockPurchase = Math.max(0, closingStockPurchase + soldCost - totalPurchase + totalStockAdjustment - totalStockRecovered);
        const openingStockSale = closingStockSale + totalSales;

        const purchaseShippingCharge = 0;
        const purchaseAdditionalExpenses = 0;
        const transferShippingCharge = transfers.reduce((s, t) => s + Number(t.shipping_charge || 0), 0);
        const totalCustomerReward = 0;
        const totalPayroll = 0;
        const totalProductionCost = 0;
        const sellShippingCharge = 0;
        const sellAdditionalExpenses = 0;
        const totalPurchaseDiscount = 0;
        const totalSellRoundOff = 0;
        const totalSellReturnDiscount = 0;

        const cogs = openingStockPurchase + totalPurchase - closingStockPurchase;
        const grossProfit = totalSales - cogs;
        const netProfit = grossProfit
            + (sellShippingCharge + sellAdditionalExpenses + totalStockRecovered + totalPurchaseDiscount + totalSellRoundOff + totalSellReturnDiscount)
            - (totalStockAdjustment + totalExpense + purchaseShippingCharge + transferShippingCharge + purchaseAdditionalExpenses + totalSellDiscount + totalCustomerReward + totalPayroll + totalProductionCost);

        res.json({
            warnings: warnings(),
            date: today,
            opening_stock_purchase: Number(openingStockPurchase.toFixed(2)),
            opening_stock_sale: Number(openingStockSale.toFixed(2)),
            total_purchase: Number(totalPurchase.toFixed(2)),
            total_stock_adjustment: Number(totalStockAdjustment.toFixed(2)),
            total_expense: Number(totalExpense.toFixed(2)),
            purchase_shipping_charge: purchaseShippingCharge,
            purchase_additional_expenses: purchaseAdditionalExpenses,
            transfer_shipping_charge: Number(transferShippingCharge.toFixed(2)),
            total_sell_discount: Number(totalSellDiscount.toFixed(2)),
            total_customer_reward: totalCustomerReward,
            total_sell_return: Number(totalSellReturn.toFixed(2)),
            total_payroll: totalPayroll,
            total_production_cost: totalProductionCost,
            closing_stock_purchase: Number(closingStockPurchase.toFixed(2)),
            closing_stock_sale: Number(closingStockSale.toFixed(2)),
            total_sales: Number(totalSales.toFixed(2)),
            sell_shipping_charge: sellShippingCharge,
            sell_additional_expenses: sellAdditionalExpenses,
            total_stock_recovered: Number(totalStockRecovered.toFixed(2)),
            total_purchase_return: Number(totalPurchaseReturn.toFixed(2)),
            total_purchase_discount: totalPurchaseDiscount,
            total_sell_round_off: totalSellRoundOff,
            total_sell_return_discount: totalSellReturnDiscount,
            cogs: Number(cogs.toFixed(2)),
            gross_profit: Number(grossProfit.toFixed(2)),
            net_profit: Number(netProfit.toFixed(2))
        });
    } catch (err) {
        console.error('GET /api/reports/today-profit error:', err);
        res.status(500).json({ message: 'Failed to calculate today profit' });
    }
});

router.get('/api/notifications/feed', authenticateToken, async (req, res) => {
    const normRole = (req.user.role || '').toLowerCase().replace(/[\s-]+/g, '_');
    if (!MANAGER_ROLES.includes(normRole)) {
        return res.status(403).json({ message: 'Manager or CEO access required' });
    }
    try {
        const tenantId = req.user.tenant_id || 1;
        const today = new Date().toISOString().slice(0, 10);
        const fromTs = `${today} 00:00:00`;
        const toTs = `${today} 23:59:59.999`;

        const [priceChanges, todayTxns, todayExpenses, clientsOwing, lowStock, activities] = await Promise.all([
            safeQuery(`SELECT product_name, old_price, new_price, change_reason, changed_by_name, created_at
                       FROM price_history WHERE COALESCE(tenant_id, 1) = $1 ORDER BY created_at DESC LIMIT 8`, [tenantId]),
            safeQuery(`SELECT total_amount, is_return, items FROM transactions
                       WHERE COALESCE(tenant_id, 1) = $1 AND created_at >= $2 AND created_at <= $3 AND LOWER(COALESCE(status,'')) = 'completed'`, [tenantId, fromTs, toTs]),
            safeQuery(`SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
                       WHERE COALESCE(tenant_id, 1) = $1 AND created_at >= $2 AND created_at <= $3`, [tenantId, fromTs, toTs]),
            safeQuery(`SELECT name, current_balance FROM customers
                       WHERE COALESCE(tenant_id, 1) = $1 AND COALESCE(current_balance, 0) > 0 ORDER BY current_balance DESC LIMIT 5`, [tenantId]),
            safeQuery(`SELECT name, stock, reorder_level FROM products
                       WHERE COALESCE(tenant_id, 1) = $1 AND deleted_at IS NULL AND COALESCE(stock, 0) <= COALESCE(reorder_level, 10) ORDER BY stock ASC LIMIT 5`, [tenantId]),
            safeQuery(`SELECT a.action, a.details, a.created_at, COALESCE(u.name, u.username, 'Staff') AS user_name
                       FROM activity_logs a LEFT JOIN users u ON u.id = a.user_id
                       WHERE COALESCE(a.tenant_id, 1) = $1 ORDER BY a.created_at DESC LIMIT 8`, [tenantId])
        ]);

        const formatPlainDetails = (raw) => {
            if (!raw) return '';
            let obj = raw;
            if (typeof obj === 'string') {
                try { obj = JSON.parse(obj); } catch (_) {
                    return obj.replace(/[{}[\]()"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
                }
            }
            if (typeof obj === 'object' && obj !== null) {
                return Object.entries(obj)
                    .filter(([, v]) => v !== null && v !== undefined && v !== '')
                    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v).replace(/[{}[\]()"]/g, '') : v}`)
                    .join(', ')
                    .replace(/[{}[\]()"]/g, '')
                    .slice(0, 90);
            }
            return String(obj).replace(/[{}[\]()"]/g, '').trim().slice(0, 90);
        };
        const formatActionTitle = (action) => String(action || 'Event')
            .toLowerCase()
            .replace(/_/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase());

        const items = [];

        // 1. Today's Profit / Loss summary alert
        const salesTotal = todayTxns.filter(t => !t.is_return).reduce((s, t) => s + Number(t.total_amount || 0), 0);
        const expTotal = Number(todayExpenses[0]?.total || 0);
        const netToday = salesTotal - expTotal;
        items.push({
            category: netToday >= 0 ? 'Profit Made' : 'Profit Loss',
            tone: netToday >= 0 ? 'success' : 'danger',
            title: netToday >= 0 ? `Today's Net Sales/Profit: GH₵ ${netToday.toFixed(2)}` : `Today's Net Loss: -GH₵ ${Math.abs(netToday).toFixed(2)}`,
            detail: `Sales: GH₵ ${salesTotal.toFixed(2)} · Expenses: GH₵ ${expTotal.toFixed(2)}`,
            link: '/reports?tab=pnl',
            time: 'Today',
            ts: Date.now()
        });

        // 2. Price reductions & price adjustments
        for (const p of priceChanges) {
            const oldP = Number(p.old_price || 0);
            const newP = Number(p.new_price || 0);
            const isReduced = newP < oldP;
            items.push({
                category: isReduced ? 'Price Reduced' : 'Price Adjusted',
                tone: isReduced ? 'warning' : 'info',
                title: `${p.product_name || 'Product'}: GH₵ ${oldP.toFixed(2)} → GH₵ ${newP.toFixed(2)}`,
                detail: `${p.change_reason || 'Price update'} by ${p.changed_by_name || 'Manager'}`.replace(/[{}[\]()]/g, ''),
                link: '/catalog-ops',
                time: p.created_at ? new Date(p.created_at).toLocaleString() : '',
                ts: p.created_at ? new Date(p.created_at).getTime() : 0
            });
        }

        // 3. Clients owing
        for (const c of clientsOwing) {
            items.push({
                category: 'Client Balance',
                tone: 'warning',
                title: `${c.name} owes GH₵ ${Number(c.current_balance || 0).toFixed(2)}`,
                detail: 'Outstanding credit balance',
                link: '/credit-customers',
                time: 'Active',
                ts: Date.now() - 60000
            });
        }

        // 4. Low / Negative stock
        for (const s of lowStock) {
            const stk = Number(s.stock || 0);
            items.push({
                category: stk <= 0 ? 'Out / Negative Stock' : 'Low Stock',
                tone: 'danger',
                title: `${s.name}: ${stk} left`,
                detail: `Reorder level: ${s.reorder_level || 10}`,
                link: stk < 0 ? '/negative-stock' : '/inventory?tab=stock&lowStock=true',
                time: 'Stock Alert',
                ts: Date.now() - 30000
            });
        }

        // 5. Recent activity logs
        for (const a of activities) {
            const plain = formatPlainDetails(a.details);
            items.push({
                category: 'Activity',
                tone: 'neutral',
                title: `${formatActionTitle(a.action)} by ${a.user_name}`,
                detail: plain,
                link: '/activity-log',
                time: a.created_at ? new Date(a.created_at).toLocaleString() : '',
                ts: a.created_at ? new Date(a.created_at).getTime() : 0
            });
        }

        items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        res.json({ count: items.length, items: items.slice(0, 25) });
    } catch (err) {
        console.error('GET /api/notifications/feed error:', err);
        res.status(500).json({ message: 'Failed to load notifications' });
    }
});

router.post('/api/reports/deleted-transactions/:id/restore', authenticateToken, async (req, res) => {
    if (!MANAGER_ROLES.includes((req.user.role || '').toLowerCase())) {
        return res.status(403).json({ message: 'Manager or CEO access required' });
    }
    const tenantId = req.user.tenant_id || 1;
    try {
        const upd = await pool.query(
            `UPDATE transactions SET status = 'completed'
             WHERE id = $1 AND COALESCE(tenant_id, 1) = $2
               AND LOWER(COALESCE(status,'')) IN ('deleted','voided','cancelled')
             RETURNING id, receipt_number, customer_name, total_amount`,
            [req.params.id, tenantId]
        );
        if (!upd.rows.length) return res.status(404).json({ message: 'Deleted transaction not found' });
        const { logActivity } = require('../services/audit');
        await logActivity(req, 'RESTORE_TRANSACTION', {
            transaction_id: upd.rows[0].id,
            receipt_number: upd.rows[0].receipt_number,
            customer_name: upd.rows[0].customer_name || 'Walk-in',
            total: Number(upd.rows[0].total_amount || 0)
        });
        res.json({ success: true, transaction: upd.rows[0] });
    } catch (err) {
        console.error('POST /api/reports/deleted-transactions/:id/restore error:', err);
        res.status(500).json({ message: 'Failed to restore transaction' });
    }
});

router.get('/api/reports/sales-representative', authenticateToken, async (req, res) => {
    if (!MANAGER_ROLES.includes((req.user.role || '').toLowerCase())) {
        return res.status(403).json({ message: 'Manager or CEO access required' });
    }
    const tenantId = req.user.tenant_id || 1;
    const today = new Date().toISOString().slice(0, 10);
    const from = req.query.from || (today.slice(0, 8) + '01');
    const to = req.query.to || today;
    const branch = req.query.branch && req.query.branch !== 'All Branches' ? String(req.query.branch).trim() : '';
    const userId = req.query.user_id && req.query.user_id !== 'all' ? Number(req.query.user_id) : null;
    const fromTs = `${from} 00:00:00`;
    const toTs = `${to} 23:59:59.999`;

    try {
        const txParams = [tenantId, fromTs, toTs];
        let txWhere = `COALESCE(t.tenant_id, 1) = $1 AND t.created_at >= $2 AND t.created_at <= $3 AND LOWER(COALESCE(t.status,'')) NOT IN ('deleted','voided','cancelled')`;
        if (branch) { txParams.push(branch); txWhere += ` AND LOWER(COALESCE(t.store_location,'')) = LOWER($${txParams.length})`; }
        if (userId) { txParams.push(userId); txWhere += ` AND t.user_id = $${txParams.length}`; }

        const expParams = [tenantId, fromTs, toTs];
        let expWhere = `COALESCE(e.tenant_id, 1) = $1 AND COALESCE(e.expense_date::timestamptz, e.created_at) >= $2 AND COALESCE(e.expense_date::timestamptz, e.created_at) <= $3`;
        if (branch) { expParams.push(branch); expWhere += ` AND LOWER(COALESCE(e.store_location,'')) = LOWER($${expParams.length})`; }
        if (userId) { expParams.push(userId); expWhere += ` AND e.created_by = $${expParams.length}`; }

        const [usersRes, brRes, txRes, expRes] = await Promise.all([
            pool.query(`SELECT id, COALESCE(name, username, email) AS name, role FROM users WHERE COALESCE(tenant_id, 1) = $1 AND deleted_at IS NULL ORDER BY name ASC`, [tenantId]).catch(() => ({ rows: [] })),
            pool.query(`SELECT name FROM branches WHERE COALESCE(tenant_id, 1) = $1 AND deleted_at IS NULL ORDER BY name ASC`, [tenantId]).catch(() => ({ rows: [] })),
            pool.query(`SELECT t.id, t.created_at, t.receipt_number, COALESCE(t.customer_name, 'Walk-in') AS customer_name,
                               COALESCE(t.store_location, '') AS location, t.total_amount, t.paid_amount, t.balance_due,
                               t.status, t.is_return, t.user_id, COALESCE(u.name, u.username, 'Staff') AS user_name
                        FROM transactions t
                        LEFT JOIN users u ON u.id = t.user_id
                        WHERE ${txWhere}
                        ORDER BY t.created_at DESC LIMIT 500`, txParams).catch(() => ({ rows: [] })),
            pool.query(`SELECT e.id, COALESCE(e.expense_date::timestamptz, e.created_at) AS date,
                               COALESCE(e.reference_no, '') AS reference_no, COALESCE(e.category, '') AS category,
                               COALESCE(e.store_location, '') AS location, e.amount, COALESCE(e.description, '') AS description,
                               COALESCE(u.name, u.username, 'Staff') AS expense_for
                        FROM expenses e
                        LEFT JOIN users u ON u.id = e.created_by
                        WHERE ${expWhere}
                        ORDER BY date DESC LIMIT 500`, expParams).catch(() => ({ rows: [] }))
        ]);

        let totalSale = 0, totalSalesReturn = 0, sellDue = 0, sellReturnDue = 0;
        const salesAdded = txRes.rows.map(t => {
            const isRet = Boolean(t.is_return);
            const totalAmt = Math.abs(Number(t.total_amount || 0));
            const paidAmt = t.paid_amount !== null && t.paid_amount !== undefined ? Math.abs(Number(t.paid_amount)) : totalAmt;
            const remAmt = t.balance_due !== null && t.balance_due !== undefined ? Math.max(0, Number(t.balance_due)) : Math.max(0, totalAmt - paidAmt);
            if (isRet) { totalSalesReturn += totalAmt; sellReturnDue += remAmt; }
            else { totalSale += totalAmt; sellDue += remAmt; }
            const payStatus = remAmt <= 0.01 ? 'Paid' : (paidAmt > 0 ? 'Partial' : 'Due');
            return {
                date: t.created_at,
                invoice_no: t.receipt_number || ('#' + t.id),
                customer_name: t.customer_name,
                location: t.location || 'Main Shop',
                payment_status: payStatus,
                total_amount: totalAmt,
                total_paid: paidAmt,
                total_remaining: remAmt,
                is_return: isRet,
                user_name: t.user_name
            };
        });

        const expenses = expRes.rows.map(e => ({
            date: e.date,
            reference_no: e.reference_no || ('EXP-' + e.id),
            category: e.category || 'General',
            location: e.location || 'Main Shop',
            payment_status: 'Paid',
            total_amount: Number(e.amount || 0),
            expense_for: e.expense_for || 'Staff',
            expense_note: e.description || ''
        }));
        const totalExpense = expenses.reduce((s, e) => s + e.total_amount, 0);

        res.json({
            users: usersRes.rows,
            branches: brRes.rows.map(b => b.name).filter(Boolean),
            summary: {
                total_sale: Number(totalSale.toFixed(2)),
                total_sales_return: Number(totalSalesReturn.toFixed(2)),
                net_sale: Number((totalSale - totalSalesReturn).toFixed(2)),
                total_expense: Number(totalExpense.toFixed(2)),
                sell_due: Number(sellDue.toFixed(2)),
                sell_return_due: Number(sellReturnDue.toFixed(2))
            },
            salesAdded,
            salesWithCommission: [],
            expenses
        });
    } catch (err) {
        console.error('GET /api/reports/sales-representative error:', err);
        res.status(500).json({ message: 'Failed to load sales representative report' });
    }
});

module.exports = router;

