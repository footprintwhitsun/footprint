/**
 * Footprint - Enterprise Role-Based Access Control (RBAC) Auth Guard
 * Enforces strict client-side route protection before DOM rendering.
 * Provides cryptographic JWT role verification, instant redirect on breach attempt,
 * security alerts, and live server session heartbeat.
 */

(function() {
    'use strict';

    // 1. Helper: Extract current page route from URL
    function getCurrentRoute() {
        let path = window.location.pathname.toLowerCase().trim();
        // Collapse multiple slashes (e.g. //transactions.html -> /transactions.html)
        path = path.replace(/\/+/g, '/');
        // Remove trailing slash
        if (path.length > 1 && path.endsWith('/')) {
            path = path.slice(0, -1);
        }
        // Remove .html if present
        if (path.endsWith('.html')) {
            path = path.slice(0, -5);
        }
        // If empty or root, treat as /login or /
        if (!path || path === '') path = '/';
        return path;
    }

    // 2. Helper: Parse & validate JWT payload safely
    function parseJwt(token) {
        if (!token || typeof token !== 'string') return null;
        try {
            const parts = token.split('.');
            if (parts.length !== 3) return null;
            const base64Url = parts[1];
            const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
            const jsonPayload = decodeURIComponent(
                atob(base64)
                    .split('')
                    .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
                    .join('')
            );
            return JSON.parse(jsonPayload);
        } catch (e) {
            console.error('Failed to parse JWT token:', e);
            return null;
        }
    }

    // 3. Define Role Groups
    const ROLES = {
        CEO: ['ceo', 'admin'],
        LEADERSHIP: ['ceo', 'admin', 'manager', 'store_manager', 'company', 'business_client'],
        MANAGERS: ['admin', 'manager', 'store_manager'],
        STAFF_ALL: ['admin', 'manager', 'store_manager', 'cashier', 'teller'],
        COMPANY: ['company', 'business_client'],
        ALL_USERS: ['ceo', 'admin', 'manager', 'store_manager', 'cashier', 'teller', 'company', 'business_client']
    };

    // 4. Define Route Permissions Matrix
    // Maps canonical route paths to authorized roles
    const ROUTE_PERMISSIONS = {
        // Public routes
        '/login': 'PUBLIC',
        '/forgot-password': 'PUBLIC',
        '/reset-password': 'PUBLIC',
        '/help': 'PUBLIC',
        '/privacy': 'PUBLIC',
        '/terms': 'PUBLIC',

        // Executive & Management Leadership
        '/ceo-portal': ROLES.CEO,
        '/tax-management': ROLES.LEADERSHIP,
        '/settings': ROLES.LEADERSHIP,
        '/locations': ROLES.LEADERSHIP,

        // Management & Branch Store Operations (Manager / Admin only - Blocked for CEO & Cashier)
        '/dashboard': ROLES.MANAGERS,
        '/inventory': ROLES.MANAGERS,
        '/reports': ROLES.MANAGERS,
        '/sales-dashboard': ROLES.MANAGERS,
        '/profitability': ROLES.MANAGERS,
        '/bulk-upload': ROLES.MANAGERS,
        '/categories': ROLES.MANAGERS,
        '/suppliers': ROLES.MANAGERS,
        '/purchase-orders': ROLES.MANAGERS,
        '/negative-stock': ROLES.MANAGERS,
        '/promotions': ROLES.MANAGERS,
        '/transactions': ROLES.STAFF_ALL,
        '/credit-customers': ROLES.MANAGERS,
        '/pos-register': ROLES.MANAGERS,

        // POS & Staff Operations (Cashier / Manager / Admin only - Blocked for CEO & Company)
        '/pos': ROLES.STAFF_ALL,
        '/open-shift': ROLES.STAFF_ALL,
        '/close-shift': ROLES.STAFF_ALL,
        '/payment': ROLES.STAFF_ALL,
        '/receipt': ROLES.STAFF_ALL,
        '/customers': ROLES.STAFF_ALL,
        '/customer-display': ROLES.STAFF_ALL,

        // B2B Corporate Client Portal
        '/company-portal': ROLES.COMPANY,

        // Profile & Account
        '/profile': ROLES.ALL_USERS
    };

    // 5. Helper: Determine user's home landing dashboard based on role
    function getHomeRoute(role) {
        const r = (role || '').toLowerCase().trim();
        if (r === 'ceo') return '/ceo-portal';
        if (r === 'admin') return '/dashboard';
        if (r === 'manager' || r === 'store_manager') return '/dashboard';
        if (r === 'cashier' || r === 'teller') return '/pos';
        if (r === 'company' || r === 'business_client') return '/company-portal';
        return '/login';
    }

    // 6. Execute Immediate Synchronous Auth & RBAC Check
    const currentRoute = getCurrentRoute();
    const token = localStorage.getItem('authToken') || localStorage.getItem('companyToken');
    const userPayload = parseJwt(token);

    // Check Token Expiry
    if (token && userPayload && userPayload.exp) {
        if (userPayload.exp * 1000 < Date.now()) {
            console.warn('Authentication token expired.');
            localStorage.removeItem('authToken');
            localStorage.removeItem('companyToken');
            localStorage.removeItem('currentUser');
            localStorage.removeItem('companyUser');
            sessionStorage.removeItem('rbac_violation');
            if (currentRoute !== '/login') {
                document.documentElement.style.display = 'none';
                window.location.replace('/login');
                return;
            }
        }
    }

    const isPublic = ROUTE_PERMISSIONS[currentRoute] === 'PUBLIC' || currentRoute === '/' || currentRoute === '/login';

    if (isPublic) {
        // Clear any stale unauthenticated prompts on public login pages
        sessionStorage.removeItem('rbac_violation');
        
        const isLoggingOut = window.location.search.includes('logout') || sessionStorage.getItem('is_logging_out');
        if (isLoggingOut) {
            localStorage.removeItem('authToken');
            localStorage.removeItem('companyToken');
            localStorage.removeItem('currentUser');
            localStorage.removeItem('companyUser');
            localStorage.clear();
            sessionStorage.removeItem('is_logging_out');
            sessionStorage.removeItem('rbac_violation');
            return;
        }
        // If already logged in with valid token on login page, redirect to home
        if (token && userPayload && currentRoute === '/login') {
            const role = (userPayload.role || userPayload.type || (userPayload.company_id ? 'company' : '')).toLowerCase();
            const home = getHomeRoute(role);
            if (home !== '/login') {
                window.location.replace(home);
                return;
            }
        }
        // Allow public page to render
        return;
    }

    // Protected Route Verification:
    if (!token || !userPayload) {
        // Not authenticated - redirect cleanly without setting phantom violation alerts
        document.documentElement.style.display = 'none';
        sessionStorage.removeItem('rbac_violation');
        window.location.replace('/login');
        return;
    }

    const userRole = (userPayload.role || userPayload.type || (userPayload.company_id ? 'company' : '')).toLowerCase().trim();
    const allowedRoles = ROUTE_PERMISSIONS[currentRoute];

    // If route is unknown or user role is not permitted:
    const isAuthorized = Array.isArray(allowedRoles) && allowedRoles.includes(userRole);

    if (!isAuthorized) {
        document.documentElement.style.display = 'none';
        
        const routeName = currentRoute.replace(/^\//, '').replace(/-/g, ' ').toUpperCase();
        const homeRoute = getHomeRoute(userRole);
        
        sessionStorage.setItem('rbac_violation', JSON.stringify({
            message: `Access Denied: Your account role (${userRole.toUpperCase()}) is not authorized to access ${routeName || 'that page'}.`,
            attemptedRoute: currentRoute,
            role: userRole,
            timestamp: Date.now()
        }));

        console.warn(`RBAC GUARD: Unauthorized navigation to ${currentRoute} by role ${userRole}. Redirecting to ${homeRoute}`);
        window.location.replace(homeRoute && homeRoute !== currentRoute ? homeRoute : '/login');
        return;
    }

    // 7. Inject Enterprise Sidebar CSS & Logout Button Styling on DOM Ready
    function injectSidebarStyles() {
        if (!document.getElementById('sidebar-enterprise-css')) {
            const link = document.createElement('link');
            link.id = 'sidebar-enterprise-css';
            link.rel = 'stylesheet';
            link.href = 'sidebar.css';
            if (document.head) document.head.appendChild(link);
        }
    }

    if (document.head) {
        injectSidebarStyles();
    } else {
        document.addEventListener('DOMContentLoaded', injectSidebarStyles);
    }

    // 8. Security Toast & Async Session Heartbeat on DOM Ready
    document.addEventListener('DOMContentLoaded', () => {
        injectSidebarStyles();

        // Check for RBAC violation flash alert
        const violationData = sessionStorage.getItem('rbac_violation');
        if (violationData) {
            sessionStorage.removeItem('rbac_violation');
            try {
                const parsed = JSON.parse(violationData);
                const rawMsg = (parsed && parsed.message) ? parsed.message.toLowerCase() : '';
                const isStaleAuthPrompt = rawMsg.includes('authentication required') || 
                                          rawMsg.includes('please sign in') || 
                                          rawMsg.includes('session expired') || 
                                          rawMsg.includes('session has ended');

                // If user is currently authenticated on an authorized route, suppress unauthenticated prompts
                if (!isStaleAuthPrompt || !token || !userPayload) {
                    showSecurityToast(parsed.message || 'Access Denied: You do not have permission to access that page.');
                }
            } catch(e) {
                // Ignore parsing errors
            }
        }

        // Asynchronously verify session health against backend
        verifySessionWithServer(token);
    });

    async function verifySessionWithServer(jwtToken) {
        try {
            const res = await fetch('/api/session', {
                headers: { 'Authorization': `Bearer ${jwtToken}` }
            });
            if (!res.ok) {
                if (res.status === 401 || res.status === 403) {
                    console.warn('Session verification failed on server. Logging out.');
                    localStorage.removeItem('authToken');
                    localStorage.removeItem('companyToken');
                    localStorage.removeItem('currentUser');
                    localStorage.removeItem('companyUser');
                    localStorage.clear();
                    sessionStorage.removeItem('rbac_violation');
                    window.location.replace('/login');
                }
            }
        } catch (e) {
            // Network failure or offline - do not force logout if offline
            console.log('Session verification ping skipped (offline/network):', e.message);
        }
    }

    function showSecurityToast(msg) {
        const toast = document.createElement('div');
        toast.style.position = 'fixed';
        toast.style.bottom = '24px';
        toast.style.right = '24px';
        toast.style.background = '#800020';
        toast.style.color = '#ffffff';
        toast.style.padding = '14px 22px';
        toast.style.borderRadius = '10px';
        toast.style.boxShadow = '0 8px 30px rgba(0,0,0,0.35)';
        toast.style.fontFamily = "'Montserrat', 'Poppins', sans-serif";
        toast.style.fontSize = '14px';
        toast.style.fontWeight = '600';
        toast.style.zIndex = '9999999';
        toast.style.display = 'flex';
        toast.style.alignItems = 'center';
        toast.style.gap = '12px';
        toast.style.borderLeft = '6px solid #fdbb2d';
        toast.style.animation = 'slideInToast 0.3s ease-out';

        toast.innerHTML = `
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fdbb2d" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                <line x1="12" y1="9" x2="12" y2="13"></line>
                <line x1="12" y1="17" x2="12.01" y2="17"></line>
            </svg>
            <span>${escapeHtml(msg)}</span>
        `;

        const style = document.createElement('style');
        style.textContent = `
            @keyframes slideInToast {
                from { transform: translateY(30px); opacity: 0; }
                to { transform: translateY(0); opacity: 1; }
            }
        `;
        document.head.appendChild(style);
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.transition = 'all 0.4s ease';
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(20px)';
            setTimeout(() => toast.remove(), 400);
        }, 5000);
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // Universal Global Logout Function
    window.logout = async function() {
        try {
            const token = localStorage.getItem('authToken') || localStorage.getItem('companyToken');
            sessionStorage.setItem('is_logging_out', 'true');
            // Purge credentials immediately from storage
            localStorage.removeItem('authToken');
            localStorage.removeItem('companyToken');
            localStorage.removeItem('currentUser');
            localStorage.removeItem('companyUser');
            localStorage.clear();

            if (token) {
                // Call backend logout asynchronously without blocking navigation
                fetch('/api/logout', { 
                    method: 'POST', 
                    headers: { 'Authorization': `Bearer ${token}` },
                    keepalive: true
                }).catch(() => {});

                fetch('/api/company/logout', { 
                    method: 'POST',
                    keepalive: true
                }).catch(() => {});
            }
        } catch(e) {
            console.error('Logout error:', e);
        } finally {
            localStorage.clear();
            sessionStorage.clear();
            // Clear document cookies if accessible
            try {
                document.cookie.split(";").forEach(c => {
                    document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
                });
            } catch(e) {}
            window.location.replace('/login?logout=true');
        }
    };

    // Expose utility globally
    window.authGuard = {
        getUser: () => userPayload,
        getRole: () => userRole,
        getToken: () => token,
        getHomeRoute: getHomeRoute,
        logout: window.logout,
        showToast: showSecurityToast
    };

})();
