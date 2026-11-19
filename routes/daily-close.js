const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');
const { pool } = require('../db/pool');
const { authenticateToken, requireRole, PAGE_ROLES } = require('../middleware/auth');
const { logActivity } = require('../services/audit');

async function ensureDailyCloseTable() {
    if (!pool) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS daily_closes (
            id SERIAL PRIMARY KEY,
            tenant_id INTEGER DEFAULT 1,
            close_date DATE NOT NULL,
            branch_name VARCHAR(120) DEFAULT 'All Branches',
            counted_cash DECIMAL(12,2) DEFAULT 0.00,
            expected_cash DECIMAL(12,2) DEFAULT 0.00,
            cash_difference DECIMAL(12,2) DEFAULT 0.00,
            total_sales DECIMAL(12,2) DEFAULT 0.00,
            total_profit DECIMAL(12,2) DEFAULT 0.00,
            closed_by INTEGER NULL,
            closed_by_name VARCHAR(120) DEFAULT '',
            summary JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    `);
}

async function safeQuery(sql, params = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (e) {
        return [];
    }
}

async function buildDailyCloseData(dateStr, branch = '', tenantId = 1) {
    const dayStart = `${dateStr} 00:00:00`;
    const dayEnd = `${dateStr} 23:59:59.999`;

    const branchFilter = branch && branch !== 'All Branches' ? 'AND LOWER(COALESCE(store_location,\'\')) = LOWER($4)' : '';
    const txParams = branchFilter ? [dayStart, dayEnd, tenantId, branch] : [dayStart, dayEnd, tenantId];

    const isSingleBranch = Boolean(branch && branch !== 'All Branches');
    const laterParams = isSingleBranch ? [dayEnd, tenantId, branch] : [dayEnd, tenantId];
    const laterBranchFilter = isSingleBranch ? 'AND LOWER(COALESCE(store_location,\'\')) = LOWER($3)' : '';
    const layawayBranchFilter = isSingleBranch ? 'AND LOWER(COALESCE(store_location,\'\')) = LOWER($3)' : '';
    const layawayParams = isSingleBranch ? [dayStart, dayEnd, branch] : [dayStart, dayEnd];

    const [products, txns, expenses, custPayments, adjustments, goodsReceived, laterTxns, laterAdjustments, laterReceived, layawayPays] = await Promise.all([
        safeQuery(`SELECT id, barcode, name, COALESCE(brand, 'Unbranded') AS brand, COALESCE(category, 'General') AS category,
                          COALESCE(selling_unit, 'Unit') AS unit, COALESCE(price, 0) AS price,
                          COALESCE(cost_price, 0) AS cost_price, COALESCE(stock, 0) AS stock,
                          COALESCE(stock_levels, '{}'::jsonb) AS stock_levels,
                          COALESCE(reorder_level, 10) AS reorder_level
                   FROM products WHERE COALESCE(tenant_id, 1) = $1 ORDER BY brand ASC, category ASC, name ASC`, [tenantId]),
        safeQuery(`SELECT t.*,
                          CASE WHEN u.id IS NOT NULL THEN COALESCE(u.name, u.username, 'Staff') || ' (@' || COALESCE(u.username, SPLIT_PART(u.email, '@', 1)) || ' · ' || UPPER(COALESCE(u.role, 'staff')) || ')' ELSE NULL END AS teller_name,
                          u.username AS cashier_username, u.role AS cashier_role
                   FROM transactions t
                   LEFT JOIN users u ON t.user_id = u.id
                   WHERE COALESCE(t.tenant_id, 1) = $3 AND t.created_at >= $1 AND t.created_at <= $2 ${branchFilter}
                   ORDER BY t.created_at ASC`, txParams),
        safeQuery(`SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE COALESCE(tenant_id, 1) = $3 AND created_at >= $1 AND created_at <= $2`, [dayStart, dayEnd, tenantId]),
        safeQuery(`SELECT COALESCE(SUM(amount), 0) AS total FROM customer_payments WHERE COALESCE(tenant_id, 1) = $3 AND created_at >= $1 AND created_at <= $2`, [dayStart, dayEnd, tenantId]),
        safeQuery(`SELECT product_barcode, COALESCE(SUM(quantity_adjusted), 0) AS adj_qty
                   FROM stock_adjustments WHERE COALESCE(tenant_id, 1) = $3 AND created_at >= $1 AND created_at <= $2 GROUP BY product_barcode`, [dayStart, dayEnd, tenantId]),
        safeQuery(`SELECT product_barcode, COALESCE(SUM(quantity_received), 0) AS rec_qty
                   FROM goods_received WHERE COALESCE(tenant_id, 1) = $3 AND created_at >= $1 AND created_at <= $2 GROUP BY product_barcode`, [dayStart, dayEnd, tenantId]),
        // Movements after the selected day, used to roll today's stock back to that day's closing figure
        safeQuery(`SELECT items, is_return FROM transactions WHERE COALESCE(tenant_id, 1) = $2 AND created_at > $1 ${laterBranchFilter}`, laterParams),
        isSingleBranch ? Promise.resolve([]) : safeQuery(`SELECT product_barcode, COALESCE(SUM(quantity_adjusted), 0) AS qty
                   FROM stock_adjustments WHERE COALESCE(tenant_id, 1) = $2 AND created_at > $1 GROUP BY product_barcode`, [dayEnd, tenantId]),
        isSingleBranch ? Promise.resolve([]) : safeQuery(`SELECT product_barcode, COALESCE(SUM(quantity_received), 0) AS qty
                   FROM goods_received WHERE COALESCE(tenant_id, 1) = $2 AND created_at > $1 GROUP BY product_barcode`, [dayEnd, tenantId]),
        safeQuery(`SELECT LOWER(COALESCE(payment_method,'cash')) AS method, COALESCE(SUM(amount), 0) AS total
                   FROM layaway_payments WHERE created_at >= $1 AND created_at <= $2 ${layawayBranchFilter}
                   GROUP BY LOWER(COALESCE(payment_method,'cash'))`, layawayParams)
    ]);

    // Net stock change since the end of the selected day, per barcode
    const laterNet = new Map();
    const bump = (bc, q) => { if (bc) laterNet.set(bc, (laterNet.get(bc) || 0) + q); };
    for (const tx of laterTxns) {
        const its = Array.isArray(tx.items) ? tx.items : (typeof tx.items === 'string' ? JSON.parse(tx.items || '[]') : []);
        for (const it of its) {
            const q = Number(it.qty || 0) * Number(it.unit_factor || 1);
            bump(it.barcode, tx.is_return ? q : -q);
        }
    }
    for (const a of laterAdjustments) bump(a.product_barcode, Number(a.qty || 0));
    for (const g of laterReceived) bump(g.product_barcode, Number(g.qty || 0));

    const costMap = new Map(products.map(p => [p.barcode, Number(p.cost_price || 0)]));
    const brandMap = new Map(products.map(p => [p.barcode, p.brand || 'Unbranded']));
    const unitMap = new Map(products.map(p => [p.barcode, p.unit || 'Unit']));

    const soldByBarcode = new Map();
    const returnedByBarcode = new Map();
    const soldItemsAgg = new Map();

    const methodTotals = { cash: 0, momo: 0, card: 0, bank: 0, credit: 0, store_credit: 0 };
    let totalReturns = 0;
    let totalDiscounts = 0;
    let totalSales = 0;
    let creditSalesGiven = 0;

    for (const tx of txns) {
        const items = Array.isArray(tx.items) ? tx.items : (typeof tx.items === 'string' ? JSON.parse(tx.items || '[]') : []);
        const isRet = Boolean(tx.is_return);
        const amt = Number(tx.total_amount || 0);
        const disc = Number(tx.discount_amount || 0);
        totalDiscounts += disc;

        if (isRet) {
            totalReturns += Math.abs(amt);
        } else {
            totalSales += amt;
        }

        // Method breakdown
        const splits = Array.isArray(tx.payment_splits) && tx.payment_splits.length
            ? tx.payment_splits
            : [{ method: tx.payment_method || 'cash', amount: amt }];

        if (!isRet) {
            let txCash = 0;
            for (const sp of splits) {
                const m = String(sp.method || 'cash').toLowerCase();
                const spAmt = Number(sp.amount || 0);
                if (m.includes('momo')) methodTotals.momo += spAmt;
                else if (m.includes('card')) methodTotals.card += spAmt;
                else if (m.includes('bank') || m.includes('cheque')) methodTotals.bank += spAmt;
                else if (m.includes('store_credit')) methodTotals.store_credit += spAmt;
                else if (m.includes('credit')) { methodTotals.credit += spAmt; creditSalesGiven += spAmt; }
                else txCash += spAmt;
            }
            const changeGiven = Math.max(0, Number(tx.change_amount || 0));
            methodTotals.cash += Math.max(0, txCash - changeGiven);
            const bal = Number(tx.balance_due || 0);
            if (bal > 0) creditSalesGiven += bal;
        } else {
            for (const sp of splits) {
                const m = String(sp.method || 'cash').toLowerCase();
                const spAmt = Math.abs(Number(sp.amount || 0));
                if (!m.includes('momo') && !m.includes('card') && !m.includes('bank') && !m.includes('cheque') && !m.includes('store_credit') && !m.includes('credit')) {
                    methodTotals.cash -= spAmt;
                }
            }
        }

        for (const it of items) {
            const bc = it.barcode || it.name;
            const qty = Number(it.qty || 0) * Number(it.unit_factor || 1);
            const lineTotal = Number(it.price || 0) * Number(it.qty || 0);
            const unitCost = costMap.get(it.barcode) || 0;
            const lineCost = unitCost * qty;

            if (isRet) {
                returnedByBarcode.set(bc, (returnedByBarcode.get(bc) || 0) + qty);
            } else {
                soldByBarcode.set(bc, (soldByBarcode.get(bc) || 0) + qty);
                const prev = soldItemsAgg.get(bc) || {
                    barcode: it.barcode || '',
                    name: it.name || bc,
                    brand: brandMap.get(it.barcode) || 'Unbranded',
                    unit: it.unit_name || unitMap.get(it.barcode) || 'Unit',
                    qty: 0,
                    total: 0,
                    discount: 0,
                    cost: 0,
                    profit: 0
                };
                prev.qty += Number(it.qty || 0);
                prev.total += lineTotal;
                prev.discount += Number(it.discount || 0);
                prev.cost += lineCost;
                prev.profit = prev.total - prev.discount - prev.cost;
                soldItemsAgg.set(bc, prev);
            }
        }
    }

    const adjMap = new Map(adjustments.map(a => [a.product_barcode, Number(a.adj_qty || 0)]));
    const recMap = new Map(goodsReceived.map(g => [g.product_barcode, Number(g.rec_qty || 0)]));

    const inventorySheet = products.map(p => {
        let current = Number(p.stock || 0);
        if (isSingleBranch) {
            const levels = typeof p.stock_levels === 'string' ? JSON.parse(p.stock_levels || '{}') : (p.stock_levels || {});
            const key = Object.keys(levels).find(k => k.toLowerCase() === branch.toLowerCase());
            current = key !== undefined ? Number(levels[key] || 0) : 0;
        }
        // Roll current stock back to the end of the selected day
        const closing = current - (laterNet.get(p.barcode) || 0);
        const sold = soldByBarcode.get(p.barcode) || 0;
        const received = recMap.get(p.barcode) || 0;
        const retOrAdj = (returnedByBarcode.get(p.barcode) || 0) + (adjMap.get(p.barcode) || 0);
        const opening = closing + sold - received - retOrAdj;
        const moved = sold !== 0 || received !== 0 || retOrAdj !== 0;
        const lowStock = closing <= Number(p.reorder_level || 10);
        return {
            barcode: p.barcode,
            name: p.name,
            brand: p.brand || 'Unbranded',
            category: p.category || 'General',
            unit: p.unit || 'Unit',
            opening_stock: Number(opening.toFixed(3)),
            received_today: Number(received.toFixed(3)),
            sold_today: Number(sold.toFixed(3)),
            returned_or_adjusted: Number(retOrAdj.toFixed(3)),
            closing_stock: Number(closing.toFixed(3)),
            cost_price: Number(p.cost_price || 0),
            value_at_cost: Number((closing * Number(p.cost_price || 0)).toFixed(2)),
            moved_today: moved,
            low_stock: lowStock
        };
    });

    const salesSheetItems = Array.from(soldItemsAgg.values()).map(it => ({
        ...it,
        avg_price: it.qty > 0 ? Number((it.total / it.qty).toFixed(2)) : 0,
        total: Number(it.total.toFixed(2)),
        cost: Number(it.cost.toFixed(2)),
        profit: Number(it.profit.toFixed(2))
    }));

    const receipts = txns.map(tx => ({
        id: tx.id,
        receipt_number: tx.receipt_number,
        time: tx.created_at,
        teller: tx.teller_name || 'Teller',
        customer: tx.customer_name || 'Walk-in',
        payment_method: tx.payment_method || 'cash',
        total_amount: Number(tx.total_amount || 0),
        is_return: Boolean(tx.is_return)
    }));

    const expensesPaidOut = Number((expenses[0] && expenses[0].total) || 0);
    const creditPaymentsReceived = Number((custPayments[0] && custPayments[0].total) || 0);
    const layawayCash = layawayPays.filter(l => l.method === 'cash').reduce((s, l) => s + Number(l.total || 0), 0);
    const layawayTotal = layawayPays.reduce((s, l) => s + Number(l.total || 0), 0);
    const expectedCash = Number((methodTotals.cash - expensesPaidOut + creditPaymentsReceived + layawayCash).toFixed(2));

    return {
        date: dateStr,
        branch: branch || 'All Branches',
        closing_stock_note: isSingleBranch
            ? 'Branch closing stock is rolled back using that branch\'s later sales and returns only; later goods received and stock adjustments are not recorded per branch.'
            : 'Closing stock is today\'s stock rolled back by all sales, returns, goods received and adjustments after the selected day.',
        inventorySheet,
        salesSheetItems,
        receipts,
        totals: {
            total_sales: Number(totalSales.toFixed(2)),
            total_profit: Number(salesSheetItems.reduce((s, i) => s + i.profit, 0).toFixed(2)),
            by_method: methodTotals,
            returns: Number(totalReturns.toFixed(2)),
            discounts: Number(totalDiscounts.toFixed(2)),
            expenses_paid_out: expensesPaidOut,
            expected_cash: expectedCash,
            credit_sales_given: Number(creditSalesGiven.toFixed(2)),
            credit_payments_received: creditPaymentsReceived,
            layaway_payments_received: Number(layawayTotal.toFixed(2)),
            layaway_cash_received: Number(layawayCash.toFixed(2))
        }
    };
}

router.get('/api/daily-close', authenticateToken, async (req, res) => {
    try {
        await ensureDailyCloseTable();
        const tenantId = req.user.tenant_id || 1;
        const date = req.query.date || new Date().toISOString().slice(0, 10);
        const branch = req.query.branch || 'All Branches';
        const data = await buildDailyCloseData(date, branch, tenantId);
        const history = await safeQuery(
            `SELECT id, close_date, branch_name, counted_cash, expected_cash, cash_difference, total_sales, closed_by_name, created_at
             FROM daily_closes WHERE COALESCE(tenant_id, 1) = $1 ORDER BY close_date DESC, created_at DESC LIMIT 30`,
            [tenantId]
        );
        res.json({ ...data, history });
    } catch (err) {
        console.error('GET /api/daily-close error:', err);
        res.status(500).json({ message: 'Failed to generate daily close sheets' });
    }
});

router.post('/api/daily-close/close', authenticateToken, requireRole(['ceo', 'admin', 'manager', 'store_manager']), async (req, res) => {
    try {
        await ensureDailyCloseTable();
        const tenantId = req.user.tenant_id || 1;
        const { date = new Date().toISOString().slice(0, 10), branch = 'All Branches', counted_cash = 0 } = req.body;
        const data = await buildDailyCloseData(date, branch, tenantId);
        const expected = data.totals.expected_cash;
        const counted = Number(counted_cash || 0);
        const diff = Number((counted - expected).toFixed(2));

        const result = await pool.query(
            `INSERT INTO daily_closes (tenant_id, close_date, branch_name, counted_cash, expected_cash, cash_difference, total_sales, total_profit, closed_by, closed_by_name, summary)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
            [
                tenantId, date, branch, counted, expected, diff,
                data.totals.total_sales, data.totals.total_profit,
                req.user.id || null, req.user.name || 'Staff', JSON.stringify(data.totals)
            ]
        );
        await logActivity(req, 'DAILY_CLOSE_COMPLETED', { date, branch, counted_cash: counted, expected_cash: expected, diff });
        res.status(201).json({ success: true, close_record: result.rows[0], ...data });
    } catch (err) {
        console.error('POST /api/daily-close/close error:', err);
        res.status(500).json({ message: 'Failed to close day' });
    }
});

// Typing physical counts back in creates stock adjustments
router.post('/api/daily-close/submit-counts', authenticateToken, requireRole(['ceo', 'admin', 'manager', 'store_manager']), async (req, res) => {
    const client = await pool.connect();
    try {
        const tenantId = req.user.tenant_id || 1;
        const { counts = [] } = req.body; // [{ barcode, physical_count, closing_stock }]
        if (!counts.length) return res.status(400).json({ message: 'No physical counts provided' });

        await client.query('BEGIN');
        let adjusted = 0;
        for (const row of counts) {
            if (row.physical_count === '' || row.physical_count === null || row.physical_count === undefined) continue;
            const phys = Number(row.physical_count);
            const expected = Number(row.closing_stock || 0);
            const diff = Number((phys - expected).toFixed(3));
            if (diff !== 0) {
                await client.query('UPDATE products SET stock = $1 WHERE barcode = $2 AND COALESCE(tenant_id, 1) = $3', [phys, row.barcode, tenantId]);
                await client.query(
                    `INSERT INTO stock_adjustments (tenant_id, product_barcode, adjustment_type, quantity_adjusted, reason, approver_id, approved_at)
                     VALUES ($1, $2, 'Correction', $3, $4, $5, NOW())`,
                    [tenantId, row.barcode, diff, 'Daily Close Physical Count', req.user.id || null]
                );
                adjusted++;
            }
        }
        await client.query('COMMIT');
        await logActivity(req, 'DAILY_CLOSE_COUNTS_APPLIED', { adjusted_items: adjusted });
        res.json({ success: true, adjusted });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('POST /api/daily-close/submit-counts error:', err);
        res.status(500).json({ message: 'Failed to apply physical counts' });
    } finally {
        client.release();
    }
});

router.post('/api/daily-close/email-ceo', authenticateToken, requireRole(['ceo', 'admin', 'manager', 'store_manager']), async (req, res) => {
    try {
        const tenantId = req.user.tenant_id || 1;
        const { date = new Date().toISOString().slice(0, 10), branch = 'All Branches' } = req.body;
        const recipient = process.env.CEO_EMAIL || process.env.ADMIN_EMAIL;
        if (!recipient || !process.env.SMTP_HOST) {
            return res.status(400).json({ message: 'CEO email or SMTP not configured in .env' });
        }
        const data = await buildDailyCloseData(date, branch, tenantId);
        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: process.env.SMTP_PORT,
            secure: process.env.SMTP_SECURE === 'true',
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        });
        await transporter.sendMail({
            from: `"OKWESIWA CO LTD" <${process.env.ADMIN_EMAIL}>`,
            to: recipient,
            subject: `Daily Close Report — ${branch} (${date})`,
            html: `
                <h2>OKWESIWA CO LTD — Daily Close (${date})</h2>
                <p><strong>Branch:</strong> ${branch}</p>
                <p><strong>Total Sales:</strong> GH₵ ${data.totals.total_sales.toFixed(2)}</p>
                <p><strong>Total Profit:</strong> GH₵ ${data.totals.total_profit.toFixed(2)}</p>
                <p><strong>Expected Cash:</strong> GH₵ ${data.totals.expected_cash.toFixed(2)}</p>
                <p><strong>Receipts:</strong> ${data.receipts.length}</p>
            `
        });
        res.json({ success: true, message: `Daily close emailed to ${recipient}` });
    } catch (err) {
        res.status(500).json({ message: 'Email failed: ' + err.message });
    }
});

module.exports = router;

