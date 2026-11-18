const test = require('node:test');
const assert = require('node:assert/strict');
const b = require('../services/branches');

test('toQty keeps fractions to 3 decimals and turns junk into 0', () => {
    assert.equal(b.toQty('2.5'), 2.5);
    assert.equal(b.toQty(3.75), 3.75);
    assert.equal(b.toQty('2.50049'), 2.5);
    assert.equal(b.toQty('2.5006'), 2.501);
    assert.equal(b.toQty(' 7 '), 7);
    assert.equal(b.toQty(-2), -2);
    for (const junk of ['', null, undefined, 'abc', NaN, Infinity, {}, []]) assert.equal(b.toQty(junk), 0, String(junk));
});

test('pickStockKey reuses a key that already holds stock, whatever its spelling, before inventing one', () => {
    assert.equal(b.pickStockKey({ 'Accra Branch': 5 }, ['Accra', 'Accra Branch']), 'Accra Branch');   // legacy key in use
    assert.equal(b.pickStockKey({ 'main warehouse': 5 }, ['Main Warehouse']), 'main warehouse');       // case differs
    assert.equal(b.pickStockKey({ ' Main A ': 1 }, ['main a']), ' Main A ');                           // spaces differ
    assert.equal(b.pickStockKey({}, ['Dzorwulu', 'Main Warehouse']), 'Dzorwulu');                       // none yet -> the branch's own name
    assert.equal(b.pickStockKey(null, ['Kumasi']), 'Kumasi');
    assert.equal(b.pickStockKey('{"Kumasi Branch": 2}', ['Kumasi', 'Kumasi Branch']), 'Kumasi Branch'); // JSON as a string
    assert.equal(b.pickStockKey({}, []), b.DEFAULT_BRANCH_NAME);
    assert.equal(b.pickStockKey({ A: 1 }, [null, '', '  ', 'A']), 'A');
});

function fakeDb({ branches = [], products = {} }) {
    const calls = [];
    return {
        calls,
        query: async (sql, params) => {
            calls.push(params);
            if (/FROM branches/.test(sql)) {
                if (/WHERE id = \$1/.test(sql)) return { rows: branches.filter((x) => x.id === Number(params[0]) && x.tenant_id === params[1]).slice(0, 1) };
                return { rows: branches.filter((x) => x.tenant_id === params[0]).sort((a, c) => (c.is_main ? 1 : 0) - (a.is_main ? 1 : 0) || a.id - c.id).slice(0, 1) };
            }
            if (/FROM products/.test(sql)) { const p = products[params[0] + '|' + params[1]]; return { rows: p ? [{ stock_levels: p }] : [] }; }
            return { rows: [] };
        }
    };
}

test('resolveStockKey uses the real branch name, not one guessed from the id', async () => {
    const db = fakeDb({ branches: [{ id: 2, name: 'Tema Depot', location: 'Tema', tenant_id: 1 }] });
    assert.equal(await b.resolveStockKey(db, { tenantId: 1, branchId: 2, barcode: 'X', fallbackName: null }), 'Tema Depot');   // was "Accra Branch"
});

test('resolveStockKey keeps writing to a legacy key if that is where the product already has stock', async () => {
    const db = fakeDb({ branches: [{ id: 2, name: 'Tema Depot', location: 'Tema', tenant_id: 1 }], products: { 'X|1': { 'Accra Branch': 9 } } });
    assert.equal(await b.resolveStockKey(db, { tenantId: 1, branchId: 2, barcode: 'X', fallbackName: null }), 'Accra Branch');
});

test('resolveStockKey does not see another tenant\'s branch', async () => {
    const db = fakeDb({ branches: [{ id: 2, name: 'Other Tenant Depot', location: '', tenant_id: 2 }] });
    const key = await b.resolveStockKey(db, { tenantId: 1, branchId: 2, barcode: 'X', fallbackName: 'My Shop' });
    assert.equal(key, 'My Shop');
    assert.equal(await b.loadBranch(db, 1, 2), null);
});

test('mainBranchName prefers the tenant\'s main branch and falls back to the default', async () => {
    const db = fakeDb({ branches: [{ id: 5, name: 'Second', location: '', tenant_id: 1, is_main: false }, { id: 9, name: 'Head Office', location: '', tenant_id: 1, is_main: true }] });
    assert.equal(await b.mainBranchName(db, 1), 'Head Office');
    assert.equal(await b.mainBranchName(fakeDb({}), 1), b.DEFAULT_BRANCH_NAME);
    assert.equal(await b.mainBranchName({ query: async () => { throw new Error('down'); } }, 1), b.DEFAULT_BRANCH_NAME);
});

test('mainBranchId is the tenant\'s own main branch, cached, and never another tenant\'s id 1', async () => {
    const calls = [];
    const db = { query: async (sql, params) => { calls.push(params); return { rows: params[0] === 7 ? [{ id: 42, name: 'HQ', location: '' }] : [] }; } };
    assert.equal(await b.mainBranchId(db, 7), 42);
    assert.equal(await b.mainBranchId(db, 7), 42);           // cached: one query
    assert.equal(calls.filter((p) => p[0] === 7).length, 1);
    assert.equal(await b.mainBranchId(db, 8), 1);            // tenant with no branch row: the last-resort default
    assert.equal(await b.mainBranchId({ query: async () => { throw new Error('down'); } }, 9), 1);
});

test('No route guesses a branch name or id from a literal any more', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const ROOT = path.resolve(__dirname, '..');
    const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const server = read('server.js');
    assert.ok(!/Accra Branch|Kumasi Branch/.test(server), 'branch names must come from the branches table');
    assert.ok(!/(branch_id|bId) == [23] \?/.test(server), 'no id-to-name guessing');
    assert.ok(!/store_id \|\| 1\b|StoreId \|\| 1\b|branchId = 1\b/.test(server), 'the default branch is the tenant\'s main branch, not id 1');
    for (const f of ['server.js', 'routes/pos.js', 'routes/extras.js']) {
        assert.ok(!/\|\| 'Main (Warehouse|Branch|Shop)'/.test(read(f)), `${f}: use DEFAULT_BRANCH_NAME`);
    }
    assert.ok(!/WHERE id = 1\b[^;]*branches|branches[^;]*WHERE id = 1\b/.test(server.replace(/--[^\n]*/g, '')), 'no "branch id = 1" lookups');
    assert.ok(!/parseInt\([^)]*(levelsObj|stockLevels\[|levels\[|physicalQty|row\.stock|existingProduct\.stock)/.test(server), 'stock quantities are never truncated with parseInt');
    assert.ok(server.includes("jsonb_build_object($2::text, COALESCE(stock, 0))"), 'initial stock_levels use the tenant\'s main branch name');
    assert.ok(/toQty\(item\.variance\) !== 0/.test(server), 'NUMERIC variance arrives as a string: compare as a number');
});

test('Reorder alerts are per tenant; the code falls back until migration 008 has run', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(server.includes("upsert('(tenant_id, product_barcode)')") && server.includes("e.code !== '42P10'") && server.includes("upsert('(product_barcode)')"));
    const mig = fs.readFileSync(path.join(__dirname, '..', 'migrations', '008_reorder_alerts_per_tenant.sql'), 'utf8');
    assert.match(mig, /UNIQUE \(product_barcode\)/);
    assert.match(mig, /CREATE UNIQUE INDEX IF NOT EXISTS idx_reorder_alerts_tenant_barcode ON reorder_alerts \(tenant_id, product_barcode\)/);
});

test('initDb creates the branch columns and balance_due before anything reads them (found on a fresh database)', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const backfill = server.indexOf('-- 1. Initialize stock_levels from stock if missing');
    const alter = server.indexOf('ALTER TABLE branches ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES tenants(id) DEFAULT 1;');
    assert.ok(alter > -1 && backfill > -1 && alter < backfill, 'branches.tenant_id/is_main/deleted_at must exist before the main-branch backfill uses them');
    assert.ok(server.includes('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS balance_due'), 'the dashboard needs transactions.balance_due from boot');
});

test('Until migration 008 runs, a reorder alert never overwrites another tenant\'s row', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(server.includes('WHERE reorder_alerts.tenant_id = EXCLUDED.tenant_id'));
    assert.ok(server.includes("e2.code !== '42501'"), 'a row-level-security refusal skips that alert instead of failing the check');
});
