const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { authenticateToken, MANAGER_ROLES } = require('../middleware/auth');
const { logActivity } = require('../services/audit');
const { ensureGlSchema, seedTenantAccounts, postJournalEntry } = require('./accounting');

let payrollSchemaReady = false;
async function ensurePayrollSchema() {
    if (payrollSchemaReady) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS payroll_profiles (
            id SERIAL PRIMARY KEY,
            tenant_id INTEGER DEFAULT 1,
            user_id INTEGER NOT NULL,
            base_salary NUMERIC(12,2) NOT NULL DEFAULT 0,
            allowances NUMERIC(12,2) NOT NULL DEFAULT 0,
            ssnit_enabled BOOLEAN DEFAULT true,
            paye_enabled BOOLEAN DEFAULT true,
            bank_name VARCHAR(120) DEFAULT '',
            account_number VARCHAR(80) DEFAULT '',
            momo_number VARCHAR(40) DEFAULT '',
            ssnit_number VARCHAR(60) DEFAULT '',
            tin_number VARCHAR(60) DEFAULT '',
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS payroll_profiles_tenant_user_idx ON payroll_profiles (tenant_id, user_id);

        CREATE TABLE IF NOT EXISTS payroll_runs (
            id SERIAL PRIMARY KEY,
            tenant_id INTEGER DEFAULT 1,
            run_number VARCHAR(40) NOT NULL,
            pay_period VARCHAR(20) NOT NULL,
            pay_date DATE NOT NULL,
            total_gross NUMERIC(14,2) DEFAULT 0,
            total_ssnit_emp NUMERIC(14,2) DEFAULT 0,
            total_ssnit_er NUMERIC(14,2) DEFAULT 0,
            total_paye NUMERIC(14,2) DEFAULT 0,
            total_net NUMERIC(14,2) DEFAULT 0,
            status VARCHAR(20) DEFAULT 'posted',
            journal_entry_id INTEGER NULL,
            created_by INTEGER NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS payroll_items (
            id SERIAL PRIMARY KEY,
            tenant_id INTEGER DEFAULT 1,
            run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL,
            staff_name VARCHAR(160) NOT NULL,
            staff_role VARCHAR(60) DEFAULT '',
            base_salary NUMERIC(12,2) DEFAULT 0,
            allowances NUMERIC(12,2) DEFAULT 0,
            gross_pay NUMERIC(12,2) DEFAULT 0,
            ssnit_employee NUMERIC(12,2) DEFAULT 0,
            ssnit_employer NUMERIC(12,2) DEFAULT 0,
            taxable_income NUMERIC(12,2) DEFAULT 0,
            paye_tax NUMERIC(12,2) DEFAULT 0,
            other_deductions NUMERIC(12,2) DEFAULT 0,
            net_pay NUMERIC(12,2) DEFAULT 0,
            payment_method VARCHAR(40) DEFAULT 'Bank/MoMo'
        );
    `);
    payrollSchemaReady = true;
}

const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

// Standard GRA monthly PAYE progressive bands (in GH₵)
const PAYE_BANDS = [
    [490, 0],
    [110, 0.05],
    [130, 0.10],
    [3166.67, 0.175],
    [16000, 0.25],
    [30520, 0.30],
    [Infinity, 0.35]
];

function computeMonthlyPAYE(taxableIncome) {
    let remaining = Math.max(0, Number(taxableIncome || 0));
    let tax = 0;
    for (const [limit, rate] of PAYE_BANDS) {
        if (remaining <= 0) break;
        const slice = Math.min(remaining, limit);
        tax += slice * rate;
        remaining -= slice;
    }
    return round2(tax);
}

function computeStaffPay(profile, otherDeductions = 0) {
    const base = round2(profile.base_salary || 0);
    const allowances = round2(profile.allowances || 0);
    const gross = round2(base + allowances);
    const ssnitEmp = profile.ssnit_enabled !== false ? round2(base * 0.055) : 0;
    const ssnitEr = profile.ssnit_enabled !== false ? round2(base * 0.13) : 0;
    const taxable = Math.max(0, round2(gross - ssnitEmp));
    const paye = profile.paye_enabled !== false ? computeMonthlyPAYE(taxable) : 0;
    const deductions = round2(otherDeductions);
    const net = Math.max(0, round2(gross - ssnitEmp - paye - deductions));
    return {
        base_salary: base,
        allowances,
        gross_pay: gross,
        ssnit_employee: ssnitEmp,
        ssnit_employer: ssnitEr,
        taxable_income: taxable,
        paye_tax: paye,
        other_deductions: deductions,
        net_pay: net
    };
}

function requireManager(req, res) {
    if (!MANAGER_ROLES.includes((req.user.role || '').toLowerCase())) {
        res.status(403).json({ message: 'Manager or CEO access required' });
        return false;
    }
    return true;
}

router.get('/api/payroll/profiles', authenticateToken, async (req, res) => {
    if (!requireManager(req, res)) return;
    try {
        await ensurePayrollSchema();
        const tenantId = req.user.tenant_id || 1;
        const r = await pool.query(
            `SELECT u.id AS user_id, COALESCE(u.name, u.username, 'Staff') AS staff_name, u.username, u.role, u.store_location,
                    COALESCE(p.base_salary, 0)::numeric(12,2) AS base_salary,
                    COALESCE(p.allowances, 0)::numeric(12,2) AS allowances,
                    COALESCE(p.ssnit_enabled, true) AS ssnit_enabled,
                    COALESCE(p.paye_enabled, true) AS paye_enabled,
                    COALESCE(p.bank_name, '') AS bank_name,
                    COALESCE(p.account_number, '') AS account_number,
                    COALESCE(p.momo_number, '') AS momo_number,
                    COALESCE(p.ssnit_number, '') AS ssnit_number,
                    COALESCE(p.tin_number, '') AS tin_number
             FROM users u
             LEFT JOIN payroll_profiles p ON p.user_id = u.id AND COALESCE(p.tenant_id, 1) = $1
             WHERE COALESCE(u.tenant_id, 1) = $1
             ORDER BY staff_name ASC`,
            [tenantId]
        );
        const profiles = r.rows.map(row => ({ ...row, preview: computeStaffPay(row) }));
        res.json({ profiles });
    } catch (err) {
        console.error('GET /api/payroll/profiles error:', err);
        res.status(500).json({ message: 'Failed to load payroll profiles' });
    }
});

router.post('/api/payroll/profiles', authenticateToken, async (req, res) => {
    if (!requireManager(req, res)) return;
    try {
        await ensurePayrollSchema();
        const tenantId = req.user.tenant_id || 1;
        const userId = Number(req.body.user_id);
        const baseSalary = Number(req.body.base_salary || 0);
        const allowances = Number(req.body.allowances || 0);
        if (!userId || baseSalary < 0 || allowances < 0) {
            return res.status(400).json({ message: 'Valid staff user and non-negative salary/allowances required' });
        }
        const r = await pool.query(
            `INSERT INTO payroll_profiles (tenant_id, user_id, base_salary, allowances, ssnit_enabled, paye_enabled, bank_name, account_number, momo_number, ssnit_number, tin_number, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
             ON CONFLICT (tenant_id, user_id) DO UPDATE SET
                 base_salary = EXCLUDED.base_salary,
                 allowances = EXCLUDED.allowances,
                 ssnit_enabled = EXCLUDED.ssnit_enabled,
                 paye_enabled = EXCLUDED.paye_enabled,
                 bank_name = EXCLUDED.bank_name,
                 account_number = EXCLUDED.account_number,
                 momo_number = EXCLUDED.momo_number,
                 ssnit_number = EXCLUDED.ssnit_number,
                 tin_number = EXCLUDED.tin_number,
                 updated_at = NOW()
             RETURNING *`,
            [
                tenantId, userId, baseSalary, allowances,
                req.body.ssnit_enabled !== false,
                req.body.paye_enabled !== false,
                String(req.body.bank_name || '').slice(0, 120),
                String(req.body.account_number || '').slice(0, 80),
                String(req.body.momo_number || '').slice(0, 40),
                String(req.body.ssnit_number || '').slice(0, 60),
                String(req.body.tin_number || '').slice(0, 60)
            ]
        );
        await logActivity(req, 'PAYROLL_PROFILE_UPDATED', { user_id: userId, base_salary: baseSalary });
        res.json({ success: true, profile: r.rows[0] });
    } catch (err) {
        console.error('POST /api/payroll/profiles error:', err);
        res.status(500).json({ message: 'Failed to save payroll profile' });
    }
});

router.get('/api/payroll/runs', authenticateToken, async (req, res) => {
    if (!requireManager(req, res)) return;
    try {
        await ensurePayrollSchema();
        const tenantId = req.user.tenant_id || 1;
        const r = await pool.query(
            `SELECT * FROM payroll_runs WHERE COALESCE(tenant_id, 1) = $1 ORDER BY pay_date DESC, id DESC LIMIT 50`,
            [tenantId]
        );
        res.json({ runs: r.rows });
    } catch (err) {
        console.error('GET /api/payroll/runs error:', err);
        res.status(500).json({ message: 'Failed to load payroll runs' });
    }
});

router.get('/api/payroll/runs/:id', authenticateToken, async (req, res) => {
    if (!requireManager(req, res)) return;
    try {
        await ensurePayrollSchema();
        const tenantId = req.user.tenant_id || 1;
        const runRes = await pool.query('SELECT * FROM payroll_runs WHERE id = $1 AND COALESCE(tenant_id, 1) = $2', [req.params.id, tenantId]);
        if (!runRes.rows.length) return res.status(404).json({ message: 'Payroll run not found' });
        const itemsRes = await pool.query(
            `SELECT * FROM payroll_items WHERE run_id = $1 AND COALESCE(tenant_id, 1) = $2 ORDER BY staff_name ASC`,
            [req.params.id, tenantId]
        );
        res.json({ run: runRes.rows[0], items: itemsRes.rows });
    } catch (err) {
        console.error('GET /api/payroll/runs/:id error:', err);
        res.status(500).json({ message: 'Failed to load payroll run details' });
    }
});

router.post('/api/payroll/runs', authenticateToken, async (req, res) => {
    if (!requireManager(req, res)) return;
    const client = await pool.connect();
    try {
        await ensurePayrollSchema();
        await ensureGlSchema();
        await client.query('BEGIN');
        const tenantId = req.user.tenant_id || 1;
        const payPeriod = String(req.body.pay_period || new Date().toISOString().slice(0, 7));
        const payDate = req.body.pay_date || new Date().toISOString().slice(0, 10);
        const postToGl = req.body.post_to_gl !== false;

        const staffRes = await client.query(
            `SELECT u.id AS user_id, COALESCE(u.name, u.username, 'Staff') AS staff_name, u.role,
                    p.base_salary, p.allowances, p.ssnit_enabled, p.paye_enabled, p.bank_name, p.momo_number
             FROM users u
             JOIN payroll_profiles p ON p.user_id = u.id AND COALESCE(p.tenant_id, 1) = $1
             WHERE COALESCE(u.tenant_id, 1) = $1 AND (COALESCE(p.base_salary, 0) > 0 OR COALESCE(p.allowances, 0) > 0)
             ORDER BY staff_name ASC`,
            [tenantId]
        );
        if (!staffRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'No staff have a configured salary greater than zero' });
        }

        const calculated = staffRes.rows.map(s => ({
            ...s,
            ...computeStaffPay(s),
            payment_method: s.bank_name ? `Bank (${s.bank_name})` : (s.momo_number ? `MoMo (${s.momo_number})` : 'Cash / Transfer')
        }));

        const totals = calculated.reduce((acc, c) => {
            acc.gross += c.gross_pay;
            acc.ssnitEmp += c.ssnit_employee;
            acc.ssnitEr += c.ssnit_employer;
            acc.paye += c.paye_tax;
            acc.net += c.net_pay;
            return acc;
        }, { gross: 0, ssnitEmp: 0, ssnitEr: 0, paye: 0, net: 0 });

        const runNum = 'PAY-' + payPeriod.replace(/[^0-9]/g, '') + '-' + Math.floor(100 + Math.random() * 900);
        let journalEntryId = null;

        if (postToGl && totals.gross > 0) {
            await seedTenantAccounts(tenantId, client);
            const accRes = await client.query(
                `SELECT id, code FROM gl_accounts WHERE COALESCE(tenant_id, 1) = $1 AND code IN ('6100','6110','2200','2300')`,
                [tenantId]
            );
            const byCode = Object.fromEntries(accRes.rows.map(a => [a.code, a.id]));
            if (byCode['6100'] && byCode['6110'] && byCode['2200'] && byCode['2300']) {
                const glLines = [
                    { account_id: byCode['6100'], description: `Gross Salaries (${payPeriod})`, debit: round2(totals.gross), credit: 0 }
                ];
                if (round2(totals.ssnitEr) > 0) {
                    glLines.push({ account_id: byCode['6110'], description: `Employer SSNIT 13% (${payPeriod})`, debit: round2(totals.ssnitEr), credit: 0 });
                }
                const statPayable = round2(totals.ssnitEmp + totals.ssnitEr + totals.paye);
                if (statPayable > 0) {
                    glLines.push({ account_id: byCode['2200'], description: `PAYE & SSNIT Payable (${payPeriod})`, debit: 0, credit: statPayable });
                }
                if (round2(totals.net) > 0) {
                    glLines.push({ account_id: byCode['2300'], description: `Net Salaries Payable (${payPeriod})`, debit: 0, credit: round2(totals.net) });
                }
                const entry = await postJournalEntry(client, {
                    tenantId,
                    entryDate: payDate,
                    reference: runNum,
                    memo: `Payroll Run ${payPeriod}`,
                    source: 'payroll',
                    createdBy: req.user.id || null,
                    lines: glLines
                });
                journalEntryId = entry.id;
            }
        }

        const rRes = await client.query(
            `INSERT INTO payroll_runs (tenant_id, run_number, pay_period, pay_date, total_gross, total_ssnit_emp, total_ssnit_er, total_paye, total_net, journal_entry_id, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
            [tenantId, runNum, payPeriod, payDate, round2(totals.gross), round2(totals.ssnitEmp), round2(totals.ssnitEr), round2(totals.paye), round2(totals.net), journalEntryId, req.user.id || null]
        );
        const run = rRes.rows[0];

        for (const item of calculated) {
            await client.query(
                `INSERT INTO payroll_items (tenant_id, run_id, user_id, staff_name, staff_role, base_salary, allowances, gross_pay, ssnit_employee, ssnit_employer, taxable_income, paye_tax, other_deductions, net_pay, payment_method)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
                [tenantId, run.id, item.user_id, item.staff_name, item.role || '', item.base_salary, item.allowances, item.gross_pay, item.ssnit_employee, item.ssnit_employer, item.taxable_income, item.paye_tax, item.other_deductions, item.net_pay, item.payment_method]
            );
        }

        await client.query('COMMIT');
        await logActivity(req, 'PAYROLL_RUN_POSTED', { run_number: runNum, pay_period: payPeriod, total_net: round2(totals.net) });
        res.status(201).json({ success: true, run });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('POST /api/payroll/runs error:', err);
        res.status(500).json({ message: err.message || 'Failed to post payroll run' });
    } finally {
        client.release();
    }
});

module.exports = router;

