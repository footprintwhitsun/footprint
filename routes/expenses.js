const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { mainBranchId } = require('../services/branches');
const { authenticateToken, requireRole, requirePermission, MANAGER_ROLES } = require('../middleware/auth');
const { logActivity } = require('../services/audit');

let expReady = false;
async function ensureExpensesSchema() {
    if (expReady || !pool) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS expense_categories (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL DEFAULT 1,
                name VARCHAR(100) NOT NULL,
                code VARCHAR(40) DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(tenant_id, name)
            );
            ALTER TABLE expenses ADD COLUMN IF NOT EXISTS store_location VARCHAR(120) DEFAULT '';
            ALTER TABLE expenses ADD COLUMN IF NOT EXISTS reference_no VARCHAR(80) DEFAULT '';
        `);
        expReady = true;
    } catch (e) {
        console.warn('Expenses schema notice:', e.message);
    }
}

const DEFAULT_CATEGORIES = ['Rent', 'Utilities', 'Salaries', 'Transport & Fuel', 'Supplies', 'Repairs & Maintenance', 'Marketing'];

router.get('/api/expense-categories', authenticateToken, async (req, res) => {
    await ensureExpensesSchema();
    const tenantId = req.user.tenant_id || 1;
    try {
        let r = await pool.query('SELECT * FROM expense_categories WHERE COALESCE(tenant_id, 1) = $1 ORDER BY name ASC', [tenantId]);
        if (r.rows.length === 0) {
            for (const name of DEFAULT_CATEGORIES) {
                await pool.query(
                    `INSERT INTO expense_categories (tenant_id, name) VALUES ($1, $2) ON CONFLICT (tenant_id, name) DO NOTHING`,
                    [tenantId, name]
                );
            }
            r = await pool.query('SELECT * FROM expense_categories WHERE COALESCE(tenant_id, 1) = $1 ORDER BY name ASC', [tenantId]);
        }
        res.json({ categories: r.rows });
    } catch (err) {
        console.error('GET /api/expense-categories error:', err);
        res.status(500).json({ message: 'Failed to load expense categories' });
    }
});

router.post('/api/expense-categories', authenticateToken, requireRole(MANAGER_ROLES), requirePermission('expenses', 'create'), async (req, res) => {
    await ensureExpensesSchema();
    const tenantId = req.user.tenant_id || 1;
    const { name, code = '' } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ message: 'Category name is required' });
    try {
        const r = await pool.query(
            `INSERT INTO expense_categories (tenant_id, name, code) VALUES ($1, $2, $3)
             ON CONFLICT (tenant_id, name) DO UPDATE SET code = EXCLUDED.code RETURNING *`,
            [tenantId, String(name).trim(), String(code || '').trim()]
        );
        await logActivity(req, 'EXPENSE_CATEGORY_SAVED', { name: r.rows[0].name });
        res.status(201).json({ success: true, category: r.rows[0] });
    } catch (err) {
        console.error('POST /api/expense-categories error:', err);
        res.status(500).json({ message: 'Failed to save expense category' });
    }
});

router.delete('/api/expense-categories/:id', authenticateToken, requireRole(MANAGER_ROLES), requirePermission('expenses', 'delete'), async (req, res) => {
    await ensureExpensesSchema();
    const tenantId = req.user.tenant_id || 1;
    try {
        const r = await pool.query('DELETE FROM expense_categories WHERE id = $1 AND COALESCE(tenant_id, 1) = $2 RETURNING id', [req.params.id, tenantId]);
        if (!r.rows.length) return res.status(404).json({ message: 'Category not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ message: 'Failed to delete expense category' });
    }
});

router.get('/api/expenses', authenticateToken, async (req, res) => {
    await ensureExpensesSchema();
    const tenantId = req.user.tenant_id || 1;
    const today = new Date().toISOString().slice(0, 10);
    const from = req.query.from || today.slice(0, 8) + '01';
    const to = req.query.to || today;
    const category = req.query.category ? String(req.query.category).trim() : '';
    try {
        const params = [tenantId, `${from} 00:00:00`, `${to} 23:59:59.999`];
        let catClause = '';
        if (category) {
            params.push(category);
            catClause = ` AND LOWER(COALESCE(e.category,'')) = LOWER($4)`;
        }
        const r = await pool.query(
            `SELECT e.*, COALESCE(u.name, u.username, 'Staff') AS created_by_name
             FROM expenses e
             LEFT JOIN users u ON u.id = e.created_by
             WHERE COALESCE(e.tenant_id, 1) = $1
               AND COALESCE(e.expense_date::timestamptz, e.created_at) >= $2
               AND COALESCE(e.expense_date::timestamptz, e.created_at) <= $3
               ${catClause}
             ORDER BY COALESCE(e.expense_date, e.created_at::date) DESC, e.id DESC`,
            params
        );
        res.json({ expenses: r.rows });
    } catch (err) {
        console.error('GET /api/expenses error:', err);
        res.status(500).json({ message: 'Failed to load expenses' });
    }
});

router.post('/api/expenses', authenticateToken, requireRole(MANAGER_ROLES), requirePermission('expenses', 'create'), async (req, res) => {
    await ensureExpensesSchema();
    const tenantId = req.user.tenant_id || 1;
    const { category, amount, description = '', expense_date, store_location = '', reference_no = '' } = req.body || {};
    const numAmt = Number(amount);
    if (!category || !Number.isFinite(numAmt) || numAmt <= 0) {
        return res.status(400).json({ message: 'Category and a positive amount are required' });
    }
    try {
        const r = await pool.query(
            `INSERT INTO expenses (tenant_id, category, amount, description, expense_date, branch_id, store_location, reference_no, created_by)
             VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6, $7, $8, $9) RETURNING *`,
            [tenantId, String(category).trim(), numAmt, String(description || ''), expense_date || null, req.user.store_id || (await mainBranchId(pool, tenantId)), String(store_location || req.user.store_location || ''), String(reference_no || ''), req.user.id || null]
        );
        await logActivity(req, 'EXPENSE_CREATED', { id: r.rows[0].id, category, amount: numAmt });
        res.status(201).json({ success: true, expense: r.rows[0] });
    } catch (err) {
        console.error('POST /api/expenses error:', err);
        res.status(500).json({ message: 'Failed to record expense' });
    }
});

router.delete('/api/expenses/:id', authenticateToken, requireRole(MANAGER_ROLES), requirePermission('expenses', 'delete'), async (req, res) => {
    await ensureExpensesSchema();
    const tenantId = req.user.tenant_id || 1;
    try {
        const r = await pool.query('DELETE FROM expenses WHERE id = $1 AND COALESCE(tenant_id, 1) = $2 RETURNING id', [req.params.id, tenantId]);
        if (!r.rows.length) return res.status(404).json({ message: 'Expense not found' });
        await logActivity(req, 'EXPENSE_DELETED', { id: req.params.id });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ message: 'Failed to delete expense' });
    }
});

module.exports = router;

