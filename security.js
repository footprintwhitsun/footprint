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