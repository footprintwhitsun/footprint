// Vercel Serverless Function entry point with startup resilience
let app;
let initError = null;

try {
    app = require('../server');
} catch (err) {
    console.error('FATAL: Serverless initialization failed:', err);
    initError = err;
}

module.exports = (req, res) => {
    if (initError) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        const errMessage = (initError && initError.stack) ? initError.stack : String(initError);
        const safeError = errMessage.replace(/</g, '&lt;').replace(/>/g, '&gt;');

        return res.end(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Server Initialization Error - Footprint POS</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b0f19; color: #f3f4f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; box-sizing: border-box; }
        .card { background: #111827; border: 1px solid #1f2937; border-radius: 16px; padding: 36px; max-width: 650px; width: 100%; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); }
        .badge { display: inline-flex; align-items: center; background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); padding: 4px 12px; border-radius: 9999px; font-size: 13px; font-weight: 600; margin-bottom: 16px; }
        h1 { font-size: 22px; font-weight: 700; margin: 0 0 12px 0; color: #ffffff; }
        p { color: #94a3b8; font-size: 15px; line-height: 1.6; margin: 0 0 20px 0; }
        pre { background: #030712; color: #f87171; padding: 16px; border-radius: 8px; font-size: 13px; overflow-x: auto; border: 1px solid #374151; white-space: pre-wrap; word-break: break-all; }
        .instructions { background: #1f2937; border-radius: 12px; padding: 20px; border: 1px solid #374151; margin-top: 20px; }
        .instructions ol { margin: 0; padding-left: 20px; color: #e2e8f0; font-size: 14px; line-height: 1.8; }
        .instructions code { background: #111827; color: #38bdf8; padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 13px; }
        .link { display: inline-block; margin-top: 20px; color: #60a5fa; text-decoration: none; font-weight: 500; font-size: 14px; }
        .link:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <div class="card">
        <div class="badge">Vercel Function Error</div>
        <h1>Server Initialization Failed</h1>
        <p>The serverless function encountered an error while booting:</p>
        <pre>${safeError}</pre>
        <div class="instructions">
            <p style="margin-top:0; color:#e2e8f0; font-weight:600;">Resolution Steps:</p>
            <ol>
                <li>Open your <strong>Vercel Dashboard</strong> &rarr; Project Settings &rarr; <strong>Environment Variables</strong>.</li>
                <li>Verify that <code>DATABASE_URL</code>, <code>JWT_SECRET</code>, and <code>SESSION_SECRET</code> are configured.</li>
                <li>Go to <strong>Deployments</strong> &rarr; <strong>Redeploy</strong>.</li>
            </ol>
        </div>
        <a class="link" href="https://vercel.com/dashboard" target="_blank">&rarr; Open Vercel Dashboard</a>
    </div>
</body>
</html>`);
    }

    if (typeof app === 'function') {
        return app(req, res);
    } else if (app && typeof app.handle === 'function') {
        return app.handle(req, res);
    } else {
        res.statusCode = 500;
        return res.end('Invalid application export from server.js');
    }
};

