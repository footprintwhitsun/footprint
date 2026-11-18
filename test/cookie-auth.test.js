const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'y'.repeat(48);
const auth = require('../middleware/auth');

const fakeRes = () => {
    const r = { code: 200, body: null };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
};
const run = (req) => new Promise((resolve) => {
    const res = fakeRes();
    let nexted = false;
    const done = () => resolve({ res, nexted });
    res.json = (b) => { res.body = b; done(); return res; };
    auth.authenticateToken(req, res, () => { nexted = true; done(); });
});

const user = { id: 7, role: 'Manager', tenant_id: 3, name: 'Ama' };

test('A session marker looks like a token but carries only display fields and never verifies', () => {
    const marker = auth.makeSessionMarker(user);
    assert.equal(marker.split('.').length, 3);
    assert.ok(auth.isSessionMarker(marker));
    const payload = JSON.parse(Buffer.from(marker.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    assert.equal(payload.role, 'Manager');
    assert.ok(payload.exp > Date.now() / 1000);
    assert.throws(() => jwt.verify(marker, process.env.JWT_SECRET));
    assert.equal(auth.bearerFromHeader('Bearer ' + marker), null);
    assert.equal(auth.bearerFromHeader('Bearer null'), null);
    assert.equal(auth.bearerFromHeader('Bearer ' + jwt.sign(user, process.env.JWT_SECRET)).length > 20, true);
});

test('A marker authenticates only through the session cookie, and a forged marker grants nothing', async () => {
    const marker = auth.makeSessionMarker({ id: 1, role: 'super_admin', tenant_id: 1 });
    // no session behind it -> not authenticated
    const forged = await run({ headers: { authorization: 'Bearer ' + marker }, session: {} });
    assert.equal(forged.nexted, false);
    assert.equal(forged.res.code, 401);
    // a real session behind it -> the SESSION user is used, not what the marker claims
    const req = { headers: { authorization: 'Bearer ' + marker }, session: { user } };
    const ok = await run(req);
    assert.equal(ok.nexted, true);
    assert.equal(req.user.id, 7);
    assert.equal(req.user.role, 'manager');
});

test('Login responses hand the browser a session marker, not the signed JWT', () => {
    const fs = require('node:fs');
    const server = fs.readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(server.includes('const tokenForClient'));
    assert.equal((server.match(/tokenForClient\(req,/g) || []).length >= 4, true);
    assert.ok(!/token:\s*token,\s*\n\s*redirectTo/.test(server), 'staff login must not return the raw JWT');
    assert.ok(server.includes('bearerFromHeader(req.headers.authorization)'), 'CSRF bypass must require a real bearer token');
});
