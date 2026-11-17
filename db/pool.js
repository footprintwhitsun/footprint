const { Pool } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');

// SaaS RLS Wrapper Context Tracking
const tenantContext = new AsyncLocalStorage();

let pool = null;
let dbConfigured = false;
let rlsBootstrapComplete = false;
const missingConfigKeys = [];

try {
    const rawConnStr = process.env.DATABASE_URL;
    const connStr = rawConnStr ? rawConnStr.trim().replace(/^["']|["']$/g, '') : null;

    if (!connStr && !(process.env.PGHOST && process.env.PGDATABASE)) {
        missingConfigKeys.push('DATABASE_URL');
        console.error('CRITICAL: No database configuration found in environment. DATABASE_URL must be set.');
    }

    const isProduction = process.env.NODE_ENV === 'production';
    const isSupabase = connStr && (
        connStr.includes('supabase.co') ||
        connStr.includes('supabase.com') ||
        connStr.includes('sslmode=require')
    );
    // TLS to the database. Give the provider's CA certificate (a PEM, or a path to one) in DB_SSL_CA to verify
    // the server. DB_SSL_REJECT_UNAUTHORIZED=true verifies against the system's trusted CAs.
    let ssl = false;
    if (isProduction || isSupabase) {
        const caRaw = process.env.DB_SSL_CA;
        if (caRaw) {
            const fsMod = require('fs');
            const ca = fsMod.existsSync(caRaw) ? fsMod.readFileSync(caRaw, 'utf8') : caRaw.replace(/\\n/g, '\n');
            ssl = { ca, rejectUnauthorized: true };
        } else if (process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true') {
            ssl = { rejectUnauthorized: true };
        } else {
            ssl = { rejectUnauthorized: false };
            if (isProduction) console.warn('WARNING: the database connection is encrypted but the server certificate is not verified. Set DB_SSL_CA to your provider\'s CA certificate.');
        }
    }

    if (process.env.PGHOST || process.env.PGUSER || process.env.PGPASSWORD || process.env.PGDATABASE) {
        pool = new Pool({
            host: process.env.PGHOST || 'localhost',
            user: process.env.PGUSER || undefined,
            password: process.env.PGPASSWORD || undefined,
            database: process.env.PGDATABASE || undefined,
            port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : undefined,
            ssl,
            statement_timeout: 8000,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 8000
        });
        dbConfigured = true;
    } else if (connStr) {
        let cleanConnStr = connStr.replace(/sslmode=[^&]*/g, '')
            .replace(/\?&/, '?')
            .replace(/&&/g, '&')
            .replace(/[?&]$/, '');

        if (cleanConnStr.includes(':6543')) {
            const separator = cleanConnStr.includes('?') ? '&' : '?';
            if (!cleanConnStr.includes('prepare_threshold')) {
                cleanConnStr += `${separator}prepare_threshold=0`;
            }
        }

        pool = new Pool({
            connectionString: cleanConnStr,
            ssl,
            statement_timeout: 8000,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 8000
        });
        dbConfigured = true;
    }

    if (pool) {
        pool.on('error', (err) => {
            console.error('DATABASE POOL ERROR:', err);
        });

        const originalPoolConnect = pool.connect.bind(pool);
        pool.connect = async function () {
            const client = await originalPoolConnect();
            const ctx = tenantContext.getStore();
            if (ctx) {
                const tenantKey = `${ctx.tenantId || ''}:${ctx.isSuperAdmin ? 'true' : 'false'}`;
                if (client.__currentSessionKey !== tenantKey) {
                    try {
                        await client.query(
                            `SELECT set_config('app.current_tenant', $1, false), set_config('app.is_super_admin', $2, false)`,
                            [ctx.isSuperAdmin ? '' : (ctx.tenantId ? ctx.tenantId.toString() : '1'), ctx.isSuperAdmin ? 'true' : 'false']
                        );
                        client.__currentSessionKey = tenantKey;
                    } catch (e) {
                        console.error('Failed to set tenant config on client:', e.message);
                    }
                }
            } else if (rlsBootstrapComplete && client.__currentSessionKey) {
                try {
                    await client.query(
                        `SELECT set_config('app.current_tenant', $1, false), set_config('app.is_super_admin', $2, false)`,
                        ['1', 'false']
                    );
                    client.__currentSessionKey = '1:false';
                } catch (e) {
                    console.error('Failed to reset tenant config on client:', e.message);
                }
            }
            return client;
        };

        pool.query = async function (...args) {
            const client = await pool.connect();
            try {
                return await client.query(...args);
            } finally {
                client.release();
            }
        };
    }
} catch (err) {
    console.error('Postgres pool init error:', err && err.message ? err.message : err);
}

function setRlsBootstrapComplete(val = true) {
    rlsBootstrapComplete = Boolean(val);
}

module.exports = {
    pool,
    dbConfigured,
    tenantContext,
    missingConfigKeys,
    setRlsBootstrapComplete
};

