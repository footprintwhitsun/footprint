const path = require('path');
const jwt = require('jsonwebtoken');
const { pool, tenantContext } = require('../db/pool');

const JWT_SECRET = process.env.JWT_SECRET || (
    process.env.NODE_ENV === 'production'
        ? (() => { throw new Error('FATAL: JWT_SECRET environment variable must be set in production'); })()
        : 'okwesiwa-dev-jwt-secret-local-only'
);

const SESSION_SECRET = process.env.SESSION_SECRET || (
    process.env.NODE_ENV === 'production'
        ? (() => { throw new Error('FATAL: SESSION_SECRET environment variable must be set in production'); })()
        : 'okwesiwa-dev-session-secret-local-only'
);

// Revoked tokens live in the database (shared by every server instance), not in this process.
const { revokeToken, isTokenRevoked } = require('../services/shared-state');
// Kept so older callers that wrote tokenBlacklist.add(token) still revoke properly.
const tokenBlacklist = { add: (token) => { revokeToken(token); }, has: () => false };

const PAGE_ROLES = {
    CEO_ONLY: ['super_admin', 'ceo', 'admin'],
    LEADERSHIP: ['super_admin', 'ceo', 'admin', 'manager', 'store_manager', 'company', 'business_client'],
    MANAGERS: ['super_admin', 'ceo', 'admin', 'manager', 'store_manager'],
    STAFF_ALL: ['super_admin', 'ceo', 'admin', 'manager', 'store_manager', 'cashier', 'teller', 'storekeeper', 'driver'],
    COMPANY: ['super_admin', 'ceo', 'admin', 'company', 'business_client'],
    ALL_USERS: ['super_admin', 'ceo', 'admin', 'manager', 'store_manager', 'cashier', 'teller', 'storekeeper', 'driver', 'company', 'business_client']
};

const MANAGER_ROLES = ['super_admin', 'ceo', 'admin', 'manager', 'store_manager'];

const userTenantScope = (req) => ((req.user.role === 'super_admin' || req.user.role === 'ceo') ? null : (req.user.tenant_id || 1));

// Cookie-mode login: the browser never holds the signed JWT. The server hands it a "session marker" instead:
// an UNSIGNED, non-secret token-shaped string (header.payload.session) that carries only the display fields the
// pages need (role, name, expiry) so existing client code keeps working. It is never accepted as a credential:
// requests are authenticated by the httpOnly session cookie. A forged marker grants nothing.
const SESSION_MARKER_SIG = 'session';
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const isSessionMarker = (t) => {
    if (typeof t !== 'string') return false;
    const parts = t.split('.');
    return parts.length === 3 && parts[2] === SESSION_MARKER_SIG;
};
const makeSessionMarker = (payload, ttlSeconds = 8 * 3600) => {
    const now = Math.floor(Date.now() / 1000);
    return [b64url({ alg: 'none', typ: 'JWT' }), b64url({ ...payload, iat: now, exp: now + ttlSeconds }), SESSION_MARKER_SIG].join('.');
};
// The real bearer token in an Authorization header, or null (absent, "null", or a session marker).
const bearerFromHeader = (authHeader) => {
    const t = authHeader && authHeader.split(' ')[1];
    if (!t || t === 'null' || t === 'undefined' || isSessionMarker(t)) return null;
    return t;
};

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = bearerFromHeader(authHeader);

    const enforceSaaSBoundary = (userPayload) => {
        if (!userPayload) return res.status(401).json({ message: 'Not authenticated' });
        if (userPayload.role) userPayload.role = userPayload.role.toLowerCase();
        userPayload.tenant_id = userPayload.tenant_id ? parseInt(userPayload.tenant_id, 10) : 1;
        req.user = userPayload;

        const isSuperAdmin = (userPayload.role === 'super_admin' || userPayload.role === 'ceo' || userPayload.role === 'admin');
        const tenantId = userPayload.tenant_id ? userPayload.tenant_id.toString() : '1';
        tenantContext.run({ tenantId, isSuperAdmin }, () => next());
    };

    if (token) {
        const verifyAndContinue = () => jwt.verify(token, JWT_SECRET, (err, user) => {
            if (err) return res.status(403).json({ message: 'Invalid or expired token' });
            enforceSaaSBoundary(user);
        });
        isTokenRevoked(token).then((revoked) => {
            if (revoked) return res.status(401).json({ message: 'Session has been revoked. Please log in again.' });
            verifyAndContinue();
        }).catch(() => verifyAndContinue());
    } else if (req.session && req.session.user) {
        enforceSaaSBoundary(req.session.user);
    } else if (req.session && req.session.companyUser) {
        enforceSaaSBoundary(req.session.companyUser);
    } else {
        res.status(401).json({ message: 'Not authenticated' });
    }
};

const requireRole = (allowedRoles) => (req, res, next) => {
    const role = (req.user?.role || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
    if (role === 'super_admin') return next();
    if (!allowedRoles.includes(role)) {
        return res.status(403).json({ message: 'Insufficient role permissions for this action' });
    }
    next();
};

const requirePermission = (moduleKey, action) => async (req, res, next) => {
    const role = (req.user?.role || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
    if (role === 'super_admin' || role === 'ceo' || role === 'admin') return next();
    try {
        if (pool) {
            const r = await pool.query(
                'SELECT permissions FROM roles WHERE LOWER(slug) = $1 AND tenant_id = $2 LIMIT 1',
                [role, req.user.tenant_id || 1]
            );
            if (r.rows.length > 0) {
                const perms = r.rows[0].permissions || {};
                const allowed = Array.isArray(perms[moduleKey]) && perms[moduleKey].includes(action);
                if (!allowed) {
                    return res.status(403).json({ message: `Permission denied: ${moduleKey}.${action}` });
                }
                return next();
            }
        }
    } catch (e) {
        // If roles table does not exist yet, fall through to role-based check
    }
    if (MANAGER_ROLES.includes(role)) return next();
    return res.status(403).json({ message: `Permission denied: ${moduleKey}.${action}` });
};

const guardPageRoute = (allowedRoles, htmlFile, rootDir) => (req, res) => {
    const baseDir = rootDir || path.join(__dirname, '..');
    const sessionUser = req.session && (req.session.user || req.session.companyUser);
    let bearerUser = null;
    if (!sessionUser) {
        const token = bearerFromHeader(req.headers['authorization']);
        if (token) {
            try { bearerUser = jwt.verify(token, JWT_SECRET); } catch (e) { bearerUser = null; }
        }
    }
    const effectiveUser = sessionUser || bearerUser;

    if (effectiveUser && effectiveUser.role) {
        const role = (effectiveUser.role || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
        if (Array.isArray(allowedRoles) && !allowedRoles.includes(role)) {
            if (req.session) req.session.destroy(() => { });
            return res.redirect('/login?unauthorized=true');
        }
    }

    res.sendFile(path.join(baseDir, htmlFile));
};

module.exports = {
    JWT_SECRET,
    SESSION_SECRET,
    tokenBlacklist,
    revokeToken,
    PAGE_ROLES,
    MANAGER_ROLES,
    userTenantScope,
    authenticateToken,
    requireRole,
    requirePermission,
    guardPageRoute,
    makeSessionMarker,
    bearerFromHeader,
    isSessionMarker
};
