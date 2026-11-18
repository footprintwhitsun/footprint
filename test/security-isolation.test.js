const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('RLS saasTables includes newly covered operational tables', () => {
    const server = read('server.js');
    const required = [
        'products', 'suppliers', 'purchase_orders', 'purchase_order_items',
        'delivery_notes', 'pos_holds', 'pos_quotations', 'pos_approval_tokens',
        'layaways', 'layaway_payments', 'staff_attendance', 'cash_accounts',
        'branch_targets', 'cash_drops', 'daily_closes', 'brands',
        'unit_conversions', 'price_history', 'customer_groups', 'customer_sites',
        'supplier_payments', 'roles'
    ];
    for (const tbl of required) {
        assert.ok(server.includes(`'${tbl}'`), `Expected ${tbl} in saasTables`);
    }
});

test('Purchase orders and auth-code endpoints are role-gated and tenant-scoped', () => {
    const server = read('server.js');
    assert.match(server, /app\.get\('\/api\/purchase-orders',\s*authenticateToken,\s*requireRole\(MANAGER_ROLES\)/);
    assert.match(server, /app\.post\('\/api\/purchase-orders',\s*authenticateToken,\s*requireRole\(MANAGER_ROLES\),\s*requirePermission\('purchases',\s*'create'\)/);
    assert.match(server, /app\.post\('\/api\/purchase-orders\/:id\/receive',\s*authenticateToken,\s*requireRole\(MANAGER_ROLES\),\s*requirePermission\('purchases',\s*'edit'\)/);
    assert.match(server, /app\.post\('\/api\/settings\/auth-code',\s*authenticateToken,\s*requireRole\(MANAGER_ROLES\),\s*requirePermission\('settings',\s*'edit'\)/);
    assert.ok(!server.includes("SELECT MAX(id) as max_id FROM system_settings"), 'MAX(id)+1 race should be removed');
});

test('catalog-ops, extras, ceo-live, pos, and backups enforce tenant isolation', () => {
    const catalog = read('routes/catalog-ops.js');
    assert.ok(catalog.includes('brands_tenant_name_idx'), 'brands unique index must be per-tenant');
    assert.ok(catalog.includes('customer_groups_tenant_name_idx'), 'customer_groups unique index must be per-tenant');
    assert.ok(catalog.includes("requirePermission('prices', 'edit')"), 'bulk-apply should enforce requirePermission');

    const extras = read('routes/extras.js');
    assert.ok(extras.includes('layaways_tenant_number_idx'), 'layaways unique index must be per-tenant');
    assert.ok(extras.includes('ALTER TABLE layaway_payments ADD COLUMN IF NOT EXISTS tenant_id'), 'layaway_payments must have tenant_id');

    const ceoLive = read('routes/ceo-live.js');
    assert.ok(ceoLive.includes('WHERE COALESCE(po.tenant_id, 1) = $1'), 'ceo-live payables must be tenant-scoped');
    assert.ok(ceoLive.includes('WHERE id = $1 AND COALESCE(tenant_id, 1) = $2 FOR UPDATE'), 'supplier-payments PO lookup must be tenant-scoped');

    const pos = read('routes/pos.js');
    assert.ok(pos.includes('pos_quotations_tenant_number_idx'), 'pos_quotations unique index must be per-tenant');
    assert.ok(pos.includes('delivery_notes_tenant_number_idx'), 'delivery_notes unique index must be per-tenant');
    assert.ok(pos.includes('ALTER TABLE pos_approval_tokens ADD COLUMN IF NOT EXISTS tenant_id'), 'pos_approval_tokens must have tenant_id');
    assert.ok(pos.includes("SET status = 'converted'"), 'quotation convert must persist converted status');

    const backups = read('routes/backups.js');
    assert.ok(backups.includes('SELECT id FROM tenants ORDER BY id ASC'), 'nightly backups must iterate all tenants');
});

test('CSP removes unsafe-eval, /healthz exists, product_batches & company portal are tenant-safe', () => {
    const security = read('security.js');
    assert.ok(!security.includes("'unsafe-eval'"), 'CSP should not allow unsafe-eval');
    const server = read('server.js');
    assert.ok(server.includes("app.get('/healthz'"), '/healthz route must exist');
    assert.ok(server.includes('product_batches_tenant_barcode_batch_branch_key'), 'product_batches must use per-tenant unique constraint');
    assert.ok(!server.includes('ON CONFLICT (product_barcode, batch_number, branch_id)'), 'non-tenant product_batches conflict target must not exist');
    assert.match(server, /app\.post\('\/api\/company\/proforma-invoices',\s*authenticateToken,\s*requireRole\(COMPANY_PORTAL_ROLES\)/);
    assert.match(server, /app\.get\('\/api\/company\/sales-invoices',\s*authenticateToken,\s*requireRole\(COMPANY_PORTAL_ROLES\)/);
    assert.match(server, /app\.post\('\/api\/company\/sales-invoices',\s*authenticateToken,\s*requireRole\(COMPANY_PORTAL_ROLES\)/);
    assert.match(server, /app\.get\('\/api\/company\/transactions',\s*authenticateToken,\s*requireRole\(COMPANY_PORTAL_ROLES\)/);
});

test('Live /healthz returns 200 ok:true when server is running', async (t) => {
    let res;
    try {
        res = await new Promise((resolve, reject) => {
            const req = http.get('http://127.0.0.1:8080/healthz', (r) => {
                let body = '';
                r.on('data', (c) => body += c);
                r.on('end', () => resolve({ status: r.statusCode, body }));
            });
            req.on('error', reject);
            req.setTimeout(5000, () => req.destroy(new Error('timeout')));
        });
    } catch (err) {
        if (err && (err.code === 'ECONNREFUSED' || err.message === 'timeout')) {
            t.skip('No live server on 127.0.0.1:8080 in this environment');
            return;
        }
        throw err;
    }
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.ok, true);
    assert.equal(json.db, 'connected');
});


test('Shelf move endpoint exists, is manager-only and tenant-scoped', () => {
    const server = read('server.js');
    assert.match(server, /app\.post\('\/api\/shelf\/move',\s*authenticateToken,\s*requireRole\(MANAGER_ROLES\)/);
    const start = server.indexOf("app.post('/api/shelf/move'");
    const body = server.slice(start, start + 4000);
    assert.ok(body.includes('COALESCE(tenant_id, 1) = $2'), 'product lookup must be tenant scoped');
    assert.ok(body.includes('req.user.id'), 'staff id must come from the login, not the request body');
});

test('Pages no longer call the non-existent /api/locations route', () => {
    for (const f of ['reports.html', 'stock-transfers.html']) {
        assert.ok(!read(f).includes('/api/locations'), `${f} must use /api/branches`);
    }
});

test('Saved report views are manager-only, per user and tenant-scoped', () => {
    const src = read('routes/reports-core.js');
    for (const verb of ['get', 'post', 'delete']) {
        assert.match(src, new RegExp(`router\\.${verb}\\('/api/reports/saved-views[^']*',\\s*authenticateToken,\\s*requireManager`));
    }
    assert.ok(src.includes('tenant_id = $1 AND user_id = $2'), 'listing must filter by tenant and user');
    assert.ok(src.includes('id = $1 AND tenant_id = $2 AND user_id = $3'), 'delete must filter by tenant and user');
});

test('Parked POS orders are stored in the database, not only in the browser', () => {
    const pos = read('pos.html');
    assert.ok(pos.includes("fetch('/api/pos/holds'"), 'POS must save parked orders through /api/pos/holds');
    assert.ok(pos.includes('deleteParkedOnServer'), 'retrieving or discarding a parked order must delete it on the server');
    const routes = read('routes/pos.js');
    assert.ok(routes.includes('ADD COLUMN IF NOT EXISTS meta JSONB'), 'holds must keep discount and promo in meta');
});

test('Old report URLs redirect to the Reports hub', () => {
    const server = read('server.js');
    assert.ok(server.includes("app.get('/core-reports', (req, res) => res.redirect('/reports?tab=drilldown'))"));
    assert.ok(server.includes("app.get('/all-reports', (req, res) => res.redirect('/reports?tab=detailed'))"));
    assert.ok(server.includes("app.get('/sales-dashboard', (req, res) => res.redirect('/reports?tab=overview'))"));
    assert.ok(server.includes("app.get('/profitability', (req, res) => res.redirect('/reports?tab=overview'))"));
    assert.ok(server.includes("guardPageRoute(PAGE_ROLES.MANAGERS, 'reports.html')"), 'the hub itself stays role-guarded');
    assert.ok(read('reports.html').includes('OkwUI.sectionPage'), 'reports.html must be the hub');
});

test('Settings hub replaces seven pages and old URLs redirect into it', () => {
    const server = read('server.js');
    const map = {
        '/business-settings': "'/settings?tab=' + tab",
        '/locations': "'/settings?tab=locations'",
        '/tax-management': "'/settings?tab=taxrates'",
        '/notification-templates': "'/settings?tab=notifications'",
        '/activity-log': "'/settings?tab=activity'",
        '/backups': "'/settings?tab=backups'"
    };
    for (const [route, target] of Object.entries(map)) {
        const i = server.indexOf(`app.get('${route}'`);
        assert.ok(i > -1, `${route} route must exist`);
        assert.ok(server.slice(i, i + 400).includes(target), `${route} must redirect into the settings hub`);
    }
    assert.ok(server.includes("guardPageRoute(PAGE_ROLES.LEADERSHIP, 'settings.html')"), 'settings stays guarded (company users use it too)');
    const hub = read('settings.html');
    assert.ok(hub.includes('OkwUI.sectionPage'));
    assert.ok(hub.includes("roles: CEO_ADMIN, render: mountBackups"), 'backups section is CEO/admin only');
});

test('Locations are stored in the database and branch updates never reset VAT', () => {
    const server = read('server.js');
    assert.ok(server.includes('ADD COLUMN IF NOT EXISTS phone VARCHAR(50)'));
    assert.ok(server.includes('CASE WHEN $5 THEN EXCLUDED.vat_rate ELSE system_settings.vat_rate END'), 'VAT is only changed when sent');
    const hub = read('settings.html');
    assert.ok(hub.includes("api('/api/branches'"), 'locations must use /api/branches');
    assert.ok(!/localStorage\.setItem\('locations'/.test(hub), 'no browser-only location storage');
});

test('Hub pages are role-guarded, and embedded legacy pages are only served inside a hub', () => {
    const server = read('server.js');
    const hubs = { '/team': 'team.html', '/stock': 'stock.html', '/sales': 'sales.html', '/money': 'money.html', '/customers': 'customers-hub.html' };
    for (const [route, file] of Object.entries(hubs)) {
        assert.ok(new RegExp(`app\\.get\\('${route}', guardPageRoute\\(PAGE_ROLES\\.[A-Z_]+, '${file}'\\)`).test(server), `${route} must be a guarded hub`);
        assert.ok(read(file).includes('OkwUI.sectionPage'), `${file} must use the shared section page`);
    }
    // the helper itself: non-embedded visits redirect, embedded ones go through the role guard
    assert.ok(server.includes("if (req.query.embed !== '1') return res.redirect(hubUrl(req));") && server.includes('return guard(req, res, next);'), 'non-embedded visits redirect; embedded ones pass the role guard');
    for (const [route, file] of [['/pos-register', 'pos-register.html'], ['/roles', 'roles.html'], ['/inventory', 'inventory.html'], ['/sell', 'sell.html'], ['/credit-customers', 'credit-customers.html'], ['/expenses', 'expenses.html']]) {
        assert.ok(new RegExp(`app\\.get\\('${route}', embeddedPage\\('${file}', PAGE_ROLES\\.[A-Z_]+`).test(server), `${route} must be embedded-only`);
    }
});

test('Embedded mode hides the shell and the hub Section picker duplicates', () => {
    assert.ok(read('layout.js').includes("IS_EMBEDDED = /[?&]embed=1(&|$)/.test(window.location.search) && window.self !== window.top"));
    const css = read('portal-skin.css');
    for (const sel of ['.okw-embed .sidebar', '.okw-embed .okw-topbar', '.okw-embed .back-link', '.okw-embed label[for$="-view"]']) {
        assert.ok(css.includes(sel), sel + ' must be hidden when embedded');
    }
    assert.ok(read('ui-components.js').includes("u.searchParams.set('embed', '1')"));
});

test('Every menu link points at a real route and, for hubs, a real section', () => {
    const src = read('layout.js');
    const mods = eval(src.match(/const MODULES = (\[[\s\S]*?\n    \]);/)[1]);
    const server = read('server.js');
    const hubFiles = { '/settings': 'settings.html', '/reports': 'reports.html', '/team': 'team.html', '/stock': 'stock.html', '/sales': 'sales.html', '/money': 'money.html', '/customers': 'customers-hub.html' };
    const ids = {};
    for (const [route, file] of Object.entries(hubFiles)) ids[route] = new Set([...read(file).matchAll(/(?:\{ id: |businessSection\()'([^']+)'/g)].map(m => m[1]));
    for (const m of mods) {
        const [p, q] = m.url.split('?');
        assert.ok(server.includes(`app.get('${p}'`) || p === '/profile' || p === '/pos', `${m.label}: no route for ${p}`);
        const tab = q && new URLSearchParams(q).get('tab');
        if (ids[p] && tab) assert.ok(ids[p].has(tab), `${m.label}: hub ${p} has no section "${tab}"`);
    }
});

test('Cash account balances are manager-only, and embedded pages cannot trap the login page in a frame', () => {
    const extras = read('routes/extras.js');
    const i = extras.indexOf("router.get('/api/accounts'");
    assert.ok(i > -1 && extras.slice(i, i + 300).includes('MANAGER_ROLES.includes'), 'GET /api/accounts must check the role');
    const server = read('server.js');
    assert.ok(server.includes("(window.top || window).location.replace(${JSON.stringify(target)})"), 'embedded auth redirects must leave the frame');
    assert.ok(read('layout.js').includes("a.target = '_top'"), 'links inside a frame must open in the whole window');
    for (const f of ['auth-guard.js', 'customers.html', 'credit-customers.html', 'inventory.html', 'transactions.html']) {
        assert.ok(!/(^|[^.\w)])window\.location\.(replace\('\/login|href = '\/login)/.test(read(f)), `${f} must send the whole window to the login page`);
    }
});

test('The browser page guard (auth-guard.js) agrees with the server on every page route', () => {
    const server = read('server.js');
    const guard = read('auth-guard.js');
    const client = {};
    for (const m of guard.matchAll(/'(\/[a-z-]+)':\s*ROLES\.([A-Z_]+)/g)) client[m[1]] = m[2];
    const toClient = (r) => (r === 'CEO_ONLY' ? 'CEO' : r);
    const checked = [];
    const routes = [
        ...server.matchAll(/app\.get\('(\/[a-z-]+)',\s*guardPageRoute\(PAGE_ROLES\.([A-Z_]+),\s*'[^']+'\)/g),
        ...server.matchAll(/app\.get\('(\/[a-z-]+)',\s*embeddedPage\('[^']+',\s*PAGE_ROLES\.([A-Z_]+)/g)
    ];
    for (const m of routes) {
        const [, route, role] = m;
        checked.push(route);
        assert.ok(client[route], `auth-guard.js has no entry for ${route}: every user would be refused`);
        assert.equal(client[route], toClient(role), `${route}: browser guard says ${client[route]}, server says ${role}`);
    }
    for (const hub of ['/team', '/stock', '/sales', '/money', '/customers', '/settings', '/reports']) {
        assert.ok(checked.includes(hub), `${hub} must be a guarded server route`);
    }
});

test('Report queries report their failures instead of hiding them', async () => {
    // stand-in database: any statement containing "missing_table" fails
    const poolPath = require.resolve('../db/pool');
    const saved = require.cache[poolPath];
    require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { pool: { query: async (sql) => {
        if (/missing_table/.test(sql)) throw new Error('relation "missing_table" does not exist');
        return { rows: [{ ok: 1 }] };
    } } } };
    const helperPath = require.resolve('../services/safe-query');
    delete require.cache[helperPath];
    const { safeQuery, withWarnings, warnings } = require('../services/safe-query');
    const origError = console.error; console.error = () => { };
    try {
        let bad, good, seen, other;
        await new Promise((resolve) => withWarnings({}, {}, async () => {
            bad = await safeQuery('SELECT * FROM missing_table');
            good = await safeQuery('SELECT 1');
            seen = warnings();
            // a second request running at the same time must not see this request's warnings
            await new Promise((r2) => withWarnings({}, {}, async () => { other = warnings(); r2(); }));
            resolve();
        }));
        assert.deepEqual(bad, [], 'a failed query still returns an empty list so optional tables do not break the page');
        assert.deepEqual(good, [{ ok: 1 }]);
        assert.equal(seen.length, 1, 'the failure must be reported');
        assert.match(seen[0], /missing_table/);
        assert.deepEqual(other, [], 'warnings belong to one request only');
        assert.deepEqual(warnings(), [], 'outside a request there is nothing to report');
    } finally {
        console.error = origError;
        if (saved) require.cache[poolPath] = saved; else delete require.cache[poolPath];
        delete require.cache[helperPath];
    }
    for (const f of ['routes/reports-all.js', 'routes/reports-core.js', 'routes/ceo-live.js', 'routes/extras.js']) {
        const src = read(f);
        assert.ok(src.includes("require('../services/safe-query')") && src.includes('router.use(withWarnings)') && src.includes('warnings: warnings()') || src.includes('warnings()'), `${f} must return warnings`);
        assert.ok(!/^async function safeQuery/m.test(src), `${f} must not keep a private swallow-everything helper`);
    }
    assert.ok(read('ui-components.js').includes('function warnIfPartial'));
});

test('Tax report, tax rules and branch deletion are company-scoped and branch deletion keeps history', () => {
    const server = read('server.js');
    const report = server.slice(server.indexOf("app.get('/api/ceo/tax-report'"), server.indexOf("app.get('/api/ceo/tax-report'") + 4500);
    assert.ok(report.includes("COALESCE(tenant_id, 1) = $2 AND (branch_id = $1 OR branch_id = 1)"), 'tax rules in the report must be company-scoped');
    assert.ok(report.includes("LOWER(status) = 'completed' AND COALESCE(tenant_id, 1) = $1"), 'report transactions must be company-scoped');
    assert.ok(!report.includes('WHERE branch_id = 1"'), 'VAT must not be read from a fixed branch id');
    const put = server.slice(server.indexOf("app.put('/api/taxes/:id'"), server.indexOf("app.put('/api/taxes/:id'") + 900);
    const del = server.slice(server.indexOf("app.delete('/api/taxes/:id'"), server.indexOf("app.delete('/api/taxes/:id'") + 900);
    assert.ok(put.includes("COALESCE(tenant_id, 1) = $5") && del.includes("COALESCE(tenant_id, 1) = $2"), 'editing or removing a tax rule must be company-scoped');
    assert.ok(server.includes("INSERT INTO tax_rules (name, rate, branch_id, tenant_id)"), 'new tax rules must record their company');
    const branchDel = server.slice(server.indexOf("app.delete('/api/branches/:id'"), server.indexOf("app.delete('/api/branches/:id'") + 3200);
    assert.ok(branchDel.includes('UPDATE branches SET deleted_at = NOW()'), 'deleting a branch must keep its row');
    assert.ok(!branchDel.includes('DELETE FROM branches'), 'no hard delete');
    assert.ok(branchDel.includes('You cannot delete your only location.'));
});

test('Page templates never write unescaped names, notes or addresses into HTML', () => {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-escaping.mjs')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
});

test('Revoked tokens and attempt counters are shared through the database, and survive its failure', async () => {
    const poolPath = require.resolve('../db/pool');
    const savedPool = require.cache[poolPath];
    const rows = { revoked: new Set(), rate: new Map() };
    let failing = false;
    const fakePool = { query: async (sql, params) => {
        if (failing) throw new Error('db down');
        if (/CREATE TABLE/.test(sql)) return { rows: [] };
        if (/INSERT INTO revoked_tokens/.test(sql)) { rows.revoked.add(params[0]); return { rows: [] }; }
        if (/DELETE FROM revoked_tokens/.test(sql) || /DELETE FROM rate_limits WHERE reset_at/.test(sql)) return { rows: [] };
        if (/SELECT 1 FROM revoked_tokens/.test(sql)) return { rows: rows.revoked.has(params[0]) ? [{}] : [] };
        if (/INSERT INTO rate_limits/.test(sql)) {
            const key = params[0]; const ms = Number(params[1]); const now = Date.now();
            let r = rows.rate.get(key);
            if (!r || r.reset <= now) r = { hits: 0, reset: now + ms };
            r.hits += 1; rows.rate.set(key, r);
            return { rows: [{ hits: r.hits, reset_at: new Date(r.reset) }] };
        }
        if (/DELETE FROM rate_limits WHERE key/.test(sql)) { rows.rate.delete(params[0]); return { rows: [] }; }
        return { rows: [] };
    } };
    require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { pool: fakePool } };
    const svcPath = require.resolve('../services/shared-state');
    delete require.cache[svcPath];
    const svc = require('../services/shared-state');
    const origError = console.error; console.error = () => { };
    try {
        const token = 'h.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.s';
        assert.equal(await svc.isTokenRevoked(token), false);
        await svc.revokeToken(token);
        assert.equal(rows.revoked.size, 1, 'the revocation must be written to the database');
        svc.resetForTests(); // a different server instance: nothing in memory
        assert.equal(await svc.isTokenRevoked(token), true, 'another instance must see the revocation');

        const store = new svc.PgRateLimitStore('login:'); store.init({ windowMs: 60000 });
        let last; for (let i = 0; i < 3; i++) last = await store.increment('1.2.3.4');
        assert.equal(last.totalHits, 3, 'hits must accumulate in the database');
        svc.resetForTests();
        assert.equal((await store.increment('1.2.3.4')).totalHits, 4, 'a different instance continues the same count');
        await store.resetKey('1.2.3.4');
        assert.equal((await store.increment('1.2.3.4')).totalHits, 1);

        failing = true; svc.resetForTests();
        assert.equal(await svc.isTokenRevoked('x.y.z'), false, 'a database outage must not lock everyone out');
        assert.equal((await store.increment('9.9.9.9')).totalHits, 1, 'counters fall back to this instance');
        assert.equal((await store.increment('9.9.9.9')).totalHits, 2);
    } finally {
        console.error = origError;
        if (savedPool) require.cache[poolPath] = savedPool; else delete require.cache[poolPath];
        delete require.cache[svcPath];
    }
});

test('A production server refuses placeholder secrets, and cross-site writes are blocked', async () => {
    const { spawn, spawnSync } = require('node:child_process');
    const base = { ...process.env, DATABASE_URL: 'postgresql://nobody:nopass@127.0.0.1:1/none' };
    // production with the published example secrets must not start
    const bad = spawnSync(process.execPath, ['server.js'], { cwd: ROOT, encoding: 'utf8', timeout: 20000,
        env: { ...base, NODE_ENV: 'production', PORT: '5198', JWT_SECRET: 'footprint-secure-secret-key-2025', SESSION_SECRET: 'x'.repeat(40) } });
    assert.notEqual(bad.status, 0, 'must exit');
    assert.match(bad.stderr + bad.stdout, /Insecure secrets/);

    // development server: a cookie-less write from another site is refused, the same site is not
    const port = 5197;
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...base, NODE_ENV: 'development', PORT: String(port) }, stdio: 'ignore' });
    try {
        let up = false;
        for (let i = 0; i < 40 && !up; i++) {
            await new Promise(r => setTimeout(r, 250));
            up = await new Promise(res => { http.get(`http://127.0.0.1:${port}/healthz`, r => { r.resume(); res(true); }).on('error', () => res(false)); });
        }
        assert.ok(up, 'test server must start');
        const post = (headers) => new Promise((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port, path: '/api/auth/revoke', method: 'POST', headers: { 'content-length': 0, ...headers } }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b })); });
            req.on('error', reject); req.end();
        });
        const cross = await post({ origin: 'https://evil.example' });
        assert.equal(cross.status, 403);
        assert.match(cross.body, /Cross-site request blocked/);
        const same = await post({ origin: `http://127.0.0.1:${port}` });
        assert.notEqual(same.status, 403, 'a same-site request must reach the handler');
    } finally { child.kill(); }
});

test('The factory authorization code is refused and the deploy leaves developer scripts out', () => {
    const server = read('server.js');
    assert.ok(server.includes("const FACTORY_AUTH_CODE = '123456'") && server.includes("status === 'default'"), 'the default code must be refused');
    assert.ok(!/credit_auth_code VARCHAR\(50\) DEFAULT '123456'/.test(server), 'no database default for the code');
    assert.ok(server.includes('crypto.timingSafeEqual'), 'compare the code in constant time');
    const v = JSON.parse(read('vercel.json'));
    assert.ok(/seed\.js/.test(v.functions['api/index.js'].excludeFiles), 'seed and setup scripts must not ship');
    assert.ok(read('layout.js').includes('initIdleSignOut'), 'back-office roles are signed out when idle');
});

test('Checkout rounds every line, the discount and the taxable base to the pesewa', () => {
    const pos = read('routes/pos.js');
    assert.ok(pos.includes('itemsSubtotal = Math.round((itemsSubtotal + Math.round((unitPrice * qty + Number.EPSILON) * 100) / 100) * 100) / 100'));
    assert.ok(pos.includes('const requestedDiscount = Math.round((Number(discount_amount || 0) + Number.EPSILON) * 100) / 100'));
    assert.ok(pos.includes('const taxableBase = Math.round(Math.max(0, itemsSubtotal - requestedDiscount) * 100) / 100'));
});

test('Stock takes, transfers and batches are role-gated and tenant-scoped', () => {
    const server = read('server.js');
    assert.match(server, /app\.post\('\/api\/stock-takes\/:id\/approve',\s*authenticateToken,\s*requireRole\(MANAGER_ROLES\)/);
    assert.match(server, /app\.post\('\/api\/stock-takes\/:id\/items',\s*authenticateToken,\s*requireRole\(PAGE_ROLES\.STAFF_ALL\)/);
    assert.match(server, /app\.post\('\/api\/transfers\/:id\/confirm',\s*authenticateToken,\s*requireRole\(PAGE_ROLES\.STAFF_ALL\)/);
    assert.match(server, /app\.get\('\/api\/batches',\s*authenticateToken,\s*requireRole\(PAGE_ROLES\.STAFF_ALL\)/);
    assert.ok(server.includes('stockTakeInTenant(client, id, req.user.tenant_id || 1, true)'), 'approve must scope the stock take to the tenant');
    assert.ok(server.includes('FROM stock_transfers WHERE id = $1 AND COALESCE(tenant_id, 1) = $2 FOR UPDATE'), 'transfer confirm must be tenant-scoped');
    assert.ok(!/confirmed_by\s*\}\s*=\s*req\.body/.test(server), 'confirmed_by must come from the session, not the request body');
});

test('Company invoices and proformas are only reachable by their own company or tenant staff', () => {
    const server = read('server.js');
    for (const route of [
        "app.get('/api/company/proforma-invoices/:id'",
        "app.get('/api/company/sales-invoices/:id'",
        "app.post('/api/company/proforma-invoices/:id/send'",
        "app.post('/api/company/proforma-invoices/:id/convert'",
        "app.post('/api/company/sales-invoices/:id/payment'"
    ]) {
        const i = server.indexOf(route);
        assert.ok(i > -1, `${route} exists`);
        const head = server.slice(i, i + 700);
        assert.ok(head.includes('requireRole(COMPANY_PORTAL_ROLES)'), `${route} is role-gated`);
        assert.ok(head.includes('companyDocAllowed('), `${route} checks document ownership`);
    }
});

test('The schema debug endpoint is not available in production', () => {
    const server = read('server.js');
    const i = server.indexOf("app.get('/api/debug/schema/:tableName'");
    assert.ok(server.slice(i, i + 400).includes("NODE_ENV === 'production'"));
});

test('Batch, reorder and stock/expiry reports are staff-only and tenant-scoped', () => {
    const server = read('server.js');
    for (const route of [
        "app.get('/api/batches/product/:barcode'", "app.get('/api/batches/next/:product_barcode'",
        "app.post('/api/reorder/check'", "app.get('/api/reorder/alerts/:branch_id'",
        "app.get('/api/reports/low-stock/:branch_id'", "app.get('/api/reports/expiry/:branch_id'"
    ]) {
        const i = server.indexOf(route);
        assert.ok(i > -1, `${route} exists`);
        const block = server.slice(i, i + 1400);
        assert.ok(block.includes('requireRole(PAGE_ROLES.STAFF_ALL)'), `${route} is role-gated`);
        assert.ok(/tenant_id/.test(block), `${route} is tenant-scoped`);
    }
});

test('The content security policy blocks plugins, base-tag and form hijacking', () => {
    const sec = read('security.js');
    for (const d of ['objectSrc', 'baseUri', 'formAction']) assert.ok(sec.includes(d), `${d} is set`);
});

test('The strict content security policy is report-only, on pages only, and blocks inline scripts and handlers', () => {
    const security = require('../security');
    const headers = {};
    const res = { setHeader: (k, v) => { headers[k] = v; } };
    security.cspReportOnly({ path: '/dashboard' }, res, () => {});
    const policy = headers['Content-Security-Policy-Report-Only'];
    assert.ok(policy, 'page responses carry the report-only policy');
    assert.ok(!/unsafe-inline/.test(policy), 'the strict policy has no unsafe-inline');
    assert.ok(policy.includes("script-src-attr 'none'"), 'inline event handlers are reported');
    assert.ok(policy.includes('report-uri /api/csp-report'));
    for (const p of ['/api/products', '/layout.js', '/sidebar.css']) {
        const h = {};
        security.cspReportOnly({ path: p }, { setHeader: (k, v) => { h[k] = v; } }, () => {});
        assert.equal(h['Content-Security-Policy-Report-Only'], undefined, `${p} is skipped`);
    }
});
