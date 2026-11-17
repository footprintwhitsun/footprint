const { pool } = require('../db/pool');

async function logActivity(req, action, details = {}) {
    try {
        if (!pool) return;
        const userId = req?.user?.id || req?.session?.user?.id || null;
        const ip = req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '0.0.0.0';
        await pool.query(
            'INSERT INTO activity_logs (user_id, action, details, ip_address) VALUES ($1, $2, $3, $4)',
            [userId, action, details, ip]
        );
    } catch (err) {
        console.error('Audit Log Error:', err.message);
    }
}

module.exports = { logActivity };

