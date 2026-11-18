/**
 * Branch and stock-quantity helpers shared by the routes.
 *
 * Stock is kept per branch in products.stock_levels as { "<branch name>": quantity }. Older code guessed the
 * name from the branch id ("2" -> "Accra Branch") and truncated quantities with parseInt, which put stock under
 * the wrong key and dropped fractions (2.5 m became 2). Everything now resolves the real branch from the
 * branches table and keeps quantities as numbers with up to 3 decimals.
 */

// Used only when nothing better is known (no branch row, no store on the user). Set MAIN_BRANCH_LOCATION to change it.
const DEFAULT_BRANCH_NAME = (process.env.MAIN_BRANCH_LOCATION || '').trim() || 'Main Warehouse';

// Names that older versions wrote for branch ids. Only used to FIND stock that already exists under them.
const LEGACY_BRANCH_ALIASES = { 1: 'Main Warehouse', 2: 'Accra Branch', 3: 'Kumasi Branch' };

const norm = (s) => String(s === null || s === undefined ? '' : s).trim().toLowerCase();

/** A stock quantity: a finite number >= -999999999, rounded to 3 decimals. Anything else is 0. */
function toQty(value) {
    const n = typeof value === 'number' ? value : Number(String(value === null || value === undefined ? '' : value).trim());
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 1000) / 1000;
}

/**
 * Which key of a stock_levels object to read or write for a branch. Prefers a key that already exists (matched
 * exactly, then ignoring case and spaces) so existing stock is never split across two spellings; otherwise the
 * first usable candidate, which is the branch's own name.
 */
function pickStockKey(levels, candidates) {
    let obj = levels;
    if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch (_) { obj = null; } }
    const keys = obj && typeof obj === 'object' ? Object.keys(obj) : [];
    const list = (candidates || []).filter((c) => c !== null && c !== undefined && String(c).trim() !== '');
    for (const c of list) { if (keys.includes(String(c))) return String(c); }
    for (const c of list) { const hit = keys.find((k) => norm(k) === norm(c)); if (hit) return hit; }
    return list.length ? String(list[0]).trim() : DEFAULT_BRANCH_NAME;
}

/** The branch row for an id (inside the tenant), or the tenant's main branch when no id is given. */
async function loadBranch(db, tenantId, branchId) {
    if (branchId !== null && branchId !== undefined && branchId !== '') {
        const r = await db.query(
            'SELECT id, name, location FROM branches WHERE id = $1 AND COALESCE(tenant_id, 1) = $2 AND deleted_at IS NULL',
            [branchId, tenantId]
        );
        return r.rows[0] || null;
    }
    const r = await db.query(
        'SELECT id, name, location FROM branches WHERE COALESCE(tenant_id, 1) = $1 AND deleted_at IS NULL ORDER BY is_main DESC NULLS LAST, id ASC LIMIT 1',
        [tenantId]
    );
    return r.rows[0] || null;
}

const mainIdCache = new Map(); // tenantId -> { id, at }
const MAIN_ID_TTL_MS = 60 * 1000;

/**
 * The id of the tenant's main branch (the default branch for new records). Older code used the literal id 1,
 * which for any tenant whose main branch is not id 1 pointed at another tenant's branch.
 */
async function mainBranchId(db, tenantId) {
    const key = String(tenantId);
    const hit = mainIdCache.get(key);
    if (hit && Date.now() - hit.at < MAIN_ID_TTL_MS) return hit.id;
    let id = 1;
    try {
        const b = await loadBranch(db, tenantId, null);
        if (b && b.id) id = b.id;
    } catch (_) { /* keep 1 only when the branches table cannot be read */ }
    mainIdCache.set(key, { id, at: Date.now() });
    return id;
}

/** Name of the tenant's main branch, for seeding stock_levels of a product that has none yet. */
async function mainBranchName(db, tenantId) {
    try {
        const b = await loadBranch(db, tenantId, null);
        if (b && (b.name || b.location)) return b.name || b.location;
    } catch (_) { /* fall through */ }
    return DEFAULT_BRANCH_NAME;
}

/**
 * The stock_levels key to use for one product at one branch. `fallbackName` is the logged-in user's own store
 * name, used when the branch cannot be found.
 */
async function resolveStockKey(db, { tenantId, branchId, barcode, fallbackName }) {
    let branch = null;
    try { branch = await loadBranch(db, tenantId, branchId); } catch (_) { /* branches table unavailable */ }
    let levels = null;
    if (barcode) {
        const r = await db.query('SELECT stock_levels FROM products WHERE barcode = $1 AND COALESCE(tenant_id, 1) = $2 LIMIT 1', [barcode, tenantId]);
        levels = r.rows[0] ? r.rows[0].stock_levels : null;
    }
    const legacy = branchId !== null && branchId !== undefined ? LEGACY_BRANCH_ALIASES[Number(branchId)] : null;
    return pickStockKey(levels, [branch && branch.name, branch && branch.location, fallbackName, legacy, DEFAULT_BRANCH_NAME]);
}

module.exports = { DEFAULT_BRANCH_NAME, LEGACY_BRANCH_ALIASES, toQty, pickStockKey, loadBranch, mainBranchId, mainBranchName, resolveStockKey };
