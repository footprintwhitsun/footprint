const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { authenticateToken, MANAGER_ROLES } = require('../middleware/auth');
const { logActivity } = require('../services/audit');

router.get('/api/audit-logs', authenticateToken, async (req, res) => {
    const userRole = (req.user.role || '').toLowerCase();
    if (!MANAGER_ROLES.includes(userRole)) {
        return res.status(403).json({ message: 'Unauthorized' });
    }
    try {
        const tenantId = req.user.tenant_id || 1;
        const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
        const result = await pool.query(`
            SELECT a.*,
                COALESCE(u.name, cu.company_name) AS user_name,
                u.email AS user_email,
                CASE
                    WHEN u.role IS NOT NULL THEN u.role
                    WHEN cu.id IS NOT NULL THEN 'Company'
                    ELSE 'System'
                END AS user_role
            FROM activity_logs a
            LEFT JOIN users u ON a.user_id = u.id
            LEFT JOIN company_users cu ON a.user_id = cu.id
            WHERE COALESCE(a.tenant_id, 1) = $1
            ORDER BY a.created_at DESC
            LIMIT $2
        `, [tenantId, limit]);
        res.json(result.rows);
    } catch (error) {
        console.error('Fetch Audit Logs Error:', error);
        res.status(500).json({ message: 'Error fetching audit logs' });
    }
});

const ALLOWED_CLIENT_AUDIT_ACTIONS = new Set([
    'PRINT_RECEIPT',
    'EXPORT_REPORT',
    'VIEW_SCREEN',
    'OPEN_DRAWER_REQUEST'
]);

router.post('/api/audit/log', authenticateToken, async (req, res) => {
    const { action, details } = req.body;
    const normalized = String(action || '').toUpperCase().trim();
    if (!ALLOWED_CLIENT_AUDIT_ACTIONS.has(normalized)) {
        return res.status(403).json({ message: 'Action is not permitted for client audit logging' });
    }
    try {
        await logActivity(req, normalized, details);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ message: 'Error logging activity' });
    }
});

module.exports = router;
