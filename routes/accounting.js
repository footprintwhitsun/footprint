const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { authenticateToken, MANAGER_ROLES } = require('../middleware/auth');
const { logActivity } = require('../services/audit');

let glSchemaReady = false;
async function ensureGlSchema() {
    if (glSchemaReady) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS gl_accounts (
            id SERIAL PRIMARY KEY,
            tenant_id INTEGER DEFAULT 1,
            code VARCHAR(20) NOT NULL,
            name VARCHAR(120) NOT NULL,
            type VARCHAR(20) NOT NULL,
            normal_balance VARCHAR(10) NOT NULL,
            is_system BOOLEAN DEFAULT false,
            is_active BOOLEAN DEFAULT true,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS gl_accounts_tenant_code_idx ON gl_accounts (tenant_id, code);

        CREATE TABLE IF NOT EXISTS gl_journal_entries (
            id SERIAL PRIMARY KEY,
            tenant_id INTEGER DEFAULT 1,
            entry_number VARCHAR(40) NOT NULL,
            entry_date DATE NOT NULL,
            reference VARCHAR(120) DEFAULT '',
            memo TEXT DEFAULT '',
            source VARCHAR(40) DEFAULT 'manual',
            created_by INTEGER NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS gl_journal_lines (
            id SERIAL PRIMARY KEY,
            tenant_id INTEGER DEFAULT 1,
            entry_id INTEGER NOT NULL REFERENCES gl_journal_entries(id) ON DELETE CASCADE,
            account_id INTEGER NOT NULL REFERENCES gl_accounts(id),
            description VARCHAR(255) DEFAULT '',
            debit NUMERIC(14,2) DEFAULT 0,
            credit NUMERIC(14,2) DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS bank_statement_lines (
            id SERIAL PRIMARY KEY,
            tenant_id INTEGER DEFAULT 1,
            account_id INTEGER NOT NULL REFERENCES gl_accounts(id),
            txn_date DATE NOT NULL,
            description VARCHAR(255) NOT NULL,
            reference VARCHAR(120) DEFAULT '',
            amount NUMERIC(14,2) NOT NULL,
            status VARCHAR(20) DEFAULT 'unmatched',
            matched_entry_id INTEGER NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    `);
    glSchemaReady = true;
}

const DEFAULT_ACCOUNTS = [
    ['1000', 'Cash on Hand', 'Asset', 'debit'],
    ['1010', 'Bank Account', 'Asset', 'debit'],
    ['1020', 'Mobile Money Merchant', 'Asset', 'debit'],
    ['1100', 'Accounts Receivable', 'Asset', 'debit'],
    ['1200', 'Inventory Asset', 'Asset', 'debit'],
    ['2000', 'Accounts Payable', 'Liability', 'credit'],
    ['2100', 'VAT / Tax Payable', 'Liability', 'credit'],
    ['2200', 'PAYE & SSNIT Payable', 'Liability', 'credit'],
    ['2300', 'Net Salaries Payable', 'Liability', 'credit'],
    ['3000', "Owner's Equity", 'Equity', 'credit'],
    ['3100', 'Retained Earnings', 'Equity', 'credit'],
    ['4000', 'Sales Revenue', 'Revenue', 'credit'],
    ['5000', 'Cost of Goods Sold', 'Expense', 'debit'],
    ['6000', 'Operating Expenses', 'Expense', 'debit'],
    ['6100', 'Payroll & Wages Expense', 'Expense', 'debit'],
    ['6110', 'Employer SSNIT Expense', 'Expense', 'debit']
];

async function seedTenantAccounts(tenantId, client = pool) {
    const existing = await client.query('SELECT COUNT(*)::int AS cnt FROM gl_accounts WHERE COALESCE(tenant_id, 1) = $1', [tenantId]);
    if ((existing.rows[0]?.cnt || 0) > 0) return;
    for (const [code, name, type, normalBalance] of DEFAULT_ACCOUNTS) {
        await client.query(
            `INSERT INTO gl_accounts (tenant_id, code, name, type, normal_balance, is_system)
             VALUES ($1, $2, $3, $4, $5, true) ON CONFLICT DO NOTHING`,
            [tenantId, code, name, type, normalBalance]
        );
    }
}

function requireManager(req, res) {
    if (!MANAGER_ROLES.includes((req.user.role || '').toLowerCase())) {
        res.status(403).json({ message: 'Manager or CEO access required' });
        return false;
    }
    return true;
}

router.get('/api/gl/accounts', authenticateToken, async (req, res) => {
    if (!requireManager(req, res)) return;
    try {
        await ensureGlSchema();
        const tenantId = req.user.tenant_id || 1;
        await seedTenantAccounts(tenantId);
        const r = await pool.query(
            `SELECT a.*,
                    COALESCE(SUM(l.debit), 0)::numeric(14,2) AS total_debit,
                    COALESCE(SUM(l.credit), 0)::numeric(14,2) AS total_credit
             FROM gl_accounts a
             LEFT JOIN gl_journal_lines l ON l.account_id = a.id AND COALESCE(l.tenant_id, 1) = $1
             WHERE COALESCE(a.tenant_id, 1) = $1
             GROUP BY a.id
             ORDER BY a.code ASC`,
            [tenantId]
        );
        const accounts = r.rows.map(a => {
            const d = Number(a.total_debit || 0);
            const c = Number(a.total_credit || 0);
            const balance = a.normal_balance === 'debit' ? Number((d - c).toFixed(2)) : Number((c - d).toFixed(2));
            return { ...a, total_debit: d, total_credit: c, balance };
        });
        res.json({ accounts });
    } catch (err) {
        console.error('GET /api/gl/accounts error:', err);
        res.status(500).json({ message: 'Failed to load Chart of Accounts' });
    }
});

router.post('/api/gl/accounts', authenticateToken, async (req, res) => {
    if (!requireManager(req, res)) return;
    try {
        await ensureGlSchema();
        const tenantId = req.user.tenant_id || 1;
        const code = String(req.body.code || '').trim();
        const name = String(req.body.name || '').trim();
        const type = String(req.body.type || '').trim();
        if (!code || !name || !['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'].includes(type)) {
            return res.status(400).json({ message: 'Valid code, name, and account type are required' });
        }
        const normalBalance = ['Asset', 'Expense'].includes(type) ? 'debit' : 'credit';
        const r = await pool.query(
            `INSERT INTO gl_accounts (tenant_id, code, name, type, normal_balance, is_system)
             VALUES ($1, $2, $3, $4, $5, false) RETURNING *`,
            [tenantId, code, name, type, normalBalance]
        );
        await logActivity(req, 'GL_ACCOUNT_CREATED', { code, name, type });
        res.status(201).json({ success: true, account: r.rows[0] });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ message: 'Account code already exists' });
        console.error('POST /api/gl/accounts error:', err);
        res.status(500).json({ message: 'Failed to create account' });
    }
});

router.get('/api/gl/journal', authenticateToken, async (req, res) => {
    if (!requireManager(req, res)) return;
    try {
        await ensureGlSchema();
        const tenantId = req.user.tenant_id || 1;
        await seedTenantAccounts(tenantId);
        const entriesRes = await pool.query(
            `SELECT * FROM gl_journal_entries WHERE COALESCE(tenant_id, 1) = $1 ORDER BY entry_date DESC, id DESC LIMIT 100`,
            [tenantId]
        );
        const entryIds = entriesRes.rows.map(e => e.id);
        let linesByEntry = {};
        if (entryIds.length) {
            const linesRes = await pool.query(
                `SELECT l.*, a.code AS account_code, a.name AS account_name
                 FROM gl_journal_lines l
                 JOIN gl_accounts a ON a.id = l.account_id
                 WHERE COALESCE(l.tenant_id, 1) = $1 AND l.entry_id = ANY($2::int[])
                 ORDER BY l.id ASC`,
                [tenantId, entryIds]
            );
            for (const line of linesRes.rows) {
                if (!linesByEntry[line.entry_id]) linesByEntry[line.entry_id] = [];
                linesByEntry[line.entry_id].push(line);
            }
        }
        const entries = entriesRes.rows.map(e => ({ ...e, lines: linesByEntry[e.id] || [] }));
        res.json({ entries });
    } catch (err) {
        console.error('GET /api/gl/journal error:', err);
        res.status(500).json({ message: 'Failed to load journal entries' });
    }
});

async function postJournalEntry(client, { tenantId, entryDate, reference = '', memo = '', source = 'manual', createdBy = null, lines = [] }) {
    await seedTenantAccounts(tenantId, client);
    if (!Array.isArray(lines) || lines.length < 2) {
        throw Object.assign(new Error('At least 2 journal lines are required'), { statusCode: 400 });
    }
    let totalDebit = 0;
    let totalCredit = 0;
    const cleanLines = [];
    for (const ln of lines) {
        const accountId = Number(ln.account_id);
        const debit = Number(Number(ln.debit || 0).toFixed(2));
        const credit = Number(Number(ln.credit || 0).toFixed(2));
        if (!accountId || debit < 0 || credit < 0 || (debit === 0 && credit === 0)) {
            throw Object.assign(new Error('Each line needs an account and a positive debit or credit'), { statusCode: 400 });
        }
        totalDebit += debit;
        totalCredit += credit;
        cleanLines.push({ accountId, description: String(ln.description || '').slice(0, 255), debit, credit });
    }
    if (totalDebit <= 0 || Math.abs(totalDebit - totalCredit) >= 0.01) {
        throw Object.assign(new Error(`Journal entry is out of balance (Debits: ${totalDebit.toFixed(2)}, Credits: ${totalCredit.toFixed(2)})`), { statusCode: 400 });
    }
    const entryNum = 'JE-' + Date.now() + '-' + Math.floor(100 + Math.random() * 900);
    const eRes = await client.query(
        `INSERT INTO gl_journal_entries (tenant_id, entry_number, entry_date, reference, memo, source, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [tenantId, entryNum, entryDate, reference, memo, source, createdBy]
    );
    const entry = eRes.rows[0];
    for (const ln of cleanLines) {
        await client.query(
            `INSERT INTO gl_journal_lines (tenant_id, entry_id, account_id, description, debit, credit)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [tenantId, entry.id, ln.accountId, ln.description, ln.debit, ln.credit]
        );
    }
    return entry;
}

router.post('/api/gl/journal', authenticateToken, async (req, res) => {
    if (!requireManager(req, res)) return;
    const client = await pool.connect();
    try {
        await ensureGlSchema();
        await client.query('BEGIN');
        const tenantId = req.user.tenant_id || 1;
        const entryDate = req.body.entry_date || new Date().toISOString().slice(0, 10);
        const entry = await postJournalEntry(client, {
            tenantId,
            entryDate,
            reference: String(req.body.reference || ''),
            memo: String(req.body.memo || ''),
            source: 'manual',
            createdBy: req.user.id || null,
            lines: req.body.lines
        });
        await client.query('COMMIT');
        await logActivity(req, 'GL_JOURNAL_POSTED', { entry_number: entry.entry_number, memo: entry.memo });
        res.status(201).json({ success: true, entry });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        res.status(err.statusCode || 500).json({ message: err.message || 'Failed to post journal entry' });
    } finally {
        client.release();
    }
});

router.get('/api/gl/trial-balance', authenticateToken, async (req, res) => {
    if (!requireManager(req, res)) return;
    try {
        await ensureGlSchema();
        const tenantId = req.user.tenant_id || 1;
        await seedTenantAccounts(tenantId);
        const asOf = req.query.as_of || new Date().toISOString().slice(0, 10);
        const r = await pool.query(
            `SELECT a.id, a.code, a.name, a.type, a.normal_balance,
                    COALESCE(SUM(CASE WHEN e.entry_date <= $2::date THEN l.debit ELSE 0 END), 0)::numeric(14,2) AS debit,
                    COALESCE(SUM(CASE WHEN e.entry_date <= $2::date THEN l.credit ELSE 0 END), 0)::numeric(14,2) AS credit
             FROM gl_accounts a
             LEFT JOIN gl_journal_lines l ON l.account_id = a.id AND COALESCE(l.tenant_id, 1) = $1
             LEFT JOIN gl_journal_entries e ON e.id = l.entry_id AND COALESCE(e.tenant_id, 1) = $1
             WHERE COALESCE(a.tenant_id, 1) = $1
             GROUP BY a.id
             ORDER BY a.code ASC`,
            [tenantId, asOf]
        );
        let totalDebit = 0;
        let totalCredit = 0;
        const summary = { Asset: 0, Liability: 0, Equity: 0, Revenue: 0, Expense: 0 };
        const rows = r.rows.map(row => {
            const d = Number(row.debit || 0);
            const c = Number(row.credit || 0);
            totalDebit += d;
            totalCredit += c;
            const net = row.normal_balance === 'debit' ? Number((d - c).toFixed(2)) : Number((c - d).toFixed(2));
            if (summary[row.type] !== undefined) summary[row.type] += net;
            return { ...row, debit: d, credit: c, net_balance: net };
        });
        const netIncome = Number((summary.Revenue - summary.Expense).toFixed(2));
        res.json({
            as_of: asOf,
            rows,
            totals: { debit: Number(totalDebit.toFixed(2)), credit: Number(totalCredit.toFixed(2)), balanced: Math.abs(totalDebit - totalCredit) < 0.01 },
            balance_sheet: {
                assets: Number(summary.Asset.toFixed(2)),
                liabilities: Number(summary.Liability.toFixed(2)),
                equity: Number((summary.Equity + netIncome).toFixed(2)),
                net_income: netIncome
            }
        });
    } catch (err) {
        console.error('GET /api/gl/trial-balance error:', err);
        res.status(500).json({ message: 'Failed to compute trial balance' });
    }
});

router.get('/api/gl/reconcile', authenticateToken, async (req, res) => {
    if (!requireManager(req, res)) return;
    try {
        await ensureGlSchema();
        const tenantId = req.user.tenant_id || 1;
        await seedTenantAccounts(tenantId);
        const accountId = Number(req.query.account_id || 0);
        if (!accountId) return res.json({ statement_lines: [], ledger_lines: [], summary: { statement_total: 0, cleared_total: 0, ledger_balance: 0, difference: 0 } });

        const [stmtRes, ledRes] = await Promise.all([
            pool.query(
                `SELECT * FROM bank_statement_lines WHERE COALESCE(tenant_id, 1) = $1 AND account_id = $2 ORDER BY txn_date DESC, id DESC LIMIT 200`,
                [tenantId, accountId]
            ),
            pool.query(
                `SELECT l.id, l.entry_id, e.entry_number, e.entry_date, e.reference, e.memo, l.debit, l.credit
                 FROM gl_journal_lines l
                 JOIN gl_journal_entries e ON e.id = l.entry_id
                 WHERE COALESCE(l.tenant_id, 1) = $1 AND l.account_id = $2
                 ORDER BY e.entry_date DESC, l.id DESC LIMIT 200`,
                [tenantId, accountId]
            )
        ]);
        const statementTotal = stmtRes.rows.reduce((s, r) => s + Number(r.amount || 0), 0);
        const clearedTotal = stmtRes.rows.filter(r => r.status === 'matched').reduce((s, r) => s + Number(r.amount || 0), 0);
        const ledgerBalance = ledRes.rows.reduce((s, r) => s + Number(r.debit || 0) - Number(r.credit || 0), 0);
        res.json({
            statement_lines: stmtRes.rows,
            ledger_lines: ledRes.rows,
            summary: {
                statement_total: Number(statementTotal.toFixed(2)),
                cleared_total: Number(clearedTotal.toFixed(2)),
                ledger_balance: Number(ledgerBalance.toFixed(2)),
                difference: Number((statementTotal - ledgerBalance).toFixed(2))
            }
        });
    } catch (err) {
        console.error('GET /api/gl/reconcile error:', err);
        res.status(500).json({ message: 'Failed to load reconciliation data' });
    }
});

router.post('/api/gl/reconcile/import', authenticateToken, async (req, res) => {
    if (!requireManager(req, res)) return;
    try {
        await ensureGlSchema();
        const tenantId = req.user.tenant_id || 1;
        const accountId = Number(req.body.account_id);
        const lines = Array.isArray(req.body.lines) ? req.body.lines : [req.body];
        if (!accountId || !lines.length) return res.status(400).json({ message: 'Account and at least one statement line are required' });

        let inserted = 0;
        for (const ln of lines) {
            const amount = Number(ln.amount);
            const desc = String(ln.description || '').trim();
            if (!desc || !Number.isFinite(amount)) continue;
            await pool.query(
                `INSERT INTO bank_statement_lines (tenant_id, account_id, txn_date, description, reference, amount)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [tenantId, accountId, ln.txn_date || new Date().toISOString().slice(0, 10), desc.slice(0, 255), String(ln.reference || '').slice(0, 120), amount]
            );
            inserted++;
        }
        res.status(201).json({ success: true, inserted });
    } catch (err) {
        console.error('POST /api/gl/reconcile/import error:', err);
        res.status(500).json({ message: 'Failed to import statement lines' });
    }
});

router.post('/api/gl/reconcile/:id/toggle', authenticateToken, async (req, res) => {
    if (!requireManager(req, res)) return;
    try {
        await ensureGlSchema();
        const tenantId = req.user.tenant_id || 1;
        const cur = await pool.query('SELECT * FROM bank_statement_lines WHERE id = $1 AND COALESCE(tenant_id, 1) = $2', [req.params.id, tenantId]);
        if (!cur.rows.length) return res.status(404).json({ message: 'Statement line not found' });
        const nextStatus = cur.rows[0].status === 'matched' ? 'unmatched' : 'matched';
        const r = await pool.query(
            `UPDATE bank_statement_lines SET status = $1 WHERE id = $2 AND COALESCE(tenant_id, 1) = $3 RETURNING *`,
            [nextStatus, req.params.id, tenantId]
        );
        res.json({ success: true, line: r.rows[0] });
    } catch (err) {
        console.error('POST /api/gl/reconcile/:id/toggle error:', err);
        res.status(500).json({ message: 'Failed to update reconciliation status' });
    }
});

module.exports = router;
module.exports.ensureGlSchema = ensureGlSchema;
module.exports.seedTenantAccounts = seedTenantAccounts;
module.exports.postJournalEntry = postJournalEntry;

