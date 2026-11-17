// Report queries tolerate a missing optional table or column, but never silently:
// every failure is logged on the server and returned to the page as `warnings`,
// so a database fault no longer looks like "no data".
const { AsyncLocalStorage } = require('async_hooks');
const { pool } = require('../db/pool');

const context = new AsyncLocalStorage();

// Express middleware: gives each request its own list of warnings.
function withWarnings(req, res, next) {
    context.run({ warnings: [] }, next);
}

// The warnings collected so far for the current request.
function warnings() {
    const store = context.getStore();
    return store ? store.warnings.slice() : [];
}

async function safeQuery(sql, params = []) {
    try {
        const result = await pool.query(sql, params);
        return result.rows;
    } catch (err) {
        const message = (err && err.message) || 'query failed';
        console.error('[report query failed]', message, '|', String(sql).replace(/\s+/g, ' ').trim().slice(0, 120));
        const store = context.getStore();
        if (store && store.warnings.length < 10) store.warnings.push(message.slice(0, 160));
        return [];
    }
}

module.exports = { safeQuery, withWarnings, warnings };
