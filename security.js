const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { validationResult } = require('express-validator');

// Security middleware
const isProduction = process.env.NODE_ENV === 'production';

exports.securityHeaders = helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'", 
                "'unsafe-inline'", 
                'https://cdn.jsdelivr.net', 
                'https://cdnjs.cloudflare.com', 
                'https://unpkg.com', 
                'https://cdn.sheetjs.com'
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
// (no inline scripts, no inline event handlers) would have blocked, so the pages can be fixed first.
const STRICT_REPORT_POLICY = [
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://cdn.sheetjs.com",
    "script-src-attr 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    'report-uri /api/csp-report'
].join('; ');

exports.cspReportOnly = (req, res, next) => {
    const p = req.path || '';
    if (!p.startsWith('/api/') && !/\.(css|js|svg|png|jpg|jpeg|webp|ico|woff2?|json|map)$/i.test(p)) {
        res.setHeader('Content-Security-Policy-Report-Only', STRICT_REPORT_POLICY);
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