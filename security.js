const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { validationResult } = require('express-validator');

// Security middleware
const isProduction = process.env.NODE_ENV === 'production';

exports.securityHeaders = helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            // Scripts come only from this site (third-party libraries are pinned in vendor/), so a script tag
            // injected from a public CDN, which can serve any published package, is refused.
            scriptSrc: [
                "'self'", 
                "'unsafe-inline'"
            ],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: [
                "'self'", 
                "'unsafe-inline'", 
                'https://cdn.jsdelivr.net', 
                'https://cdnjs.cloudflare.com', 
                'https://fonts.googleapis.com'
            ],
            imgSrc: ["'self'", "data:", "https:", "blob:"],
            connectSrc: [
                "'self'", 
                'https://api.mtn.com', 
                'https://cdn.jsdelivr.net', 
                'https://cdnjs.cloudflare.com',
                'https://cdn.sheetjs.com'
            ],
            fontSrc: [
                "'self'", 
                'https://cdnjs.cloudflare.com', 
                'https://fonts.gstatic.com'
            ],
            frameAncestors: ["'self'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            workerSrc: ["'self'", "blob:"],
            upgradeInsecureRequests: isProduction ? [] : null
        }
    },
    xFrameOptions: { action: 'sameorigin' },
    xContentTypeOptions: true,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    dnsPrefetchControl: { allow: true },
    hsts: isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginEmbedderPolicy: false
});

// Strict policy in REPORT-ONLY mode: nothing is blocked. The browser reports what an enforced policy
// (no unsafe-inline scripts, no inline event handlers) would have blocked, so the pages can be fixed first.
//
// Inline <script> blocks are allowed by the SHA-256 of their exact text, computed from the page file itself
// (static per file, so browser caching and 304 responses keep working; a nonce would change every response).
// Editing a page's script changes its hash automatically; an injected script has no matching hash and is blocked.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STRICT_BASE = [
    "default-src 'self'",
    "script-src-attr 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    'report-uri /api/csp-report'
];
const SCRIPT_HOSTS = "'self'";
const buildStrictPolicy = (hashes) =>
    [STRICT_BASE[0], `script-src ${SCRIPT_HOSTS}${hashes && hashes.length ? ' ' + hashes.map(h => `'${h}'`).join(' ') : ''}`, ...STRICT_BASE.slice(1)].join('; ');

const INLINE_SCRIPT = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
const hashCache = new Map(); // absolute file -> { mtimeMs, hashes }
function inlineScriptHashes(file) {
    const st = fs.statSync(file);
    const hit = hashCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.hashes;
    const text = fs.readFileSync(file, 'utf8');
    const set = new Set();
    let m;
    INLINE_SCRIPT.lastIndex = 0;
    while ((m = INLINE_SCRIPT.exec(text))) {
        if (m[1].trim()) set.add('sha256-' + crypto.createHash('sha256').update(m[1], 'utf8').digest('base64'));
    }
    const hashes = [...set];
    if (hashCache.size < 300) hashCache.set(file, { mtimeMs: st.mtimeMs, hashes });
    return hashes;
}

exports.inlineScriptHashes = inlineScriptHashes;
exports.buildStrictPolicy = buildStrictPolicy;

exports.cspReportOnly = (req, res, next) => {
    const p = req.path || '';
    if (!p.startsWith('/api/') && !/\.(css|js|svg|png|jpg|jpeg|webp|ico|woff2?|json|map)$/i.test(p)) {
        res.setHeader('Content-Security-Policy-Report-Only', buildStrictPolicy([]));
        // When a page file is sent, allow exactly that file's inline scripts.
        const send = typeof res.sendFile === 'function' ? res.sendFile.bind(res) : null;
        if (send) res.sendFile = function (file, ...rest) {
            try {
                if (typeof file === 'string' && /\.html$/i.test(file) && path.isAbsolute(file)) {
                    res.setHeader('Content-Security-Policy-Report-Only', buildStrictPolicy(inlineScriptHashes(file)));
                }
            } catch (_) { /* a policy that cannot be built must never stop the page */ }
            return send(file, ...rest);
        };
    }
    next();
};

// Rate limiting
exports.limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // limit each IP to 1000 requests per windowMs
    message: 'Too many requests from this IP, please try again after 15 minutes'
});

// Input validation
exports.validateInput = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ 
            success: false,
            errors: errors.array() 
        });
    }
    next();
};