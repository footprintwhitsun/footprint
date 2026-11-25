const { pool } = require('../db/pool');

async function logActivity(req, action, details = {}) {
    try {
        if (!pool) return;
        const userId = req?.user?.id || req?.session?.user?.id || null;
        const tenantId = req?.user?.tenant_id || req?.session?.user?.tenant_id || 1;
        const ip = req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '0.0.0.0';
        const payload = (details && typeof details === 'object' && !Array.isArray(details))
            ? {
                actor_name: req?.user?.name || req?.user?.username || undefined,
                actor_role: req?.user?.role || undefined,
                branch: details.store_location || details.branch || req?.user?.store_location || undefined,
                ...details
            }
            : { value: details };
        await pool.query(
            'INSERT INTO activity_logs (tenant_id, user_id, action, details, ip_address) VALUES ($1, $2, $3, $4, $5)',
            [tenantId, userId, action, payload, ip]
        );
    } catch (err) {
        console.error('Audit Log Error:', err.message);
    }
}

module.exports = { logActivity };

