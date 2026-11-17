// State that must be the same on every server instance (serverless runs many):
//   * revoked login tokens (logout / "revoke session")
//   * attempt counters for login, password reset and authorization codes
// Both live in the database. If the database cannot be reached the code falls back to this instance's
// memory, so an outage never locks everybody out, and the failure is logged.
const crypto = require('crypto');
const { pool } = require('../db/pool');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

let tablesReady = false;
async function ensureTables() {
    if (tablesReady || !pool) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS revoked_tokens (
            token_hash TEXT PRIMARY KEY,
            expires_at TIMESTAMPTZ NOT NULL,
            revoked_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expiry ON revoked_tokens (expires_at);
        CREATE TABLE IF NOT EXISTS rate_limits (
            key TEXT PRIMARY KEY,
            hits INTEGER NOT NULL DEFAULT 0,
            reset_at TIMESTAMPTZ NOT NULL
        );
    `);
    tablesReady = true;
}
function resetForTests() { tablesReady = false; revokedLocal.clear(); notRevokedCache.clear(); rateLocal.clear(); }

/* ---------------------------- revoked tokens ---------------------------- */
const revokedLocal = new Map();        // hash -> expiry ms (this instance)
const notRevokedCache = new Map();     // hash -> checked-at ms (short, so a revoke elsewhere shows up quickly)
const NEG_TTL_MS = 15 * 1000;

function tokenExpiryMs(token) {
    try {
        const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
        if (payload && payload.exp) return payload.exp * 1000;
    } catch (_) { /* fall through */ }
    return Date.now() + 24 * 60 * 60 * 1000;
}

async function revokeToken(token) {
    if (!token) return;
    const hash = sha(token);
    const expMs = tokenExpiryMs(token);
    revokedLocal.set(hash, expMs);
    notRevokedCache.delete(hash);
    if (revokedLocal.size > 20000) for (const [h, e] of revokedLocal) if (e < Date.now()) revokedLocal.delete(h);
    if (!pool) return;
    try {
        await ensureTables();
        await pool.query('INSERT INTO revoked_tokens (token_hash, expires_at) VALUES ($1, to_timestamp($2)) ON CONFLICT (token_hash) DO NOTHING', [hash, expMs / 1000]);
        if (Math.random() < 0.05) await pool.query('DELETE FROM revoked_tokens WHERE expires_at < NOW()');
    } catch (err) {
        console.error('[revoked-tokens] could not store the revoked token in the database; it is revoked on this instance only:', err.message);
    }
}

async function isTokenRevoked(token) {
    if (!token) return false;
    const hash = sha(token);
    const local = revokedLocal.get(hash);
    if (local && local > Date.now()) return true;
    if (!pool) return false;
    const checkedAt = notRevokedCache.get(hash);
    if (checkedAt && Date.now() - checkedAt < NEG_TTL_MS) return false;
    try {
        await ensureTables();
        const r = await pool.query('SELECT 1 FROM revoked_tokens WHERE token_hash = $1 AND expires_at > NOW()', [hash]);
        if (r.rows.length) { revokedLocal.set(hash, Date.now() + 60 * 60 * 1000); return true; }
        notRevokedCache.set(hash, Date.now());
        if (notRevokedCache.size > 5000) notRevokedCache.clear();
        return false;
    } catch (err) {
        console.error('[revoked-tokens] revocation check failed; allowing the request:', err.message);
        return false;
    }
}

/* ----------------------------- attempt counters ----------------------------- */
const rateLocal = new Map();           // key -> { count, resetAt }
function hitLocal(key, windowMs) {
    const now = Date.now();
    let rec = rateLocal.get(key);
    if (!rec || now >= rec.resetAt) rec = { count: 0, resetAt: now + windowMs };
    rec.count += 1;
    rateLocal.set(key, rec);
    if (rateLocal.size > 20000) for (const [k, v] of rateLocal) if (v.resetAt < now) rateLocal.delete(k);
    return { count: rec.count, resetAt: new Date(rec.resetAt) };
}

// Count one attempt for `key` inside a window; returns { count, resetAt }.
async function hit(key, windowMs) {
    if (!pool) return hitLocal(key, windowMs);
    try {
        await ensureTables();
        const r = await pool.query(`
            INSERT INTO rate_limits (key, hits, reset_at) VALUES ($1, 1, NOW() + ($2 || ' milliseconds')::interval)
            ON CONFLICT (key) DO UPDATE SET
                hits = CASE WHEN rate_limits.reset_at <= NOW() THEN 1 ELSE rate_limits.hits + 1 END,
                reset_at = CASE WHEN rate_limits.reset_at <= NOW() THEN NOW() + ($2 || ' milliseconds')::interval ELSE rate_limits.reset_at END
            RETURNING hits, reset_at`, [key, String(windowMs)]);
        if (Math.random() < 0.02) pool.query('DELETE FROM rate_limits WHERE reset_at < NOW() - INTERVAL \'1 hour\'').catch(() => { });
        return { count: Number(r.rows[0].hits), resetAt: new Date(r.rows[0].reset_at) };
    } catch (err) {
        console.error('[rate-limit] database counter failed; using this instance only:', err.message);
        return hitLocal(key, windowMs);
    }
}
async function clearHits(key) {
    rateLocal.delete(key);
    if (!pool) return;
    try { await ensureTables(); await pool.query('DELETE FROM rate_limits WHERE key = $1', [key]); } catch (_) { /* best effort */ }
}

// express-rate-limit (v6) store backed by the same table.
class PgRateLimitStore {
    constructor(prefix = 'rl:') { this.prefix = prefix; this.windowMs = 60 * 1000; }
    init(options) { if (options && options.windowMs) this.windowMs = options.windowMs; }
    async increment(key) {
        const r = await hit(this.prefix + key, this.windowMs);
        return { totalHits: r.count, resetTime: r.resetAt };
    }
    async decrement(key) {
        const k = this.prefix + key;
        const rec = rateLocal.get(k); if (rec && rec.count > 0) rec.count -= 1;
        if (!pool) return;
        try { await ensureTables(); await pool.query('UPDATE rate_limits SET hits = GREATEST(hits - 1, 0) WHERE key = $1', [k]); } catch (_) { /* best effort */ }
    }
    async resetKey(key) { await clearHits(this.prefix + key); }
}

module.exports = { revokeToken, isTokenRevoked, hit, clearHits, PgRateLimitStore, resetForTests };
