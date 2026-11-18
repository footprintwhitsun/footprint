require('dotenv').config({ path: require('path').join(__dirname, '.env') });

// Handle unhandled promise rejections & uncaught exceptions at the VERY TOP
process.on('unhandledRejection', (err) => {
    console.error('CRITICAL: Unhandled Rejection:', err);
    console.error('Stack:', err?.stack || 'No stack trace');
    // Keep server running - just log the error
});

process.on('uncaughtException', (err) => {
    console.error('CRITICAL: Uncaught Exception:', err);
    console.error('Stack:', err?.stack || 'No stack trace');
    // Keep server running - just log the error
});

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const crypto = require('crypto');
const { randomUUID: uuidv4 } = crypto;
const fs = require('fs');
const { pool, dbConfigured, tenantContext, missingConfigKeys, setRlsBootstrapComplete } = require('./db/pool');
const { PgRateLimitStore, hit: hitCounter, clearHits } = require('./services/shared-state');
const {
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
    guardPageRoute
} = require('./middleware/auth');
// Secrets: a production server must not start with a placeholder or a short secret.
(function checkSecrets() {
    const placeholders = ['footprint-secure-secret-key-2025', 'okwesiwa-dev-jwt-secret-local-only', 'okwesiwa-dev-session-secret-local-only', 'change_this_to_a_random_secret_string'];
    const problems = [];
    for (const [name, value] of [['JWT_SECRET', JWT_SECRET], ['SESSION_SECRET', SESSION_SECRET]]) {
        if (placeholders.includes(value)) problems.push(`${name} is a placeholder value that is published with the project`);
        else if (String(value).length < 32) problems.push(`${name} is shorter than 32 characters`);
    }
    if (!problems.length) return;
    const message = 'Insecure secrets: ' + problems.join('; ') + '. Generate new ones, for example: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"';
    if (process.env.NODE_ENV === 'production') { console.error('FATAL: ' + message); process.exit(1); }
    console.warn('WARNING: ' + message);
})();

// Errors that escape a handler are logged in one machine-readable line so they can be found and alerted on.
process.on('unhandledRejection', (reason) => {
    console.error(JSON.stringify({ level: 'error', event: 'unhandledRejection', message: reason && reason.message ? reason.message : String(reason), stack: reason && reason.stack ? String(reason.stack).split('\n').slice(0, 4).join(' | ') : undefined, at: new Date().toISOString() }));
});

const path = require('path');
const axios = require('axios');
const https = require('https');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const security = require('./security');
const multer = require('multer');
const xlsx = require('xlsx');

const faviconPath = path.join(__dirname, 'logo.png');

const app = express();
app.set('trust proxy', 1);
const compression = require('compression');
app.use(compression());
// Override port 5000 to 5001 to avoid macOS AirPlay conflict
const port = (process.env.PORT && process.env.PORT !== '5000') ? process.env.PORT : 8080;

// Configure Multer for memory storage with upload size limit (5 MB)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Serve favicon if user has added favicon.ico or logo.png
app.get(['/favicon.ico', '/favicon.png'], (req, res) => {
    const icoPath = path.join(__dirname, 'favicon.ico');
    if (req.path === '/favicon.ico' && fs.existsSync(icoPath)) return res.sendFile(icoPath);
    if (fs.existsSync(faviconPath)) return res.sendFile(faviconPath);
    return res.status(204).end();
});
app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'manifest.json'));
});

// Shared PostgreSQL pool & RLS context live in ./db/pool (imported above).

// Audit Logging Helper
// Read-only VIEW_* events are recorded at most once per user+action per minute: the audit trail still shows
// who looked at what, without an extra database write on the critical path of every page load.
const recentViewLogs = new Map();
const VIEW_LOG_INTERVAL_MS = 60 * 1000;
async function logActivity(req, action, details = {}) {
    try {
        const userId = req.user?.id || req.session?.user?.id || null;
        if (typeof action === 'string' && action.startsWith('VIEW_')) {
            const key = userId + '|' + action;
            const now = Date.now();
            const last = recentViewLogs.get(key);
            if (last && now - last < VIEW_LOG_INTERVAL_MS) return;
            recentViewLogs.set(key, now);
            if (recentViewLogs.size > 5000) {
                for (const [k, t] of recentViewLogs) if (now - t > VIEW_LOG_INTERVAL_MS) recentViewLogs.delete(k);
            }
        }
        const ip = req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || '0.0.0.0';
        await pool.query(
            'INSERT INTO activity_logs (user_id, action, details, ip_address) VALUES ($1, $2, $3, $4)',
            [userId, action, details, ip]  // Don't stringify for JSONB column
        );
    } catch (err) {
        console.error('Audit Log Error:', err.message);
    }
}

// A company document (proforma / sales invoice) is visible to users of its own company, and to staff of the
// tenant that owns that company. Everyone else gets "not found".
const COMPANY_DOC_TABLES = new Set(['proforma_invoices', 'sales_invoices']);
async function companyDocAllowed(req, table, id, db) {
    if (!COMPANY_DOC_TABLES.has(table)) return false;
    const runner = db || pool;
    const role = String(req.user?.role || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
    const tenantId = req.user?.tenant_id || 1;
    if (role === 'business_client' || role === 'company' || req.user?.type === 'company') {
        let companyId = req.user.company_id;
        if (!companyId) {
            const r = await runner.query('SELECT company_id FROM company_users WHERE id = $1', [req.user.id]);
            companyId = r.rows[0]?.company_id;
        }
        if (!companyId) return false;
        const r = await runner.query(`SELECT 1 FROM ${table} WHERE id = $1 AND company_id = $2`, [id, companyId]);
        return r.rows.length > 0;
    }
    const r = await runner.query(
        `SELECT 1 FROM ${table} d JOIN companies c ON c.id = d.company_id WHERE d.id = $1 AND COALESCE(c.tenant_id, 1) = $2`,
        [id, tenantId]
    );
    return r.rows.length > 0;
}

// A stock take is scoped to a tenant through its branch.
async function stockTakeInTenant(db, id, tenantId, lock) {
    const r = await db.query(
        `SELECT st.id, st.status, st.branch_id FROM stock_takes st
         LEFT JOIN branches b ON b.id = st.branch_id
         WHERE st.id = $1 AND COALESCE(b.tenant_id, 1) = $2${lock ? ' FOR UPDATE OF st' : ''}`,
        [id, tenantId]
    );
    return r.rows[0] || null;
}

// Helper to resolve stock for a branch with exact, case-insensitive, and fuzzy alias matching (consistent with CEO portal)
function resolveBranchStockFromLevels(levels, candidates) {
    if (!levels) return 0;
    let levelsObj = levels;
    if (typeof levels === 'string') {
        try { levelsObj = JSON.parse(levels || '{}'); } catch (e) { return 0; }
    }
    if (typeof levelsObj !== 'object' || levelsObj === null) return 0;

    const candList = (Array.isArray(candidates) ? candidates : [candidates]).filter(Boolean);
    if (candList.length === 0) return 0;

    const keys = Object.keys(levelsObj);
    if (keys.length === 0) return 0;

    let stockVal = null;

    for (const cand of candList) {
        if (!cand) continue;
        const candTrim = String(cand).trim();
        const candLower = candTrim.toLowerCase();

        // 1. Exact match
        let key = keys.find(k => k === candTrim);
        // 2. Case-insensitive exact match
        if (!key) key = keys.find(k => k.trim().toLowerCase() === candLower);
        // 3. Substring/fuzzy fallback (e.g. 'OKWESIWA LTD Ent Dzorwulu' <-> 'Dzorwulu')
        if (!key) key = keys.find(k => {
            const kl = k.trim().toLowerCase();
            return kl.includes(candLower) || candLower.includes(kl);
        });

        if (key !== undefined && levelsObj[key] !== undefined && levelsObj[key] !== null) {
            const val = Number(levelsObj[key]);
            if (!isNaN(val)) {
                if (stockVal === null) {
                    stockVal = val;
                } else if (stockVal === 0 && val !== 0) {
                    stockVal = val;
                } else if (val < 0) {
                    stockVal = val; // Prioritize negative stock
                } else if (val > stockVal && stockVal >= 0) {
                    stockVal = val;
                }
            }
        }
    }

    return stockVal !== null ? stockVal : 0;
}

// Initialize/Migrate Database Schema
async function initDb() {
    if (!pool) {
        console.warn('initDb skipped: No database pool configured');
        return;
    }
    try {
        if (process.env.VERCEL) {
            try {
                const fastCheck = await pool.query(`
                    SELECT
                        to_regclass('public.users') IS NOT NULL AS has_users,
                        to_regclass('public.gl_accounts') IS NOT NULL AS has_gl,
                        to_regclass('public.payroll_runs') IS NOT NULL AS has_payroll,
                        EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'delivery_notes' AND column_name = 'store_location'
                        ) AS has_dn_loc
                `);
                const row = fastCheck.rows[0] || {};
                if (row.has_users && row.has_gl && row.has_payroll && row.has_dn_loc) {
                    console.log('Database schema up-to-date (fast boot)');
                    return;
                }
            } catch (_) {
                // Fall through to full schema bootstrap
            }
        }
        await pool.query(`
            -- SaaS Multitenancy Table
            CREATE TABLE IF NOT EXISTS tenants (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                subscription_status VARCHAR(50) DEFAULT 'Active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO tenants (id, name) VALUES (1, 'Default System Business') ON CONFLICT (id) DO NOTHING;
            
            -- Company Portal Core Tables
            CREATE TABLE IF NOT EXISTS companies (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER REFERENCES tenants(id) DEFAULT 1,
                name VARCHAR(255) NOT NULL,
                tax_id VARCHAR(50),
                phone VARCHAR(50),
                email VARCHAR(255),
                address TEXT,
                registration_number VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            ALTER TABLE companies ADD COLUMN IF NOT EXISTS registration_number VARCHAR(100);
            ALTER TABLE companies ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) DEFAULT 1;
            UPDATE companies SET tenant_id = 1 WHERE tenant_id IS NULL;
        `);

        // Force explicit separate creation for company_users to prevent transaction pooling drops
        await pool.query(`
            CREATE TABLE IF NOT EXISTS company_users (
                id SERIAL PRIMARY KEY,
                company_id INTEGER REFERENCES companies(id),
                company_name VARCHAR(255),
                contact_person VARCHAR(100),
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                phone VARCHAR(50),
                address TEXT,
                status VARCHAR(20) DEFAULT 'Active',
                role VARCHAR(50) DEFAULT 'business_client',
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS proforma_invoices (
                id SERIAL PRIMARY KEY,
                company_id INTEGER REFERENCES companies(id),
                invoice_number VARCHAR(100) UNIQUE NOT NULL,
                issue_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expiry_date TIMESTAMP,
                subtotal DECIMAL(12,2),
                markup_type VARCHAR(20),
                markup_value DECIMAL(12,2),
                markup_amount DECIMAL(12,2),
                discount_type VARCHAR(20),
                discount_value DECIMAL(12,2),
                discount_amount DECIMAL(12,2),
                tax_amount DECIMAL(12,2) DEFAULT 0,
                total_amount DECIMAL(12,2),
                notes TEXT,
                status VARCHAR(20) DEFAULT 'Sent',
                payment_method VARCHAR(50),
                created_by INTEGER REFERENCES users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS proforma_invoice_items (
                id SERIAL PRIMARY KEY,
                proforma_id INTEGER REFERENCES proforma_invoices(id) ON DELETE CASCADE,
                product_id INTEGER,
                barcode VARCHAR(50),
                product_name VARCHAR(255) NOT NULL,
                quantity DECIMAL(12,2) NOT NULL,
                unit_price DECIMAL(12,2) NOT NULL,
                line_total DECIMAL(12,2) NOT NULL
            );

            CREATE TABLE IF NOT EXISTS company_transactions (
                id SERIAL PRIMARY KEY,
                company_id INTEGER REFERENCES companies(id),
                invoice_id INTEGER,
                transaction_type VARCHAR(50),
                amount DECIMAL(12,2),
                created_by INTEGER REFERENCES users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS sales_invoices (
                id SERIAL PRIMARY KEY,
                company_id INTEGER REFERENCES companies(id),
                proforma_id INTEGER REFERENCES proforma_invoices(id),
                invoice_number VARCHAR(100) UNIQUE NOT NULL,
                issue_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                due_date TIMESTAMP,
                subtotal DECIMAL(12,2),
                markup_type VARCHAR(20),
                markup_value DECIMAL(12,2),
                markup_amount DECIMAL(12,2),
                discount_type VARCHAR(20),
                discount_value DECIMAL(12,2),
                discount_amount DECIMAL(12,2),
                tax_amount DECIMAL(12,2) DEFAULT 0,
                paid_amount DECIMAL(12,2) DEFAULT 0,
                total_amount DECIMAL(12,2),
                notes TEXT,
                payment_method VARCHAR(50),
                status VARCHAR(20) DEFAULT 'Unpaid',
                created_by INTEGER REFERENCES users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS sales_invoice_items (
                id SERIAL PRIMARY KEY,
                invoice_id INTEGER REFERENCES sales_invoices(id) ON DELETE CASCADE,
                product_id INTEGER,
                barcode VARCHAR(50),
                product_name VARCHAR(255) NOT NULL,
                quantity DECIMAL(12,2) NOT NULL,
                unit_price DECIMAL(12,2) NOT NULL,
                line_total DECIMAL(12,2) NOT NULL
            );

            -- Ensure barcode and product_id columns exist for migrations
            ALTER TABLE proforma_invoice_items ADD COLUMN IF NOT EXISTS product_id INTEGER;
            ALTER TABLE proforma_invoice_items ADD COLUMN IF NOT EXISTS barcode VARCHAR(50);
            ALTER TABLE sales_invoice_items ADD COLUMN IF NOT EXISTS product_id INTEGER;
            ALTER TABLE sales_invoice_items ADD COLUMN IF NOT EXISTS barcode VARCHAR(50);

            -- Ensure tax columns exist for migrations
            ALTER TABLE proforma_invoices ADD COLUMN IF NOT EXISTS tax_amount DECIMAL(12,2) DEFAULT 0;
            ALTER TABLE proforma_invoices ADD COLUMN IF NOT EXISTS tax_details JSONB;
            ALTER TABLE proforma_invoices ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50);
            ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50);
            ALTER TABLE proforma_invoices ADD COLUMN IF NOT EXISTS client_name VARCHAR(255);
            ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS tax_amount DECIMAL(12,2) DEFAULT 0;
            ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS tax_details JSONB;
            ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS client_name VARCHAR(255);
            ALTER TABLE proforma_invoices ADD COLUMN IF NOT EXISTS customer_id INT;
            ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS customer_id INT;

            CREATE TABLE IF NOT EXISTS product_batches (
                id SERIAL PRIMARY KEY,
                product_barcode VARCHAR(255),
                batch_number VARCHAR(255),
                expiry_date DATE,
                quantity INT DEFAULT 0,
                quantity_available INT DEFAULT 0,
                quantity_received INT DEFAULT 0,
                branch_id INT DEFAULT 1,
                status VARCHAR(50) DEFAULT 'Active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            ALTER TABLE product_batches ADD COLUMN IF NOT EXISTS quantity INT DEFAULT 0;
            ALTER TABLE product_batches ADD COLUMN IF NOT EXISTS quantity_available INT DEFAULT 0;
            ALTER TABLE product_batches ADD COLUMN IF NOT EXISTS quantity_received INT DEFAULT 0;
            ALTER TABLE product_batches ADD COLUMN IF NOT EXISTS branch_id INT DEFAULT 1;
            ALTER TABLE product_batches ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Active';
            
            -- Fix existing data
            UPDATE product_batches SET quantity_available = quantity WHERE quantity_available = 0 AND quantity > 0;
            UPDATE product_batches SET branch_id = 1 WHERE branch_id IS NULL;

            -- Create Branches Table
            CREATE TABLE IF NOT EXISTS branches (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                location VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            -- Sync branches_id_seq with the actual max id to prevent duplicate key errors
            SELECT setval(pg_get_serial_sequence('branches', 'id'), COALESCE((SELECT MAX(id) FROM branches), 1), false);

            -- Create Products Table if not exists
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                barcode VARCHAR(50) NOT NULL,
                name VARCHAR(255) NOT NULL,
                category VARCHAR(100),
                price DECIMAL(10,2) NOT NULL,
                cost_price DECIMAL(10,2) DEFAULT 0,
                selling_unit VARCHAR(50) DEFAULT 'Unit',
                packaging_unit VARCHAR(50) DEFAULT 'Box',
                conversion_rate DECIMAL(10,2) DEFAULT 1,
                reorder_level INTEGER DEFAULT 10,
                track_batch BOOLEAN DEFAULT TRUE,
                track_expiry BOOLEAN DEFAULT FALSE,
                stock_levels JSONB,
                stock INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            -- Hardware migration: Ensure track_expiry defaults to FALSE and existing hardware items do not require expiry
            ALTER TABLE products ALTER COLUMN track_expiry SET DEFAULT FALSE;
            
            -- Add unique constraint on barcode+name combination (not just barcode)
            -- First check for and handle any existing duplicates
            DO $$ 
            DECLARE
                dup_count INTEGER;
            BEGIN
                -- Count duplicates
                SELECT COUNT(*) INTO dup_count
                FROM (
                    SELECT barcode, name 
                    FROM products 
                    GROUP BY barcode, name 
                    HAVING COUNT(*) > 1
                ) dups;
                
                -- If no duplicates, proceed with constraint change
                IF dup_count = 0 THEN
                    -- Drop the old barcode primary key constraint with CASCADE to remove dependencies
                    ALTER TABLE products DROP CONSTRAINT IF EXISTS products_pkey CASCADE;
                    ALTER TABLE products DROP CONSTRAINT IF EXISTS products_barcode_name_key CASCADE;
                    
                    -- Drop old hard constraint if it exists, replace with partial index
                    -- Partial index allows re-adding a product after it has been soft-deleted
                    ALTER TABLE products DROP CONSTRAINT IF EXISTS products_tenant_barcode_name_key CASCADE;
                    ALTER TABLE products DROP CONSTRAINT IF EXISTS products_barcode_name_key CASCADE;
                    -- Ensure deleted_at column exists BEFORE creating the partial index that references it
                    ALTER TABLE products ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
                    ALTER TABLE products ADD COLUMN IF NOT EXISTS tenant_id INT DEFAULT 1;
                    -- Drop old index (may have wrong definition) and recreate with barcode+name
                    DROP INDEX IF EXISTS products_barcode_active_idx;
                    CREATE UNIQUE INDEX IF NOT EXISTS products_barcode_active_idx
                        ON products(tenant_id, barcode, name) WHERE deleted_at IS NULL AND barcode IS NOT NULL AND barcode != '';
                ELSE
                    -- Skip if duplicates exist - keep existing structure
                    RAISE NOTICE 'Skipping unique index creation - % duplicate (barcode,name) pairs found', dup_count;
                END IF;
            END $$;

            -- 1. Initialize stock_levels from stock if missing (Legacy support)
            UPDATE products 
            SET stock_levels = jsonb_build_object('Main Warehouse', stock)
            WHERE (stock_levels IS NULL OR stock_levels = '{}'::jsonb) AND stock > 0;

            -- 2. Force sync total stock from stock_levels (Ensures Dashboard KPI is accurate)
            UPDATE products 
            SET stock = (
                SELECT COALESCE(SUM(value::int), 0) 
                FROM jsonb_each_text(COALESCE(stock_levels, '{}'::jsonb))
            );

            -- Create Users Table if not exists
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                name VARCHAR(255),
                role VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Ensure users table has all required columns for Staff Management
            ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(100) UNIQUE;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_id VARCHAR(50) UNIQUE;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'Active';
            ALTER TABLE users ADD COLUMN IF NOT EXISTS store_location VARCHAR(100);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS store_id INT;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token VARCHAR(255);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expiry TIMESTAMPTZ;

            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'users'
                      AND column_name = 'reset_token_expiry'
                      AND data_type = 'timestamp without time zone'
                ) THEN
                    ALTER TABLE users
                        ALTER COLUMN reset_token_expiry
                        TYPE TIMESTAMPTZ
                        USING reset_token_expiry AT TIME ZONE 'UTC';
                END IF;
            END $$;

            -- Update existing users to have Active status if null
            UPDATE users SET status = 'Active' WHERE status IS NULL;
            
            -- Normalize existing emails and roles to lowercase to prevent case-sensitivity issues
            UPDATE users SET email = LOWER(email), role = LOWER(role);

            -- Ensure reorder_level has default
            UPDATE products SET reorder_level = 10 WHERE reorder_level IS NULL;

            /* Create Promotions Table if not exists */
            CREATE TABLE IF NOT EXISTS promotions (
                id SERIAL PRIMARY KEY,
                code VARCHAR(50) UNIQUE NOT NULL,
                discount_percentage DECIMAL(5,2) NOT NULL,
                total_discounted DECIMAL(10,2) DEFAULT 0.00,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            -- Ensure total_discounted column exists
           ALTER TABLE promotions ADD COLUMN IF NOT EXISTS total_discounted DECIMAL(10,2) DEFAULT 0.00;
           ALTER TABLE promotions ADD COLUMN IF NOT EXISTS branch_id INT;

           /* Create Promotion Usage Table for Branch Specific Tracking */
           CREATE TABLE IF NOT EXISTS promotion_usage (
                id SERIAL PRIMARY KEY,
                promotion_code VARCHAR(50),
                branch_id INT,
                total_discounted DECIMAL(10,2) DEFAULT 0.00,
                UNIQUE(promotion_code, branch_id)
           );

           -- Create Categories Table
            CREATE TABLE IF NOT EXISTS categories (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                description TEXT,
                branch_id INT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            -- Ensure unique constraint on name + branch for categories to support ON CONFLICT
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'categories_name_branch_id_key') THEN
                    ALTER TABLE categories ADD CONSTRAINT categories_name_branch_id_key UNIQUE (name, branch_id);
                END IF;
            END $$;

            -- Create Suppliers Table
            CREATE TABLE IF NOT EXISTS suppliers (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                contact_person VARCHAR(100),
                phone VARCHAR(50),
                email VARCHAR(255),
                address TEXT,
                rating INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Create Purchase Orders Table
            CREATE TABLE IF NOT EXISTS purchase_orders (
                id SERIAL PRIMARY KEY,
                supplier_id INTEGER,
                status VARCHAR(50) DEFAULT 'Pending',
                total_amount DECIMAL(10, 2) DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Create Purchase Order Items Table
            CREATE TABLE IF NOT EXISTS purchase_order_items (
                id SERIAL PRIMARY KEY,
                po_id INTEGER REFERENCES purchase_orders(id) ON DELETE CASCADE,
                product_barcode VARCHAR(50),
                quantity INTEGER NOT NULL,
                unit_cost DECIMAL(10, 2) NOT NULL
            );

            -- Create Transactions Table
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER,
                store_location VARCHAR(100),
                total_amount DECIMAL(10, 2),
                original_total DECIMAL(10, 2),
                current_total DECIMAL(10, 2),
                payment_method VARCHAR(50),
                receipt_number VARCHAR(100),
                items JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            ALTER TABLE transactions ADD COLUMN IF NOT EXISTS tax_breakdown JSONB;
            ALTER TABLE transactions ADD COLUMN IF NOT EXISTS original_total DECIMAL(10, 2);
            ALTER TABLE transactions ADD COLUMN IF NOT EXISTS current_total DECIMAL(10, 2);

            CREATE TABLE IF NOT EXISTS refunds (
                id SERIAL PRIMARY KEY,
                transaction_id INTEGER REFERENCES transactions(id),
                original_receipt_number VARCHAR(100),
                refund_receipt_number VARCHAR(100),
                refund_amount DECIMAL(10, 2),
                payment_method VARCHAR(50),
                processed_by INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

           -- Add branch_id to other inventory tables for isolation
           ALTER TABLE categories ADD COLUMN IF NOT EXISTS branch_id INT;
           ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS branch_id INT;
           ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS branch_id INT;

            -- Ensure transactions table has status column
            ALTER TABLE transactions ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'completed';
            UPDATE transactions SET status = 'completed' WHERE status IS NULL;
            
            -- Add return tracking columns
            ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_return BOOLEAN DEFAULT FALSE;
            ALTER TABLE transactions ADD COLUMN IF NOT EXISTS original_transaction_id INTEGER;
            ALTER TABLE transactions ADD COLUMN IF NOT EXISTS return_items JSONB;
            ALTER TABLE transactions ADD COLUMN IF NOT EXISTS has_returns BOOLEAN DEFAULT FALSE;
            
            -- Create Customers Table
            CREATE TABLE IF NOT EXISTS customers (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                phone VARCHAR(50),
                email VARCHAR(255),
                credit_limit DECIMAL(10,2) DEFAULT 0.00,
                current_balance DECIMAL(10,2) DEFAULT 0.00,
                account_number VARCHAR(10) UNIQUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            ALTER TABLE customers ADD COLUMN IF NOT EXISTS account_number VARCHAR(10) UNIQUE;
            ALTER TABLE transactions ADD COLUMN IF NOT EXISTS customer_id INT;
            ALTER TABLE transactions ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255);
            ALTER TABLE customers ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'Active';
            ALTER TABLE customers ADD COLUMN IF NOT EXISTS created_by INT;

            ALTER TABLE customers ADD COLUMN IF NOT EXISTS pending_credit_limit DECIMAL(12, 2);

            -- Create Shifts Table
            CREATE TABLE IF NOT EXISTS shifts (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                end_time TIMESTAMP,
                start_cash DECIMAL(10,2) DEFAULT 0,
                end_cash DECIMAL(10,2),
                notes TEXT,
                status VARCHAR(20) DEFAULT 'open'
            );

            -- Create Customer Payments Table (For Statement Generation)
            CREATE TABLE IF NOT EXISTS customer_payments (
                id SERIAL PRIMARY KEY,
                customer_id INTEGER REFERENCES customers(id),
                amount DECIMAL(10, 2) NOT NULL,
                payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                recorded_by INTEGER
            );

            -- Durable idempotency claims. An in-process Map cannot protect replays: on
            -- serverless each invocation has its own memory, and concurrent same-key requests
            -- both pass an in-memory check before either writes.
            CREATE TABLE IF NOT EXISTS idempotency_claims (
                key TEXT PRIMARY KEY,
                user_id INTEGER,
                receipt_number TEXT,
                transaction_id INTEGER,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);

        // Only one open shift per user at a time. Existing overlapping rows (created before
        // this guard) would violate the index, so this is best-effort and reported loudly.
        try {
            await pool.query(`
                CREATE UNIQUE INDEX IF NOT EXISTS uq_shifts_one_open_per_user
                ON shifts (user_id) WHERE end_time IS NULL
            `);
        } catch (idxErr) {
            console.error('WARNING: could not create the one-open-shift-per-user unique index (likely duplicate open shifts already exist):', idxErr.message);
        }

        // Best-effort: reject duplicate receipt numbers if none already exist.
        try {
            await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_receipt ON transactions (receipt_number)`);
        } catch (idxErr) {
            console.error('WARNING: could not unique-index transactions.receipt_number (duplicate receipts already exist):', idxErr.message);
        }

        // Replays older than this are not meaningful; keep the claim table bounded.
        try {
            await pool.query(`DELETE FROM idempotency_claims WHERE created_at < NOW() - INTERVAL '30 days'`);
        } catch (cleanErr) {
            console.error('WARNING: could not prune idempotency_claims:', cleanErr.message);
        }

        // Fix legacy schema constraints (first_name/last_name) to allow NULLs
        try {
            await pool.query(`
                    DO $$ 
                    BEGIN 
                        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'first_name') THEN 
                            ALTER TABLE customers ALTER COLUMN first_name DROP NOT NULL; 
                        END IF;
                        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'last_name') THEN 
                            ALTER TABLE customers ALTER COLUMN last_name DROP NOT NULL; 
                        END IF;
                    END $$;
                `);
        } catch (e) { console.error('Schema constraint fix error:', e.message); }

        await pool.query(`
            -- Create Expenses Table for Net Profit Calculation
            CREATE TABLE IF NOT EXISTS expenses (
                id SERIAL PRIMARY KEY,
                category VARCHAR(100) NOT NULL, -- Rent, Utilities, Salary, etc.
                amount DECIMAL(10,2) NOT NULL,
                description TEXT,
                expense_date DATE DEFAULT CURRENT_DATE,
                branch_id INT DEFAULT 1,
                created_by INT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Create Activity Logs Table (Audit Trail)
            CREATE TABLE IF NOT EXISTS activity_logs (
                id SERIAL PRIMARY KEY,
                user_id INT,
                action VARCHAR(100),
                details JSONB,
                ip_address VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Create System Settings Table
            CREATE TABLE IF NOT EXISTS system_settings (
                id INT PRIMARY KEY,
                store_name VARCHAR(255),
                currency_symbol VARCHAR(50),
                vat_rate DECIMAL(5,2),
                receipt_footer TEXT,
                tax_id VARCHAR(50),
                phone VARCHAR(50),
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            -- Add branch_id to system_settings if not exists
            ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS branch_id INT DEFAULT 1;
            ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS tax_id VARCHAR(50);
            ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS address TEXT;
            ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS email VARCHAR(255);
            ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS logo_url TEXT;
            ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
            ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS bank_name VARCHAR(255);
            ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS bank_account_name VARCHAR(255);
            ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS bank_account_number VARCHAR(255);
            ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS bank_branch VARCHAR(255);
            ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS momo_number VARCHAR(255);
            ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS momo_name VARCHAR(255);
            
            -- Add credit_auth_code to system_settings
            ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS credit_auth_code VARCHAR(50);
            ALTER TABLE system_settings ALTER COLUMN credit_auth_code DROP DEFAULT;
            ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS credit_auth_code_expiry TIMESTAMP;
            
            -- Add monthly_target to system_settings
            ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS monthly_target DECIMAL(12,2) DEFAULT 50000.00;

            -- Ensure unique constraint on branch_id
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_settings_branch_id_key') THEN
                    ALTER TABLE system_settings ADD CONSTRAINT system_settings_branch_id_key UNIQUE (branch_id);
                END IF;
            END $$;



            -- Create Customer Ledger Table (Part 2 Implementation)
            CREATE TABLE IF NOT EXISTS customer_ledger (
                id SERIAL PRIMARY KEY,
                customer_id INTEGER NOT NULL,
                date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                description VARCHAR(255),
                type VARCHAR(50),
                debit DECIMAL(12, 2) DEFAULT 0.00,
                credit DECIMAL(12, 2) DEFAULT 0.00,
                balance DECIMAL(12, 2) DEFAULT 0.00,
                transaction_id INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_ledger_customer_date ON customer_ledger(customer_id, date);

            -- Backfill Ledger if empty (Ensures existing data appears in statements)
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM customer_ledger LIMIT 1) THEN
                    -- Insert Sales
                    INSERT INTO customer_ledger (customer_id, date, description, type, debit, credit, transaction_id)
                    SELECT customer_id, created_at, COALESCE(receipt_number, 'TRX') || ' (Sale)', 'SALE', total_amount, 0, id
                    FROM transactions WHERE payment_method = 'credit' AND customer_id IS NOT NULL AND status = 'completed';
                    
                    -- Insert Payments
                    INSERT INTO customer_ledger (customer_id, date, description, type, debit, credit)
                    SELECT customer_id, payment_date, 'Payment Received', 'PAYMENT', 0, amount FROM customer_payments;
                END IF;
            END $$;

            -- FIX: Backfill store_id for users who have a location but no ID (Ensures Managers see correct VAT)
            UPDATE users u
            SET store_id = b.id
            FROM branches b
            WHERE (LOWER(u.store_location) = LOWER(b.location) OR LOWER(u.store_location) = LOWER(b.name))
            AND u.store_id IS NULL;
        `);

        // --- SOFT DELETE MIGRATION (Data Retention Compliance) ---
        // Records are never physically removed. deleted_at timestamp marks when they were "deleted".
        await pool.query(`
            ALTER TABLE users         ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
            ALTER TABLE products      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
            ALTER TABLE categories    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
            ALTER TABLE suppliers     ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
            ALTER TABLE customers     ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
            ALTER TABLE branches      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
            ALTER TABLE branches      ADD COLUMN IF NOT EXISTS is_main BOOLEAN DEFAULT FALSE;
            ALTER TABLE branches      ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
            ALTER TABLE branches      ADD COLUMN IF NOT EXISTS manager VARCHAR(120);
            ALTER TABLE branches      ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'Active';
            ALTER TABLE promotions    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
            -- Ensure branch 1 is the main branch if no main branch is set yet
            UPDATE branches SET is_main = TRUE WHERE id = 1 AND NOT EXISTS (SELECT 1 FROM branches WHERE is_main = TRUE);

            -- Partial unique indexes: uniqueness ONLY enforced on active (non-deleted) records.
            -- This allows re-creation of the same email/barcode/code after a soft delete.
            CREATE UNIQUE INDEX IF NOT EXISTS users_email_active_idx
                ON users(LOWER(email)) WHERE deleted_at IS NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS users_username_active_idx
                ON users(username) WHERE deleted_at IS NULL AND username IS NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS users_employee_id_active_idx
                ON users(employee_id) WHERE deleted_at IS NULL AND employee_id IS NOT NULL;
            ALTER TABLE promotions ADD COLUMN IF NOT EXISTS tenant_id INT DEFAULT 1;
            CREATE UNIQUE INDEX IF NOT EXISTS promotions_code_tenant_active_idx
                ON promotions(code, tenant_id) WHERE deleted_at IS NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS customers_account_number_active_idx
                ON customers(account_number) WHERE deleted_at IS NULL AND account_number IS NOT NULL;
        `);

        // --- ENHANCED INVENTORY TABLES (Fix for 500 Errors) ---
        await pool.query(`
            -- Shelf Management
            CREATE TABLE IF NOT EXISTS shelf_inventory (
                id SERIAL PRIMARY KEY,
                product_barcode VARCHAR(50),
                quantity_on_shelf INTEGER DEFAULT 0,
                store_quantity INTEGER DEFAULT 0,
                branch_id INTEGER,
                last_verified TIMESTAMP,
                staff_id INTEGER,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(product_barcode, branch_id)
            );
            
            -- Fix: Ensure branch_id exists on shelf_inventory (Migration for existing tables)
            ALTER TABLE shelf_inventory ADD COLUMN IF NOT EXISTS branch_id INTEGER;
            
            -- Fix: Update unique constraint to include branch_id if it was previously just product_barcode
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shelf_inventory_product_barcode_key') THEN
                    ALTER TABLE shelf_inventory DROP CONSTRAINT shelf_inventory_product_barcode_key;
                    ALTER TABLE shelf_inventory ADD CONSTRAINT shelf_inventory_product_barcode_branch_id_key UNIQUE (product_barcode, branch_id);
                END IF;
            END $$;

            CREATE TABLE IF NOT EXISTS shelf_movements (
                id SERIAL PRIMARY KEY,
                product_barcode VARCHAR(50),
                movement_type VARCHAR(50),
                quantity INTEGER,
                staff_id INTEGER,
                from_location VARCHAR(100),
                to_location VARCHAR(100),
                branch_id INTEGER,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Stock Adjustments
            CREATE TABLE IF NOT EXISTS stock_adjustments (
                id SERIAL PRIMARY KEY,
                product_barcode VARCHAR(50),
                adjustment_type VARCHAR(50),
                quantity_adjusted INTEGER,
                reason TEXT,
                approver_id INTEGER,
                branch_id INTEGER,
                approved_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Stock Takes
            CREATE TABLE IF NOT EXISTS stock_takes (
                id SERIAL PRIMARY KEY,
                stock_take_date DATE,
                branch_id INTEGER,
                created_by INTEGER,
                approved_by INTEGER,
                status VARCHAR(50) DEFAULT 'In Progress',
                variance_total DECIMAL(10,2),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS stock_take_items (
                id SERIAL PRIMARY KEY,
                stock_take_id INTEGER REFERENCES stock_takes(id) ON DELETE CASCADE,
                product_barcode VARCHAR(50),
                physical_count INTEGER,
                system_count INTEGER,
                variance INTEGER,
                variance_reason VARCHAR(255),
                counted_by VARCHAR(100),
                counted_at TIMESTAMP
            );

            -- Reorder Alerts
            CREATE TABLE IF NOT EXISTS reorder_alerts (
                id SERIAL PRIMARY KEY,
                product_barcode VARCHAR(50),
                current_stock INTEGER,
                reorder_level INTEGER,
                suggested_quantity INTEGER,
                priority VARCHAR(20),
                status VARCHAR(50) DEFAULT 'Active',
                branch_id INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                acknowledged_at TIMESTAMP,
                UNIQUE(product_barcode)
            );

            -- Inventory Audit Log
            CREATE TABLE IF NOT EXISTS inventory_audit_log (
                id SERIAL PRIMARY KEY,
                action_type VARCHAR(100),
                product_barcode VARCHAR(50),
                quantity_before INTEGER,
                quantity_after INTEGER,
                reference_id INTEGER,
                reference_type VARCHAR(50),
                user_id INTEGER,
                branch_id INTEGER,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            -- Goods Received
            CREATE TABLE IF NOT EXISTS goods_received (
                id SERIAL PRIMARY KEY,
                po_id INTEGER,
                product_barcode VARCHAR(50),
                quantity_received INTEGER,
                quantity_packaging_units INTEGER,
                unit_cost DECIMAL(10,2),
                batch_number VARCHAR(100),
                expiry_date DATE,
                received_by INTEGER,
                invoice_number VARCHAR(100),
                branch_id INTEGER,
                received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Create Stock Transfers Table
            CREATE TABLE IF NOT EXISTS stock_transfers (
                id SERIAL PRIMARY KEY,
                transfer_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                from_branch_id INTEGER,
                to_branch_id INTEGER,
                status VARCHAR(50) DEFAULT 'Pending',
                created_by INTEGER,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1
            );
            
            -- Ensure stock_transfers has all columns
            ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS branch_id INT;
            ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS confirmed_by INT;
            ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMP;
            ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS notes TEXT;
            ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS from_location VARCHAR(255);
            ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS to_location VARCHAR(255);
            ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS items JSONB;
            -- databases built by init_db_and_users.js lack this column, which made GET /api/transfers return 500
            ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS transfer_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

            CREATE TABLE IF NOT EXISTS stock_transfer_items (
                id SERIAL PRIMARY KEY,
                transfer_id INTEGER REFERENCES stock_transfers(id) ON DELETE CASCADE,
                product_barcode VARCHAR(50),
                quantity_sent INTEGER,
                quantity_received INTEGER,
                unit_cost DECIMAL(10,2),
                batch_number VARCHAR(100),
                expiry_date DATE
            );
            
            -- Price Lists
            CREATE TABLE IF NOT EXISTS price_lists (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                list_type VARCHAR(50),
                branch_id INTEGER,
                effective_date DATE,
                status VARCHAR(20) DEFAULT 'Active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS price_list_items (
                id SERIAL PRIMARY KEY,
                price_list_id INTEGER REFERENCES price_lists(id) ON DELETE CASCADE,
                product_barcode VARCHAR(50),
                markup_percentage DECIMAL(5,2),
                selling_price DECIMAL(10,2),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Ensure per-tenant unique constraint on product_batches for ON CONFLICT clauses
            ALTER TABLE product_batches ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES tenants(id) DEFAULT 1;
            UPDATE product_batches SET tenant_id = 1 WHERE tenant_id IS NULL;
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_batches_barcode_batch_branch_key') THEN
                    ALTER TABLE product_batches DROP CONSTRAINT product_batches_barcode_batch_branch_key;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_batches_tenant_barcode_batch_branch_key') THEN
                    ALTER TABLE product_batches ADD CONSTRAINT product_batches_tenant_barcode_batch_branch_key UNIQUE (tenant_id, product_barcode, batch_number, branch_id);
                END IF;
            END $$;
        `);

        // --- TAX MANAGEMENT TABLES ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS tax_rules (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                rate DECIMAL(5,2) NOT NULL,
                branch_id INTEGER,
                status VARCHAR(20) DEFAULT 'Active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Add branch_id column if it doesn't exist
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tax_rules' AND column_name='branch_id') THEN
                    ALTER TABLE tax_rules ADD COLUMN branch_id INTEGER;
                END IF;
            END $$;

            -- Migration: Set branch_id = 1 for any legacy rules where it is currently NULL
            -- This prevents them from leaking into other portals/branches
            UPDATE tax_rules SET branch_id = 1 WHERE branch_id IS NULL;
            
            -- Add soft-delete column for tax_rules
            ALTER TABLE tax_rules ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
        `);
        // MULTI-TENANT ISOLATION MIGRATIONS
        await pool.query(`
            ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES tenants(id) DEFAULT 1;
            ALTER TABLE branches ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES tenants(id) DEFAULT 1;
            ALTER TABLE products ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES tenants(id) DEFAULT 1;
            ALTER TABLE categories ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES tenants(id) DEFAULT 1;
            ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES tenants(id) DEFAULT 1;
            ALTER TABLE transactions ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES tenants(id) DEFAULT 1;
            ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES tenants(id) DEFAULT 1;
            ALTER TABLE expenses ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES tenants(id) DEFAULT 1;
            ALTER TABLE shifts ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES tenants(id) DEFAULT 1;
            ALTER TABLE refunds ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES tenants(id) DEFAULT 1;
            ALTER TABLE customers ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES tenants(id) DEFAULT 1;
            ALTER TABLE promotions ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES tenants(id) DEFAULT 1;

            UPDATE users SET tenant_id = 1 WHERE tenant_id IS NULL;
            UPDATE branches SET tenant_id = 1 WHERE tenant_id IS NULL;
            UPDATE products SET tenant_id = 1 WHERE tenant_id IS NULL;
            UPDATE categories SET tenant_id = 1 WHERE tenant_id IS NULL;
            UPDATE suppliers SET tenant_id = 1 WHERE tenant_id IS NULL;
            UPDATE transactions SET tenant_id = 1 WHERE tenant_id IS NULL;
            UPDATE purchase_orders SET tenant_id = 1 WHERE tenant_id IS NULL;
            UPDATE expenses SET tenant_id = 1 WHERE tenant_id IS NULL;
            UPDATE shifts SET tenant_id = 1 WHERE tenant_id IS NULL;
            UPDATE refunds SET tenant_id = 1 WHERE tenant_id IS NULL;
            UPDATE customers SET tenant_id = 1 WHERE tenant_id IS NULL;
            UPDATE promotions SET tenant_id = 1 WHERE tenant_id IS NULL;

            -- users is not covered by RLS (it is absent from the saasTables loop), so every
            -- user-management statement filters on tenant_id; index it here, after the column
            -- and backfill above exist, so a fresh database does not fail on a missing column.
            CREATE INDEX IF NOT EXISTS idx_users_tenant ON users (tenant_id);
        `);



        // SaaS MULTI-TENANT ARCHITECTURE LOOP
        // Natively inject tenant_id global sandboxes across all operational tables
        const saasTables = [
            'proforma_invoices', 'proforma_invoice_items', 'company_transactions',
            'sales_invoices', 'sales_invoice_items', 'product_batches', 'transactions',
            'refunds', 'customers', 'shifts', 'customer_payments', 'expenses',
            'activity_logs', 'system_settings', 'customer_ledger', 'shelf_inventory',
            'shelf_movements', 'stock_adjustments', 'stock_takes', 'stock_take_items',
            'reorder_alerts', 'inventory_audit_log', 'goods_received', 'stock_transfers',
            'stock_transfer_items', 'price_lists', 'price_list_items', 'tax_rules',
            'products', 'suppliers', 'purchase_orders', 'purchase_order_items',
            'delivery_notes', 'pos_holds', 'pos_quotations', 'pos_approval_tokens',
            'layaways', 'layaway_payments', 'staff_attendance', 'cash_accounts',
            'branch_targets', 'cash_drops', 'daily_closes', 'brands',
            'unit_conversions', 'price_history', 'customer_groups', 'customer_sites',
            'supplier_payments', 'roles', 'companies', 'company_users',
            'business_settings', 'notification_templates', 'expense_categories',
            'gl_accounts', 'gl_journal_entries', 'gl_journal_lines', 'bank_statement_lines',
            'payroll_profiles', 'payroll_runs', 'payroll_items'
        ];

        for (const table of saasTables) {
            try {
                // Ensure table structure exists and forcefully map sandbox parameter
                await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES tenants(id) DEFAULT 1;`);
                await pool.query(`UPDATE ${table} SET tenant_id = 1 WHERE tenant_id IS NULL;`);

                // RLS: Natively lock the database table to the current Express Session context mathematically
                await pool.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
                await pool.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
                await pool.query(`DROP POLICY IF EXISTS tenant_isolation_policy ON ${table};`);
                await pool.query(`
                    CREATE POLICY tenant_isolation_policy ON ${table}
                    FOR ALL
                    USING (
                        current_setting('app.is_super_admin', true) = 'true' 
                        OR tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int
                    );
                `);

                // Magic Mechanism: Missing API INSERT structures automatically inherit the Sandbox Default!
                await pool.query(`
                    ALTER TABLE ${table} ALTER COLUMN tenant_id 
                    SET DEFAULT COALESCE(NULLIF(current_setting('app.current_tenant', true), '')::int, 1);
                `);
            } catch (err) {
                // If the table doesn't exist yet, we can gracefully skip
                if (err.code !== '42P01') {
                    console.error(`Error enforcing tenant_id on sandbox table ${table}:`, err.message);
                }
            }
        }

        // Composite Indexes for Enterprise Multitenancy and Scalability
        const compositeIndexes = [
            `CREATE INDEX IF NOT EXISTS idx_sales_tenant_created ON sales (tenant_id, created_at DESC)`,
            `CREATE INDEX IF NOT EXISTS idx_transactions_tenant_created ON transactions (tenant_id, created_at DESC)`,
            `CREATE INDEX IF NOT EXISTS idx_customers_tenant_phone ON customers (tenant_id, phone)`,
            `CREATE INDEX IF NOT EXISTS idx_activity_logs_tenant_created ON activity_logs (tenant_id, created_at DESC)`
        ];
        for (const idxQuery of compositeIndexes) {
            try {
                await pool.query(idxQuery);
            } catch (idxErr) {
                // Graceful skip if table not created yet
            }
        }

        // Ensure branch-scoped reporting columns exist on delivery_notes at startup
        await pool.query(`ALTER TABLE delivery_notes ADD COLUMN IF NOT EXISTS store_location VARCHAR(120) DEFAULT '';`).catch(() => {});

        console.log('Database schema checked/updated');
    } catch (err) {
        console.error('DB Init Error:', err);
    } finally {
        setRlsBootstrapComplete(true);
    }
}
const initDbPromise = initDb();
console.log('initDb() called');

// Security middleware
app.use(security.securityHeaders);
app.use(security.limiter);

app.get('/healthz', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.status(200).json({ ok: true, db: 'connected', uptime: Math.round(process.uptime()) });
    } catch (err) {
        res.status(503).json({ ok: false, db: 'disconnected' });
    }
});

// Tighter dedicated limiter for the login endpoint (10 attempts / 15 min per IP)
const loginLimiter = require('express-rate-limit')({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { success: false, message: 'Too many login attempts. Please wait 15 minutes and try again.' },
    standardHeaders: true,
    legacyHeaders: false,
    store: new PgRateLimitStore('login:')
});

// Same protection for the other credential-guessing surfaces: company login, password reset
// request, and token redemption.
const authLimiter = require('express-rate-limit')({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { success: false, message: 'Too many attempts. Please wait 15 minutes and try again.' },
    standardHeaders: true,
    legacyHeaders: false,
    store: new PgRateLimitStore('auth:')
});

// Session configuration
let sessionStore;
if (pool) {
    try {
        sessionStore = new pgSession({
            pool: pool,
            tableName: 'user_sessions',
            createTableIfMissing: true,
            ttl: 24 * 60 * 60 // 24 hours in seconds
        });
        sessionStore.on('error', (err) => {
            console.error('SESSION STORE PG ERROR (non-fatal):', err && err.message ? err.message : err);
        });
    } catch (pgErr) {
        if (process.env.NODE_ENV === 'production') {
            // A memory store would log users out at random across serverless instances. Fail loudly instead.
            console.error('FATAL: the session store could not start: ' + (pgErr && pgErr.message ? pgErr.message : pgErr));
            process.exit(1);
        }
        console.error('SESSION STORE INIT ERROR (falling back to MemoryStore, development only):', pgErr && pgErr.message ? pgErr.message : pgErr);
        sessionStore = new session.MemoryStore();
    }
} else {
    sessionStore = new session.MemoryStore();
}

const sessionConfig = {
    store: sessionStore,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true, // the cookie's clock restarts on activity
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        // Only set domain explicitly if COOKIE_DOMAIN env var is provided
        ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {})
    },
    name: 'pos.sid' // Custom session cookie name
};

// Initialize session middleware. Static assets never need a session, so skip the session-store
// (Postgres) round trip for them.
const sessionMiddleware = session(sessionConfig);
const STATIC_ASSET_RE = /\.(css|js|svg|png|jpg|jpeg|webp|ico|woff2?|map|webmanifest)$/i;
app.use((req, res, next) => {
    if (req.method === 'GET' && STATIC_ASSET_RE.test(req.path)) return next();
    return sessionMiddleware(req, res, next);
});

// Cross-site request check. A cookie-authenticated write must come from this site; calls that carry
// their own bearer token cannot be forged by another site and pass through.
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    if (req.headers.authorization) return next();
    let origin = req.headers.origin;
    if (!origin && req.headers.referer) { try { origin = new URL(req.headers.referer).origin; } catch (_) { origin = ''; } }
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (origin) {
        let originHost = '';
        try { originHost = new URL(origin).host; } catch (_) { originHost = ''; }
        if (originHost && originHost !== host && !ALLOWED_ORIGINS.includes(origin)) {
            return res.status(403).json({ success: false, message: 'Cross-site request blocked.' });
        }
    } else if (req.headers['sec-fetch-site'] === 'cross-site') {
        return res.status(403).json({ success: false, message: 'Cross-site request blocked.' });
    }
    next();
});

// Database & environment configuration check middleware for Vercel deployments
app.use((req, res, next) => {
    if ((!pool || missingConfigKeys.length > 0) && !req.path.startsWith('/favicon') && !req.path.endsWith('.png') && !req.path.endsWith('.css') && !req.path.endsWith('.js') && !req.path.endsWith('.ico')) {
        const missingList = missingConfigKeys.length > 0
            ? missingConfigKeys.map(k => `<li><code>${k}</code></li>`).join('')
            : '<li><code>DATABASE_URL</code></li>';

        return res.status(503).send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Configuration Required - OKWESIWA LTD</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b0f19; color: #f3f4f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; box-sizing: border-box; }
        .card { background: #111827; border: 1px solid #1f2937; border-radius: 16px; padding: 36px; max-width: 600px; width: 100%; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); }
        .badge { display: inline-flex; align-items: center; background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); padding: 4px 12px; border-radius: 9999px; font-size: 13px; font-weight: 600; margin-bottom: 16px; }
        h1 { font-size: 22px; font-weight: 700; margin: 0 0 12px 0; color: #ffffff; }
        p { color: #94a3b8; font-size: 15px; line-height: 1.6; margin: 0 0 20px 0; }
        .instructions { background: #1f2937; border-radius: 12px; padding: 20px; border: 1px solid #374151; }
        .instructions ol { margin: 0; padding-left: 20px; color: #e2e8f0; font-size: 14px; line-height: 1.8; }
        .instructions code { background: #111827; color: #38bdf8; padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 13px; }
        .missing-box { background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 8px; padding: 12px 16px; margin-bottom: 20px; }
        .missing-box ul { margin: 6px 0 0 0; padding-left: 20px; }
        .missing-box li { color: #fca5a5; font-size: 14px; margin: 3px 0; }
        .link { display: inline-block; margin-top: 20px; color: #60a5fa; text-decoration: none; font-weight: 500; font-size: 14px; }
        .link:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <div class="card">
        <div class="badge">Vercel Deployment Notice</div>
        <h1>Environment Variables Required</h1>
        <p>Your OKWESIWA LTD serverless function is running, but the following required environment variable(s) have not been added to your Vercel Project Settings:</p>
        <div class="missing-box">
            <strong style="color: #ef4444; font-size: 13px;">MISSING IN VERCEL SETTINGS:</strong>
            <ul>${missingList}</ul>
        </div>
        <div class="instructions">
            <ol>
                <li>Go to your <strong>Vercel Dashboard</strong> &rarr; Select this project.</li>
                <li>Navigate to <strong>Settings</strong> &rarr; <strong>Environment Variables</strong>.</li>
                <li>Add the following keys from your local <code>.env</code> file:
                    <ul>
                        <li><code>DATABASE_URL</code> (Your Supabase connection string)</li>
                        <li><code>JWT_SECRET</code></li>
                        <li><code>SESSION_SECRET</code></li>
                        <li><code>NODE_ENV</code> = <code>production</code></li>
                    </ul>
                </li>
                <li>Go to the <strong>Deployments</strong> tab &rarr; click the three dots (&hellip;) on latest deployment &rarr; <strong>Redeploy</strong>.</li>
            </ol>
        </div>
        <a class="link" href="https://vercel.com/dashboard" target="_blank">&rarr; Open Vercel Dashboard</a>
    </div>
</body>
</html>
        `);
    }
    next();
});

// CORS configuration
// Reflecting "any origin" with credentials:true lets an attacker's page read authenticated
// responses, so cross-origin access is only granted to an explicit allow-list.
const allowedOrigins = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map(s => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
if (process.env.NODE_ENV !== 'production') {
    ['http://localhost:3000', 'http://localhost:8080', 'http://127.0.0.1:3000']
        .forEach(o => { if (!allowedOrigins.includes(o)) allowedOrigins.push(o); });
}

const corsOptions = {
    origin: (origin, cb) => {
        // No Origin header: same-origin navigation, mobile apps, or server-to-server
        // callbacks such as the MoMo notification endpoint.
        if (!origin) return cb(null, true);
        if (allowedOrigins.includes(origin.replace(/\/$/, ''))) return cb(null, true);
        return cb(null, false);
    },
    credentials: true,
    optionsSuccessStatus: 200,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Idempotency-Key']
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions)); // Enable pre-flight for all routes

// Body parser middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Wait for schema & RLS bootstrap before serving API/page requests (skip for static assets/healthz and cap wait to avoid serverless 504s)
app.use(async (req, res, next) => {
    const p = req.path || '';
    // Only API calls need the schema bootstrap; HTML pages and assets are served without waiting on the database.
    if (!p.startsWith('/api/')) {
        return next();
    }
    try {
        await Promise.race([
            initDbPromise,
            new Promise((resolve) => setTimeout(resolve, 5000))
        ]);
    } catch (e) {
        // initDb logs errors internally
    }
    next();
});

// Enterprise Token Blacklist & authenticateToken are imported from ./middleware/auth above.

// Session Revocation Endpoint
app.post('/api/auth/revoke', authenticateToken, async (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token) await revokeToken(token);
    if (req.session) {
        req.session.destroy(() => { });
    }
    res.json({ success: true, message: 'Session revoked successfully' });
});

// Root Route - Redirect to login
app.get('/', (req, res) => {
    res.redirect('/login');
});

// Normalize multiple slashes and redirect .html requests to clean canonical routes
app.use((req, res, next) => {
    let cleanPath = req.path.replace(/\/+/g, '/');
    if (cleanPath.endsWith('.html')) {
        cleanPath = cleanPath.slice(0, -5);
    }
    if (cleanPath.length > 1 && cleanPath.endsWith('/')) {
        cleanPath = cleanPath.slice(0, -1);
    }
    if (cleanPath !== req.path) {
        const query = req.url.slice(req.path.length);
        return res.redirect(301, cleanPath + query);
    }
    next();
});

// PAGE_ROLES, MANAGER_ROLES, userTenantScope, and guardPageRoute are imported from ./middleware/auth above.

// A page that now lives inside a hub section: it is served only when embedded (?embed=1),
// and a direct visit goes to its hub section instead.
const embeddedPage = (file, roles, hubUrl) => {
    const guard = guardPageRoute(roles, file);
    return (req, res, next) => {
        if (req.query.embed !== '1') return res.redirect(hubUrl(req));
        // inside a frame a redirect to the login page would nest it; send the whole window there instead
        const redirect = res.redirect.bind(res);
        res.redirect = (...args) => {
            const target = String(args[args.length - 1]);
            if (!target.startsWith('/')) return redirect(...args);
            return res.status(200).type('html').send(`<script>(window.top || window).location.replace(${JSON.stringify(target)});</script>`);
        };
        return guard(req, res, next);
    };
};

// Explicitly serve HTML pages with role authorization guards
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});
app.get('/forgot-password', (req, res) => {
    res.sendFile(path.join(__dirname, 'forgot-password.html'));
});
app.get('/reset-password', (req, res) => {
    res.sendFile(path.join(__dirname, 'reset-password.html'));
});
app.get('/help', (req, res) => {
    res.sendFile(path.join(__dirname, 'help.html'));
});
app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, 'privacy.html'));
});
app.get('/terms', (req, res) => {
    res.sendFile(path.join(__dirname, 'terms.html'));
});

// CEO & Admin Portal
app.get('/ceo-portal', guardPageRoute(PAGE_ROLES.CEO_ONLY, 'ceo-portal.html'));
app.get('/ceo-live', guardPageRoute(PAGE_ROLES.CEO_ONLY, 'ceo-live.html'));
app.get('/all-reports', (req, res) => res.redirect('/reports?tab=detailed'));
app.get('/extras', guardPageRoute(PAGE_ROLES.STAFF_ALL, 'extras.html'));
app.get('/roles', embeddedPage('roles.html', PAGE_ROLES.MANAGERS, () => '/team?tab=roles'));
app.get('/team', guardPageRoute(PAGE_ROLES.MANAGERS, 'team.html'));
app.get('/backups', (req, res) => res.redirect('/settings?tab=backups'));
app.get('/activity-log', (req, res) => res.redirect('/settings?tab=activity'));
app.get('/tax-management', (req, res) => res.redirect('/settings?tab=taxrates'));
app.get('/settings', guardPageRoute(PAGE_ROLES.LEADERSHIP, 'settings.html'));
app.get('/business-settings', (req, res) => {
    // keep the old ?tab= (business, tax, product, invoice, barcode, printers)
    const tab = /^[a-z]+$/.test(String(req.query.tab || '')) ? req.query.tab : 'business';
    res.redirect('/settings?tab=' + tab);
});
app.get('/notification-templates', (req, res) => res.redirect('/settings?tab=notifications'));
app.get('/money', guardPageRoute(PAGE_ROLES.MANAGERS, 'money.html'));
app.get('/till', guardPageRoute(PAGE_ROLES.STAFF_ALL, 'till.html'));
app.get('/expenses', embeddedPage('expenses.html', PAGE_ROLES.MANAGERS, (req) => '/money?tab=expenses-' + (['list', 'add', 'categories'].includes(req.query.tab) ? req.query.tab : 'list')));
app.get('/stock-adjustments', embeddedPage('stock-adjustments.html', PAGE_ROLES.MANAGERS, (req) => '/stock?tab=adj-' + (['list', 'add', 'bulk'].includes(req.query.tab) ? req.query.tab : 'list')));
app.get('/stock-transfers', embeddedPage('stock-transfers.html', PAGE_ROLES.MANAGERS, (req) => '/stock?tab=tr-' + (req.query.tab === 'add' ? 'add' : 'list')));
const SELL_TABS = ['all', 'add', 'list_pos', 'add_draft', 'drafts', 'add_quotation', 'quotations', 'returns', 'shipments', 'discounts', 'import'];
app.get('/sales', guardPageRoute(PAGE_ROLES.MANAGERS, 'sales.html'));
app.get('/sell', embeddedPage('sell.html', PAGE_ROLES.MANAGERS, (req) => '/sales?tab=' + (SELL_TABS.includes(req.query.tab) ? req.query.tab : 'all')));
app.get('/locations', (req, res) => res.redirect('/settings?tab=locations'));

// Management & Executive Portals
app.get('/dashboard', guardPageRoute(PAGE_ROLES.MANAGERS, 'dashboard.html'));
const STOCK_TABS = ['stock', 'orders', 'receiving', 'shelf', 'distribution', 'stocktaking', 'barcodes', 'returns', 'suppliers'];
app.get('/stock', guardPageRoute(PAGE_ROLES.MANAGERS, 'stock.html'));
app.get('/inventory', embeddedPage('inventory.html', PAGE_ROLES.MANAGERS, (req) => req.query.tab === 'analytics' ? '/reports?tab=overview' : '/stock?tab=' + (STOCK_TABS.includes(req.query.tab) ? req.query.tab : 'stock')));
app.get('/reports', guardPageRoute(PAGE_ROLES.MANAGERS, 'reports.html'));
app.get('/core-reports', (req, res) => res.redirect('/reports?tab=drilldown'));
app.get('/daily-close', embeddedPage('daily-close.html', PAGE_ROLES.STAFF_ALL, () => '/till?tab=daily'));
app.get('/sales-dashboard', (req, res) => res.redirect('/reports?tab=overview'));
app.get('/profitability', (req, res) => res.redirect('/reports?tab=overview'));
app.get('/bulk-upload', embeddedPage('bulk-upload.html', PAGE_ROLES.MANAGERS, () => '/stock?tab=import'));
app.get('/categories', embeddedPage('categories.html', PAGE_ROLES.MANAGERS, () => '/stock?tab=categories'));
app.get('/catalog-ops', embeddedPage('catalog-ops.html', PAGE_ROLES.MANAGERS, () => '/stock?tab=catalog'));
app.get('/operations', guardPageRoute(PAGE_ROLES.STAFF_ALL, 'operations.html'));
app.get('/negative-stock', embeddedPage('negative-stock.html', PAGE_ROLES.MANAGERS, () => '/stock?tab=negative'));
app.get('/promotions', embeddedPage('promotions.html', PAGE_ROLES.MANAGERS, () => '/sales?tab=promotions'));
app.get('/transactions', embeddedPage('transactions.html', PAGE_ROLES.STAFF_ALL, () => '/till?tab=transactions'));
app.get('/credit-customers', embeddedPage('credit-customers.html', PAGE_ROLES.MANAGERS, (req) => '/customers?tab=' + (req.query.tab === 'auth' ? 'auth' : 'clients')));
app.get('/purchase-orders', guardPageRoute(PAGE_ROLES.MANAGERS, 'purchase-orders.html'));
app.get('/suppliers', guardPageRoute(PAGE_ROLES.MANAGERS, 'suppliers.html'));

// POS & Staff Operations
app.get('/pos', guardPageRoute(PAGE_ROLES.STAFF_ALL, 'pos.html'));
app.get('/pos-register', embeddedPage('pos-register.html', PAGE_ROLES.MANAGERS, (req) => '/team?tab=' + (req.query.tab === 'register' ? 'onboard' : 'staff')));
app.get('/open-shift', embeddedPage('open-shift.html', PAGE_ROLES.STAFF_ALL, () => '/till?tab=open'));
app.get('/close-shift', embeddedPage('close-shift.html', PAGE_ROLES.STAFF_ALL, () => '/till?tab=close'));
app.get('/payment', guardPageRoute(PAGE_ROLES.STAFF_ALL, 'payment.html'));
app.get('/receipt', guardPageRoute(PAGE_ROLES.STAFF_ALL, 'receipt.html'));
app.get('/customers', guardPageRoute(PAGE_ROLES.STAFF_ALL, 'customers-hub.html'));
app.get('/customers-list', embeddedPage('customers.html', PAGE_ROLES.STAFF_ALL, () => '/customers?tab=all'));
app.get('/customer-display', guardPageRoute(PAGE_ROLES.STAFF_ALL, 'customer-display.html'));

// Corporate B2B Client Portal
app.get('/company-portal', guardPageRoute(PAGE_ROLES.COMPANY, 'company-portal.html'));

// Profile & Account
app.get('/profile', guardPageRoute(PAGE_ROLES.ALL_USERS, 'profile.html'));

// Forgot Password Endpoint
app.post('/forgot-password', authLimiter, async (req, res) => {
    const { email } = req.body;
    try {
        const userResult = await pool.query('SELECT id, email, name FROM users WHERE LOWER(email) = LOWER($1)', [email]);
        if (userResult.rows.length === 0) {
            // To prevent email enumeration, we send a success response even if the user is not found.
            console.log(`Password reset attempt for non-existent user: ${email}`);
            return res.json({
                success: true,
                message: 'If an account with this email exists, a password reset link has been sent.'
            });
        }
        const user = userResult.rows[0];

        // Generate unique reset token
        const resetToken = crypto.randomBytes(32).toString('hex');
        const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');

        const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
        const resetLink = `${baseUrl}/reset-password?token=${resetToken}`;

        // Store the hashed token and expiry in the database
        const expiry = new Date(Date.now() + 3600000); // Token expires in 1 hour
        await pool.query(
            'UPDATE users SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3',
            [hashedToken, expiry, user.id]
        );

        // Nodemailer setup
        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: process.env.SMTP_PORT,
            secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });

        // Email content
        const mailOptions = {
            from: `"OKWESIWA LTD" <${process.env.ADMIN_EMAIL}>`,
            to: user.email,
            subject: 'Your Password Reset Request',
            html: `
                <p>Hello ${user.name},</p>
                <p>You requested a password reset for your OKWESIWA LTD account.</p>
                <p>Please click the following link to reset your password. This link is valid for 1 hour:</p>
                <a href="${resetLink}" style="background-color: #1a2a6c; color: white; padding: 10px 15px; text-decoration: none; border-radius: 5px;">Reset Password</a>
                <p>If you did not request a password reset, please ignore this email.</p>
                <p>Thank you,<br>The OKWESIWA LTD Team</p>
            `
        };

        // Send email
        await transporter.sendMail(mailOptions);

        res.json({
            success: true,
            message: 'If an account with this email exists, a password reset link has been sent.'
        });

    } catch (error) {
        console.error('Forgot password error:', error);
        // Generic error to prevent leaking information
        res.status(500).json({ message: 'An error occurred while processing your request' });
    }
});

// Routes

// Login Route
app.post('/login', loginLimiter, [
    body('email').isEmail(),
    body('password').isLength({ min: 6 })
], security.validateInput, async (req, res) => {
    const { email, password } = req.body;

    try {
        // Find user by email with branch/store and tenant information (Case Insensitive)
        const userResult = await pool.query(
            'SELECT id, username, name, email, password, role, store_id, store_location, status, tenant_id FROM users WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL',
            [email]
        );

        if (userResult.rows.length === 0) {
            // Check company_users fallback
            const companyRes = await pool.query(
                'SELECT id, company_id, company_name, email, password, contact_person, phone, address, status, tenant_id FROM company_users WHERE LOWER(email) = LOWER($1)',
                [email]
            );
            if (companyRes.rows.length > 0) {
                const compUser = companyRes.rows[0];
                if (compUser.status !== 'Active') {
                    return res.status(403).json({ success: false, message: 'Company account is inactive.' });
                }
                const validPass = await bcrypt.compare(password, compUser.password);
                if (validPass) {
                    req.session.companyUser = {
                        id: compUser.id,
                        company_id: compUser.company_id,
                        company_name: compUser.company_name,
                        email: compUser.email,
                        role: 'company',
                        type: 'company',
                        tenant_id: compUser.tenant_id || 1
                    };
                    const token = jwt.sign(req.session.companyUser, JWT_SECRET, { expiresIn: '8h' });
                    return res.json({
                        success: true,
                        message: 'Login successful',
                        user: req.session.companyUser,
                        token,
                        redirectTo: '/company-portal'
                    });
                }
            }
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        const user = userResult.rows[0];

        // Check if user is active
        if (String(user.status || '').toLowerCase() !== 'active') {
            return res.status(403).json({
                success: false,
                message: 'Account is inactive. Please contact administrator.'
            });
        }

        // Verify password with bcrypt
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        // Normalize role to lowercase for internal processing and resolve canonical branch
        const normalizedRole = user.role.toLowerCase();
        const tenantId = user.tenant_id || 1;
        let resolvedStoreId = user.store_id || null;
        let resolvedStoreLoc = user.store_location || null;
        try {
            const brRes = await pool.query(
                `SELECT id, name FROM branches
                 WHERE COALESCE(tenant_id, 1) = $1
                   AND (($2::int IS NOT NULL AND id = $2::int) OR ($3::text IS NOT NULL AND (LOWER(name) = LOWER($3::text) OR LOWER(location) = LOWER($3::text))))
                 LIMIT 1`,
                [tenantId, resolvedStoreId, resolvedStoreLoc]
            );
            if (brRes.rows.length > 0) {
                resolvedStoreId = brRes.rows[0].id;
                resolvedStoreLoc = brRes.rows[0].name;
            } else {
                const fallbackBr = await pool.query(
                    'SELECT id, name FROM branches WHERE COALESCE(tenant_id, 1) = $1 ORDER BY is_main DESC NULLS LAST, id ASC LIMIT 1',
                    [tenantId]
                );
                if (fallbackBr.rows.length > 0) {
                    resolvedStoreId = resolvedStoreId || fallbackBr.rows[0].id;
                    resolvedStoreLoc = resolvedStoreLoc || fallbackBr.rows[0].name;
                }
            }
        } catch (_) {}
        const resolvedUsername = user.username || (user.email ? user.email.split('@')[0] : 'staff');
        const finalStoreLoc = resolvedStoreLoc || process.env.MAIN_BRANCH_LOCATION || 'Main Warehouse';

        // Set session
        req.session.user = {
            id: user.id,
            username: resolvedUsername,
            email: user.email,
            name: user.name,
            role: normalizedRole,
            tenant_id: tenantId,
            store_id: resolvedStoreId || 1,
            store_location: finalStoreLoc
        };

        // Log Login Activity
        await logActivity(req, 'LOGIN', { email: user.email, username: resolvedUsername, role: user.role });

        // Generate JWT Token
        const token = jwt.sign(req.session.user, JWT_SECRET, { expiresIn: '8h' });

        // Set redirect path based on role
        const userRole = user.role.toLowerCase();
        let redirectTo = '/open-shift';
        if (userRole === 'super_admin' || userRole === 'admin' || userRole === 'manager') redirectTo = '/dashboard';
        if (userRole === 'ceo') redirectTo = '/ceo-portal';

        // Check for active shift for cashiers to prevent flash
        if (userRole === 'cashier' || userRole === 'teller') {
            const activeShift = await pool.query('SELECT id FROM shifts WHERE user_id = $1 AND end_time IS NULL', [user.id]);
            if (activeShift.rows.length > 0) {
                redirectTo = '/pos';
            }
        }

        res.json({
            success: true,
            token: token,
            redirectTo: redirectTo.replace(/^\//, ''),
            user: {
                id: user.id,
                username: resolvedUsername,
                email: user.email,
                name: user.name,
                role: user.role,
                tenant_id: tenantId,
                store_id: resolvedStoreId || 1,
                store_location: finalStoreLoc
            }
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, message: 'An error occurred during login' });
    }
});

// Session Check Endpoint
app.get('/api/session', authenticateToken, async (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });
    if (req.user.type === 'company') {
        return res.json({ user: req.user });
    }
    try {
        const uRes = await pool.query(
            'SELECT id, username, name, email, role, store_id, store_location, tenant_id FROM users WHERE id = $1 AND deleted_at IS NULL LIMIT 1',
            [req.user.id]
        );
        if (uRes.rows.length === 0) {
            return res.json({ user: req.user });
        }
        const dbUser = uRes.rows[0];
        const tenantId = dbUser.tenant_id || req.user.tenant_id || 1;
        let storeId = dbUser.store_id || req.user.store_id || null;
        let storeLocation = dbUser.store_location || req.user.store_location || null;
        try {
            const brRes = await pool.query(
                `SELECT id, name FROM branches
                 WHERE COALESCE(tenant_id, 1) = $1
                   AND (($2::int IS NOT NULL AND id = $2::int) OR ($3::text IS NOT NULL AND (LOWER(name) = LOWER($3::text) OR LOWER(location) = LOWER($3::text))))
                 LIMIT 1`,
                [tenantId, storeId, storeLocation]
            );
            if (brRes.rows.length > 0) {
                storeId = brRes.rows[0].id;
                storeLocation = brRes.rows[0].name;
            } else {
                const fallbackBr = await pool.query(
                    'SELECT id, name FROM branches WHERE COALESCE(tenant_id, 1) = $1 ORDER BY is_main DESC NULLS LAST, id ASC LIMIT 1',
                    [tenantId]
                );
                if (fallbackBr.rows.length > 0) {
                    storeId = storeId || fallbackBr.rows[0].id;
                    storeLocation = storeLocation || fallbackBr.rows[0].name;
                }
            }
        } catch (_) {}
        const username = dbUser.username || (dbUser.email ? dbUser.email.split('@')[0] : 'staff');
        res.json({
            user: {
                ...req.user,
                ...dbUser,
                role: (dbUser.role || req.user.role || '').toLowerCase(),
                username,
                tenant_id: tenantId,
                store_id: storeId || 1,
                store_location: storeLocation || process.env.MAIN_BRANCH_LOCATION || 'Main Warehouse'
            }
        });
    } catch (err) {
        res.json({ user: req.user });
    }
});

// Logout Endpoint
app.post('/api/logout', async (req, res) => {
    // Destroying the session alone left an issued bearer token valid for its full 8h life.
    const authHeader = req.headers['authorization'];
    const bearer = authHeader && authHeader.split(' ')[1];
    if (bearer && bearer !== 'null' && bearer !== 'undefined') await revokeToken(bearer);
    await logActivity(req, 'LOGOUT');
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ message: 'Could not log out' });
        }
        res.clearCookie('pos.sid');
        res.json({ message: 'Logged out successfully' });
    });
});

// Company Login Endpoint
app.post('/api/company/login', authLimiter, [
    body('email').isEmail(),
    body('password').isLength({ min: 6 })
], security.validateInput, async (req, res) => {
    const { email, password } = req.body;

    try {
        // Find company user by email
        const userResult = await pool.query(
            'SELECT id, company_id, company_name, email, password, contact_person, phone, address, status, tenant_id FROM company_users WHERE LOWER(email) = LOWER($1)',
            [email]
        );

        if (userResult.rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        const user = userResult.rows[0];

        // Check if user is active
        if (String(user.status || '').toLowerCase() !== 'active') {
            return res.status(403).json({
                success: false,
                message: 'Account is inactive. Please contact administrator.'
            });
        }

        // Verify password with bcrypt
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        // Set company session
        req.session.companyUser = {
            id: user.id,
            company_id: user.company_id,
            email: user.email,
            company_name: user.company_name,
            contact_person: user.contact_person,
            phone: user.phone,
            address: user.address,
            store_id: user.id + 1000, // Use a unique offset to avoid collision with physical branches
            role: 'company',
            type: 'company',
            tenant_id: user.tenant_id || 1
        };

        // Generate JWT Token
        const token = jwt.sign(req.session.companyUser, JWT_SECRET, { expiresIn: '8h' });

        res.json({
            success: true,
            token: token,
            user: {
                id: user.id,
                company_id: user.company_id,
                email: user.email,
                company_name: user.company_name,
                contact_person: user.contact_person,
                phone: user.phone,
                address: user.address,
                store_id: user.id + 1000,
                role: 'company',
                type: 'company',
                tenant_id: user.tenant_id || 1
            }
        });

    } catch (error) {
        console.error('Company login error:', error);
        res.status(500).json({ success: false, message: 'An error occurred during login' });
    }
});

// Company Session Check Endpoint
app.get('/api/company/session', (req, res) => {
    if (req.session.companyUser) {
        res.json({ user: req.session.companyUser });
    } else {
        res.status(401).json({ message: 'Not authenticated' });
    }
});

// Company Logout Endpoint
app.post('/api/company/logout', async (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ message: 'Could not log out' });
        }
        res.clearCookie('pos.sid');
        res.json({ message: 'Logged out successfully' });
    });
});

// ============ COMPANY PROFILE ENDPOINTS ============

// Get Company Profile
app.get('/api/company/profile', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const result = await pool.query(
            `SELECT cu.id, cu.company_name, cu.contact_person, cu.email, cu.phone, cu.address, cu.status, cu.role,
                    c.tax_id, c.registration_number
             FROM company_users cu
             LEFT JOIN companies c ON cu.company_id = c.id
             WHERE cu.id = $1`,
            [userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Company profile not found' });
        }

        res.json({ profile: result.rows[0] });
    } catch (error) {
        console.error('Error fetching company profile:', error);
        res.status(500).json({ message: 'Error fetching company profile' });
    }
});

// Update Company Profile
app.put('/api/company/profile', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { company_name, contact_person, phone, address, tax_id, registration_number } = req.body;

        // Update company_users table
        await pool.query(
            `UPDATE company_users 
             SET company_name = $1, contact_person = $2, phone = $3, address = $4
             WHERE id = $5`,
            [company_name, contact_person, phone, address, userId]
        );

        // Update companies table (tax_id, registration_number)
        const userRow = await pool.query('SELECT company_id FROM company_users WHERE id = $1', [userId]);
        if (userRow.rows.length > 0 && userRow.rows[0].company_id) {
            await pool.query(
                `UPDATE companies SET name = $1, phone = $2, address = $3, tax_id = $4, registration_number = $5
                 WHERE id = $6`,
                [company_name, phone, address, tax_id, registration_number, userRow.rows[0].company_id]
            );
        }

        res.json({ success: true, message: 'Profile updated successfully' });
    } catch (error) {
        console.error('Error updating company profile:', error);
        res.status(500).json({ message: 'Error updating company profile' });
    }
});

// Change Company Password
app.post('/api/company/change-password', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ message: 'Current and new passwords are required' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ message: 'New password must be at least 6 characters' });
        }

        // Verify current password
        const userResult = await pool.query('SELECT password FROM company_users WHERE id = $1', [userId]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        const validPassword = await bcrypt.compare(currentPassword, userResult.rows[0].password);
        if (!validPassword) {
            return res.status(401).json({ message: 'Current password is incorrect' });
        }

        // Hash and update new password
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE company_users SET password = $1 WHERE id = $2', [hashedPassword, userId]);

        res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
        console.error('Error changing password:', error);
        res.status(500).json({ message: 'Error changing password' });
    }
});

// ============ USER MANAGEMENT ENDPOINTS ============

// Get all users
app.get('/api/users', authenticateToken, async (req, res) => {
    try {
        // users has no RLS policy, so tenant scoping must be applied here.
        // CEO is the platform owner and keeps cross-tenant visibility.
        if (!MANAGER_ROLES.includes(req.user.role)) {
            return res.status(403).json({ message: 'Unauthorized' });
        }

        let query = `
            SELECT id, username, name as "fullName", employee_id as "employeeId", 
                   phone, email, role, store_location as store, status, created_at 
            FROM users 
            WHERE deleted_at IS NULL
        `;
        const params = [];
        let paramIndex = 1;

        if (req.user.role !== 'ceo') {
            query += ` AND tenant_id = $${paramIndex}`;
            params.push(req.user.tenant_id || 1);
            paramIndex++;
        }

        // If the requester is a manager, never show CEO or Admin accounts in user management
        if (req.user.role === 'manager' || req.user.role === 'store_manager') {
            query += ` AND LOWER(role) NOT IN ('ceo', 'admin')`;
        } else if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo' && req.user.store_location) {
            query += ` AND store_location = $${paramIndex}`;
            params.push(req.user.store_location);
        }

        query += ` ORDER BY created_at DESC`;

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Create user
app.post('/api/users', authenticateToken, async (req, res) => {
    const { username, fullName, employeeId, phone, email, role, store, password } = req.body;

    try {
        const userRole = req.user.role;
        if (userRole !== 'admin' && userRole !== 'manager' && userRole !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });

        // Managers cannot create CEO or Administrator accounts
        if ((userRole === 'manager' || userRole === 'store_manager') && (role.toLowerCase() === 'ceo' || role.toLowerCase() === 'admin')) {
            return res.status(403).json({ message: 'Managers cannot create CEO or Administrator accounts' });
        }

        // Resolve store_id from branches table to ensure correct settings/VAT linkage
        let storeId = null;
        if (store) {
            const branchRes = await pool.query('SELECT id FROM branches WHERE location = $1 OR name = $1', [store]);
            if (branchRes.rows.length > 0) storeId = branchRes.rows[0].id;
        }

        // Require an explicit password (>= 8 chars) or DEFAULT_USER_PASS env var
        const rawPassword = (password && String(password).trim()) || process.env.DEFAULT_USER_PASS || '';
        if (rawPassword.length < 8) {
            return res.status(400).json({ message: 'Password must be at least 8 characters' });
        }
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(rawPassword, salt);

        await pool.query(`
            INSERT INTO users (username, name, employee_id, phone, email, role, store_location, store_id, password, status, tenant_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Active', $10)
        `, [username, fullName, employeeId, phone, email.toLowerCase(), role.toLowerCase(), store, storeId, hashedPassword, req.user.tenant_id || 1]);

        await logActivity(req, 'CREATE_USER', { username, role, store });

        res.json({ success: true, message: 'User created successfully' });
    } catch (err) {
        console.error(err);

        if (err.code === '23505') { // Unique violation
            return res.status(400).json({ message: 'Username, Email or Employee ID already exists' });
        }
        res.status(500).json({ message: 'Error creating user' });
    }
});

// Update user
app.put('/api/users/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const userRole = req.user.role;
    if (userRole !== 'admin' && userRole !== 'manager' && userRole !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });
    const { fullName, username, email, phone, role, store, status } = req.body;

    const tenantId = userTenantScope(req);

    try {
        // Prevent managers from modifying CEO or Admin accounts
        const targetRes = await pool.query(
            `SELECT role FROM users WHERE id = $1${tenantId ? ' AND tenant_id = $2' : ''}`,
            tenantId ? [id, tenantId] : [id]
        );
        if (targetRes.rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }
        const targetRole = (targetRes.rows[0].role || '').toLowerCase();
        if ((userRole === 'manager' || userRole === 'store_manager') && (targetRole === 'ceo' || targetRole === 'admin')) {
            return res.status(403).json({ message: 'Managers cannot modify executive accounts' });
        }

        // Resolve store_id
        let storeId = null;
        if (store) {
            const branchRes = await pool.query('SELECT id FROM branches WHERE location = $1 OR name = $1', [store]);
            if (branchRes.rows.length > 0) storeId = branchRes.rows[0].id;
        }

        // Fetch current status to determine action type
        const userRes = await pool.query('SELECT status FROM users WHERE id = $1', [id]);
        const currentStatus = userRes.rows[0]?.status;

        // Convert empty strings to null to prevent unique constraint violations on ''
        const dbUsername = username && username.trim() !== '' ? username.trim() : null;
        const dbPhone = phone && phone.trim() !== '' ? phone.trim() : null;

        const finalRole = (role || targetRes.rows[0]?.role || 'staff').toLowerCase();
        // Only the platform owner may hand out executive roles; otherwise any manager could
        // promote themselves or an accomplice to admin.
        if ((finalRole === 'super_admin' || finalRole === 'ceo' || finalRole === 'admin') && userRole !== 'ceo' && userRole !== 'super_admin') {
            return res.status(403).json({ message: 'Only the CEO can assign CEO or Admin roles' });
        }
        await pool.query(`
            UPDATE users 
            SET name = $1, username = $2, email = $3, phone = $4, role = $5, store_location = $6, store_id = $7, status = $8
            WHERE id = $9${tenantId ? ' AND tenant_id = $10' : ''}
        `, tenantId
            ? [fullName, dbUsername, email, dbPhone, finalRole, store, storeId, status, id, tenantId]
            : [fullName, dbUsername, email, dbPhone, finalRole, store, storeId, status, id]);

        let action = 'UPDATE_USER';
        if (status && currentStatus !== status) {
            if (status === 'Inactive') action = 'DEACTIVATE_USER';
            else if (status === 'Active') action = 'ACTIVATE_USER';
        }

        await logActivity(req, action, { id, username, role, status, previousStatus: currentStatus });

        res.json({ success: true, message: 'User updated successfully' });
    } catch (err) {
        console.error(err);
        if (err.code === '23505') {
            return res.status(400).json({ message: 'Username, Email or Employee ID already exists' });
        }
        res.status(500).json({ message: 'Error updating user: ' + err.message });
    }
});

// Delete user (Permanent delete)
app.delete('/api/users/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const userRole = req.user.role;
    if (!MANAGER_ROLES.includes(userRole)) return res.status(403).json({ message: 'Unauthorized' });
    const tenantId = userTenantScope(req);
    try {
        // Scope the target to the caller's tenant and require it to exist
        const targetRes = await pool.query(
            `SELECT role FROM users WHERE id = $1${tenantId ? ' AND tenant_id = $2' : ''}`,
            tenantId ? [id, tenantId] : [id]
        );
        if (targetRes.rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }
        const targetRole = (targetRes.rows[0].role || '').toLowerCase();
        if ((userRole === 'manager' || userRole === 'store_manager') && (targetRole === 'ceo' || targetRole === 'admin')) {
            return res.status(403).json({ message: 'Managers cannot delete executive accounts' });
        }
        if (parseInt(id, 10) === parseInt(req.user.id, 10)) {
            return res.status(400).json({ message: 'You cannot delete your own account' });
        }
        // Soft delete: mark as deleted, revoke access — record kept for data retention
        await pool.query(
            `UPDATE users SET deleted_at = NOW(), status = 'Deleted' WHERE id = $1${tenantId ? ' AND tenant_id = $2' : ''}`,
            tenantId ? [id, tenantId] : [id]
        );
        await logActivity(req, 'SOFT_DELETE_USER', { id });
        res.json({ success: true, message: 'User deactivated (data retained for compliance)' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error deleting user' });
    }
});

// Reset Password
app.post('/api/users/:id/reset-password', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { password } = req.body;
    const userRole = req.user.role;
    if (!MANAGER_ROLES.includes(userRole)) return res.status(403).json({ message: 'Unauthorized' });
    if (!password || String(password).length < 8) {
        return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }
    const tenantId = userTenantScope(req);

    try {
        // Scope the target to the caller's tenant and require it to exist
        const targetRes = await pool.query(
            `SELECT role FROM users WHERE id = $1${tenantId ? ' AND tenant_id = $2' : ''}`,
            tenantId ? [id, tenantId] : [id]
        );
        if (targetRes.rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }
        const targetRole = (targetRes.rows[0].role || '').toLowerCase();
        if ((userRole === 'manager' || userRole === 'store_manager') && (targetRole === 'ceo' || targetRole === 'admin')) {
            return res.status(403).json({ message: 'Managers cannot reset executive passwords' });
        }
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        await pool.query(
            `UPDATE users SET password = $1 WHERE id = $2${tenantId ? ' AND tenant_id = $3' : ''}`,
            tenantId ? [hashedPassword, id, tenantId] : [hashedPassword, id]
        );
        await logActivity(req, 'RESET_PASSWORD', { userId: id });
        res.json({ success: true, message: 'Password reset successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error resetting password' });
    }
});

// Update Password (Self)
app.post('/api/update-password', authenticateToken, async (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });

    const { currentPassword, newPassword } = req.body;

    try {
        const result = await pool.query('SELECT password FROM users WHERE id = $1', [req.user.id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'User not found' });

        const valid = await bcrypt.compare(currentPassword, result.rows[0].password);
        if (!valid) return res.status(400).json({ message: 'Incorrect current password' });

        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(newPassword, salt);

        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, req.user.id]);
        await logActivity(req, 'UPDATE_PASSWORD_SELF');
        res.json({ success: true, message: 'Password updated successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Dashboard Data Endpoint
app.get('/api/dashboard', authenticateToken, async (req, res) => {
    const dashRole = (req.user?.role || '').toLowerCase();
    if (!req.user || !['super_admin', 'admin', 'manager', 'store_manager', 'ceo'].includes(dashRole)) {
        return res.status(403).json({ message: 'Unauthorized' });
    }

    try {
        // Fetch fresh user info from DB to ensure we have the latest store assignment
        const userRes = await pool.query('SELECT store_id, store_location FROM users WHERE id = $1', [req.user.id]);
        const dbUser = userRes.rows[0];

        const user = req.user;
        const tenantId = user.tenant_id || 1;
        const storeLocation = dbUser?.store_location || user.store_location;

        const todayStr = new Date().toISOString().slice(0, 10);
        const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '')) ? req.query.from : todayStr.slice(0, 8) + '01';
        const toDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || '')) ? req.query.to : todayStr;
        const fromTs = `${fromDate} 00:00:00`;
        const toTs = `${toDate} 23:59:59.999`;

        // Filter parameters
        let locationFilter = "AND COALESCE(t.tenant_id, 1) = $3";
        let queryParams = [fromTs, toTs, tenantId];

        const isGlobalDash = ['super_admin', 'admin', 'ceo'].includes(dashRole);
        if (storeLocation) {
            locationFilter = "AND t.store_location = $4 AND COALESCE(t.tenant_id, 1) = $3";
            queryParams.push(storeLocation);
        }

        const _salesP = (async () => {
        // Gross Sales, Sell Returns, Invoice Due & Transactions in selected date range
        const salesSummaryRes = await pool.query(
            `SELECT
                COALESCE(SUM(CASE WHEN COALESCE(t.is_return, false) = false THEN
                    COALESCE(NULLIF(t.total_amount, 0), (SELECT COALESCE(SUM((item->>'qty')::numeric * (item->>'price')::numeric), 0) FROM jsonb_array_elements(t.items) as item))
                ELSE 0 END), 0) AS gross_sales,
                COALESCE(SUM(CASE WHEN t.is_return = true THEN
                    ABS(COALESCE(NULLIF(t.total_amount, 0), (SELECT COALESCE(SUM((item->>'qty')::numeric * (item->>'price')::numeric), 0) FROM jsonb_array_elements(t.items) as item)))
                ELSE 0 END), 0) AS sell_return,
                COALESCE(SUM(CASE WHEN COALESCE(t.is_return, false) = false THEN GREATEST(COALESCE(t.balance_due, 0), 0) ELSE 0 END), 0) AS invoice_due,
                COUNT(*) FILTER (WHERE COALESCE(t.is_return, false) = false)::int AS txn_count
             FROM transactions t
             WHERE LOWER(t.status) IN ('completed', 'pending', 'partial', 'credit')
               AND t.created_at >= $1 AND t.created_at <= $2 ${locationFilter}`,
            queryParams
        );

        const grossSales = Number(salesSummaryRes.rows[0]?.gross_sales || 0);
        const totalSellReturn = Number(salesSummaryRes.rows[0]?.sell_return || 0);
        const netSales = Number((grossSales - totalSellReturn).toFixed(2));
        let invoiceDue = Number(salesSummaryRes.rows[0]?.invoice_due || 0);
        if (invoiceDue === 0) {
            try {
                const custDueRes = await pool.query(
                    'SELECT COALESCE(SUM(GREATEST(current_balance, 0)), 0) AS due FROM customers WHERE COALESCE(tenant_id, 1) = $1',
                    [tenantId]
                );
                invoiceDue = Number(custDueRes.rows[0]?.due || 0);
            } catch (_) {}
        }

        return { salesSummaryRes, grossSales, totalSellReturn, netSales, invoiceDue };
        })();

        const _purchP = (async () => {
        // Purchases, Purchase Due, Purchase Returns & Expenses in selected date range
        let totalPurchase = 0;
        let purchaseDue = 0;
        let totalPurchaseReturn = 0;
        try {
            const poSummary = await pool.query(
                `SELECT
                    COALESCE(SUM(CASE WHEN LOWER(COALESCE(po.status,'')) NOT IN ('cancelled', 'returned', 'return') THEN COALESCE(po.total_amount, 0) ELSE 0 END), 0) AS total_purchase,
                    COALESCE(SUM(CASE WHEN LOWER(COALESCE(po.status,'')) IN ('ordered', 'pending', 'received') THEN GREATEST(COALESCE(po.total_amount, 0) - COALESCE(sp.paid, 0), 0) ELSE 0 END), 0) AS purchase_due,
                    COALESCE(SUM(CASE WHEN LOWER(COALESCE(po.status,'')) IN ('returned', 'return') THEN COALESCE(po.total_amount, 0) ELSE 0 END), 0) AS purchase_return
                 FROM purchase_orders po
                 LEFT JOIN (
                    SELECT purchase_order_id, SUM(amount) AS paid
                    FROM supplier_payments
                    WHERE COALESCE(tenant_id, 1) = $1
                    GROUP BY purchase_order_id
                 ) sp ON sp.purchase_order_id = po.id
                 WHERE COALESCE(po.tenant_id, 1) = $1 AND po.created_at >= $2 AND po.created_at <= $3`,
                [tenantId, fromTs, toTs]
            );
            totalPurchase = Number(poSummary.rows[0]?.total_purchase || 0);
            purchaseDue = Number(poSummary.rows[0]?.purchase_due || 0);
            totalPurchaseReturn = Number(poSummary.rows[0]?.purchase_return || 0);
        } catch (_) {}

        return { totalPurchase, purchaseDue, totalPurchaseReturn };
        })();

        const _expP = (async () => {
        let totalExpense = 0;
        try {
            const expSummary = await pool.query(
                `SELECT COALESCE(SUM(amount), 0) AS total_expense
                 FROM expenses
                 WHERE COALESCE(tenant_id, 1) = $1 AND created_at >= $2 AND created_at <= $3`,
                [tenantId, fromTs, toTs]
            );
            totalExpense = Number(expSummary.rows[0]?.total_expense || 0);
        } catch (_) {}

        return { totalExpense };
        })();

        const _stockP = (async () => {
        // Low & Out of Stock Logic
        let lowStockCount = 0;
        let outOfStockCount = 0;

        if (storeLocation && !isGlobalDash) {
            // Generic branch lookup — fetch BOTH name and location from branches table
            // stock_levels keys may be stored under the branch name, location, or a historical variant
            const branchLookup = await pool.query(
                'SELECT name, location FROM branches WHERE name = $1 OR location = $1 LIMIT 1',
                [storeLocation]
            );
            const branchRow = branchLookup.rows[0];

            const candidates = [storeLocation, branchRow?.name, branchRow?.location].filter(Boolean);

            const productsRes = await pool.query(
                'SELECT stock_levels, reorder_level FROM products WHERE tenant_id = $1 AND deleted_at IS NULL',
                [req.user.tenant_id]
            );

            for (const product of productsRes.rows) {
                const branchStock = resolveBranchStockFromLevels(product.stock_levels, candidates);
                const reorder = product.reorder_level ?? 10;
                if (branchStock <= 0) outOfStockCount++;
                else if (branchStock <= reorder) lowStockCount++;
            }
        } else {
            // Admin/CEO global view — sum total stock across all branches per product
            const stockRes = await pool.query(
                `WITH BranchTotals AS (
                    SELECT 
                        COALESCE((
                            SELECT SUM(CAST(value AS INTEGER)) 
                            FROM jsonb_each_text(COALESCE(stock_levels, '{}'))
                        ), COALESCE(stock, 0)) as total_stock,
                        COALESCE(reorder_level, 10) as target_reorder
                    FROM products 
                    WHERE tenant_id = $1 AND deleted_at IS NULL
                 )
                 SELECT 
                    SUM(CASE WHEN total_stock <= 0 THEN 1 ELSE 0 END) as out_of_stock,
                    SUM(CASE WHEN total_stock > 0 AND total_stock <= target_reorder THEN 1 ELSE 0 END) as low_stock
                 FROM BranchTotals`,
                [req.user.tenant_id]
            );
            outOfStockCount = parseInt(stockRes.rows[0].out_of_stock || 0);
            lowStockCount = parseInt(stockRes.rows[0].low_stock || 0);
        }

        return { lowStockCount, outOfStockCount };
        })();

        const _recentP = (async () => {
        // Recent Transactions
        let recentWhere = "WHERE LOWER(t.status) = 'completed' AND t.is_return = FALSE AND t.tenant_id = $" + (storeLocation ? "2" : "1");
        let recentParams = storeLocation ? [storeLocation, req.user.tenant_id] : [req.user.tenant_id];

        if (storeLocation) {
            recentWhere += " AND t.store_location = $1";
        }

        const recentRes = await pool.query(
            `SELECT t.*, 
             (CASE WHEN t.is_return THEN -1 ELSE 1 END * 
              (SELECT COALESCE(SUM((item->>'qty')::numeric * (item->>'price')::numeric), 0) FROM jsonb_array_elements(t.items) as item)
             ) as total_amount,
             CASE WHEN t.is_return THEN 'RETURN' ELSE 'SALE' END as type,
             CASE WHEN u.id IS NOT NULL THEN COALESCE(u.name, u.username, 'Staff') || ' (@' || COALESCE(u.username, SPLIT_PART(u.email, '@', 1)) || ' · ' || UPPER(COALESCE(u.role, 'staff')) || ')' ELSE NULL END as cashier_name,
             u.username as cashier_username, u.role as cashier_role
             FROM transactions t 
             LEFT JOIN users u ON t.user_id = u.id 
             ${recentWhere}
             ORDER BY t.created_at DESC LIMIT 5`,
            recentParams
        );

        return { recentRes };
        })();

        const _cashierP = (async () => {
        // Cashier Performance Stats (in selected date range)
        let cashierWhere = "AND COALESCE(t.tenant_id, 1) = $3";
        const cashierParams = [fromTs, toTs, tenantId];
        if (storeLocation) {
            cashierWhere += " AND t.store_location = $4";
            cashierParams.push(storeLocation);
        }

        const cashierRes = await pool.query(
            `SELECT CONCAT(u.name, ' (@', u.username, ' - ', u.role, ')') as cashier, 
                    COUNT(t.id) as transaction_count, 
                    SUM(t.total_amount) as total_sales
             FROM transactions t
             LEFT JOIN users u ON t.user_id = u.id
             WHERE LOWER(t.status) = 'completed' AND t.created_at >= $1 AND t.created_at <= $2 ${cashierWhere}
             GROUP BY u.name, u.username, u.role
             ORDER BY total_sales DESC LIMIT 5`,
            cashierParams
        );

        return { cashierRes };
        })();

        const [{ salesSummaryRes, grossSales, totalSellReturn, netSales, invoiceDue }, { totalPurchase, purchaseDue, totalPurchaseReturn }, { totalExpense }, { lowStockCount, outOfStockCount }, { recentRes }, { cashierRes }] =
            await Promise.all([_salesP, _purchP, _expP, _stockP, _recentP, _cashierP]);

        res.json({
            stats: {
                totalSales: grossSales,
                invoiceDue,
                netSales,
                totalSellReturn,
                totalPurchase,
                purchaseDue,
                totalPurchaseReturn,
                totalExpense,
                totalTransactions: parseInt(salesSummaryRes.rows[0]?.txn_count || 0),
                lowStockCount: lowStockCount,
                outOfStockCount: outOfStockCount
            },
            recentTransactions: recentRes.rows,
            cashierStats: cashierRes.rows,
            branch: storeLocation || 'All Branches',
            range: { from: fromDate, to: toDate }
        });
        await logActivity(req, 'VIEW_DASHBOARD');
    } catch (err) {
        console.error('Dashboard error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Shift Management Endpoints
app.get('/api/shifts/active', authenticateToken, async (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });

    try {
        const result = await pool.query(
            "SELECT * FROM shifts WHERE user_id = $1 AND end_time IS NULL",
            [req.user.id]
        );
        if (result.rows.length > 0) {
            return res.json({ active: true, shift: result.rows[0] });
        }
        if (MANAGER_ROLES.includes((req.user.role || '').toLowerCase())) {
            return res.json({
                active: true,
                managerBypass: true,
                shift: {
                    id: 'mgr-' + req.user.id,
                    user_id: req.user.id,
                    role: req.user.role,
                    store_location: req.user.store_location
                }
            });
        }
        res.json({ active: false, shift: undefined });
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/shifts/open', authenticateToken, async (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });

    const { startCash, notes } = req.body;
    const openingCash = parseFloat(startCash);
    if (startCash !== undefined && startCash !== '' && !Number.isFinite(openingCash)) {
        return res.status(400).json({ message: 'startCash must be a number' });
    }

    try {
        const existing = await pool.query(
            'SELECT id FROM shifts WHERE user_id = $1 AND end_time IS NULL',
            [req.user.id]
        );
        if (existing.rows.length > 0) {
            return res.status(409).json({ message: 'A shift is already open', shiftId: existing.rows[0].id });
        }

        // The partial unique index on shifts(user_id) WHERE end_time IS NULL makes a
        // simultaneous double-open fail loudly instead of creating two overlapping shifts.
        await pool.query(
            "INSERT INTO shifts (user_id, start_cash, notes) VALUES ($1, $2, $3)",
            [req.user.id, Number.isFinite(openingCash) ? openingCash : 0, notes]
        );
        // Automatically log staff attendance clock-in when shift opens
        try {
            const now = new Date();
            const isLate = now.getHours() > 8 || (now.getHours() === 8 && now.getMinutes() > 15);
            await pool.query(
                `INSERT INTO staff_attendance (tenant_id, user_id, staff_name, is_late)
                 SELECT $1, $2, $3, $4
                 WHERE NOT EXISTS (SELECT 1 FROM staff_attendance WHERE user_id = $2 AND tenant_id = $1 AND clock_out IS NULL)`,
                [req.user.tenant_id || 1, req.user.id, req.user.name || req.user.username || 'Staff', isLate]
            );
        } catch (_) {}
        await logActivity(req, 'OPEN_SHIFT', { startCash });
        res.json({ success: true });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ message: 'A shift is already open' });
        }
        console.error('Shift open error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.get('/api/shifts/summary', authenticateToken, async (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });

    try {
        // Get active shift
        const shiftRes = await pool.query(
            "SELECT * FROM shifts WHERE user_id = $1 AND end_time IS NULL",
            [req.user.id]
        );

        if (shiftRes.rows.length === 0) {
            return res.status(404).json({ message: 'No active shift found' });
        }

        const shift = shiftRes.rows[0];

        // Calculate sales for this shift
        const salesRes = await pool.query(
            `SELECT payment_method, COALESCE(SUM(total_amount), 0) as total 
             FROM transactions 
             WHERE user_id = $1 AND created_at >= $2 AND status = 'completed'
             GROUP BY payment_method`,
            [req.user.id, shift.start_time]
        );

        let cashSales = 0;
        let momoSales = 0;
        let cardSales = 0;

        salesRes.rows.forEach(row => {
            const method = (row.payment_method || '').toLowerCase();
            const amount = parseFloat(row.total);
            if (method === 'cash') cashSales += amount;
            else if (method === 'momo' || method.includes('mobile')) momoSales += amount;
            else if (method === 'card') cardSales += amount;
        });

        const startCash = parseFloat(shift.start_cash || 0);
        const expectedCash = startCash + cashSales;

        res.json({ startCash, cashSales, momoSales, cardSales, expectedCash });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/shifts/close', authenticateToken, async (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });
    const { endCash, notes } = req.body;
    try {
        const result = await pool.query(
            "UPDATE shifts SET end_time = NOW(), end_cash = $1, notes = $2, status = 'closed' WHERE user_id = $3 AND end_time IS NULL RETURNING id",
            [endCash, notes, req.user.id]
        );
        await logActivity(req, 'CLOSE_SHIFT', { endCash });
        if (result.rowCount === 0) return res.status(400).json({ message: 'No active shift to close' });
        // Automatically clock out open attendance record when shift closes
        try {
            await pool.query(
                `UPDATE staff_attendance
                 SET clock_out = NOW(),
                     hours_worked = ROUND(EXTRACT(EPOCH FROM (NOW() - clock_in)) / 3600.0, 2)
                 WHERE user_id = $1 AND COALESCE(tenant_id, 1) = $2 AND clock_out IS NULL`,
                [req.user.id, req.user.tenant_id || 1]
            );
        } catch (_) {}
        res.json({ success: true });
    } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
});

// Get shift history for reports
app.get('/api/shifts/history', authenticateToken, async (req, res) => {
    try {
        const isRestricted = !['super_admin', 'admin', 'ceo'].includes((req.user.role || '').toLowerCase());
        const userBranch = req.user.store_location || 'Main Warehouse';

        let query = `
            SELECT s.*, u.name as user_name, u.store_location as branch,
                   COALESCE(SUM(t.total_amount), 0) as total_sales
            FROM shifts s
            LEFT JOIN users u ON s.user_id = u.id
            LEFT JOIN transactions t ON t.user_id = s.user_id 
                AND t.created_at >= s.start_time 
                AND (s.end_time IS NULL OR t.created_at <= s.end_time)
                AND t.status = 'completed'
        `;
        let params = [];

        // Filter by branch for non-admin/CEO users
        if (isRestricted) {
            query += ` WHERE u.store_location = $1`;
            params.push(userBranch);
        }

        query += ` GROUP BY s.id, u.name, u.store_location ORDER BY s.start_time DESC`;

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error('Shift history error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Promotions Endpoints
app.get('/api/promotions', authenticateToken, async (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });
    try {
        let query;
        let params = [];

        // Filter by branch for non-CEO/Admin users if they are assigned to a store
        if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo' && req.user.store_id) {
            // For branch users, show only their branch's usage in 'total_discounted'
            query = `
                SELECT p.code, p.discount_percentage, p.created_at, p.branch_id,
                       COALESCE(b.name, 'Global') as branch_name,
                       COALESCE(pu.total_discounted, 0) as total_discounted
                FROM promotions p
                LEFT JOIN branches b ON p.branch_id = b.id
                LEFT JOIN promotion_usage pu ON p.code = pu.promotion_code AND pu.branch_id = $1
                WHERE p.tenant_id = $2 AND p.branch_id = $1 AND p.deleted_at IS NULL
                ORDER BY p.created_at DESC`;
            params.push(req.user.store_id, req.user.tenant_id);
        } else {
            // For Admin/CEO, show global total_discounted
            query = `
                SELECT p.*, COALESCE(b.name, 'Global') as branch_name 
                FROM promotions p
                LEFT JOIN branches b ON p.branch_id = b.id
                WHERE p.tenant_id = $1 AND p.deleted_at IS NULL
                ORDER BY p.created_at DESC`;
            params.push(req.user.tenant_id);
        }

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/promotions', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });
    const { code, discount } = req.body;
    const branchId = req.user.store_id;

    try {
        // Check if a soft-deleted promotion with the same code exists for this tenant
        const deletedRes = await pool.query(
            'SELECT id FROM promotions WHERE code = $1 AND tenant_id = $2 AND deleted_at IS NOT NULL LIMIT 1',
            [code, req.user.tenant_id]
        );

        if (deletedRes.rows.length > 0) {
            // RESTORE: clear deleted_at and update discount/branch with new values
            await pool.query(
                'UPDATE promotions SET discount_percentage = $1, branch_id = $2, deleted_at = NULL WHERE code = $3 AND tenant_id = $4',
                [discount, branchId, code, req.user.tenant_id]
            );
            await logActivity(req, 'RESTORE_PROMOTION', { code, discount, branchId });
            return res.json({ success: true, restored: true });
        }

        // Fresh INSERT — no deleted record found for this code
        await pool.query(
            'INSERT INTO promotions (code, discount_percentage, branch_id, tenant_id) VALUES ($1, $2, $3, $4)',
            [code, discount, branchId, req.user.tenant_id]
        );
        await logActivity(req, 'CREATE_PROMOTION', { code, discount, branchId, tenantId: req.user.tenant_id });
        res.json({ success: true });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ message: `Promotion code "${code}" already exists and is active.` });
        }
        console.error(err);
        res.status(500).json({ message: 'Error creating promotion' });
    }
});

app.delete('/api/promotions/:code', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });
    try {
        // Soft delete: hidden from frontend but kept for compliance
        let query = 'UPDATE promotions SET deleted_at = NOW() WHERE code = $1 AND tenant_id = $2 AND deleted_at IS NULL';
        let params = [req.params.code, req.user.tenant_id];

        if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo' && req.user.store_id) {
            query += ' AND branch_id = $3';
            params.push(req.user.store_id);
        }

        const result = await pool.query(query, params);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Promotion not found or access denied' });
        }

        await logActivity(req, 'SOFT_DELETE_PROMOTION', { code: req.params.code });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error deleting promotion' });
    }
});

app.get('/api/promotions/validate/:code', authenticateToken, async (req, res) => {
    try {
        let query = 'SELECT * FROM promotions WHERE code = $1 AND tenant_id = $2 AND deleted_at IS NULL';
        let params = [req.params.code, req.user.tenant_id];

        // Validate branch applicability
        if (req.user && req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo' && req.user.store_id) {
            query += ' AND branch_id = $3';
            params.push(req.user.store_id);
        }

        const result = await pool.query(query, params);
        if (result.rows.length > 0) {
            res.json(result.rows[0]);
        } else {
            res.status(404).json({ message: 'Invalid promo code' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Products Endpoints
app.get('/products', authenticateToken, async (req, res) => {
    try {
        const userBranch = req.user.store_location;
        const isRestricted = !['super_admin', 'admin', 'ceo'].includes((req.user.role || '').toLowerCase());

        // Ensure all products have stock_levels initialized
        await pool.query(`
            UPDATE products 
            SET stock_levels = jsonb_build_object('Main Warehouse', COALESCE(stock, 0))
            WHERE (stock_levels IS NULL OR stock_levels = '{}'::jsonb) AND tenant_id = $1
        `, [req.user.tenant_id || 1]);

        // Support Pagination & Search parameters
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limitParam = req.query.limit;
        const limit = limitParam === 'all' ? null : Math.max(1, parseInt(limitParam) || 20);
        const offset = limit ? (page - 1) * limit : 0;
        const search = req.query.search ? req.query.search.trim() : null;

        let queryParams = [req.user.tenant_id];
        let whereClause = `WHERE tenant_id = $1 AND deleted_at IS NULL`;

        if (search) {
            queryParams.push(`%${search}%`);
            whereClause += ` AND (name ILIKE $2 OR barcode ILIKE $2 OR category ILIKE $2)`;
        }

        let limitClause = '';
        if (limit !== null) {
            queryParams.push(limit);
            limitClause = `LIMIT $${queryParams.length}`;
            queryParams.push(offset);
            limitClause += ` OFFSET $${queryParams.length}`;
        }

        // Get products and ensure total stock matches sum of location stocks
        const result = await pool.query(`
            SELECT 
                *,
                COUNT(*) OVER() AS total_count,
                COALESCE(
                    (SELECT SUM(CAST(value AS INTEGER)) 
                     FROM jsonb_each_text(COALESCE(stock_levels, '{}'))),
                    0
                ) as calculated_total
            FROM products 
            ${whereClause}
            ORDER BY name
            ${limitClause}
        `, queryParams);

        const totalItems = result.rows.length > 0 ? parseInt(result.rows[0].total_count) : 0;
        const totalPages = limit ? Math.ceil(totalItems / limit) : 1;

        // Process rows - recalculate stock from stock_levels to keep in sync
        const rows = result.rows.map(p => {
            if (isRestricted && userBranch) {
                // Branch View: Show only stock for this branch (dynamic — works for any branch name)
                const levels = p.stock_levels || {};
                const levelsObj = typeof levels === 'string' ? JSON.parse(levels) : levels;
                let bStock = 0;
                for (const key of Object.keys(levelsObj)) {
                    if (key.toLowerCase() === (userBranch || '').toLowerCase()) {
                        bStock += parseInt(levelsObj[key]) || 0;
                    }
                }
                p.stock = bStock;
            } else {
                // Admin/CEO View: Show total stock
                if (p.stock_levels && typeof p.stock_levels === 'object') {
                    p.stock = p.calculated_total;
                } else if (!p.stock_levels) {
                    p.stock_levels = { 'Main Warehouse': p.stock || 0 };
                }
            }
            delete p.calculated_total; // Remove the helper column
            return p;
        });

        // Pass Pagination Meta Data via Headers
        res.setHeader('X-Total-Count', totalItems);
        res.setHeader('X-Total-Pages', totalPages);
        res.setHeader('X-Current-Page', page);

        await logActivity(req, 'VIEW_INVENTORY_LIST');
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// API-prefixed routes for front-end compatibility
app.get('/api/products', authenticateToken, async (req, res) => {
    try {
        const userBranch = req.user.store_location;
        const isRestricted = !['super_admin', 'admin', 'ceo'].includes((req.user.role || '').toLowerCase());

        // Ensure all products have stock_levels initialized
        await pool.query(`
            UPDATE products 
            SET stock_levels = jsonb_build_object('Main Warehouse', COALESCE(stock, 0))
            WHERE (stock_levels IS NULL OR stock_levels = '{}'::jsonb) AND tenant_id = $1
        `, [req.user.tenant_id || 1]);

        // Support Pagination & Search parameters
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limitParam = req.query.limit;
        const limit = limitParam === 'all' ? null : Math.max(1, parseInt(limitParam) || 20);
        const offset = limit ? (page - 1) * limit : 0;
        const search = req.query.search ? req.query.search.trim() : null;

        let queryParams = [req.user.tenant_id || 1];
        let whereClause = `WHERE tenant_id = $1 AND deleted_at IS NULL`;

        if (search) {
            queryParams.push(`%${search}%`);
            whereClause += ` AND (name ILIKE $2 OR barcode ILIKE $2 OR category ILIKE $2)`;
        }

        let limitClause = '';
        if (limit !== null) {
            queryParams.push(limit);
            limitClause = `LIMIT $${queryParams.length}`;
            queryParams.push(offset);
            limitClause += ` OFFSET $${queryParams.length}`;
        }

        const result = await pool.query(`
            SELECT 
                *,
                COUNT(*) OVER() AS total_count,
                COALESCE(
                    (SELECT SUM(CAST(value AS INTEGER)) 
                     FROM jsonb_each_text(COALESCE(stock_levels, '{}'))),
                    0
                ) as calculated_total
            FROM products 
            ${whereClause}
            ORDER BY name
            ${limitClause}
        `, queryParams);

        const totalItems = result.rows.length > 0 ? parseInt(result.rows[0].total_count) : 0;
        const totalPages = limit ? Math.ceil(totalItems / limit) : 1;

        const rows = result.rows.map(p => {
            if (isRestricted && userBranch) {
                const levels = p.stock_levels || {};
                const levelsObj = typeof levels === 'string' ? JSON.parse(levels) : levels;
                let bStock = 0;
                for (const key of Object.keys(levelsObj)) {
                    if (key.toLowerCase() === (userBranch || '').toLowerCase()) {
                        bStock += parseInt(levelsObj[key]) || 0;
                    }
                }
                p.stock = bStock;
            } else {
                if (p.stock_levels && typeof p.stock_levels === 'object') {
                    p.stock = p.calculated_total;
                } else if (!p.stock_levels) {
                    p.stock_levels = { 'Main Warehouse': p.stock || 0 };
                }
            }
            delete p.calculated_total;
            return p;
        });

        // Pass Pagination Meta Data via Headers
        res.setHeader('X-Total-Count', totalItems);
        res.setHeader('X-Total-Pages', totalPages);
        res.setHeader('X-Current-Page', page);

        await logActivity(req, 'VIEW_INVENTORY_LIST');
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get product by barcode (for returns)
app.get('/api/products/barcode/:barcode', authenticateToken, async (req, res) => {
    try {
        const { barcode } = req.params;

        const result = await pool.query(`
            SELECT p.*,
                COALESCE(
                    (SELECT stock_levels::jsonb ->> $2 
                     FROM products p2 
                     WHERE p2.id = p.id AND stock_levels::jsonb ? $2),
                    p.stock::text
                ) as stock_for_branch
            FROM products p
            WHERE (p.barcode = $1 OR p.group_barcode = $1) AND p.tenant_id = $3
            LIMIT 1
        `, [barcode, req.user.store_location || 'Main Warehouse', req.user.tenant_id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Product not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error fetching product by barcode:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

const stockLevelsInitDone = new Set();
// Full product endpoint with branch-specific stock_for_branch field
app.get('/api/products/full', authenticateToken, async (req, res) => {
    try {
        // Refresh user store info from DB to ensure accuracy
        const userRes = await pool.query('SELECT store_id, store_location FROM users WHERE id = $1', [req.user.id]);
        const dbUser = userRes.rows[0] || {};

        let userBranch = dbUser.store_location || req.user.store_location || 'Main Warehouse';
        const isRestricted = !['super_admin', 'admin', 'ceo'].includes((req.user.role || '').toLowerCase());

        // Core mapping: Always link external company portals directly to the primary/main warehouse
        if (req.user.role === 'business_client' || req.user.type === 'company') {
            // Resolve main branch name from DB so it matches actual stock_levels keys
            try {
                const mainBranchRes = await pool.query(
                    `SELECT name, location FROM branches WHERE is_main = TRUE AND deleted_at IS NULL LIMIT 1`
                );
                if (mainBranchRes.rows.length > 0) {
                    userBranch = mainBranchRes.rows[0].name || mainBranchRes.rows[0].location;
                } else {
                    // Fallback: use branch id=1
                    const fallbackRes = await pool.query('SELECT name, location FROM branches WHERE id = 1 LIMIT 1');
                    userBranch = fallbackRes.rows[0]?.name || process.env.MAIN_BRANCH_LOCATION || 'Main Branch';
                }
            } catch (branchErr) {
                userBranch = process.env.MAIN_BRANCH_LOCATION || 'Main Branch';
            }
        }


        // Ensure all products have stock_levels initialized (once per tenant per instance, not on every read)
        const _initTenant = req.user.tenant_id || 1;
        if (!stockLevelsInitDone.has(_initTenant)) {
            await pool.query(`
                UPDATE products 
                SET stock_levels = jsonb_build_object('Main Warehouse', COALESCE(stock, 0))
                WHERE (stock_levels IS NULL OR stock_levels = '{}'::jsonb) AND tenant_id = $1
            `, [_initTenant]);
            stockLevelsInitDone.add(_initTenant);
        }

        // Support Pagination & Search parameters
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limitParam = req.query.limit;
        const lowStockOnly = req.query.lowStock === 'true';
        const outOfStockOnly = req.query.outOfStock === 'true';
        const stockFilter = lowStockOnly || outOfStockOnly;

        const requestedLimit = limitParam === 'all' ? null : Math.max(1, parseInt(limitParam) || 20);
        const search = req.query.search ? req.query.search.trim() : null;

        let queryParams = [req.user.tenant_id || 1];
        let whereClause = `WHERE tenant_id = $1 AND deleted_at IS NULL`;
        if (search) {
            queryParams.push(`%${search}%`);
            whereClause += ` AND (name ILIKE $2 OR barcode ILIKE $2 OR category ILIKE $2)`;
        }

        // Branch lookup runs in parallel with the first product query
        const branchPromise = pool.query(
            'SELECT id, name, location FROM branches WHERE name = $1 OR location = $1',
            [userBranch]
        );

        // Full-row query for a set of products; batch stats are aggregated once instead of two subselects per row.
        const fullSelect = (where, params, tail) => pool.query(`
            SELECT p.*,
                COALESCE((SELECT SUM(CAST(value AS INTEGER)) FROM jsonb_each_text(COALESCE(p.stock_levels, '{}'))), 0) AS calculated_total,
                COALESCE(pb.batch_count, 0) AS batch_count,
                pb.next_expiry AS next_expiry
            FROM products p
            LEFT JOIN (
                SELECT product_barcode, COUNT(*) AS batch_count, MIN(expiry_date) AS next_expiry
                FROM product_batches WHERE status = 'Active' GROUP BY product_barcode
            ) pb ON pb.product_barcode = p.barcode
            ${where}
            ORDER BY p.name
            ${tail || ''}
        `, params);

        let result, totalItems, branchRes;
        let idFilterRows = null; // light rows used only when a stock filter is active

        if (stockFilter) {
            // Light pass: only the columns the stock/reorder rule needs, for every matching product.
            const [lightRes, br] = await Promise.all([
                pool.query(`
                    SELECT id, stock, reorder_level, stock_levels,
                        COALESCE((SELECT SUM(CAST(value AS INTEGER)) FROM jsonb_each_text(COALESCE(stock_levels, '{}'))), 0) AS calculated_total
                    FROM products ${whereClause} ORDER BY name
                `, queryParams),
                branchPromise
            ]);
            branchRes = br;
            idFilterRows = lightRes.rows;
        } else {
            const pageLimit = requestedLimit;
            const pageParams = queryParams.slice();
            let tail = '';
            if (pageLimit !== null) {
                pageParams.push(pageLimit);
                tail = `LIMIT $${pageParams.length}`;
                pageParams.push((page - 1) * pageLimit);
                tail += ` OFFSET $${pageParams.length}`;
            }
            const [res1, br] = await Promise.all([
                pool.query(`
                    SELECT p.*,
                        COUNT(*) OVER() AS total_count,
                        COALESCE((SELECT SUM(CAST(value AS INTEGER)) FROM jsonb_each_text(COALESCE(p.stock_levels, '{}'))), 0) AS calculated_total,
                        COALESCE(pb.batch_count, 0) AS batch_count,
                        pb.next_expiry AS next_expiry
                    FROM products p
                    LEFT JOIN (
                        SELECT product_barcode, COUNT(*) AS batch_count, MIN(expiry_date) AS next_expiry
                        FROM product_batches WHERE status = 'Active' GROUP BY product_barcode
                    ) pb ON pb.product_barcode = p.barcode
                    ${whereClause.replace(/\b(tenant_id|deleted_at|name|barcode|category)\b/g, 'p.$1')}
                    ORDER BY p.name
                    ${tail}
                `, pageParams),
                branchPromise
            ]);
            result = res1;
            branchRes = br;
            totalItems = result.rows.length > 0 ? parseInt(result.rows[0].total_count) : 0;
        }

        const branchRow = branchRes.rows[0];
        const branchStockKey = branchRow?.name || userBranch;
        const branchCandidates = [userBranch, branchStockKey, branchRow?.location].filter(Boolean);

        const displayStock = (p) => {
            const branchStock = resolveBranchStockFromLevels(p.stock_levels, branchCandidates);
            p.stock_for_branch = branchStock;
            if ((isRestricted && userBranch) || req.user.role === 'business_client') {
                p.stock = branchStock;
            } else if (p.stock_levels && typeof p.stock_levels === 'object' && Object.keys(p.stock_levels).length > 0) {
                p.stock = p.calculated_total;
            }
            return p;
        };

        let finalRows, finalTotal;
        if (stockFilter) {
            // Same rule as before (p.stock as displayed vs reorder level), but on light rows only.
            const matched = idFilterRows.filter(p => {
                displayStock(p);
                const s = Number(p.stock ?? 0);
                const reorder = (p.reorder_level !== null && p.reorder_level !== undefined) ? Number(p.reorder_level) : 10;
                if (outOfStockOnly && !lowStockOnly) return s <= 0;
                return s <= reorder;
            });
            finalTotal = matched.length;
            const startIdx = (page - 1) * (requestedLimit || finalTotal);
            const pageIds = (requestedLimit ? matched.slice(startIdx, startIdx + requestedLimit) : matched).map(p => p.id);
            if (pageIds.length === 0) {
                finalRows = [];
            } else {
                const full = await fullSelect(`WHERE p.id = ANY($1::int[])`, [pageIds]);
                finalRows = full.rows.map(p => { displayStock(p); delete p.calculated_total; return p; });
            }
        } else {
            finalRows = result.rows.map(p => { displayStock(p); delete p.calculated_total; return p; });
            finalTotal = totalItems;
        }

        // Set header with branch key for frontend reference
        res.setHeader('X-Branch-Stock-Key', branchStockKey);

        // Pass Pagination Meta Data via Headers (filtered counts when lowStock=true)
        res.setHeader('X-Total-Count', finalTotal);
        res.setHeader('X-Total-Pages', requestedLimit ? Math.ceil(finalTotal / requestedLimit) : 1);
        res.setHeader('X-Current-Page', page);

        await logActivity(req, 'VIEW_INVENTORY_LIST');
        res.json(finalRows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/products', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    const { barcode, name, category, price, stock, cost_price, selling_unit, packaging_unit, conversion_rate, reorder_level, track_batch, track_expiry, batch_number, expiry_date } = req.body;
    try {
        const tenantId = req.user.tenant_id || 1;
        const finalBarcode = (barcode && barcode.trim()) ? barcode.trim() : ('FP-' + Date.now());

        // Refresh store info from DB to ensure accuracy
        const userRes = await pool.query('SELECT store_id, store_location FROM users WHERE id = $1', [req.user.id]);
        const dbUser = userRes.rows[0];

        const userBranch = dbUser?.store_location || req.user.store_location || 'Main Warehouse';
        const branchId = dbUser?.store_id || req.user.store_id || 1;

        const stockValue = parseInt(stock) || 0;
        const stockLevels = JSON.stringify({ [userBranch]: stockValue });

        // Check if a soft-deleted product with the same barcode+name already exists
        const deletedRes = await pool.query(
            `SELECT id FROM products WHERE barcode = $1 AND name = $2 AND tenant_id = $3 AND deleted_at IS NOT NULL LIMIT 1`,
            [finalBarcode, name, tenantId]
        );

        if (deletedRes.rows.length > 0) {
            // RESTORE: clear deleted_at and update all fields with the new values
            const existingId = deletedRes.rows[0].id;
            await pool.query(
                `UPDATE products SET
                    name = $1, category = $2, price = $3, stock = $4, stock_levels = $5,
                    cost_price = $6, selling_unit = $7, packaging_unit = $8,
                    conversion_rate = $9, reorder_level = $10,
                    track_batch = $11, track_expiry = $12,
                    deleted_at = NULL
                 WHERE id = $13 AND tenant_id = $14`,
                [name, category, price, stockValue, stockLevels,
                    cost_price || 0, selling_unit || 'Unit', packaging_unit || 'Box',
                    conversion_rate || 1, reorder_level || 10,
                    track_batch ?? true, track_expiry ?? false, existingId, tenantId]
            );
            await logActivity(req, 'RESTORE_PRODUCT', { barcode: finalBarcode, name, stock });
            return res.json({ success: true, restored: true });
        }

        // Fresh INSERT — no deleted record found for this barcode
        await pool.query(
            `INSERT INTO products (barcode, name, category, price, stock, stock_levels, cost_price, selling_unit, packaging_unit, conversion_rate, reorder_level, track_batch, track_expiry, branch_id, tenant_id) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
            [finalBarcode, name, category, price, stockValue, stockLevels, cost_price || 0, selling_unit || 'Unit', packaging_unit || 'Box', conversion_rate || 1, reorder_level || 10, track_batch ?? true, track_expiry ?? false, branchId, tenantId]
        );

        // Insert Batch if provided and stock > 0
        if (stockValue > 0 && (batch_number || expiry_date)) {
            const finalBatchNum = batch_number || `BATCH-${Date.now()}`;
            await pool.query(
                `INSERT INTO product_batches (product_barcode, batch_number, expiry_date, quantity, quantity_available, quantity_received, branch_id, status, tenant_id)
                 VALUES ($1, $2, $3, $4, $4, $4, $5, 'Active', $6)
                 ON CONFLICT (tenant_id, product_barcode, batch_number, branch_id) 
                 DO UPDATE SET 
                     expiry_date = EXCLUDED.expiry_date,
                     quantity = EXCLUDED.quantity,
                     quantity_available = EXCLUDED.quantity_available,
                     quantity_received = EXCLUDED.quantity_received`,
                [finalBarcode, finalBatchNum, expiry_date || null, stockValue, branchId, tenantId]
            );
        }

        await logActivity(req, 'CREATE_PRODUCT', { barcode: finalBarcode, name, stock });
        res.json({ success: true });
    } catch (err) {
        if (err.code === '23505' && err.constraint === 'products_barcode_active_idx') {
            return res.status(409).json({ message: `A product named "${name}" with barcode "${barcode}" already exists. Use a different barcode/name combination or edit the existing product.` });
        }
        console.error('Error adding product:', err);
        res.status(500).json({ message: 'Error adding product: ' + (err.message || '') });
    }
});

// --- FLEXIBLE DATE PARSER HELPER ---
// Intelligently parses dates in format DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD, etc.
// Handles any separator (/, -, .) and determines month/day based on numeric values
function parseFlexibleDate(dateInput) {
    if (!dateInput) return null;

    // If it's a number, it's likely an Excel date serial
    if (typeof dateInput === 'number') {
        const excelEpoch = new Date(1900, 0, 1);
        const date = new Date(excelEpoch.getTime() + (dateInput - 2) * 24 * 60 * 60 * 1000);
        if (!isNaN(date.getTime())) {
            return date.toISOString().split('T')[0];
        }
    }

    // If it's a string
    if (typeof dateInput === 'string') {
        dateInput = dateInput.trim();

        // Try common separators: /, -, .
        let parts = [];

        if (dateInput.includes('/')) {
            parts = dateInput.split('/').map(p => parseInt(p));
        } else if (dateInput.includes('-')) {
            parts = dateInput.split('-').map(p => parseInt(p));
        } else if (dateInput.includes('.')) {
            parts = dateInput.split('.').map(p => parseInt(p));
        }

        if (parts.length === 3 && parts.every(p => !isNaN(p))) {
            let day, month, year;
            const p0 = parts[0];
            const p1 = parts[1];
            const p2 = parts[2];

            // Smart detection based on numeric values
            // If any part > 31, it's definitely the year
            // If any part > 12, it must be the day

            if (p0 > 31) {
                // YYYY/MM/DD or YYYY/DD/MM - p0 is year
                year = p0;
                if (p1 > 12) {
                    day = p1;
                    month = p2;
                } else if (p2 > 12) {
                    day = p2;
                    month = p1;
                } else {
                    // Both <= 12, assume MM/DD
                    month = p1;
                    day = p2;
                }
            } else if (p2 > 31) {
                // MM/DD/YYYY or DD/MM/YYYY - p2 is year
                year = p2;
                if (p0 > 12) {
                    day = p0;
                    month = p1;
                } else if (p1 > 12) {
                    month = p0;
                    day = p1;
                } else {
                    // Both <= 12, assume first part is day (DD/MM format is common)
                    day = p0;
                    month = p1;
                }
            } else {
                // None > 31, year might be in different position or 2-digit
                // Check if any looks like a year (> current realistic year or < current year)
                if (p0 > 31 || (p0 > 12 && p1 <= 12 && p2 <= 31)) {
                    year = p0;
                    if (p1 > 12) {
                        day = p1; month = p2;
                    } else if (p2 > 12) {
                        day = p2; month = p1;
                    } else {
                        month = p1; day = p2;
                    }
                } else if (p1 > 31 || (p1 > 12 && p0 <= 12 && p2 <= 31)) {
                    year = p1;
                    day = p0; month = p2;
                } else if (p2 > 31 || p2 > 0) {
                    // p2 is most likely year (most common format)
                    year = p2;
                    if (p0 > 12) {
                        day = p0; month = p1;
                    } else if (p1 > 12) {
                        month = p0; day = p1;
                    } else {
                        day = p0; month = p1;
                    }
                }
            }

            // Validate ranges
            if (!day || !month || !year) return null;
            if (day < 1 || day > 31 || month < 1 || month > 12) {
                return null;
            }

            // Handle 2-digit years
            if (year < 100) {
                year += year < 50 ? 2000 : 1900;
            }

            // Create date (Date constructor: year, month (0-indexed), day)
            const date = new Date(year, month - 1, day);
            if (!isNaN(date.getTime())) {
                return date.toISOString().split('T')[0];
            }
        }
    }

    return null;
}

// --- BULK UPLOAD ENDPOINT ---
app.post('/api/products/bulk', authenticateToken, requireRole(MANAGER_ROLES), upload.single('file'), async (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });

    try {
        if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

        // Parse Excel/CSV File
        const fileExt = req.file.originalname?.toLowerCase() || '';
        const isCSV = fileExt.endsWith('.csv');

        const workbook = xlsx.read(req.file.buffer, {
            type: 'buffer',
            raw: isCSV
        });

        const sheetName = workbook.SheetNames[0];
        const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], {
            defval: '',
            raw: false
        });



        const results = { success: 0, failed: 0, errors: [] };
        const userBranch = req.user.store_location || 'Main Warehouse';
        const branchId = req.user.store_id || 1;

        // Helper to extract clean numeric value (handles "GHS 10.00", "₵5", "1,000")
        const cleanNum = (val) => {
            if (typeof val === 'number') return val;
            if (!val || typeof val !== 'string') return 0;
            return parseFloat(val.replace(/[^0-9.-]/g, '')) || 0;
        };

        // storage for stock-take items (barcode + physical count)
        const stockTakeItems = [];
        for (const rawRow of data) {
            // Normalize keys: trim and lowercase to handle CSV header variations
            const row = {};
            Object.keys(rawRow).forEach(k => {
                row[k.trim().toLowerCase()] = rawRow[k];
            });

            let name, category, cost, price, markup, stock, sellingUnit, packagingUnit, conversionRate, reorderLevel;
            let batchNumber, expiryDate, barcode, physicalCount, stockLevels;

            try {
                // Map Excel Columns to Database Fields
                // Handle encoding issues by stripping special chars and normalizing
                const normalizeKey = (k) => k.toLowerCase().replace(/[^a-z0-9]/g, '');
                const rowKeys = Object.keys(row);

                const findColumn = (patterns) => {
                    for (const pattern of patterns) {
                        const normalizedPattern = normalizeKey(pattern);
                        const match = rowKeys.find(k => normalizeKey(k).includes(normalizedPattern));
                        if (match) {
                            return row[match];
                        }
                    }
                    return '';
                };

                name = findColumn(['product name', 'name']).toString().trim();
                if (!name) {
                    continue; // Skip empty rows
                }

                category = findColumn(['category', 'type']).toString().trim() || 'General';
                // ensure category exists in categories table
                if (category) {
                    await pool.query(
                        `INSERT INTO categories (name, branch_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                        [category, branchId]
                    );
                }

                cost = cleanNum(findColumn(['cost', 'costprice']));
                price = cleanNum(findColumn(['price', 'sellingprice']));
                markup = cleanNum(findColumn(['markup', 'margin']));

                // Auto-calculate price if missing but Cost & Markup exist
                if (price === 0 && cost > 0 && markup > 0) {
                    price = cost * (1 + (markup / 100));
                }

                stock = parseInt(findColumn(['currentstock', 'stock', 'quantity']) || 0);
                sellingUnit = findColumn(['sellingunit', 'unit']) || 'Unit';
                packagingUnit = findColumn(['packagingunit', 'box', 'pack']) || 'Box';
                conversionRate = cleanNum(findColumn(['itemsperpackage', 'conversion', 'perpackage']) || 1);
                reorderLevel = parseInt(findColumn(['reorderlevel', 'reorder', 'threshold']) || 10);

                // Extract Batch Information
                batchNumber = findColumn(['batchnumber', 'batch', 'lot']).toString().trim();
                expiryDate = findColumn(['expirydate', 'expiry', 'expirationdate', 'expires']);

                // Parse expiry date using flexible parser (handles any format/separator)
                if (expiryDate) {
                    const parsedDate = parseFlexibleDate(expiryDate);
                    expiryDate = parsedDate || '';
                }

                // --- SMART PRODUCT MATCHING ---
                let existingProduct = null;
                const barcodeProvided = findColumn(['barcode', 'sku', 'productcode']).toString().trim();

                if (barcodeProvided) {
                    const barcodeRes = await pool.query('SELECT * FROM products WHERE barcode = $1 AND tenant_id = $2', [barcodeProvided, req.user.tenant_id]);
                    if (barcodeRes.rows.length > 0) {
                        existingProduct = barcodeRes.rows[0];
                        barcode = barcodeProvided;
                    }
                }

                // If not found by barcode, try finding by Name + Category (Case-Insensitive)
                if (!existingProduct) {
                    const nameCatRes = await pool.query(
                        'SELECT * FROM products WHERE LOWER(name) = LOWER($1) AND LOWER(category) = LOWER($2) AND tenant_id = $3',
                        [name, category, req.user.tenant_id]
                    );
                    if (nameCatRes.rows.length > 0) {
                        existingProduct = nameCatRes.rows[0];
                        barcode = existingProduct.barcode; // Use existing barcode
                    }
                }

                // Final Barcode Resolution for new products
                if (!existingProduct && !barcodeProvided) {
                    const prefix = name.substring(0, 3).toUpperCase().replace(/[^A-Z]/g, 'X');
                    barcode = `${prefix}-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 1000)}`;
                } else if (!existingProduct && barcodeProvided) {
                    barcode = barcodeProvided;
                }

                // Optional physical count for stock take
                physicalCount = parseInt(findColumn(['physicalcount', 'stocktake', 'count', 'physical']) || 0);
                if (!isNaN(physicalCount) && physicalCount > 0) {
                    stockTakeItems.push({ barcode, name, physicalCount });
                }

                // --- STOCK LEVEL UPDATES ---
                if (existingProduct) {
                    // 1. Calculate NEW TOTAL STOCK
                    const currentTotalStock = parseInt(existingProduct.stock || 0);
                    const newTotalStock = currentTotalStock + stock;

                    // 2. Update BRANCH-SPECIFIC STOCK in JSONB
                    let currentLevels = existingProduct.stock_levels;
                    if (typeof currentLevels === 'string') {
                        try { currentLevels = JSON.parse(currentLevels); } catch (e) { currentLevels = {}; }
                    } else if (!currentLevels) {
                        currentLevels = {};
                    }

                    const currentBranchStock = parseInt(currentLevels[userBranch] || 0);
                    currentLevels[userBranch] = currentBranchStock + stock;
                    const newStockLevels = JSON.stringify(currentLevels);

                    // 3. Update existing product
                    await pool.query(
                        `UPDATE products SET 
                            name = $1, category = $2, price = $3, cost_price = $4, 
                            stock = $5, stock_levels = $6, selling_unit = $7, 
                            packaging_unit = $8, conversion_rate = $9, reorder_level = $10,
                            track_batch = true, track_expiry = false
                         WHERE id = $11`,
                        [name, category, price, cost, newTotalStock, newStockLevels, sellingUnit, packagingUnit, conversionRate, reorderLevel, existingProduct.id]
                    );
                } else {
                    // NEW: Calculate initial stock levels
                    stockLevels = JSON.stringify({ [userBranch]: stock });

                    // Insert brand new product (Hardware default: track_expiry = false)
                    await pool.query(
                        `INSERT INTO products (barcode, name, category, price, cost_price, stock, stock_levels, selling_unit, packaging_unit, conversion_rate, reorder_level, track_batch, track_expiry, tenant_id)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, false, $12)`,
                        [barcode, name, category, price, cost, stock, stockLevels, sellingUnit, packagingUnit, conversionRate, reorderLevel, req.user.tenant_id]
                    );
                }

                // If batch number is provided, create/update batch record
                if (batchNumber) {
                    const tenantId = req.user.tenant_id || 1;
                    await pool.query(
                        `INSERT INTO product_batches (product_barcode, batch_number, expiry_date, quantity, quantity_available, quantity_received, branch_id, tenant_id, status)
                         VALUES ($1, $2, $3, $4, $4, $4, $5, $6, 'Active')
                         ON CONFLICT (tenant_id, product_barcode, batch_number, branch_id) DO NOTHING`,
                        [barcode, batchNumber, expiryDate || null, stock, branchId, tenantId]
                    );
                }

                // record barcode for stock take entry after product exists
                if (stockTakeItems.length && stockTakeItems[stockTakeItems.length - 1].name === name && !stockTakeItems[stockTakeItems.length - 1].barcode) {
                    stockTakeItems[stockTakeItems.length - 1].barcode = barcode;
                }

                results.success++;
            } catch (e) {
                results.failed++;
                const productName = name || 'Unknown Product';
                console.error(`[BULK UPLOAD] ERROR processing ${productName}:`, e.message);
                console.error(`[BULK UPLOAD] Full error:`, e);
                results.errors.push(`Error adding ${productName}: ${e.message}`);
            }
        }

        // if physical counts were provided, create a stock take record
        if (stockTakeItems.length) {
            try {
                const stRes = await pool.query(
                    `INSERT INTO stock_takes (stock_take_date, branch_id, created_by, status)
                     VALUES (CURRENT_DATE, $1, $2, 'In Progress') RETURNING id`,
                    [branchId, req.user.id]
                );
                const stId = stRes.rows[0].id;

                for (const item of stockTakeItems) {
                    // fetch current system count (may have been just inserted)
                    const sysRes = await pool.query('SELECT stock FROM products WHERE barcode = $1', [item.barcode]);
                    const systemCount = (sysRes.rows[0] && sysRes.rows[0].stock) || 0;
                    const variance = item.physicalCount - systemCount;
                    await pool.query(
                        `INSERT INTO stock_take_items (stock_take_id, product_barcode, physical_count, system_count, variance, counted_by, counted_at)
                         VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP)`,
                        [stId, item.barcode, item.physicalCount, systemCount, variance, req.user.id]
                    );
                }
            } catch (stErr) {
                console.error('Error creating stock take from bulk upload', stErr);
            }
        }

        await logActivity(req, 'BULK_PRODUCT_UPLOAD', { count: results.success, failed: results.failed });
        res.json({ success: true, results });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error processing bulk upload' });
    }
});

app.put('/api/products/:id', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    const { barcode: newBarcode, name, category, price, stock, cost_price, selling_unit, packaging_unit, conversion_rate, reorder_level, track_batch, track_expiry, stock_levels: incomingStockLevels } = req.body;
    const { id } = req.params;
    const tenantId = req.user.tenant_id || 1;
    try {
        const userRes = await pool.query('SELECT store_id, store_location FROM users WHERE id = $1', [req.user.id]);
        const dbUser = userRes.rows[0];
        const userBranch = dbUser?.store_location || 'Main Warehouse';
        const branchId = dbUser?.store_id || 1;

        const stockValue = Number(stock) || 0;

        // Get existing stock levels and tracking settings using ID scoped to tenant
        const checkRes = await pool.query(
            'SELECT stock_levels, track_batch, track_expiry, barcode FROM products WHERE id = $1 AND COALESCE(tenant_id, 1) = $2',
            [id, tenantId]
        );

        if (checkRes.rows.length === 0) {
            return res.status(404).json({ message: 'Product not found' });
        }
        const current = checkRes.rows[0];
        const currentBarcode = current.barcode; // old barcode from DB
        const finalBarcode = newBarcode || currentBarcode; // use new if provided, else keep old

        // Use incoming stock_levels if provided, otherwise merge with existing
        let stockLevels = incomingStockLevels || current.stock_levels || {};

        if (typeof stockLevels === 'string') {
            try {
                stockLevels = JSON.parse(stockLevels);
            } catch (e) {
                stockLevels = {};
            }
        }

        // Fallback: update branch stock manually using the 'stock' field if stock_levels wasn't explicitly provided
        if (!incomingStockLevels) {
            const existingBranches = Object.keys(stockLevels).filter(k => !isNaN(parseInt(stockLevels[k])));
            const targetBranch = existingBranches.length > 0 ? existingBranches[0] : userBranch;
            stockLevels[targetBranch] = stockValue;
        }

        // Recalculate total stock from all branches
        const totalStock = Object.values(stockLevels).reduce((sum, val) => sum + (parseInt(val) || 0), 0);

        const result = await pool.query(
            `UPDATE products SET 
                barcode = $1, name = $2, category = $3, price = $4, stock = $5, 
                cost_price = $6, selling_unit = $7, packaging_unit = $8, 
                conversion_rate = $9, reorder_level = $10, track_batch = $11, 
                track_expiry = $12, stock_levels = $13
             WHERE id = $14 AND COALESCE(tenant_id, 1) = $15 RETURNING *`,
            [finalBarcode, name, category, price, totalStock, cost_price, selling_unit, packaging_unit,
                conversion_rate, reorder_level, track_batch ?? current.track_batch, track_expiry ?? current.track_expiry,
                JSON.stringify(stockLevels), id, tenantId]
        );

        // Cascade barcode change to batches if barcode actually changed
        if (newBarcode && newBarcode !== currentBarcode) {
            await pool.query('UPDATE product_batches SET product_barcode = $1 WHERE product_barcode = $2', [newBarcode, currentBarcode]);
        }

        res.json({ message: 'Product updated successfully', product: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error updating product' });
    }
});

app.delete('/products/:barcode', authenticateToken, async (req, res) => {
    try {
        const tenantId = req.user.tenant_id || 1;
        const userBranch = req.user.store_location;
        const isGlobalAdmin = req.user.role === 'super_admin' || req.user.role === 'admin' || req.user.role === 'ceo';

        const productRes = await pool.query('SELECT name, stock_levels, stock FROM products WHERE (barcode = $1 OR id::text = $1) AND tenant_id = $2', [req.params.barcode, tenantId]);
        if (productRes.rows.length === 0) {
            return res.status(404).json({ message: 'Product not found or unauthorized' });
        }

        const product = productRes.rows[0];
        const productName = product.name || 'Unknown';

        if (isGlobalAdmin) {
            // Soft delete: product hidden globally but retained for 10-year compliance
            await pool.query('UPDATE products SET deleted_at = NOW() WHERE (barcode = $1 OR id::text = $1) AND tenant_id = $2', [req.params.barcode, tenantId]);
            await logActivity(req, 'SOFT_DELETE_PRODUCT_GLOBAL', { identifier: req.params.barcode, name: productName });
        } else {
            // Branch Managers ONLY remove their isolated branch stock keys
            let levels = typeof product.stock_levels === 'string' ? JSON.parse(product.stock_levels || '{}') : (product.stock_levels || {});

            const branchRes = await pool.query('SELECT name, location FROM branches WHERE name = $1 OR location = $1', [userBranch]);
            const branchRow = branchRes.rows[0] || {};
            const branchKeySet = new Set([userBranch, branchRow.name, branchRow.location].filter(Boolean));

            let branchStockDeduction = 0;
            const newLevels = { ...levels };
            for (const key of branchKeySet) {
                if (newLevels[key] !== undefined) {
                    branchStockDeduction += parseInt(newLevels[key]) || 0;
                    delete newLevels[key];
                }
            }

            await pool.query(`
                 UPDATE products 
                 SET stock_levels = $1, stock = COALESCE(stock, 0) - $2
                 WHERE (barcode = $3 OR id::text = $3) AND tenant_id = $4
             `, [JSON.stringify(newLevels), branchStockDeduction, req.params.barcode, tenantId]);

            await logActivity(req, 'DELETE_PRODUCT_LOCAL_BRANCH', { identifier: req.params.barcode, branch: userBranch, deductedStock: branchStockDeduction });
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error deleting product' });
    }
});

// new API prefix delete route for front-end compatibility
app.delete('/api/products/:barcode', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    try {
        const tenantId = req.user.tenant_id || 1;
        const userBranch = req.user.store_location;

        const productRes = await pool.query(
            'SELECT name, stock_levels, stock FROM products WHERE (barcode = $1 OR id::text = $1) AND tenant_id = $2 AND deleted_at IS NULL',
            [req.params.barcode, tenantId]
        );
        if (productRes.rows.length === 0) {
            return res.status(404).json({ message: 'Product not found or already deleted' });
        }

        const product = productRes.rows[0];
        const productName = product.name || 'Unknown';

        // Zero out this branch's stock from stock_levels before soft-deleting
        if (userBranch) {
            let levels = typeof product.stock_levels === 'string'
                ? JSON.parse(product.stock_levels || '{}')
                : (product.stock_levels || {});

            const branchRes = await pool.query(
                'SELECT name, location FROM branches WHERE (name = $1 OR location = $1) AND deleted_at IS NULL',
                [userBranch]
            );
            const branchRow = branchRes.rows[0] || {};
            const branchKeySet = new Set([userBranch, branchRow.name, branchRow.location].filter(Boolean));

            let branchStockDeduction = 0;
            const newLevels = { ...levels };
            for (const key of branchKeySet) {
                if (newLevels[key] !== undefined) {
                    branchStockDeduction += parseInt(newLevels[key]) || 0;
                    delete newLevels[key];
                }
            }

            // Update stock_levels first to accurately record the deduction
            await pool.query(`
                UPDATE products
                SET stock_levels = $1, stock = GREATEST(0, COALESCE(stock, 0) - $2)
                WHERE (barcode = $3 OR id::text = $3) AND tenant_id = $4
            `, [JSON.stringify(newLevels), branchStockDeduction, req.params.barcode, tenantId]);
        }

        // Soft-delete globally so the product disappears from all views
        await pool.query(
            'UPDATE products SET deleted_at = NOW() WHERE (barcode = $1 OR id::text = $1) AND tenant_id = $2',
            [req.params.barcode, tenantId]
        );

        await logActivity(req, 'SOFT_DELETE_PRODUCT', {
            identifier: req.params.barcode,
            name: productName,
            branch: userBranch || 'Global',
            role: req.user.role
        });

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error deleting product' });
    }
});

// Transactions Endpoint
app.get(['/transactions/all', '/api/transactions'], authenticateToken, async (req, res) => {
    const trxRole = (req.user?.role || '').toLowerCase();
    if (!req.user || !['super_admin', 'ceo', 'admin', 'manager', 'store_manager', 'cashier', 'teller'].includes(trxRole)) {
        return res.status(403).json({ message: 'Unauthorized' });
    }

    try {
        const tenantId = req.user.tenant_id || 1;
        const isGlobalTrx = ['super_admin', 'ceo', 'admin'].includes(trxRole);
        const storeLocation = isGlobalTrx ? null : req.user.store_location;
        let query = `SELECT t.*,
             CASE WHEN u.id IS NOT NULL THEN COALESCE(u.name, u.username, 'Staff') || ' (@' || COALESCE(u.username, SPLIT_PART(u.email, '@', 1)) || ' · ' || UPPER(COALESCE(u.role, 'staff')) || ')' ELSE NULL END as cashier_name,
             u.username as cashier_username, u.role as cashier_role
             FROM transactions t 
             LEFT JOIN users u ON t.user_id = u.id
             WHERE t.status = 'completed' AND COALESCE(t.tenant_id, 1) = $1`;

        const params = [tenantId];
        if (storeLocation) {
            query += ` AND t.store_location = $2`;
            params.push(storeLocation);
        }

        query += ` ORDER BY t.created_at DESC`;

        const result = await pool.query(query, params);
        await logActivity(req, 'VIEW_TRANSACTION_HISTORY');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// --- CATEGORIES MANAGEMENT ---
app.get('/api/categories', authenticateToken, async (req, res) => {
    try {
        const tenantId = req.user.tenant_id || 1;
        let query = 'SELECT * FROM categories WHERE tenant_id = $1 AND deleted_at IS NULL';
        let params = [tenantId];

        // Filter by branch for non-CEO/Admin users
        if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo' && req.user.store_id) {
            query += ' AND branch_id = $2';
            params.push(req.user.store_id);
        }
        query += ' ORDER BY name';

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
});

app.post('/api/categories', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    const { name, description } = req.body;
    const branchId = req.user.store_id || 1;
    const tenantId = req.user.tenant_id || 1;
    try {
        // Restore if soft-deleted category with same name exists in this branch
        const deletedRes = await pool.query(
            'SELECT id FROM categories WHERE name = $1 AND branch_id = $2 AND tenant_id = $3 AND deleted_at IS NOT NULL LIMIT 1',
            [name, branchId, tenantId]
        );
        if (deletedRes.rows.length > 0) {
            await pool.query(
                'UPDATE categories SET description = $1, deleted_at = NULL WHERE id = $2 AND tenant_id = $3',
                [description, deletedRes.rows[0].id, tenantId]
            );
            await logActivity(req, 'RESTORE_CATEGORY', { name, branchId });
            return res.json({ success: true, restored: true });
        }
        await pool.query('INSERT INTO categories (name, description, branch_id, tenant_id) VALUES ($1, $2, $3, $4)', [name, description, branchId, tenantId]);
        await logActivity(req, 'CREATE_CATEGORY', { name, branchId });
        res.json({ success: true });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ message: `Category "${name}" already exists.` });
        console.error('Error creating category:', err); 
        res.status(500).json({ message: 'Error creating category: ' + (err.message || '') });
    }
});

app.delete('/api/categories/:id', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    try {
        // Soft delete: category hidden but retained
        let query = 'UPDATE categories SET deleted_at = NOW() WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL';
        let params = [req.params.id, req.user.tenant_id];

        if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo' && req.user.store_id) {
            query += ' AND branch_id = $3';
            params.push(req.user.store_id);
        }

        const result = await pool.query(query, params);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Category not found or access denied' });

        await logActivity(req, 'SOFT_DELETE_CATEGORY', { id: req.params.id });
        res.json({ success: true });
    } catch (err) { console.error(err); res.status(500).json({ message: 'Error deleting category' }); }
});

// --- SUPPLIER MANAGEMENT ---
app.get('/api/suppliers', authenticateToken, async (req, res) => {
    try {
        let query = `SELECT s.*, b.name as branch_name, b.location as branch_location 
            FROM suppliers s
            LEFT JOIN branches b ON s.branch_id = b.id
            WHERE s.tenant_id = $1 AND s.deleted_at IS NULL`;
        let params = [req.user.tenant_id];

        if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo' && req.user.store_id) {
            query += ' AND s.branch_id = $2';
            params.push(req.user.store_id);
        }
        query += ' ORDER BY s.name';

        const result = await pool.query(query, params);
        await logActivity(req, 'VIEW_SUPPLIER_LIST');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

app.post('/api/suppliers', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    const { name, contact, phone, email, address } = req.body;
    const branchId = req.user.store_id || 1;
    const tenantId = req.user.tenant_id || 1;
    try {
        // Restore if soft-deleted supplier with same name exists in this branch
        const deletedRes = await pool.query(
            'SELECT id FROM suppliers WHERE name = $1 AND branch_id = $2 AND tenant_id = $3 AND deleted_at IS NOT NULL LIMIT 1',
            [name, branchId, tenantId]
        );
        if (deletedRes.rows.length > 0) {
            await pool.query(
                'UPDATE suppliers SET contact_person=$1, phone=$2, email=$3, address=$4, deleted_at=NULL WHERE id=$5 AND tenant_id=$6',
                [contact, phone, email, address, deletedRes.rows[0].id, tenantId]
            );
            await logActivity(req, 'RESTORE_SUPPLIER', { name, branchId });
            return res.json({ success: true, restored: true });
        }
        await pool.query(
            'INSERT INTO suppliers (name, contact_person, phone, email, address, branch_id, tenant_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [name, contact, phone, email, address, branchId, tenantId]
        );
        await logActivity(req, 'CREATE_SUPPLIER', { name, branchId });
        res.json({ success: true });
    } catch (err) { 
        console.error('Error adding supplier:', err);
        res.status(500).json({ message: 'Error adding supplier: ' + (err.message || '') }); 
    }
});

app.put('/api/suppliers/:id', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    const { name, contact, phone, email, address } = req.body;
    try {
        let query = 'UPDATE suppliers SET name = $1, contact_person = $2, phone = $3, email = $4, address = $5 WHERE id = $6 AND tenant_id = $7';
        let params = [name, contact, phone, email, address, req.params.id, req.user.tenant_id];

        if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo' && req.user.store_id) {
            query += ' AND branch_id = $8';
            params.push(req.user.store_id);
        }

        const result = await pool.query(query, params);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Supplier not found or access denied' });

        await logActivity(req, 'UPDATE_SUPPLIER', { id: req.params.id, name });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ message: 'Error updating supplier' }); }
});

app.delete('/api/suppliers/:id', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    try {
        // Soft delete: supplier hidden but retained for compliance
        let query = 'UPDATE suppliers SET deleted_at = NOW() WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL';
        let params = [req.params.id, req.user.tenant_id];

        if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo' && req.user.store_id) {
            query += ' AND branch_id = $3';
            params.push(req.user.store_id);
        }

        const result = await pool.query(query, params);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Supplier not found or access denied' });

        await logActivity(req, 'SOFT_DELETE_SUPPLIER', { id: req.params.id });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error deleting supplier' });
    }
});

// Dead shadowed PUT /api/products/:identifier route removed.

// --- PROCUREMENT (Purchase Orders) ---
app.get('/api/purchase-orders', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    try {
        const tenantId = req.user.tenant_id || 1;
        let query = `
            SELECT po.*, s.name as supplier_name, b.name as branch_name
            FROM purchase_orders po 
            LEFT JOIN suppliers s ON po.supplier_id = s.id AND COALESCE(s.tenant_id, 1) = $1
            LEFT JOIN branches b ON po.branch_id = b.id
            WHERE COALESCE(po.tenant_id, 1) = $1
        `;
        const params = [tenantId];

        if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo' && req.user.store_id) {
            query += ' AND po.branch_id = $2';
            params.push(req.user.store_id);
        }

        query += ' ORDER BY po.created_at DESC';

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

app.get('/api/purchase-orders/:id', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    const { id } = req.params;
    const tenantId = req.user.tenant_id || 1;
    try {
        const poRes = await pool.query(`
            SELECT po.*, s.name as supplier_name, b.name as branch_name
            FROM purchase_orders po 
            LEFT JOIN suppliers s ON po.supplier_id = s.id AND COALESCE(s.tenant_id, 1) = $2
            LEFT JOIN branches b ON po.branch_id = b.id
            WHERE po.id = $1 AND COALESCE(po.tenant_id, 1) = $2
        `, [id, tenantId]);

        if (poRes.rows.length === 0) return res.status(404).json({ message: 'PO not found' });

        const itemsRes = await pool.query(`
            SELECT poi.*, p.name 
            FROM purchase_order_items poi
            LEFT JOIN products p ON poi.product_barcode = p.barcode AND COALESCE(p.tenant_id, 1) = $2
            WHERE poi.po_id = $1 AND COALESCE(poi.tenant_id, 1) = $2
        `, [id, tenantId]);

        const po = poRes.rows[0];
        po.items = itemsRes.rows;

        res.json(po);
    } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

app.post('/api/purchase-orders', authenticateToken, requireRole(MANAGER_ROLES), requirePermission('purchases', 'create'), async (req, res) => {
    const { supplierId, items } = req.body;
    const tenantId = req.user.tenant_id || 1;
    if (!supplierId || !Array.isArray(items) || !items.length) {
        return res.status(400).json({ message: 'Supplier and items are required' });
    }
    let branchId = req.user.store_id;

    // Ensure branchId is set (fallback to location lookup or default)
    if (!branchId) {
        if (req.user.store_location) {
            try {
                const bRes = await pool.query('SELECT id FROM branches WHERE name = $1 OR location = $1', [req.user.store_location]);
                if (bRes.rows.length > 0) branchId = bRes.rows[0].id;
            } catch (e) { console.error('Branch lookup error in PO creation:', e); }
        }
        if (!branchId) branchId = 1; // Default to Main Warehouse
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const supCheck = await client.query('SELECT id FROM suppliers WHERE id = $1 AND COALESCE(tenant_id, 1) = $2', [supplierId, tenantId]);
        if (!supCheck.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Supplier not found' });
        }

        const serverTotal = Number(items.reduce((sum, item) => {
            const qty = Math.max(0, Number(item.qty || 0));
            const cost = Math.max(0, Number(item.cost || 0));
            return sum + qty * cost;
        }, 0).toFixed(2));

        const poRes = await client.query(
            'INSERT INTO purchase_orders (supplier_id, total_amount, status, branch_id, tenant_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [supplierId, serverTotal, 'Pending', branchId, tenantId]
        );
        const poId = poRes.rows[0].id;

        for (const item of items) {
            const qty = Math.max(0, Number(item.qty || 0));
            const cost = Math.max(0, Number(item.cost || 0));
            await client.query(
                'INSERT INTO purchase_order_items (po_id, product_barcode, quantity, unit_cost, tenant_id) VALUES ($1, $2, $3, $4, $5)',
                [poId, item.barcode, qty, cost, tenantId]
            );
        }
        await client.query('COMMIT');
        await logActivity(req, 'CREATE_PO', { supplierId, total: serverTotal, itemCount: items.length });
        res.json({ success: true, id: poId, total: serverTotal });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ message: 'Error creating PO' });
    } finally { client.release(); }
});

app.post('/api/purchase-orders/:id/receive', authenticateToken, requireRole(MANAGER_ROLES), requirePermission('purchases', 'edit'), async (req, res) => {
    const { id } = req.params;
    const { receivedItems } = req.body; // Array of { product_barcode, batch_number, expiry_date }
    const tenantId = req.user.tenant_id || 1;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Get PO details including supplier name for batch generation.
        // FOR UPDATE + a status gate stops a double-click or concurrent receive from
        // crediting the same stock twice.
        const poRes = await client.query(`
            SELECT po.*, s.name as supplier_name 
            FROM purchase_orders po
            LEFT JOIN suppliers s ON po.supplier_id = s.id AND COALESCE(s.tenant_id, 1) = $2
            WHERE po.id = $1 AND COALESCE(po.tenant_id, 1) = $2
            FOR UPDATE
        `, [id, tenantId]);

        if (poRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'PO not found' });
        }
        const po = poRes.rows[0];
        if ((po.status || '').toLowerCase() === 'received') {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: 'Purchase order has already been received' });
        }

        // Get PO items
        const itemsRes = await client.query('SELECT * FROM purchase_order_items WHERE po_id = $1 AND COALESCE(tenant_id, 1) = $2', [id, tenantId]);

        const today = new Date();
        const dateStr = today.toISOString().slice(2, 10).replace(/-/g, ''); // YYMMDD
        const supplierCode = (po.supplier_name || 'SUP').substring(0, 3).toUpperCase().replace(/\s/g, '');

        // Update stock and create batches
        const branchId = req.user.store_id || 1;
        for (const item of itemsRes.rows) {
            // Fetch product details for conversion
            const prodRes = await client.query('SELECT name, conversion_rate, track_expiry FROM products WHERE barcode = $1 AND COALESCE(tenant_id, 1) = $2', [item.product_barcode, tenantId]);
            const product = prodRes.rows[0] || { name: 'ITEM', conversion_rate: 1 };

            // Determine quantity to receive (use user input if available, else PO quantity)
            let qtyToReceive = item.quantity;
            let finalBatchNum = null;
            let finalExpiry = null;

            if (receivedItems && Array.isArray(receivedItems)) {
                const provided = receivedItems.find(ri => ri.product_barcode === item.product_barcode);
                if (provided) {
                    if (provided.quantity_received) qtyToReceive = parseInt(provided.quantity_received);
                    if (provided.batch_number) finalBatchNum = provided.batch_number;
                    if (provided.expiry_date) finalExpiry = new Date(provided.expiry_date);
                }
            }

            // Use the Qty from Goods Receiving directly for Total Stock
            const totalUnits = qtyToReceive;

            // 1. Update Product Stock with Total Units (Update both total stock and stock_levels for User's Branch)
            const branchName = req.user.store_location || 'Main Warehouse';
            await client.query(`
                UPDATE products 
                SET stock = COALESCE(stock, 0) + $1,
                    stock_levels = jsonb_set(
                        COALESCE(stock_levels, '{}'::jsonb), 
                        ARRAY[$3::text], 
                        to_jsonb(COALESCE((stock_levels->>$3)::int, 0) + $1)
                    )
                WHERE barcode = $2 AND COALESCE(tenant_id, 1) = $4
            `, [totalUnits, item.product_barcode, branchName, tenantId]);

            // Auto-generate if missing
            const itemCode = product.name.substring(0, 3).toUpperCase().replace(/\s/g, '');
            const trackExpiry = product.track_expiry === true;
            if (trackExpiry && !finalExpiry) {
                finalExpiry = new Date();
                finalExpiry.setFullYear(finalExpiry.getFullYear() + 1);
            }
            const expStr = finalExpiry ? finalExpiry.toISOString().slice(2, 10).replace(/-/g, '') : 'LOT';
            if (!finalBatchNum) finalBatchNum = `${supplierCode}-${dateStr}-${itemCode}-${expStr}`;

            // Check for existing batch with same number
            const existingBatchRes = await client.query(
                'SELECT expiry_date FROM product_batches WHERE product_barcode = $1 AND batch_number = $2 AND branch_id = $3 AND COALESCE(tenant_id, 1) = $4',
                [item.product_barcode, finalBatchNum, branchId, tenantId]
            );

            if (existingBatchRes.rows.length > 0 && finalExpiry) {
                const existingExpiry = existingBatchRes.rows[0].expiry_date ? new Date(existingBatchRes.rows[0].expiry_date) : null;
                if (existingExpiry && existingExpiry.toISOString().slice(0, 10) !== finalExpiry.toISOString().slice(0, 10)) {
                    finalBatchNum = `${finalBatchNum}-${expStr}`;
                }
            }

            await client.query(`
                INSERT INTO product_batches (product_barcode, batch_number, quantity, quantity_available, quantity_received, expiry_date, branch_id, tenant_id, status) 
                VALUES ($1, $2, $3, $3, $3, $4, $5, $6, 'Active')
                ON CONFLICT (tenant_id, product_barcode, batch_number, branch_id) 
                DO UPDATE SET 
                    quantity = product_batches.quantity + $3,
                    quantity_available = product_batches.quantity_available + $3,
                    quantity_received = product_batches.quantity_received + $3
            `, [item.product_barcode, finalBatchNum, totalUnits, finalExpiry, branchId]);

            // Log to inventory_audit_log
            await client.query(`
                INSERT INTO inventory_audit_log (action_type, product_barcode, quantity_before, quantity_after, reference_id, reference_type, user_id, branch_id)
                SELECT 'Stock In', $1::varchar, stock - $2, stock, $3, 'Purchase Order', $4, $5 FROM products WHERE barcode = $1
            `, [item.product_barcode, totalUnits, id, req.user.id, branchId]);
        }

        // Update PO status
        await client.query("UPDATE purchase_orders SET status = 'Received' WHERE id = $1", [id]);

        await client.query('COMMIT');
        await logActivity(req, 'RECEIVE_GOODS', { poId: id, itemsReceived: itemsRes.rows.length });
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ message: 'Error receiving goods' });
    } finally { client.release(); }
});

// Get Goods Received History
app.get('/api/goods-received', authenticateToken, async (req, res) => {
    try {
        let query = `
            SELECT gr.*, p.name as product_name 
            FROM goods_received gr
            JOIN products p ON gr.product_barcode = p.barcode
        `;
        let params = [];
        if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo' && req.user.store_id) {
            query += ' WHERE gr.branch_id = $1';
            params.push(req.user.store_id);
        }
        query += ' ORDER BY gr.received_at DESC LIMIT 100';
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// --- DISTRIBUTION ---
app.get('/api/transfers', authenticateToken, async (req, res) => {
    try {
        let query = 'SELECT * FROM stock_transfers';
        let params = [];

        // Filter transfers relevant to the user's branch (either sending or receiving)
        if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo' && req.user.store_location) {
            const userCanonicalLocation = await getBranchNameFromLocation(req.user.store_location, pool);
            query += ' WHERE from_location = $1 OR to_location = $1';
            params.push(userCanonicalLocation);
        }

        query += ' ORDER BY transfer_date DESC';
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error('GET /api/transfers Error:', err.message);
        res.status(500).json({ message: 'Server error: ' + err.message });
    }
});

app.post('/api/transfers', authenticateToken, requirePermission('stock', 'create'), async (req, res) => {
    const { from, to, items } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');


        // Get branch mapping to find correct stock_levels keys
        const branchesRes = await client.query('SELECT id, name, location FROM branches WHERE deleted_at IS NULL');
        const branches = branchesRes.rows;

        // Map the 'from' location to the correct branch name
        let mappedFrom = from;
        const fromMatch = branches.find(b => b.name === from || b.location === from);
        if (fromMatch) mappedFrom = fromMatch.name;

        // Map the 'to' location to the canonical branch name as well
        let mappedTo = to;
        const toMatch = branches.find(b => b.name === to || b.location === to);
        if (toMatch) mappedTo = toMatch.name;


        if (mappedFrom === mappedTo) {
            throw new Error(`Invalid Transfer: Both the 'From' (${from}) and 'To' (${to}) locations map to the exact same physical branch (${mappedFrom}). You cannot transfer stock into the same store.`);
        }

        // Deduct Stock FIRST (validate and update)
        for (const item of items) {
            // Get current product stock data using product_id or barcode/name fallback
            const pid = item.product_id ? Number(item.product_id) : null;
            const bc = item.barcode ? String(item.barcode).trim() : null;
            const checkRes = await client.query(`
                SELECT stock, stock_levels, barcode, id FROM products
                WHERE tenant_id = $3 AND deleted_at IS NULL
                  AND (($1::int IS NOT NULL AND id = $1::int) OR ($2::varchar IS NOT NULL AND (barcode = $2::varchar OR LOWER(name) = LOWER($2::varchar))))
                ORDER BY (id = $1::int) DESC NULLS LAST
                LIMIT 1
                FOR UPDATE
            `, [pid, bc, req.user.tenant_id]);

            if (checkRes.rows.length === 0) {
                throw new Error(`Product ${item.barcode || item.name || item.product_id} not found`);
            }

            const product = checkRes.rows[0];

            // Determine location stock - check multiple possible keys
            let stockLevels = product.stock_levels || {};
            if (typeof stockLevels === 'string') {
                try {
                    stockLevels = JSON.parse(stockLevels);
                } catch (e) {
                    stockLevels = {};
                }
            }

            // FIX: Use a Set to ensure each possible key/alias is only processed ONCE to prevent doubling stock
            const possibleKeys = [...new Set([mappedFrom, from, fromMatch?.location, fromMatch?.name].filter(Boolean))];
            let consolidatedStock = 0;
            let primaryKey = mappedFrom;

            // Consolidate all alias keys into the primary key to prevent split stock
            for (const key of possibleKeys) {
                if (stockLevels[key] !== undefined && stockLevels[key] !== null) {
                    consolidatedStock += parseInt(stockLevels[key]) || 0;
                    if (key !== primaryKey) delete stockLevels[key];
                }
            }
            stockLevels[primaryKey] = consolidatedStock;

            if (consolidatedStock < item.qty) {
                throw new Error(`Insufficient stock at ${from} for product ${item.barcode}. Available: ${consolidatedStock}, Requested: ${item.qty}`);
            }

            // Deduct from Total Stock and Source Location to keep values in sync
            // The items are "In Transit" and thus temporarily removed from available inventory

            await client.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [item.qty, product.id]);

            stockLevels[primaryKey] = consolidatedStock - item.qty;

            await client.query('UPDATE products SET stock_levels = $1 WHERE id = $2', [JSON.stringify(stockLevels), product.id]);

        }

        // Insert Transfer AFTER validating and deducting stock
        await client.query(
            'INSERT INTO stock_transfers (from_location, to_location, items, status, branch_id) VALUES ($1, $2, $3, $4, $5)',
            [mappedFrom, mappedTo, JSON.stringify(items), 'In Transit', req.user.store_id || 1]
        );

        await client.query('COMMIT');
        await logActivity(req, 'CREATE_TRANSFER', { from, to, itemCount: items.length });
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(`Transfer error:`, err.message);
        res.status(500).json({ message: err.message || 'Error creating transfer' });
    } finally {
        client.release();
    }
});

app.post('/api/transfers/:id/receive', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Get Transfer. The row lock is what makes the status check below reliable: without it
        // two concurrent receives both read 'In Transit' and both credit stock twice.
        const resTr = await client.query('SELECT * FROM stock_transfers WHERE id = $1 FOR UPDATE', [id]);
        if (resTr.rows.length === 0) throw new Error('Transfer not found');
        const transfer = resTr.rows[0];

        if (transfer.status !== 'In Transit') {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: 'Transfer already processed' });
        }

        // FIX: Authorization - Allow Admin/CEO or the specific destination branch
        const userBranchName = await getBranchNameFromLocation(req.user.store_location, pool);
        const userRole = (req.user.role || '').toLowerCase();

        const isAuthorized = userRole === 'super_admin' || userRole === 'admin' || userRole === 'ceo' ||
            (userBranchName.toLowerCase().trim() === (transfer.to_location || '').toLowerCase().trim());

        if (!isAuthorized) {
            await client.query('ROLLBACK');
            return res.status(403).json({
                message: `Unauthorized: Only the destination branch (${transfer.to_location}) can receive this transfer. Your current branch is: ${userBranchName}`
            });
        }

        const items = typeof transfer.items === 'string' ? JSON.parse(transfer.items) : transfer.items;

        // Add Stock to Destination Location and restore to Global Total Stock
        for (const item of items) {

            // Get current stock before update
            const currentStockRes = await client.query('SELECT stock, stock_levels FROM products WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [item.product_id, req.user.tenant_id]);
            const currentStock = currentStockRes.rows[0];
            if (!currentStock) throw new Error(`Product ${item.product_id} not found for this tenant`);

            let currentBranchStock = 0;
            if (currentStock.stock_levels) {
                let levels = currentStock.stock_levels;
                if (typeof levels === 'string') {
                    try {
                        levels = JSON.parse(levels);
                    } catch (e) {
                        levels = {};
                    }
                }
                currentBranchStock = parseInt(levels[transfer.to_location]) || 0;
            }


            // Restore to total stock now that items are available in a branch again
            await client.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [item.qty, item.product_id]);

            // Update destination location stock - ensure we use the exact branch name from the transfer
            await client.query(`
                UPDATE products 
                SET stock_levels = jsonb_set(
                    COALESCE(stock_levels, '{}'::jsonb), 
                    ARRAY[$1::text], 
                    to_jsonb(COALESCE((stock_levels->>$1::text)::int, 0) + $2)
                )
                WHERE id = $3
            `, [transfer.to_location, item.qty, item.product_id]);

            // Get updated stock after update
            const updatedStockRes = await client.query('SELECT stock, stock_levels FROM products WHERE id = $1 AND tenant_id = $2', [item.product_id, req.user.tenant_id]);
            const updatedStock = updatedStockRes.rows[0];

            let updatedBranchStock = 0;
            if (updatedStock.stock_levels) {
                let levels = updatedStock.stock_levels;
                if (typeof levels === 'string') {
                    try {
                        levels = JSON.parse(levels);
                    } catch (e) {
                        levels = {};
                    }
                }
                updatedBranchStock = parseInt(levels[transfer.to_location]) || 0;
            }

        }

        await client.query("UPDATE stock_transfers SET status = 'Received' WHERE id = $1", [id]);

        await client.query('COMMIT');
        await logActivity(req, 'RECEIVE_TRANSFER', { transferId: id });
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ message: 'Error receiving transfer' });
    } finally {
        client.release();
    }
});

// --- STOCK CONTROL (Expiry & Batches) ---
app.get('/api/batches/expiry', authenticateToken, async (req, res) => {
    try {
        let query = `
            SELECT b.*, 
                   (SELECT name FROM products p WHERE p.barcode = b.product_barcode ORDER BY id LIMIT 1) as name,
                   (SELECT SUM(stock) FROM products p WHERE p.barcode = b.product_barcode) as current_stock
            FROM product_batches b 
            WHERE b.quantity > 0 
        `;
        let params = [];

        if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo' && req.user.store_id) {
            query += ` AND b.branch_id = $1`;
            params.push(req.user.store_id);
        }

        query += ` ORDER BY b.expiry_date ASC NULLS LAST, b.created_at ASC, b.id ASC`;

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// Stock Take Adjustment
app.post('/api/stock-take', authenticateToken, async (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });

    const { adjustments } = req.body; // Array of { barcode, physicalQty }
    const userBranch = req.user.store_location || 'Main Warehouse';
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        for (const adj of adjustments) {
            // Get current stock info to calculate variance
            const resProd = await client.query('SELECT stock, stock_levels FROM products WHERE barcode = $1 AND tenant_id = $2', [adj.barcode, req.user.tenant_id]);
            if (resProd.rows.length === 0) continue;

            const product = resProd.rows[0];
            const stockLevels = product.stock_levels || {};
            const currentBranchStock = parseInt(stockLevels[userBranch] || 0);
            const newBranchStock = parseInt(adj.physicalQty);
            const variance = newBranchStock - currentBranchStock;

            if (variance !== 0) {
                await client.query(`
                    UPDATE products 
                    SET stock = COALESCE(stock, 0) + $1,
                        stock_levels = jsonb_set(
                            COALESCE(stock_levels, '{}'::jsonb), 
                            ARRAY[$2::text], 
                            to_jsonb($3::int)
                        )
                    WHERE barcode = $4
                `, [variance, userBranch, newBranchStock, adj.barcode]);

                // Log audit
                await client.query(`
                    INSERT INTO inventory_audit_log (action_type, product_barcode, quantity_before, quantity_after, reference_id, reference_type, user_id, branch_id, notes)
                    VALUES ('Stock Take', $1, $2, $3, NULL, 'Stock Take', $4, $5, 'Quick Update')
                `, [adj.barcode, currentBranchStock, newBranchStock, req.user.id, req.user.store_id || 1]);
            }
        }
        await client.query('COMMIT');
        await logActivity(req, 'STOCK_TAKE_UPDATE', { adjustmentsCount: adjustments.length });
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ message: 'Error processing stock take' });
    } finally { client.release(); }
});

// Reorder Suggestions
app.get('/api/inventory/reorder', authenticateToken, async (req, res) => {
    try {
        let query;
        let params = [];

        if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo' && req.user.store_location) {
            // Branch specific check using stock_levels JSON
            query = `
                SELECT * FROM products 
                WHERE deleted_at IS NULL
                AND (COALESCE(stock_levels->>$1, '0'))::int < COALESCE(reorder_level, 10)
                ORDER BY (COALESCE(stock_levels->>$1, '0'))::int ASC
            `;
            params.push(req.user.store_location);
        } else {
            // Global check
            query = 'SELECT * FROM products WHERE deleted_at IS NULL AND stock < COALESCE(reorder_level, 10) ORDER BY stock ASC';
        }

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// Negative Stock Analysis
app.get('/api/inventory/negative-analysis', authenticateToken, async (req, res) => {
    try {
        const isAdmin = req.user.role === 'super_admin' || req.user.role === 'admin' || req.user.role === 'ceo';
        const isCompany = req.user.type === 'company';

        let userBranch = req.user.store_location || 'Main Warehouse';
        const branchRes = await pool.query('SELECT name FROM branches WHERE name = $1 OR location = $1', [userBranch]);
        const branchStockKey = branchRes.rows[0]?.name || userBranch;

        // Fetch all products to safely parse JSON levels in Node.js
        const result = await pool.query(
            `SELECT id, barcode, name, stock, stock_levels, reorder_level, category FROM products WHERE deleted_at IS NULL AND tenant_id = $1`,
            [req.user.tenant_id]
        );

        let items = [];

        result.rows.forEach(row => {
            const levels = typeof row.stock_levels === 'string' ? JSON.parse(row.stock_levels) : (row.stock_levels || {});
            let checkStock = 0;

            if (isCompany || !isAdmin) {
                const candidates = [userBranch, branchStockKey, branchRes.rows[0]?.location].filter(Boolean);
                checkStock = resolveBranchStockFromLevels(levels, candidates);
            } else {
                checkStock = parseInt(row.stock || 0); // Admins check global stock
            }

            if (checkStock < 0) {
                items.push({
                    id: row.id,
                    name: row.name,
                    barcode: row.barcode,
                    category: row.category,
                    stock: checkStock,
                    units_owed: Math.abs(checkStock),
                    debt_value: Math.abs(checkStock) * 10 // Estimated value
                });
            }
        });

        items.sort((a, b) => a.stock - b.stock); // Most negative first

        // Calculate summary
        const summary = {
            negative_items: items.length,
            total_units_owed: items.reduce((sum, item) => sum + item.units_owed, 0),
            total_debt_value: items.reduce((sum, item) => sum + item.debt_value, 0)
        };

        res.json({ items, summary });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// --- ANALYTICS & YTD ---
app.get('/api/analytics/ytd/all', authenticateToken, async (req, res) => {
    try {
        let query = `
            SELECT items, created_at 
            FROM transactions 
            WHERE status = 'completed' AND created_at >= date_trunc('year', CURRENT_DATE)
        `;
        let params = [];

        if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo' && req.user.store_location) {
            query += ` AND store_location = $1`;
            params.push(req.user.store_location);
        }

        const result = await pool.query(query, params);

        let totalUnits = 0;
        let totalRevenue = 0;
        const monthlySales = {};
        const productBreakdown = {};

        // Initialize all months for a complete chart
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        months.forEach(m => monthlySales[m] = 0);

        result.rows.forEach(row => {
            const items = typeof row.items === 'string' ? JSON.parse(row.items) : row.items;
            const date = new Date(row.created_at);
            const month = date.toLocaleString('default', { month: 'short' });
            const isReturn = row.is_return || false;

            items.forEach(item => {
                const qty = isReturn ? -parseInt(item.qty) : parseInt(item.qty);
                const price = parseFloat(item.price);
                totalUnits += qty;
                totalRevenue += qty * price;
                if (monthlySales[month] !== undefined) monthlySales[month] += qty;

                // Breakdown logic
                if (!productBreakdown[item.barcode]) {
                    productBreakdown[item.barcode] = {
                        name: item.name,
                        barcode: item.barcode,
                        qty: 0,
                        revenue: 0
                    };
                }
                productBreakdown[item.barcode].qty += qty;
                productBreakdown[item.barcode].revenue += qty * price;
            });
        });

        const breakdown = Object.values(productBreakdown).sort((a, b) => b.revenue - a.revenue);
        res.json({ totalUnits, totalRevenue, monthlySales, breakdown });
    } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
});

app.get('/api/analytics/ytd/:barcode', authenticateToken, async (req, res) => {
    const { barcode } = req.params;
    try {
        let query = `
            SELECT items, created_at 
            FROM transactions 
            WHERE status = 'completed' AND created_at >= date_trunc('year', CURRENT_DATE)
        `;
        let params = [];

        if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo' && req.user.store_location) {
            query += ` AND store_location = $1`;
            params.push(req.user.store_location);
        }

        // Fetch all transactions for this year containing the product
        const result = await pool.query(query, params);

        let totalUnits = 0;
        let totalRevenue = 0;
        const monthlySales = {};

        // Initialize months for chart consistency
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        months.forEach(m => monthlySales[m] = 0);

        let productName = '';

        result.rows.forEach(row => {
            const items = typeof row.items === 'string' ? JSON.parse(row.items) : row.items;
            const date = new Date(row.created_at);
            const month = date.toLocaleString('default', { month: 'short' });
            const isReturn = row.is_return || false;

            items.forEach(item => {
                if (item.barcode === barcode) {
                    const qty = isReturn ? -parseInt(item.qty) : parseInt(item.qty);
                    const price = parseFloat(item.price);
                    totalUnits += qty;
                    totalRevenue += qty * price;
                    if (monthlySales[month] !== undefined) monthlySales[month] += qty;
                    if (!productName) productName = item.name;
                }
            });
        });

        const breakdown = [{
            name: productName || 'Unknown',
            barcode: barcode,
            qty: totalUnits,
            revenue: totalRevenue
        }];

        res.json({ barcode, totalUnits, totalRevenue, monthlySales, breakdown });
    } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
});

// User Transactions Endpoint
app.get('/transactions/me', authenticateToken, async (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });

    try {
        // Get current shift for the user
        const shiftRes = await pool.query(
            "SELECT id, start_time FROM shifts WHERE user_id = $1 AND end_time IS NULL",
            [req.user.id]
        );

        let query = "SELECT * FROM transactions WHERE user_id = $1 AND status = 'completed'";
        let params = [req.user.id];

        // If user has an active shift, filter transactions from shift start time
        if (shiftRes.rows.length > 0) {
            const currentShift = shiftRes.rows[0];
            query += " AND created_at >= $2";
            params.push(currentShift.start_time);
        }

        query += " ORDER BY created_at DESC";

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get Single Transaction Endpoint
app.get('/transactions/:id', authenticateToken, async (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });

    let { id } = req.params;
    const tenantId = req.user.tenant_id || 1;
    const isReceiptFormat = id.startsWith('RCP') || id.startsWith('REF') || (id.length > 10 && !isNaN(id));

    try {
        let result;
        if (isReceiptFormat) {
            // Query by receipt_number column
            const receiptNum = (id.startsWith('RCP') || id.startsWith('REF')) ? id : 'RCP' + id;
            result = await pool.query(`
                SELECT t.*, CASE WHEN t.is_return THEN 'RETURN' ELSE 'SALE' END as type,
                       CASE WHEN u.id IS NOT NULL THEN COALESCE(u.name, u.username, 'Staff') || ' (@' || COALESCE(u.username, SPLIT_PART(u.email, '@', 1)) || ' · ' || UPPER(COALESCE(u.role, 'staff')) || ')' ELSE NULL END AS cashier_name,
                       u.username AS cashier_username, u.role AS cashier_role,
                       u.store_id, c.name AS customer_name, c.current_balance, c.credit_limit
                FROM transactions t
                LEFT JOIN users u ON t.user_id = u.id
                LEFT JOIN customers c ON t.customer_id = c.id
                WHERE t.receipt_number = $1 AND COALESCE(t.tenant_id, 1) = $2
            `, [receiptNum, tenantId]);
        } else {
            // Query by numeric ID
            const numericId = parseInt(id);
            if (isNaN(numericId)) return res.status(400).json({ message: 'Invalid transaction ID format' });

            result = await pool.query(`
            SELECT t.*, CASE WHEN t.is_return THEN 'RETURN' ELSE 'SALE' END as type,
                   CASE WHEN u.id IS NOT NULL THEN COALESCE(u.name, u.username, 'Staff') || ' (@' || COALESCE(u.username, SPLIT_PART(u.email, '@', 1)) || ' · ' || UPPER(COALESCE(u.role, 'staff')) || ')' ELSE NULL END AS cashier_name,
                   u.username AS cashier_username, u.role AS cashier_role,
                   u.store_id, c.name AS customer_name, c.current_balance, c.credit_limit
            FROM transactions t
            LEFT JOIN users u ON t.user_id = u.id
            LEFT JOIN customers c ON t.customer_id = c.id
            WHERE t.id = $1 AND COALESCE(t.tenant_id, 1) = $2
            `, [numericId, tenantId]);
        }

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Transaction not found' });
        }

        const txn = result.rows[0];
        let taxBreakdown = [];
        let totalTax = 0;
        let subtotal = 0;

        // Use stored breakdown if available (New System)
        // Check for non-null to distinguish new transactions (even with 0 tax) from legacy ones
        if (txn.tax_breakdown !== null) {
            taxBreakdown = Array.isArray(txn.tax_breakdown) ? txn.tax_breakdown : [];
            totalTax = taxBreakdown.reduce((sum, t) => sum + parseFloat(t.amount), 0);
            subtotal = parseFloat(txn.total_amount) - totalTax;
        } else {
            // Legacy Fallback (Only for old transactions where tax_breakdown is NULL)
            const branchId = txn.store_id || req.user.store_id || 1;
            let settingsRes = await pool.query('SELECT vat_rate FROM system_settings WHERE branch_id = $1', [branchId]);
            if (settingsRes.rows.length === 0) settingsRes = await pool.query('SELECT vat_rate FROM system_settings WHERE branch_id = 1');
            const vatRate = settingsRes.rows.length > 0 ? parseFloat(settingsRes.rows[0].vat_rate) : 0.0;

            const total = parseFloat(txn.total_amount);
            totalTax = total - (total / (1 + (vatRate / 100)));
            subtotal = total - totalTax;

            taxBreakdown = [{ name: `VAT (${vatRate}%)`, amount: totalTax }];
        }

        await logActivity(req, 'VIEW_TRANSACTION_DETAIL', { id });
        res.json({
            ...txn,
            subtotal,
            tax: totalTax,
            taxBreakdown,
            discount: 0
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Finalize Transaction Endpoint
app.put('/transactions/:id/finalize', authenticateToken, async (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });

    const { id } = req.params;
    const { paymentMethod, receiptNumber, customerId } = req.body;
    const tenantId = req.user.tenant_id || 1;

    // Convert customerId to integer if provided
    const parsedCustomerId = customerId ? parseInt(customerId) : null;

    try {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Lock and read the transaction first. A retry of an already-completed sale must
            // not charge the customer's credit balance a second time.
            const txnRes = await client.query(
                'SELECT id, total_amount, receipt_number, is_return, status FROM transactions WHERE id = $1 AND COALESCE(tenant_id, 1) = $2 FOR UPDATE',
                [id, tenantId]
            );
            if (txnRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ message: 'Transaction not found' });
            }
            const alreadyCompleted = (txnRes.rows[0].status || '').toLowerCase() === 'completed';

            let customerName = null;
            if (parsedCustomerId) {
                const custCheck = await client.query(
                    'SELECT name, current_balance, credit_limit FROM customers WHERE id = $1 AND deleted_at IS NULL AND COALESCE(tenant_id, 1) = $2 FOR UPDATE',
                    [parsedCustomerId, tenantId]
                );
                if (custCheck.rows.length === 0) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({ message: 'Customer not found' });
                }
                customerName = custCheck.rows[0].name;

                // If paying by credit, update customer balance and get customer name
                if (paymentMethod === 'credit' && !alreadyCompleted) {
                    const total = Math.abs(parseFloat(txnRes.rows[0].total_amount));
                    const isReturn = txnRes.rows[0].is_return || false;
                    const receiptNum = receiptNumber || txnRes.rows[0].receipt_number || ('RCP' + Date.now());

                    // For returns, subtract from balance (reduce debt). For sales, add to balance.
                    const balanceChange = isReturn ? -total : total;

                    const custRes = await client.query(
                        'UPDATE customers SET current_balance = current_balance + $1 WHERE id = $2 AND COALESCE(tenant_id, 1) = $3 RETURNING current_balance',
                        [balanceChange, parsedCustomerId, tenantId]
                    );
                    const newBalance = custRes.rows[0].current_balance;

                    // Add to Ledger (Part 2)
                    const ledgerDesc = isReturn ? `Credit Return - ${receiptNum}` : `Credit Sale - ${receiptNum}`;
                    const ledgerType = isReturn ? 'RETURN' : 'SALE';

                    await client.query(
                        `INSERT INTO customer_ledger (customer_id, date, description, type, debit, credit, balance, transaction_id) 
                         VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7)`,
                        [parsedCustomerId, ledgerDesc, ledgerType, isReturn ? 0 : total, isReturn ? total : 0, newBalance, id]
                    );
                }
            }

            await client.query(
                "UPDATE transactions SET payment_method = $1, receipt_number = $2, customer_id = $3, customer_name = $4, status = 'completed' WHERE id = $5 AND COALESCE(tenant_id, 1) = $6",
                [paymentMethod, receiptNumber, parsedCustomerId || null, customerName, id, tenantId]
            );
            await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

        await logActivity(req, 'FINALIZE_TRANSACTION', { id, paymentMethod, receiptNumber });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get Transaction by Receipt Number (for returns)
app.get('/transactions/receipt/:receiptNumber', authenticateToken, async (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });

    const { receiptNumber } = req.params;
    const tenantId = req.user.tenant_id || 1;

    try {
        let result;

        // Try to determine if the input is numeric or text
        const isNumeric = /^\d+$/.test(receiptNumber);

        if (isNumeric) {
            // Search by ID if input is numeric
            result = await pool.query(`
                SELECT t.*,
                       CASE WHEN u.id IS NOT NULL THEN COALESCE(u.name, u.username, 'Staff') || ' (@' || COALESCE(u.username, SPLIT_PART(u.email, '@', 1)) || ' · ' || UPPER(COALESCE(u.role, 'staff')) || ')' ELSE NULL END AS cashier_name,
                       u.username AS cashier_username, u.role AS cashier_role,
                       u.store_id, c.name AS customer_name, c.current_balance, c.credit_limit
                FROM transactions t
                LEFT JOIN users u ON t.user_id = u.id
                LEFT JOIN customers c ON t.customer_id = c.id
                WHERE t.id = $1 AND t.status = 'completed' AND COALESCE(t.tenant_id, 1) = $2
            `, [receiptNumber, tenantId]);
        } else {
            // Search by receipt_number if input contains letters
            result = await pool.query(`
                SELECT t.*,
                       CASE WHEN u.id IS NOT NULL THEN COALESCE(u.name, u.username, 'Staff') || ' (@' || COALESCE(u.username, SPLIT_PART(u.email, '@', 1)) || ' · ' || UPPER(COALESCE(u.role, 'staff')) || ')' ELSE NULL END AS cashier_name,
                       u.username AS cashier_username, u.role AS cashier_role,
                       u.store_id, c.name AS customer_name, c.current_balance, c.credit_limit
                FROM transactions t
                LEFT JOIN users u ON t.user_id = u.id
                LEFT JOIN customers c ON t.customer_id = c.id
                WHERE t.receipt_number = $1 AND t.status = 'completed' AND COALESCE(t.tenant_id, 1) = $2
            `, [receiptNumber, tenantId]);
        }

        if (result.rows.length === 0) {
            // FALLBACK: Search in sales_invoices (Company Portal Quick Sales)
            const invoiceResult = await pool.query(`
                SELECT 
                    si.id, 
                    si.invoice_number as receipt_number, 
                    si.total_amount, 
                    si.subtotal, 
                    si.tax_amount as tax,
                    si.tax_details as tax_breakdown,
                    si.created_at, 
                    si.client_name as customer_name,
                    si.payment_method,
                    COALESCE(u.name, 'Admin') as cashier_name,
                    'SALE' as type,
                    (SELECT COALESCE(json_agg(json_build_object(
                        'name', product_name,
                        'qty', quantity,
                        'price', unit_price,
                        'barcode', barcode,
                        'total', line_total
                    )), '[]'::json) FROM sales_invoice_items WHERE invoice_id = si.id) as items
                FROM sales_invoices si
                LEFT JOIN users u ON si.created_by = u.id
                WHERE (si.invoice_number = $1 OR si.id::text = $1) AND COALESCE(si.tenant_id, 1) = $2
            `, [receiptNumber, tenantId]);

            if (invoiceResult.rows.length > 0) {
                result = invoiceResult;
            } else {
                return res.status(404).json({ message: 'Transaction not found' });
            }
        }

        const txn = result.rows[0];
        let taxBreakdown = [];
        let totalTax = 0;
        let subtotal = 0;

        // Use stored breakdown if available (New System)
        if (txn.tax_breakdown !== null) {
            taxBreakdown = Array.isArray(txn.tax_breakdown) ? txn.tax_breakdown : [];
            totalTax = taxBreakdown.reduce((sum, t) => sum + parseFloat(t.amount), 0);
            subtotal = parseFloat(txn.total_amount) - totalTax;
        } else {
            // Legacy fallback
            totalTax = parseFloat(txn.tax) || 0;
            subtotal = parseFloat(txn.total_amount) - totalTax;
        }

        const finalTransaction = {
            ...txn,
            subtotal: subtotal,
            tax: totalTax,
            taxBreakdown: taxBreakdown
        };

        res.json(finalTransaction);
    } catch (err) {
        console.error('Error fetching transaction by receipt:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get All Return Transactions
app.get('/api/transactions/returns', authenticateToken, async (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });

    try {
        const result = await pool.query(`
            SELECT t.*,
                   CASE WHEN u.id IS NOT NULL THEN COALESCE(u.name, u.username, 'Staff') || ' (@' || COALESCE(u.username, SPLIT_PART(u.email, '@', 1)) || ' · ' || UPPER(COALESCE(u.role, 'staff')) || ')' ELSE NULL END AS cashier_name,
                   u.username AS cashier_username, u.role AS cashier_role,
                   u.store_id, c.name AS customer_name, c.current_balance, c.credit_limit
            FROM transactions t
            LEFT JOIN users u ON t.user_id = u.id
            LEFT JOIN customers c ON t.customer_id = c.id
            WHERE t.is_return = TRUE AND t.status = 'completed'
            ORDER BY t.created_at DESC
        `);

        res.json({ returns: result.rows });
    } catch (err) {
        console.error('Error fetching returns:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get Sales Summary (Accounts for Returns)
app.get('/api/sales-summary', authenticateToken, async (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });

    try {
        const { startDate, endDate, branchId } = req.query;

        // Build WHERE clause
        let whereClause = 'WHERE t.status = $1';
        let params = ['completed'];
        let paramIndex = 2;

        if (startDate) {
            whereClause += ` AND t.created_at >= $${paramIndex}`;
            params.push(startDate);
            paramIndex++;
        }

        if (endDate) {
            whereClause += ` AND t.created_at <= $${paramIndex}`;
            params.push(endDate);
            paramIndex++;
        }

        if (branchId && req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') {
            whereClause += ` AND t.user_id IN (SELECT id FROM users WHERE store_id = $${paramIndex})`;
            params.push(branchId);
            paramIndex++;
        }

        // Get sales data with returns accounted for
        const query = `
            SELECT 
                COUNT(*) as total_transactions,
                COUNT(CASE WHEN t.is_return = FALSE THEN 1 END) as sales_transactions,
                COUNT(CASE WHEN t.is_return = TRUE THEN 1 END) as return_transactions,
                COALESCE(SUM(CASE WHEN t.is_return = FALSE THEN t.total_amount ELSE 0 END), 0) as gross_sales,
                COALESCE(SUM(CASE WHEN t.is_return = TRUE THEN t.total_amount ELSE 0 END), 0) as returns_amount,
                COALESCE(SUM(CASE WHEN t.is_return = FALSE THEN t.total_amount ELSE 0 END), 0) + 
                COALESCE(SUM(CASE WHEN t.is_return = TRUE THEN t.total_amount ELSE 0 END), 0) as net_sales,
                COALESCE(SUM(t.total_amount), 0) as total_amount
            FROM transactions t
            ${whereClause}
        `;

        const result = await pool.query(query, params);

        // Get top selling products (excluding returns)
        const productsQuery = `
            SELECT 
                p.name,
                SUM(CASE WHEN t.is_return = FALSE THEN (item->>'qty')::int ELSE 0 END) as total_sold,
                SUM(CASE WHEN t.is_return = TRUE THEN (item->>'qty')::int ELSE 0 END) as total_returned,
                SUM(CASE WHEN t.is_return = FALSE THEN (item->>'qty')::int ELSE 0 END) - 
                SUM(CASE WHEN t.is_return = TRUE THEN (item->>'qty')::int ELSE 0 END) as net_sold
            FROM transactions t, jsonb_array_elements(t.items) as item
            JOIN products p ON p.barcode = item->>'barcode'
            ${whereClause}
            GROUP BY p.name
            ORDER BY net_sold DESC
            LIMIT 10
        `;

        const productsResult = await pool.query(productsQuery, params);

        res.json({
            summary: result.rows[0],
            topProducts: productsResult.rows
        });

    } catch (err) {
        console.error('Error fetching sales summary:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Mobile Money Payment Endpoints (require live gateway integration)
app.post('/pay/momo', authenticateToken, (req, res) => {
    res.status(501).json({
        success: false,
        message: 'Live MTN MoMo API integration is not active yet. Confirm MoMo payment on your merchant phone and record it manually.'
    });
});

app.get('/pay/momo/status/:id', authenticateToken, (req, res) => {
    res.status(501).json({
        status: 'UNAVAILABLE',
        message: 'Live MTN MoMo status check is not active yet.'
    });
});

// --- DEBUG: Check Database Schema (admin only) ---
app.get('/api/debug/schema/:tableName', authenticateToken, async (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ message: 'Not found' });
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') {
        return res.status(403).json({ message: 'Unauthorized' });
    }
    try {
        const result = await pool.query(
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = $1",
            [req.params.tableName]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ message: 'Error fetching schema' }); }
});

// Helper function to get branch name from user location
async function getBranchNameFromLocation(userLocation, pool) {
    try {
        const branchesRes = await pool.query('SELECT id, name, location FROM branches WHERE deleted_at IS NULL');
        const branches = branchesRes.rows;

        // Check if user location matches any branch name or location
        const match = branches.find(b =>
            b.name === userLocation ||
            b.location === userLocation
        );

        return match ? match.name : userLocation;
    } catch (err) {
        console.error('Error getting branch mapping:', err);
        return userLocation;
    }
}

// --- BRANCH MAPPING ENDPOINT ---
app.get('/api/branch-mapping', authenticateToken, async (req, res) => {
    try {
        const userLocation = req.user.store_location;

        // Get all branches to find the matching one
        const branchesRes = await pool.query('SELECT id, name, location FROM branches WHERE deleted_at IS NULL');
        const branches = branchesRes.rows;

        // Try to find a match
        let mappedLocation = userLocation;

        // Check if user location matches any branch name or location
        const match = branches.find(b =>
            b.name === userLocation ||
            b.location === userLocation
        );

        if (match) {
            // Use the branch name for stock lookup (as stored in stock_levels JSON)
            mappedLocation = match.name;
        }

        res.json({
            originalLocation: userLocation,
            mappedLocation: mappedLocation,
            branches: branches.map(b => ({ id: b.id, name: b.name, location: b.location }))
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// --- Role Emulator / Switcher (executive preview tool) ---
app.post('/api/debug/switch-role', authenticateToken, async (req, res) => {
    if (process.env.NODE_ENV === 'production') {
        return res.status(404).json({ message: 'Not found' });
    }
    const { role } = req.body;
    try {
        // Handing out a signed token for an arbitrary role is a privilege-escalation path,
        // so it is restricted to executives and scoped to their own tenant.
        if (req.user.role !== 'ceo' && req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Only CEO or Admin can switch roles' });
        }

        let targetRole = String(role || '').toLowerCase();
        if (targetRole === 'teller') targetRole = 'cashier';
        if (!PAGE_ROLES.ALL_USERS.includes(targetRole)) {
            return res.status(400).json({ message: 'Unknown role' });
        }

        const tenantId = req.user.tenant_id || 1;
        let result = await pool.query(
            "SELECT * FROM users WHERE role = $1 AND tenant_id = $2 AND deleted_at IS NULL LIMIT 1",
            [targetRole, tenantId]
        );

        // Fallback for Manager -> Admin if no manager exists
        if (result.rows.length === 0 && targetRole === 'manager') {
            result = await pool.query(
                "SELECT * FROM users WHERE role = 'admin' AND tenant_id = $1 AND deleted_at IS NULL LIMIT 1",
                [tenantId]
            );
        }

        if (result.rows.length === 0) {
            return res.status(404).json({ message: `No user found for role: ${targetRole}` });
        }

        const user = result.rows[0];
        req.session.user = {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            store_id: user.store_id,
            store_location: user.store_location
        };

        let redirectTo = '/open-shift';
        if (user.role === 'super_admin' || user.role === 'admin' || user.role === 'manager') redirectTo = '/dashboard';
        if (user.role === 'ceo') redirectTo = '/ceo-portal';

        const token = jwt.sign(req.session.user, JWT_SECRET, { expiresIn: '8h' });
        await logActivity(req, 'DEBUG_SWITCH_ROLE', { targetRole });

        res.json({ success: true, token, redirectTo: redirectTo.replace(/^\//, ''), user: req.session.user });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error switching role' });
    }
});

// ============ CEO PORTAL INTELLIGENCE ============

// 1. Executive Financial Pulse (Global View)
app.get('/api/ceo/financials', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });

    const { branch, startDate, endDate } = req.query;

    try {
        // Build Dynamic Filters
        let txnWhere = "LOWER(status) = 'completed'";
        let txnParams = [];
        let expenseWhere = "1=1";
        let expenseParams = [];

        // Date Filtering
        if (startDate && endDate) {
            txnWhere += ` AND created_at >= $${txnParams.length + 1} AND created_at <= $${txnParams.length + 2}::date + INTERVAL '1 day' - INTERVAL '1 second'`;
            txnParams.push(startDate, endDate);

            expenseWhere += ` AND expense_date >= $${expenseParams.length + 1} AND expense_date <= $${expenseParams.length + 2}`;
            expenseParams.push(startDate, endDate);
        } else {
            // Default to current month if no dates provided
            txnWhere += " AND created_at >= date_trunc('month', CURRENT_DATE)";
            expenseWhere += " AND expense_date >= date_trunc('month', CURRENT_DATE)";
        }

        if (branch && branch !== 'All Branches') {
            txnWhere += ` AND store_location = $${txnParams.length + 1}`;
            txnParams.push(branch);

            // Resolve branch_id for expenses (Expenses use ID, Transactions use Location Name)
            const branchRes = await pool.query("SELECT id FROM branches WHERE location = $1 OR name = $1", [branch]);
            if (branchRes.rows.length > 0) {
                expenseWhere += ` AND branch_id = $${expenseParams.length + 1}`;
                expenseParams.push(branchRes.rows[0].id);
            }
        }

        // Monthly Revenue
        const revenueRes = await pool.query(`
            SELECT COALESCE(SUM(total_amount), 0) as revenue 
            FROM transactions 
            WHERE ${txnWhere}
        `, txnParams);

        // Cost of Goods Sold (Estimate: 70% of revenue for V1 until historical cost tracking is robust)
        const revenue = parseFloat(revenueRes.rows[0].revenue || 0);
        const cogs = revenue * 0.7;

        // Operational Expenses (Monthly)
        const expensesRes = await pool.query(`
            SELECT COALESCE(SUM(amount), 0) as total 
            FROM expenses
            WHERE ${expenseWhere}
        `, expenseParams);
        const opex = parseFloat(expensesRes.rows[0].total);

        // --- NEW: Company Portal Revenue (All Time) ---
        const companyRevRes = await pool.query('SELECT COALESCE(SUM(total_amount), 0) as total FROM sales_invoices');
        const companyRevenue = parseFloat(companyRevRes.rows[0].total) || 0;

        // Total Asset Value (Current Stock * Cost Price)
        let assetValue = 0;
        if (branch && branch !== 'All Branches') {
            // Calculate assets for specific branch using stock_levels JSON
            const assetsRes = await pool.query(`
                SELECT SUM(COALESCE((stock_levels->>$1)::int, 0) * cost_price) as asset_value FROM products WHERE deleted_at IS NULL
            `, [branch]);
            assetValue = parseFloat(assetsRes.rows[0].asset_value) || 0;
        } else {
            // Global assets
            const assetsRes = await pool.query(`SELECT SUM(stock * cost_price) as asset_value FROM products WHERE deleted_at IS NULL`);
            assetValue = parseFloat(assetsRes.rows[0].asset_value) || 0;
        }

        // Active Branches Count
        const branchRes = await pool.query("SELECT COUNT(*) as count FROM branches");
        const branchCount = parseInt(branchRes.rows[0].count || 0);

        // Fetch Monthly Target (Global from ID 1)
        let target = 0; // no invented target: the CEO page shows "No target set"
        const targetRes = await pool.query("SELECT monthly_target FROM system_settings WHERE id = 1");
        if (targetRes.rows.length > 0 && targetRes.rows[0].monthly_target) {
            target = parseFloat(targetRes.rows[0].monthly_target);
        }

        // Top 5 Products by Revenue (Monthly)
        const topProductsRes = await pool.query(`
            SELECT 
                item->>'name' as name,
                SUM(CASE WHEN is_return = TRUE THEN -1 ELSE 1 END * (item->>'qty')::int) as units_sold,
                SUM(CASE WHEN is_return = TRUE THEN -1 ELSE 1 END * ((item->>'qty')::int * (item->>'price')::numeric)) as revenue
            FROM transactions, jsonb_array_elements(items) as item
            WHERE ${txnWhere}
            GROUP BY item->>'name'
            ORDER BY revenue DESC
            LIMIT 5
        `, txnParams);

        // Slow Moving Products (Bottom 5 by Quantity Sold)
        const slowMovingRes = await pool.query(`
            SELECT 
                item->>'name' as name,
                SUM(CASE WHEN is_return = TRUE THEN -1 ELSE 1 END * (item->>'qty')::int) as units_sold,
                SUM(CASE WHEN is_return = TRUE THEN -1 ELSE 1 END * ((item->>'qty')::int * (item->>'price')::numeric)) as revenue
            FROM transactions, jsonb_array_elements(items) as item
            WHERE ${txnWhere}
            GROUP BY item->>'name'
            ORDER BY units_sold ASC
            LIMIT 5
        `, txnParams);

        let slowMoving = slowMovingRes.rows;
        const topProducts = topProductsRes.rows;

        // INTELLIGENT FILL: If "Slow Moving" is identical to "Top Selling" (due to low data volume),
        // fetch "Dead Stock" (Unsold items with stock) instead.
        const topNames = new Set(topProducts.map(p => p.name));
        const allSlowAreTop = slowMoving.length > 0 && slowMoving.every(p => topNames.has(p.name));

        if (allSlowAreTop || slowMoving.length === 0) {
            const excludedNames = [...topNames];
            let deadStockQuery = "SELECT name, 0 as units_sold, 0 as revenue FROM products WHERE stock > 0";
            let deadStockParams = [];

            if (excludedNames.length > 0) {
                const placeholders = excludedNames.map((_, i) => `$${i + 1}`).join(',');
                deadStockQuery += ` AND name NOT IN (${placeholders})`;
                deadStockParams = excludedNames;
            }

            deadStockQuery += " ORDER BY stock DESC LIMIT 5";
            const deadStockRes = await pool.query(deadStockQuery, deadStockParams);
            if (deadStockRes.rows.length > 0) slowMoving = deadStockRes.rows;
        }

        // Payment Method Breakdown (Monthly)
        const paymentRes = await pool.query(`
            SELECT payment_method, SUM(total_amount) as total
            FROM transactions
            WHERE ${txnWhere}
            GROUP BY payment_method
        `, txnParams);

        const grossProfit = revenue - cogs;
        const netProfit = grossProfit - opex;

        await logActivity(req, 'VIEW_CEO_FINANCIALS');
        res.json({
            revenue,
            companyRevenue,
            cogs,
            opex,
            grossProfit,
            netProfit,
            assetValue,
            branchCount,
            target,
            topProducts: topProductsRes.rows,
            slowMoving: slowMoving,
            paymentStats: paymentRes.rows
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// 1b. Update Monthly Revenue Target
app.post('/api/ceo/target', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });
    const { target } = req.body;
    try {
        await pool.query(`
            INSERT INTO system_settings (id, branch_id, store_name, currency_symbol, vat_rate, receipt_footer, monthly_target)
            VALUES (1, 1, 'OKWESIWA LTD', '₵ (GHS)', 0.00, 'Thank you!', $1)
            ON CONFLICT (id) DO UPDATE SET monthly_target = $1
        `, [target]);
        await logActivity(req, 'UPDATE_REVENUE_TARGET', { target });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// 2. Branch Performance Matrix
app.get('/api/ceo/branches', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });

    const { startDate, endDate } = req.query;

    try {
        let whereClause = "LOWER(status) = 'completed'";
        let params = [];

        if (startDate && endDate) {
            whereClause += " AND created_at >= $1 AND created_at <= $2::date + INTERVAL '1 day' - INTERVAL '1 second'";
            params.push(startDate, endDate);
        }

        const result = await pool.query(`
            SELECT 
                COALESCE(store_location, 'Main Branch') as branch,
                COUNT(CASE WHEN is_return = FALSE THEN 1 END) as txn_count,
                SUM(total_amount) as revenue
            FROM transactions
            WHERE ${whereClause}
            GROUP BY store_location
            ORDER BY revenue DESC
        `, params);
        await logActivity(req, 'VIEW_CEO_BRANCHES');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
});

// 3. Risk & Audit Radar
app.get('/api/ceo/risks', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });

    try {
        const risks = [];

        // Risk: Low Stock Only
        const lowStockRes = await pool.query(`
            SELECT COUNT(*) as count FROM products WHERE deleted_at IS NULL AND stock <= reorder_level
        `);

        if (parseInt(lowStockRes.rows[0].count) > 0) {
            risks.push({ type: 'Stockout Risk', message: `${lowStockRes.rows[0].count} items are critically low on stock.`, severity: 'high' });
        }

        await logActivity(req, 'VIEW_CEO_RISKS');
        res.json(risks);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// 4. Analytics Trend (Revenue vs Cost vs Forecast)
app.get('/api/ceo/analytics/trend', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });
    try {
        // Get last 7 days revenue
        const result = await pool.query(`
            SELECT TO_CHAR(created_at, 'Dy') as day, SUM(total_amount) as revenue
            FROM transactions 
            WHERE LOWER(status) = 'completed' AND created_at >= NOW() - INTERVAL '7 days'
            GROUP BY day, DATE(created_at)
            ORDER BY DATE(created_at)
        `);

        // Fill in data (mocking costs/forecast for demo visualization)
        const labels = result.rows.map(r => r.day);
        const revenue = result.rows.map(r => parseFloat(r.revenue));
        const costs = revenue.map(r => r * 0.7); // Est. 70% cost
        const forecast = revenue.map(r => r * 1.1); // Simple +10% forecast

        await logActivity(req, 'VIEW_CEO_ANALYTICS');
        res.json({ labels, revenue, costs, forecast });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
    }
});

// 5. Pending Credit Approvals
app.get('/api/ceo/approvals/credit-customers', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });
    try {
        const result = await pool.query(`
            SELECT c.*, u.name as created_by_name, u.store_location as branch,
            CASE 
                WHEN c.pending_credit_limit IS NOT NULL THEN 'Limit Increase' 
                ELSE 'New Account' 
            END as request_type
            FROM customers c
            LEFT JOIN users u ON c.created_by = u.id
            WHERE c.status = 'Pending' OR c.pending_credit_limit IS NOT NULL
            ORDER BY c.created_at DESC
        `);
        await logActivity(req, 'VIEW_CEO_APPROVALS_PENDING');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
    }
});

// 5b. Credit Approval History
app.get('/api/ceo/approvals/history', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });
    try {
        const result = await pool.query("SELECT * FROM customers WHERE status IN ('Active', 'Rejected') AND deleted_at IS NULL ORDER BY created_at DESC");
        await logActivity(req, 'VIEW_CEO_APPROVALS_HISTORY');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
    }
});


// 6. Approve Credit Customer
app.post('/api/ceo/approvals/credit-customers/:id/approve', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });
    try {
        const { id } = req.params;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // Apply pending limit if exists
            await client.query('UPDATE customers SET credit_limit = COALESCE(pending_credit_limit, credit_limit), pending_credit_limit = NULL WHERE id = $1 AND pending_credit_limit IS NOT NULL', [id]);
            // Activate if pending
            await client.query("UPDATE customers SET status = 'Active' WHERE id = $1 AND status = 'Pending'", [id]);
            await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

        await logActivity(req, 'APPROVE_CREDIT_CUSTOMER', { customerId: id });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
    }
});

// 7. Reject Credit Customer
app.post('/api/ceo/approvals/credit-customers/:id/reject', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });
    try {
        const { id } = req.params;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // Clear pending limit
            await client.query('UPDATE customers SET pending_credit_limit = NULL WHERE id = $1', [id]);
            // Reject if pending status
            await client.query("UPDATE customers SET status = 'Rejected' WHERE id = $1 AND status = 'Pending'", [id]);
            await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

        await logActivity(req, 'REJECT_CREDIT_CUSTOMER', { customerId: id });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
    }
});

// 12. Peak Sales Hours (New)
app.get('/api/ceo/analytics/peak-hours', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });
    try {
        const result = await pool.query(`
            SELECT EXTRACT(HOUR FROM created_at) as hour, COUNT(*) as count, SUM(total_amount) as revenue
            FROM transactions
            WHERE status = 'completed' AND created_at >= date_trunc('month', CURRENT_DATE)
            GROUP BY hour
            ORDER BY hour
        `);
        await logActivity(req, 'VIEW_CEO_PEAK_HOURS');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ message: "Server error" }); }
});

// 13. High Value Transactions (New)
app.get('/api/ceo/transactions/high-value', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });
    try {
        const result = await pool.query(`
            SELECT t.*,
                   CASE WHEN u.id IS NOT NULL THEN COALESCE(u.name, u.username, 'Staff') || ' (@' || COALESCE(u.username, SPLIT_PART(u.email, '@', 1)) || ' · ' || UPPER(COALESCE(u.role, 'staff')) || ')' ELSE NULL END as cashier_name,
                   u.username as cashier_username, u.role as cashier_role
            FROM transactions t
            LEFT JOIN users u ON t.user_id = u.id
            WHERE t.status = 'completed' AND t.created_at >= date_trunc('month', CURRENT_DATE)
            ORDER BY t.total_amount DESC
            LIMIT 5
        `);
        await logActivity(req, 'VIEW_CEO_HIGH_VALUE_TXNS');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ message: "Server error" }); }
});

// 8. Staff Performance
app.get('/api/ceo/staff-performance', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });
    try {
        const result = await pool.query(`
            SELECT u.name, COUNT(CASE WHEN t.is_return = FALSE THEN 1 END) as transactions, SUM(t.total_amount) as sales
            FROM users u
            LEFT JOIN transactions t ON u.id = t.user_id
            WHERE t.status = 'completed' AND t.created_at >= date_trunc('month', CURRENT_DATE)
            GROUP BY u.id, u.name
            ORDER BY sales DESC
            LIMIT 10
        `);

        const staff = result.rows.map(r => ({
            name: r.name,
            transactions: r.transactions,
            sales: r.sales || 0,
            performance: parseFloat(r.sales) > 5000 ? 'High' : 'Normal'
        }));

        const countRes = await pool.query("SELECT COUNT(*) FROM users WHERE status = 'Active' AND deleted_at IS NULL");

        await logActivity(req, 'VIEW_CEO_STAFF_PERFORMANCE');
        res.json({ staff, headcount: countRes.rows[0].count });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
    }
});

// 9. Low Stock (CEO View)
app.get('/api/ceo/inventory/low-stock', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });
    try {
        const result = await pool.query(`
            SELECT name, stock, reorder_level 
            FROM products 
            WHERE deleted_at IS NULL AND tenant_id = $1 AND stock <= reorder_level 
            ORDER BY stock ASC 
            LIMIT 10
        `, [req.user.tenant_id]);
        await logActivity(req, 'VIEW_CEO_LOW_STOCK');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
    }
});

// 10. Tech Status (Mock)
app.get('/api/ceo/tech-status', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });
    await logActivity(req, 'VIEW_CEO_TECH_STATUS');
    res.json([
        { service: 'Database Server', status: 'Operational', latency: '24ms', lastAudit: 'Today' },
        { service: 'API Gateway', status: 'Operational', latency: '45ms', lastAudit: 'Today' },
        { service: 'Backup Systems', status: 'Operational', latency: '-', lastAudit: 'Yesterday' },
        { service: 'Payment Gateway', status: 'Operational', latency: '120ms', lastAudit: 'Today' }
    ]);
});

// 11. Strategy (Mock)
app.get('/api/ceo/strategy', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });
    await logActivity(req, 'VIEW_CEO_STRATEGY');
    res.json([
        { initiative: 'Northern Expansion', owner: 'COO', budget: '₵500k', burnRate: '12%', status: 'On Track' },
        { initiative: 'Digital Transformation', owner: 'CTO', budget: '₵200k', burnRate: '45%', status: 'At Risk' },
        { initiative: 'Staff Training Q1', owner: 'HR', budget: '₵50k', burnRate: '80%', status: 'Completed' }
    ]);
});

// ============ CEO: Aggregation endpoints (paged, branch-aware) ============

// GET /api/ceo/suppliers?branch=&limit=&offset=
app.get('/api/ceo/suppliers', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });
    try {
        const { branch, limit = 50, offset = 0 } = req.query;
        const lim = Math.min(parseInt(limit) || 50, 100);
        const off = parseInt(offset) || 0;

        let params = [];
        let where = '';
        if (branch && branch !== 'All Branches') {
            // try resolve branch id by name or location
            const branchRes = await pool.query('SELECT id FROM branches WHERE name = $1 OR location = $1 LIMIT 1', [branch]);
            if (branchRes.rows.length > 0) {
                params.push(branchRes.rows[0].id);
                where = 'WHERE s.branch_id = $1';
            } else {
                // fallback to no-match
                where = 'WHERE 1=0';
            }
        }

        const q = `SELECT s.id, s.name, s.contact_person, s.phone, s.email, s.address, s.branch_id FROM suppliers s ${where} ORDER BY s.name LIMIT ${lim} OFFSET ${off}`;
        const result = await pool.query(q, params);
        const data = { items: result.rows, count: result.rowCount };

        await logActivity(req, 'VIEW_CEO_SUPPLIERS', { branch });
        res.json(data);
    } catch (e) { console.error(e); res.status(500).json({ message: 'Server error' }); }
});

// GET /api/ceo/purchase-orders?branch=&status=&limit=&offset=
app.get('/api/ceo/purchase-orders', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });
    try {
        const { branch, status, limit = 50, offset = 0 } = req.query;
        const lim = Math.min(parseInt(limit) || 50, 200);
        const off = parseInt(offset) || 0;

        const params = [];
        let whereClauses = [];
        if (status) { params.push(status); whereClauses.push(`po.status = $${params.length}`); }
        if (branch && branch !== 'All Branches') {
            const branchRes = await pool.query('SELECT id FROM branches WHERE name = $1 OR location = $1 LIMIT 1', [branch]);
            if (branchRes.rows.length > 0) { params.push(branchRes.rows[0].id); whereClauses.push(`po.branch_id = $${params.length}`); }
            else whereClauses.push('1=0');
        }

        const where = whereClauses.length ? ('WHERE ' + whereClauses.join(' AND ')) : '';
        const q = `SELECT po.id, po.supplier_id, po.total_amount, po.status, po.created_at, s.name as supplier_name, po.branch_id, b.name as branch_name FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id LEFT JOIN branches b ON po.branch_id = b.id ${where} ORDER BY po.created_at DESC LIMIT ${lim} OFFSET ${off}`;
        const result = await pool.query(q, params);
        const data = { items: result.rows, count: result.rowCount };

        await logActivity(req, 'VIEW_CEO_POS', { branch, status });
        res.json(data);
    } catch (e) { console.error(e); res.status(500).json({ message: 'Server error' }); }
});

// GET /api/ceo/top-products?branch=&start=&end=&limit=
app.get('/api/ceo/top-products', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });
    try {
        const { branch, start, end, limit = 10 } = req.query;
        const lim = Math.min(parseInt(limit) || 10, 100);
        const startDate = start || (new Date(new Date().getFullYear(), new Date().getMonth(), 1)).toISOString();
        const endDate = end || new Date().toISOString();

        const params = [startDate, endDate];
        let branchFilter = '';
        if (branch && branch !== 'All Branches') {
            params.push(branch);
            branchFilter = `AND store_location = $${params.length}`;
        }
        const q = `
            SELECT item->>'name' as name, SUM(CASE WHEN is_return = TRUE THEN -1 ELSE 1 END * (item->>'qty')::int) as qty, SUM(CASE WHEN is_return = TRUE THEN -1 ELSE 1 END * ((item->>'qty')::int * (item->>'price')::numeric)) as revenue
            FROM transactions, jsonb_array_elements(items) as item
            WHERE status = 'completed' AND created_at BETWEEN $1 AND $2 ${branchFilter}
            GROUP BY item->>'name'
            ORDER BY revenue DESC
            LIMIT ${lim}
        `;
        const result = await pool.query(q, params);
        const data = { items: result.rows };

        await logActivity(req, 'VIEW_CEO_TOP_PRODUCTS', { branch, start: startDate, end: endDate });
        res.json(data);
    } catch (e) { console.error(e); res.status(500).json({ message: 'Server error' }); }
});

// GET /api/ceo/branch-performance?start=&end=&limit=
app.get('/api/ceo/branch-performance', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });
    try {
        const { start, end, limit = 50 } = req.query;
        const lim = Math.min(parseInt(limit) || 50, 500);
        const startDate = start || (new Date(new Date().getFullYear(), new Date().getMonth(), 1)).toISOString();
        const endDate = end || new Date().toISOString();

        const q = `
            SELECT COALESCE(store_location, 'Main Branch') as branch, COUNT(CASE WHEN is_return = FALSE THEN 1 END) as txn_count, SUM(total_amount) as revenue
            FROM transactions
            WHERE status = 'completed' AND created_at BETWEEN $1 AND $2
            GROUP BY store_location
            ORDER BY revenue DESC
            LIMIT ${lim}
        `;
        const result = await pool.query(q, [startDate, endDate]);
        const data = result.rows;

        await logActivity(req, 'VIEW_CEO_BRANCH_PERFORMANCE', { start: startDate, end: endDate });
        res.json(data);
    } catch (e) { console.error(e); res.status(500).json({ message: 'Server error' }); }
});

// Create Transaction Endpoint
app.post('/api/transactions', authenticateToken, async (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });
    if (!req.body) return res.status(400).json({ message: 'Invalid request: No body provided' });

    const idempotencyKey = req.headers['x-idempotency-key'] || req.body?.idempotencyKey;

    const { items, total, refundAmount, paymentMethod, promoCode, discount, customerId, taxBreakdown, status, isReturn, originalTransactionId, returnItems } = req.body;
    const tenantId = req.user.tenant_id || 1;
    const scopedIdemKey = idempotencyKey ? `${tenantId}:${String(idempotencyKey)}` : null;

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: 'Invalid request: items must be a non-empty array' });
    }
    if (typeof total !== 'number' || !Number.isFinite(total) || (!isReturn && total < 0)) {
        return res.status(400).json({ message: 'Invalid request: total must be a valid number' });
    }
    if (isReturn) {
        const userRole = (req.user.role || '').toLowerCase();
        if (!MANAGER_ROLES.includes(userRole)) {
            return res.status(403).json({ message: 'Returns require Manager or CEO approval' });
        }
        if (!originalTransactionId) {
            return res.status(400).json({ message: 'Returns must reference an original transaction' });
        }
    }

    try {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            if (scopedIdemKey) {
                const claim = await client.query(
                    `INSERT INTO idempotency_claims (key, user_id) VALUES ($1, $2)
                     ON CONFLICT (key) DO NOTHING RETURNING key`,
                    [scopedIdemKey, req.user.id]
                );
                if (claim.rows.length === 0) {
                    const prior = await client.query(
                        'SELECT receipt_number, transaction_id FROM idempotency_claims WHERE key = $1',
                        [scopedIdemKey]
                    );
                    await client.query('ROLLBACK');
                    return res.json({
                        success: true,
                        receiptNumber: prior.rows[0]?.receipt_number || null,
                        transactionId: prior.rows[0]?.transaction_id || null,
                        isReplay: true
                    });
                }
            }

            // Convert customerId to integer if provided (scoped to tenant)
            const parsedCustomerId = customerId ? parseInt(customerId) : null;
            let customerName = null;
            if (parsedCustomerId) {
                const cRes = await client.query('SELECT name FROM customers WHERE id = $1 AND COALESCE(tenant_id, 1) = $2 AND deleted_at IS NULL', [parsedCustomerId, tenantId]);
                if (cRes.rows.length > 0) customerName = cRes.rows[0].name;
            }

            // 1. Verify products exist & compute server-authoritative prices
            let serverSubtotal = 0;
            const verifiedItems = [];
            for (const item of items) {
                const qty = Number(item.qty);
                if (!item.barcode || !Number.isFinite(qty) || qty <= 0) {
                    throw new Error('Each item must have a valid barcode and positive quantity');
                }
                const pRes = await client.query('SELECT id, name, price FROM products WHERE barcode = $1 AND COALESCE(tenant_id, 1) = $2', [item.barcode, tenantId]);
                if (pRes.rows.length === 0) throw new Error(`Product ${item.barcode} not found`);
                const prod = pRes.rows[0];
                const unitPrice = Number(prod.price || 0);
                serverSubtotal += unitPrice * qty;
                verifiedItems.push({ ...item, id: prod.id, name: prod.name, qty, price: unitPrice });
            }

            const safeDiscount = Math.max(0, Number(discount || 0));
            const role = (req.user.role || '').toLowerCase();
            const capPct = (role === 'super_admin' || role === 'ceo' || role === 'admin') ? 100 : (MANAGER_ROLES.includes(role) ? 20 : 5);
            const discPct = serverSubtotal > 0 ? (safeDiscount / serverSubtotal) * 100 : 0;
            if (!isReturn && discPct > capPct) {
                await client.query('ROLLBACK');
                return res.status(403).json({ message: `Discount (${discPct.toFixed(1)}%) exceeds your ${capPct}% role limit` });
            }
            const authoritativeTotal = isReturn ? -Math.abs(Number(total)) : Math.max(0, Number((serverSubtotal - safeDiscount).toFixed(2)));

            const receiptNumber = (isReturn ? 'REF' : 'RCP') + Date.now() + crypto.randomInt(100, 1000);
            // Resolve canonical store for the logged-in seller (manager or teller)
            let sellerStoreLoc = req.user.store_location || null;
            let sellerStoreId = req.user.store_id || null;
            const uStoreRes = await client.query('SELECT store_id, store_location FROM users WHERE id = $1 LIMIT 1', [req.user.id]);
            if (uStoreRes.rows.length > 0) {
                sellerStoreId = uStoreRes.rows[0].store_id || sellerStoreId;
                sellerStoreLoc = uStoreRes.rows[0].store_location || sellerStoreLoc;
            }
            const brCanon = await client.query(
                `SELECT name FROM branches
                 WHERE COALESCE(tenant_id, 1) = $1
                 ORDER BY CASE
                     WHEN ($2::int IS NOT NULL AND id = $2::int) THEN 0
                     WHEN ($3::text IS NOT NULL AND (LOWER(name) = LOWER($3::text) OR LOWER(location) = LOWER($3::text))) THEN 1
                     ELSE 2
                 END, is_main DESC NULLS LAST, id ASC
                 LIMIT 1`,
                [tenantId, sellerStoreId, sellerStoreLoc]
            );
            const canonicalStoreLoc = brCanon.rows.length > 0 ? brCanon.rows[0].name : (sellerStoreLoc || 'Main Warehouse');

            const txnRes = await client.query(
                `INSERT INTO transactions
                (tenant_id, user_id, store_location, total_amount, original_total, current_total, payment_method, receipt_number, items, created_at, customer_id, customer_name, status, tax_breakdown, is_return, original_transaction_id, return_items)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
                [tenantId, req.user.id, canonicalStoreLoc, authoritativeTotal, isReturn ? 0 : authoritativeTotal, authoritativeTotal, paymentMethod, receiptNumber, JSON.stringify(verifiedItems), parsedCustomerId, customerName, status || 'pending', JSON.stringify(taxBreakdown || []), isReturn || false, originalTransactionId || null, JSON.stringify(returnItems || [])]
            );

            // Handle Stock Management (Deduction for sales, Restoration for returns)
            if (isReturn) {
                const origTxn = await client.query(
                    'SELECT id, total_amount, receipt_number, items, is_return FROM transactions WHERE id = $1 AND COALESCE(tenant_id, 1) = $2 FOR UPDATE',
                    [originalTransactionId, tenantId]
                );
                if (origTxn.rows.length === 0 || origTxn.rows[0].is_return) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({ message: 'Original transaction not found' });
                }

                const refAmt = (typeof refundAmount === 'number' && Number.isFinite(refundAmount)) ? Math.abs(refundAmount) : Math.abs(serverSubtotal - safeDiscount);
                const originalTotal = parseFloat(origTxn.rows[0].total_amount);
                const newTotal = originalTotal - refAmt;

                await client.query(
                    'UPDATE transactions SET has_returns = TRUE, original_total = $1, current_total = $2 WHERE id = $3 AND COALESCE(tenant_id, 1) = $4',
                    [originalTotal, newTotal, originalTransactionId, tenantId]
                );

                // Record entry in refunds table
                await client.query(
                    `INSERT INTO refunds (tenant_id, transaction_id, original_receipt_number, refund_receipt_number, refund_amount, payment_method, processed_by)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [tenantId, originalTransactionId, origTxn.rows[0].receipt_number, receiptNumber, refAmt, paymentMethod, req.user.id]
                );

                // Resolve canonical branch name once for this tenant
                let storeLoc = req.user.store_location || 'Main Warehouse';
                const branchRes = await client.query(
                    'SELECT name FROM branches WHERE (name = $1 OR location = $1) AND COALESCE(tenant_id, 1) = $2 LIMIT 1',
                    [storeLoc, tenantId]
                );
                if (branchRes.rows.length > 0) {
                    storeLoc = branchRes.rows[0].name;
                }

                // For returns, ADD back stock using tenant-verified barcodes/products only
                for (const item of verifiedItems) {
                    const prodRes = await client.query(
                        'SELECT id, barcode FROM products WHERE barcode = $1 AND COALESCE(tenant_id, 1) = $2 LIMIT 1 FOR UPDATE',
                        [item.barcode, tenantId]
                    );
                    if (prodRes.rows.length === 0) {
                        console.error(`[RETURN] Cannot restore stock: Product ${item.barcode} not found in tenant ${tenantId}`);
                        continue;
                    }
                    const productId = prodRes.rows[0].id;
                    const productBarcode = prodRes.rows[0].barcode;

                    const updateRes = await client.query(`
                        UPDATE products 
                        SET stock = COALESCE(stock, 0) + $1,
                            stock_levels = jsonb_set(
                                COALESCE(stock_levels, '{}'::jsonb), 
                                ARRAY[$3::text], 
                                to_jsonb(COALESCE((stock_levels->>$3::text)::int, 0) + $1)
                            )
                        WHERE id = $2 AND COALESCE(tenant_id, 1) = $4
                        RETURNING id, name, stock
                    `, [item.qty, productId, storeLoc, tenantId]);

                    if (updateRes.rows.length === 0) {
                        console.error(`[RETURN] Failed to update stock for product ID ${productId}`);
                    }

                    const batches = await client.query(
                        'SELECT * FROM product_batches WHERE product_barcode = $1 AND COALESCE(tenant_id, 1) = $2 ORDER BY expiry_date ASC FOR UPDATE',
                        [productBarcode, tenantId]
                    );

                    let remainingQty = item.qty;
                    for (const batch of batches.rows) {
                        if (remainingQty <= 0) break;

                        const addQty = Math.min(remainingQty, 999999);
                        await client.query(
                            'UPDATE product_batches SET quantity = quantity + $1 WHERE id = $2 AND COALESCE(tenant_id, 1) = $3',
                            [addQty, batch.id, tenantId]
                        );
                        remainingQty -= addQty;
                    }
                }

            } else {
                // Normal sale - deduct stock
                // Resolve canonical branch name for POS user
                let storeLoc = req.user.store_location || 'Main Warehouse';
                const branchRes = await client.query('SELECT id, name FROM branches WHERE name = $1 OR location = $1', [storeLoc]);
                let branchId = req.user.store_id || 1;

                if (branchRes.rows.length > 0) {
                    storeLoc = branchRes.rows[0].name;
                    branchId = branchRes.rows[0].id;
                }

                // Update stock and batches.
                // Process in a fixed product order: two carts touching the same products in
                // opposite orders would otherwise take the batch row locks in conflicting
                // sequence and deadlock (40P01).
                const saleItems = [...items].sort((a, b) => String(a.id || a.barcode).localeCompare(String(b.id || b.barcode)));
                for (const item of saleItems) {
                    // Deduct from total stock and specific location using product ID (not barcode)
                    // This prevents affecting other products sharing the same barcode

                    await client.query(`
                        UPDATE products 
                        SET stock = COALESCE(stock, 0) - $1,
                            stock_levels = jsonb_set(
                                COALESCE(stock_levels, '{}'::jsonb), 
                                ARRAY[$3::text], 
                                to_jsonb(COALESCE((stock_levels->>$3::text)::int, 0) - $1)
                            )
                        WHERE id = $2
                    `, [item.qty, item.id, storeLoc]);

                    // FIFO/FEFO Batch Deduction
                    // Get batches ordered by expiry (FEFO) or FIFO for hardware items (expiry_date NULLS LAST)
                    const batches = await client.query(
                        'SELECT * FROM product_batches WHERE product_barcode = $1 AND quantity > 0 ORDER BY expiry_date ASC NULLS LAST, created_at ASC, id ASC FOR UPDATE',
                        [item.barcode]
                    );

                    let remainingQty = item.qty;
                    for (const batch of batches.rows) {
                        if (remainingQty <= 0) break;
                        const deduct = Math.min(remainingQty, batch.quantity);
                        await client.query(
                            'UPDATE product_batches SET quantity = quantity - $1 WHERE id = $2',
                            [deduct, batch.id]
                        );
                        remainingQty -= deduct;
                    }

                    // Log audit for each item sold (using product id for accurate lookup)
                    await client.query(`
                        INSERT INTO inventory_audit_log (action_type, product_barcode, quantity_before, quantity_after, reference_id, reference_type, user_id, branch_id)
                        SELECT 'Sale', $1, stock + $2, stock, $3, 'Transaction', $4, $5 FROM products WHERE id = $6
                    `, [item.barcode, item.qty, txnRes.rows[0].id, req.user.id, branchId, item.id]);
                }
            }

            // Update Promotion Usage (for both sales and returns)
            if (promoCode && discount > 0) {
                const discountChange = isReturn ? -discount : discount;

                // Update global total
                await client.query(
                    'UPDATE promotions SET total_discounted = COALESCE(total_discounted, 0) + $1 WHERE code = $2',
                    [discountChange, promoCode]
                );

                // Update branch specific usage
                const branchId = req.user.store_id || 1;
                await client.query(`
                    INSERT INTO promotion_usage (promotion_code, branch_id, total_discounted)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (promotion_code, branch_id)
                    DO UPDATE SET total_discounted = promotion_usage.total_discounted + $3
                `, [promoCode, branchId, discountChange]);
            }

            if (idempotencyKey) {
                await client.query(
                    'UPDATE idempotency_claims SET receipt_number = $1, transaction_id = $2 WHERE key = $3',
                    [receiptNumber, txnRes.rows[0].id, idempotencyKey]
                );
            }

            await client.query('COMMIT');

            // Log appropriate activity
            if (isReturn) {
                await logActivity(req, 'RETURN_SALE', { total: -total, receiptNumber, itemCount: items.length, originalTransactionId });
            } else {
                await logActivity(req, 'POS_SALE', { total, receiptNumber, itemCount: items.length });
            }

            res.json({ success: true, receiptNumber, transactionId: txnRes.rows[0].id });
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Transaction error:', err);
        res.status(500).json({ message: 'Error processing transaction' });
    }
});

// Get batches for a specific product (for dropdowns)
app.get('/api/batches/product/:barcode', authenticateToken, async (req, res) => {
    const { barcode } = req.params;
    try {
        const result = await pool.query(`
            SELECT * FROM product_batches 
            WHERE product_barcode = $1 AND quantity_available > 0 
            ORDER BY expiry_date ASC NULLS LAST, created_at ASC
        `, [barcode]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error fetching product batches' });
    }
});

// 8. Get expiring batches (FEFO alert)
app.get('/api/batches/expiring/:days', authenticateToken, async (req, res) => {
    const { days } = req.params;
    const userBranchId = req.user.store_id;
    const isRestricted = req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo';

    try {
        let query = `
            SELECT pb.*, p.name, p.selling_unit,
                EXTRACT(DAY FROM pb.expiry_date - CURRENT_DATE) as days_to_expiry
            FROM product_batches pb
            JOIN products p ON pb.product_barcode = p.barcode
            WHERE pb.status = 'Active'
            AND pb.expiry_date IS NOT NULL
            AND pb.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '1 day' * $1
        `;
        let params = [days];

        if (isRestricted && userBranchId) {
            query += ` AND pb.branch_id = $2`;
            params.push(userBranchId);
        }

        query += ` ORDER BY pb.expiry_date ASC`;

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching expiring batches' });
    }
});

// 9. Get next available batch (FIFO/FEFO)
app.get('/api/batches/next/:product_barcode', authenticateToken, async (req, res) => {
    const { product_barcode } = req.params;
    try {
        const result = await pool.query(`
            SELECT * FROM product_batches
            WHERE product_barcode = $1 AND status = 'Active' AND quantity_available > 0
            ORDER BY expiry_date ASC NULLS LAST, created_at ASC, id ASC
            LIMIT 1
        `, [product_barcode]);
        res.json(result.rows[0] || null);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching next batch' });
    }
});

// Move stock from the store to the shelf (Inventory > Batch & lot tracking).
// Managers only. Tenant-scoped. The staff id comes from the login, never from the body.
app.post('/api/shelf/move', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    const tenantId = req.user.tenant_id || 1;
    const barcode = String(req.body.product_barcode || '').trim();
    const qty = Number(req.body.quantity);
    const notes = String(req.body.notes || '').slice(0, 500);
    const batchNumber = String(req.body.batch_number || '').slice(0, 100);
    if (!barcode) return res.status(400).json({ message: 'Choose a product to move.' });
    if (!Number.isInteger(qty) || qty <= 0) {
        return res.status(400).json({ message: 'Quantity must be a whole number greater than zero.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const prod = await client.query(
            'SELECT barcode FROM products WHERE barcode = $1 AND COALESCE(tenant_id, 1) = $2 FOR UPDATE',
            [barcode, tenantId]
        );
        if (!prod.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Product not found.' });
        }

        // The branch must belong to this tenant; fall back to the user's own branch.
        const requestedBranch = Number(req.body.branch_id) || Number(req.user.store_id) || 1;
        const branch = await client.query(
            'SELECT id FROM branches WHERE id = $1 AND deleted_at IS NULL AND COALESCE(tenant_id, 1) = $2',
            [requestedBranch, tenantId]
        );
        if (!branch.rows.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Branch not found.' });
        }
        const branchId = branch.rows[0].id;

        await client.query(`
            INSERT INTO shelf_inventory (product_barcode, branch_id, quantity_on_shelf, last_verified, staff_id, notes, tenant_id)
            VALUES ($1, $2, $3, NOW(), $4, $5, $6)
            ON CONFLICT (product_barcode, branch_id)
            DO UPDATE SET quantity_on_shelf = COALESCE(shelf_inventory.quantity_on_shelf, 0) + EXCLUDED.quantity_on_shelf,
                          last_verified = NOW(), staff_id = EXCLUDED.staff_id, notes = EXCLUDED.notes
        `, [barcode, branchId, qty, req.user.id || null, notes, tenantId]);

        await client.query(`
            INSERT INTO shelf_movements (product_barcode, movement_type, quantity, staff_id, from_location, to_location, branch_id, notes, tenant_id)
            VALUES ($1, 'store_to_shelf', $2, $3, 'Store', 'Shelf', $4, $5, $6)
        `, [barcode, qty, req.user.id || null, branchId, [batchNumber && ('Batch ' + batchNumber), notes].filter(Boolean).join(' - '), tenantId]);

        await client.query('COMMIT');
        await logActivity(req, 'SHELF_MOVE', { barcode, quantity: qty, branch_id: branchId });
        res.json({ success: true, message: 'Stock moved to shelf' });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        console.error('Shelf move error:', err);
        res.status(500).json({ message: 'Could not move stock to the shelf.' });
    } finally {
        client.release();
    }
});

// Get all batches for a user// Get shelf/batch inventory for a specific branch
app.get('/api/shelf/inventory/:branch_id', authenticateToken, async (req, res) => {
    try {
        const { branch_id } = req.params;
        const result = await pool.query(`
            SELECT b.*, p.name, p.selling_unit, p.stock_levels 
            FROM product_batches b 
            JOIN products p ON b.product_barcode = p.barcode AND COALESCE(p.tenant_id, 1) = $2
            WHERE (b.branch_id = $1 OR b.branch_id IS NULL OR b.branch_id = 1) AND COALESCE(b.tenant_id, 1) = $2
            ORDER BY b.created_at DESC
        `, [branch_id, req.user.tenant_id || 1]);

        // Get exact branch name for stock map
        const branchRes = await pool.query('SELECT name FROM branches WHERE id = $1', [branch_id]);
        const branchName = branchRes.rows[0]?.name;

        const rows = result.rows.map(row => {
            const levels = typeof row.stock_levels === 'string' ? JSON.parse(row.stock_levels) : (row.stock_levels || {});

            let bStock = 0;
            if (req.user && req.user.type === 'company') {
                // Dynamically resolve stock for this branch — no hardcoded names
                const matchKey = Object.keys(levels).find(k => k.toLowerCase() === (branchName || '').toLowerCase());
                bStock = parseInt(matchKey ? levels[matchKey] : 0);
            } else {
                const manualFallback = req.user && req.user.store_location ? req.user.store_location : 'Main Warehouse';
                bStock = parseInt(levels[branchName] || levels[manualFallback] || levels['Main Warehouse'] || 0);
            }

            row.branch_stock = bStock;
            delete row.stock_levels;
            return row;
        });

        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error fetching shelf inventory' });
    }
});

app.get('/api/batches', authenticateToken, requireRole(PAGE_ROLES.STAFF_ALL), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT b.*, p.name 
            FROM product_batches b 
            JOIN products p ON b.product_barcode = p.barcode AND COALESCE(p.tenant_id, 1) = $1
            WHERE COALESCE(b.tenant_id, 1) = $1
            ORDER BY b.created_at DESC
        `, [req.user.tenant_id || 1]);
        res.json(result.rows || []);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error fetching batches' });
    }
});

// Create or update a batch
app.post('/api/batches', authenticateToken, requireRole(PAGE_ROLES.STAFF_ALL), async (req, res) => {
    const { product_barcode, batch_number, expiry_date, quantity, quantity_available } = req.body;

    if (!product_barcode || !batch_number) {
        return res.status(400).json({ message: 'product_barcode and batch_number are required' });
    }

    const tenantId = req.user.tenant_id || 1;
    try {
        // Check if batch already exists for this tenant
        const existing = await pool.query(`
            SELECT id FROM product_batches 
            WHERE product_barcode = $1 AND batch_number = $2 AND COALESCE(tenant_id, 1) = $3
        `, [product_barcode, batch_number, tenantId]);

        if (existing.rows.length > 0) {
            // Update existing batch
            const result = await pool.query(`
                UPDATE product_batches 
                SET expiry_date = $1, quantity = $2, quantity_available = $3
                WHERE id = $4 AND COALESCE(tenant_id, 1) = $5
                RETURNING *
            `, [expiry_date || null, quantity || 0, quantity_available || quantity || 0, existing.rows[0].id, tenantId]);
            res.json(result.rows[0]);
        } else {
            // Create new batch
            const result = await pool.query(`
                INSERT INTO product_batches (tenant_id, product_barcode, batch_number, expiry_date, quantity, quantity_available, status)
                VALUES ($1, $2, $3, $4, $5, $6, 'Active')
                RETURNING *
            `, [tenantId, product_barcode, batch_number, expiry_date || null, quantity || 0, quantity_available || quantity || 0]);
            res.json(result.rows[0]);
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error saving batch', error: err.message });
    }
});

// 10. Create stock adjustment
app.post('/api/stock-adjustments', authenticateToken, requireRole(MANAGER_ROLES), requirePermission('stock', 'create'), async (req, res) => {
    const tenantId = req.user.tenant_id || 1;
    const { product_barcode, adjustment_type, quantity_adjusted, reason, approver_id, branch_id, user_id } = req.body;
    const branchName = branch_id == 2 ? 'Accra Branch' : (branch_id == 3 ? 'Kumasi Branch' : 'Main Warehouse');

    try {
        const result = await pool.query(`
            INSERT INTO stock_adjustments (tenant_id, product_barcode, adjustment_type, quantity_adjusted, reason, approver_id, branch_id, approved_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
            RETURNING id
        `, [tenantId, product_barcode, adjustment_type || 'Correction', quantity_adjusted, reason || '', approver_id || req.user.id || null, branch_id || req.user.store_id || 1]);

        await pool.query(`
            UPDATE products 
            SET stock = COALESCE(stock, 0) + $1,
                stock_levels = jsonb_set(
                    COALESCE(stock_levels, '{}'::jsonb), 
                    ARRAY[$3::text], 
                    to_jsonb(COALESCE((stock_levels->>$3::text)::int, 0) + $1)
                )
            WHERE barcode = $2 AND COALESCE(tenant_id, 1) = $4
        `, [quantity_adjusted, product_barcode, branchName, tenantId]);

        await pool.query(`
            INSERT INTO inventory_audit_log (action_type, product_barcode, quantity_after, reference_id, reference_type, user_id, branch_id, notes)
            SELECT 'Stock Adjustment', $1::varchar, stock - $6, stock, $2, 'Adjustment', $3, $4, $5 FROM products WHERE barcode = $1 AND COALESCE(tenant_id, 1) = $7
        `, [product_barcode, result.rows[0].id, user_id || req.user.id || null, branch_id || req.user.store_id || 1, reason || '', quantity_adjusted, tenantId]).catch(() => {});

        await logActivity(req, 'STOCK_ADJUSTMENT', { product_barcode, quantity_adjusted, reason });
        res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error creating adjustment' });
    }
});

app.post('/api/stock-adjustments/bulk', authenticateToken, requireRole(MANAGER_ROLES), requirePermission('stock', 'create'), async (req, res) => {
    const tenantId = req.user.tenant_id || 1;
    const { adjustments = [] } = req.body || {};
    if (!Array.isArray(adjustments) || !adjustments.length) {
        return res.status(400).json({ message: 'No adjustments provided' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        let count = 0;
        for (const adj of adjustments) {
            const qty = Number(adj.quantity_adjusted || 0);
            if (!adj.product_barcode || !Number.isFinite(qty) || qty === 0) continue;
            await client.query(
                `INSERT INTO stock_adjustments (tenant_id, product_barcode, adjustment_type, quantity_adjusted, reason, approver_id, branch_id, approved_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)`,
                [tenantId, adj.product_barcode, adj.adjustment_type || 'Correction', qty, adj.reason || 'Bulk Adjustment', req.user.id || null, req.user.store_id || 1]
            );
            await client.query(
                `UPDATE products SET stock = COALESCE(stock, 0) + $1 WHERE barcode = $2 AND COALESCE(tenant_id, 1) = $3`,
                [qty, adj.product_barcode, tenantId]
            );
            count++;
        }
        await client.query('COMMIT');
        await logActivity(req, 'BULK_STOCK_ADJUSTMENT', { count });
        res.json({ success: true, count });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        res.status(500).json({ message: 'Bulk stock adjustment failed' });
    } finally {
        client.release();
    }
});

// Get Stock Adjustments History
app.get('/api/stock-adjustments', authenticateToken, async (req, res) => {
    const tenantId = req.user.tenant_id || 1;
    try {
        let query = `
            SELECT sa.*, p.name as product_name, u.name as approver_name
            FROM stock_adjustments sa
            JOIN products p ON sa.product_barcode = p.barcode AND COALESCE(p.tenant_id, 1) = $1
            LEFT JOIN users u ON sa.approver_id = u.id
            WHERE COALESCE(sa.tenant_id, 1) = $1
        `;
        const params = [tenantId];
        if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo' && req.user.store_id) {
            query += ` AND sa.branch_id = $2`;
            params.push(req.user.store_id);
        }
        query += ` ORDER BY sa.created_at DESC`;
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// 11. Start stock take
app.post('/api/stock-takes', authenticateToken, requireRole(PAGE_ROLES.STAFF_ALL), async (req, res) => {
    const { branch_id } = req.body;
    try {
        const tenantId = req.user.tenant_id || 1;
        const branchOk = await pool.query('SELECT 1 FROM branches WHERE id = $1 AND COALESCE(tenant_id, 1) = $2', [branch_id, tenantId]);
        if (branchOk.rows.length === 0) return res.status(404).json({ message: 'Branch not found' });
        const result = await pool.query(`
            INSERT INTO stock_takes (stock_take_date, branch_id, created_by, status)
            VALUES (CURRENT_DATE, $1, $2, 'In Progress')
            RETURNING id
        `, [branch_id, req.user.id]);
        await logActivity(req, 'START_STOCK_TAKE', { branch_id });
        res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ message: 'Error starting stock take' });
    }
});

// Get Stock Takes History
app.get('/api/stock-takes', authenticateToken, requireRole(PAGE_ROLES.STAFF_ALL), async (req, res) => {
    try {
        let query = `
            SELECT st.*, u.name as created_by_name 
            FROM stock_takes st
            LEFT JOIN users u ON st.created_by = u.id
            LEFT JOIN branches b ON b.id = st.branch_id
            WHERE COALESCE(b.tenant_id, 1) = $1
        `;
        let params = [req.user.tenant_id || 1];
        if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo' && req.user.store_id) {
            query += ` AND st.branch_id = $2`;
            params.push(req.user.store_id);
        }
        query += ` ORDER BY st.stock_take_date DESC`;
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// 12. Record stock take item
app.post('/api/stock-takes/:id/items', authenticateToken, requireRole(PAGE_ROLES.STAFF_ALL), async (req, res) => {
    const { id } = req.params;
    const { product_barcode } = req.body;
    const counted_by = req.user.id;
    const physical_count = Number(req.body.physical_count);
    if (!Number.isInteger(physical_count) || physical_count < 0) {
        return res.status(400).json({ message: 'physical_count must be a whole number, 0 or more' });
    }
    try {
        const tenantId = req.user.tenant_id || 1;
        const take = await stockTakeInTenant(pool, id, tenantId, false);
        if (!take) return res.status(404).json({ message: 'Stock take not found' });
        if ((take.status || '').toLowerCase() === 'approved') return res.status(409).json({ message: 'Stock take has already been approved' });
        const systemCount = await pool.query('SELECT stock FROM products WHERE barcode = $1 AND tenant_id = $2 AND deleted_at IS NULL', [product_barcode, tenantId]);
        if (systemCount.rows.length === 0) return res.status(404).json({ message: 'Product not found' });
        const variance = physical_count - systemCount.rows[0].stock;

        await pool.query(`
            INSERT INTO stock_take_items (stock_take_id, product_barcode, physical_count, system_count, variance, counted_by, counted_at)
            VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
        `, [id, product_barcode, physical_count, systemCount.rows[0].stock, variance, counted_by]);

        res.json({ success: true, variance });
    } catch (err) {
        res.status(500).json({ message: 'Error recording stock count' });
    }
});

// 13. Approve stock take
app.post('/api/stock-takes/:id/approve', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Lock the count itself: without FOR UPDATE two concurrent approvals both read a
        // pending row and apply the same variance twice. The count must belong to this tenant.
        const lockRow = await stockTakeInTenant(client, id, req.user.tenant_id || 1, true);
        const lockRes = { rows: lockRow ? [lockRow] : [] };
        if (lockRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Stock take not found' });
        }
        if ((lockRes.rows[0].status || '').toLowerCase() === 'approved') {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: 'Stock take has already been approved' });
        }
        const bId = lockRes.rows[0].branch_id || 1;
        const branchName = bId == 2 ? 'Accra Branch' : (bId == 3 ? 'Kumasi Branch' : 'Main Warehouse');

        const items = await client.query('SELECT * FROM stock_take_items WHERE stock_take_id = $1', [id]);
        for (const item of items.rows) {
            if (item.variance !== 0) {
                await client.query(`
                    UPDATE products 
                    SET stock = COALESCE(stock, 0) + $1,
                        stock_levels = jsonb_set(
                            COALESCE(stock_levels, '{}'::jsonb), 
                            ARRAY[$3::text], 
                            to_jsonb(COALESCE((stock_levels->>$3::text)::int, 0) + $1)
                        )
                    WHERE barcode = $2 AND tenant_id = $4
                `, [item.variance, item.product_barcode, branchName, req.user.tenant_id || 1]);

                await client.query(`
                    INSERT INTO inventory_audit_log (action_type, product_barcode, quantity_before, quantity_after, reference_id, reference_type, user_id)
                    VALUES ('Stock Take Variance', $1, $2, $3, $4, 'Stock Take', $5)
                `, [item.product_barcode, item.system_count, item.physical_count, id, req.user.id]);
            }
        }
        const varianceResult = await client.query('SELECT COALESCE(SUM(variance), 0) as total_variance FROM stock_take_items WHERE stock_take_id = $1', [id]);
        await client.query(`
            UPDATE stock_takes SET status = 'Approved', approved_by = $1, completed_at = CURRENT_TIMESTAMP, variance_total = $2 WHERE id = $3
        `, [req.user.id, varianceResult.rows[0].total_variance, id]);

        await client.query('COMMIT');
        await logActivity(req, 'APPROVE_STOCK_TAKE', { id, total_variance: varianceResult.rows[0].total_variance });
        res.json({ success: true, message: 'Stock take approved' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ message: 'Error approving stock take' });
    } finally { client.release(); }
});

// 14. Check reorder alerts
app.post('/api/reorder/check', authenticateToken, async (req, res) => {
    const { branch_id } = req.body;
    try {
        const result = await pool.query(`
            SELECT p.barcode, p.name, p.stock, p.reorder_level,
                CASE 
                    WHEN p.stock = 0 THEN 'Critical'
                    WHEN p.stock <= p.reorder_level THEN 'High'
                    ELSE 'Normal'
                END as priority,
                (p.reorder_level * 2) as suggested_quantity
            FROM products p
            WHERE p.stock <= p.reorder_level
            ORDER BY p.stock ASC
        `);

        for (const product of result.rows) {
            await pool.query(`
                INSERT INTO reorder_alerts (product_barcode, current_stock, reorder_level, suggested_quantity, priority, branch_id, status)
                VALUES ($1, $2, $3, $4, $5, $6, 'Active')
                ON CONFLICT (product_barcode) DO UPDATE SET
                    current_stock = $2, priority = $5, created_at = CURRENT_TIMESTAMP
            `, [product.barcode, product.stock, product.reorder_level, product.suggested_quantity, product.priority, branch_id]);
        }
        await logActivity(req, 'CHECK_REORDER_ALERTS', { branch_id, alertsFound: result.rows.length });
        res.json({ success: true, alerts: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error checking reorder alerts' });
    }
});

// 15. Get reorder alerts
app.get('/api/reorder/alerts/:branch_id', authenticateToken, async (req, res) => {
    const { branch_id } = req.params;
    try {
        const result = await pool.query(`
            SELECT ra.*, p.name, p.selling_unit, p.price
            FROM reorder_alerts ra
            JOIN products p ON ra.product_barcode = p.barcode
            WHERE ra.branch_id = $1 AND ra.status = 'Active'
            ORDER BY 
                CASE WHEN ra.priority = 'Critical' THEN 1 WHEN ra.priority = 'High' THEN 2 ELSE 3 END,
                ra.current_stock ASC
        `, [branch_id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching alerts' });
    }
});

// 16. Confirm transfer receipt
app.post('/api/transfers/:id/confirm', authenticateToken, requireRole(PAGE_ROLES.STAFF_ALL), async (req, res) => {
    const { id } = req.params;
    const items_received = Array.isArray(req.body.items_received) ? req.body.items_received : [];
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const tr = await client.query(
            'SELECT id, status FROM stock_transfers WHERE id = $1 AND COALESCE(tenant_id, 1) = $2 FOR UPDATE',
            [id, req.user.tenant_id || 1]
        );
        if (tr.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Transfer not found' });
        }
        if ((tr.rows[0].status || '').toLowerCase() === 'confirmed') {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: 'Transfer has already been confirmed' });
        }
        for (const item of items_received) {
            const qty = Number(item.quantity_received);
            if (!Number.isInteger(qty) || qty < 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'quantity_received must be a whole number, 0 or more' });
            }
            await client.query(
                'UPDATE stock_transfer_items SET quantity_received = $1 WHERE id = $2 AND transfer_id = $3',
                [qty, item.id, id]
            );
        }
        await client.query(
            `UPDATE stock_transfers SET status = 'Confirmed', confirmed_by = $1, confirmed_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [req.user.id, id]
        );
        await client.query('COMMIT');
        await logActivity(req, 'CONFIRM_TRANSFER', { id });
        res.json({ success: true, message: 'Transfer confirmed' });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        res.status(500).json({ message: 'Error confirming transfer' });
    } finally { client.release(); }
});

// 17. Low stock report
app.get('/api/reports/low-stock/:branch_id', authenticateToken, async (req, res) => {
    const { branch_id } = req.params;
    try {
        const result = await pool.query(`
            SELECT p.barcode, p.name, p.category, p.stock, p.reorder_level,
                (p.reorder_level - p.stock) as shortage,
                ROUND((p.stock::decimal / NULLIF(p.reorder_level, 0)) * 100, 2) as stock_percentage
            FROM products p
            WHERE p.stock < p.reorder_level
            ORDER BY shortage DESC
        `);
        await logActivity(req, 'VIEW_REPORT_LOW_STOCK', { branch_id });
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: 'Error generating report' });
    }
});

// 18. Expiry report
app.get('/api/reports/expiry/:branch_id', authenticateToken, async (req, res) => {
    const { branch_id } = req.params;
    try {
        const result = await pool.query(`
            SELECT pb.*, p.name, p.selling_unit,
                EXTRACT(DAY FROM pb.expiry_date - CURRENT_DATE) as days_to_expiry,
                CASE 
                    WHEN pb.expiry_date < CURRENT_DATE THEN 'Expired'
                    WHEN pb.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days' THEN 'Expiring Soon'
                    WHEN pb.expiry_date BETWEEN CURRENT_DATE + INTERVAL '7 days' AND CURRENT_DATE + INTERVAL '30 days' THEN 'Near Expiry'
                    ELSE 'OK'
                END as status
            FROM product_batches pb
            JOIN products p ON pb.product_barcode = p.barcode
            WHERE pb.branch_id = $1 AND pb.status = 'Active'
            ORDER BY pb.expiry_date ASC
        `, [branch_id]);
        await logActivity(req, 'VIEW_REPORT_EXPIRY', { branch_id });
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: 'Error generating expiry report' });
    }
});

// 20. Stock summary
app.get('/api/reports/stock-summary/:branch_id', authenticateToken, async (req, res) => {
    const { branch_id } = req.params;
    try {
        const result = await pool.query(`
            SELECT 
                COUNT(*) as total_products,
                SUM(stock) as total_units,
                SUM(stock * cost_price) as total_cost_value,
                SUM(stock * price) as total_retail_value,
                COUNT(CASE WHEN stock = 0 THEN 1 END) as out_of_stock_count,
                COUNT(CASE WHEN stock <= reorder_level THEN 1 END) as low_stock_count
            FROM products p
            WHERE p.tenant_id = $1
            ORDER BY p.name ASC
        `, [req.user.tenant_id]);
        await logActivity(req, 'VIEW_REPORT_SUMMARY', { branch_id });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ message: 'Error generating summary' });
    }
});

// 21. Get product for POS with FEFO/FIFO batch selection
app.get('/api/pos/product/:barcode', authenticateToken, requireRole(PAGE_ROLES.STAFF_ALL), async (req, res) => {
    const { barcode } = req.params;
    try {
        const product = await pool.query('SELECT * FROM products WHERE barcode = $1 AND COALESCE(tenant_id, 1) = $2 AND deleted_at IS NULL', [barcode, req.user.tenant_id || 1]);
        if (product.rows.length === 0) {
            return res.status(404).json({ message: 'Product not found' });
        }
        const prod = product.rows[0];
        if (prod.stock <= 0) {
            return res.status(400).json({ message: 'Out of stock' });
        }
        let batches = [];
        if (prod.track_batch) {
            const batchResult = await pool.query(`
                SELECT * FROM product_batches
                WHERE product_barcode = $1 AND status = 'Active' AND quantity_available > 0
                ORDER BY expiry_date ASC NULLS LAST, created_at ASC, id ASC
            `, [barcode]);
            batches = batchResult.rows;
        }
        res.json({ ...prod, batches });
    } catch (err) {
        res.status(500).json({ message: 'Error fetching product' });
    }
});

// 22. Process POS sale with batch tracking
app.post('/api/pos/sale/:barcode', authenticateToken, async (req, res) => {
    const { barcode } = req.params;
    const { quantity, batch_id, branch_id } = req.body;
    const qty = parseInt(quantity, 10);
    if (!Number.isInteger(qty) || qty <= 0) {
        return res.status(400).json({ message: 'quantity must be a positive integer' });
    }
    const branchName = branch_id == 2 ? 'Accra Branch' : (branch_id == 3 ? 'Kumasi Branch' : 'Main Warehouse');
    const tenantId = req.user.tenant_id || 1;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Locking the product row makes the stock comparison reliable; previously two
        // concurrent scans could both pass the check and oversell.
        const product = await client.query(
            'SELECT id, stock FROM products WHERE barcode = $1 AND tenant_id = $2 FOR UPDATE',
            [barcode, tenantId]
        );
        if (product.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Product not found' });
        }
        const stockBefore = parseInt(product.rows[0].stock, 10) || 0;
        if (stockBefore < qty) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Insufficient stock', available: stockBefore });
        }

        if (batch_id) {
            const batchRes = await client.query(
                'UPDATE product_batches SET quantity_sold = quantity_sold + $1, quantity_available = quantity_available - $1 WHERE id = $2 AND quantity_available >= $1',
                [qty, batch_id]
            );
            if (batchRes.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'Insufficient stock in the selected batch' });
            }
        }

        await client.query(`
            UPDATE products 
            SET stock = COALESCE(stock, 0) - $1,
                stock_levels = jsonb_set(
                    COALESCE(stock_levels, '{}'::jsonb), 
                    ARRAY[$3::text], 
                    to_jsonb(COALESCE((stock_levels->>$3::text)::int, 0) - $1)
                )
            WHERE barcode = $2 AND tenant_id = $4
        `, [qty, barcode, branchName, tenantId]);

        await client.query(`
            INSERT INTO inventory_audit_log (action_type, product_barcode, quantity_before, quantity_after, reference_id, reference_type, user_id, branch_id)
            SELECT 'Sale', $1::varchar, $2, stock, NULL, 'POS Sale', $4, $5 FROM products WHERE barcode = $1
        `, [barcode, stockBefore, qty, req.user.id, branch_id]);
        await client.query('COMMIT');

        await logActivity(req, 'POS_SALE_ITEM', { barcode, quantity: qty, batch_id });
        res.json({ success: true, remaining_stock: stockBefore - qty });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ message: 'Error processing sale' });
    } finally { client.release(); }
});

// ============ SYSTEM SETTINGS ENDPOINTS ============

app.get('/api/settings', authenticateToken, async (req, res) => {
    try {
        const tenantId = req.user.tenant_id || 1;
        // Company portal users always manage the master settings (branch_id=1)
        let branchId = 1;
        if (req.user.type !== 'company') {
            const userRes = await pool.query('SELECT store_id FROM users WHERE id = $1 AND COALESCE(tenant_id, 1) = $2', [req.user.id, tenantId]);
            const dbStoreId = userRes.rows[0]?.store_id;
            branchId = dbStoreId || req.user.store_id || 1;
        }

        let result = await pool.query('SELECT * FROM system_settings WHERE branch_id = $1 AND COALESCE(tenant_id, 1) = $2 LIMIT 1', [branchId, tenantId]);
        if (result.rows.length === 0) {
            result = await pool.query('SELECT * FROM system_settings WHERE COALESCE(tenant_id, 1) = $1 ORDER BY branch_id ASC, id ASC LIMIT 1', [tenantId]);
        }

        res.json(result.rows[0] || {});
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});


app.post('/api/settings', authenticateToken, async (req, res) => {
    // Allow admin, ceo, manager, store_manager, or company users
    const userRole = (req.user.role || '').toLowerCase();
    if (userRole !== 'admin' && userRole !== 'ceo' && req.user.type !== 'company' && userRole !== 'manager' && userRole !== 'store_manager') {
        return res.status(403).json({ message: 'Unauthorized. Only authorized users can change settings.' });
    }

    const tenantId = req.user.tenant_id || 1;
    const {
        storeName, currencySymbol, vatRate, receiptFooter, taxId, phone, monthlyTarget,
        bankName, bankAccountName, bankAccountNumber, bankBranch, momoNumber, momoName,
        address, email, logoUrl
    } = req.body;
    // Company portal users always manage the master settings (branch_id=1)
    const branchId = req.user.type === 'company' ? 1 : (req.user.store_id || 1);

    try {
        const existing = await pool.query(
            'SELECT id FROM system_settings WHERE branch_id = $1 AND COALESCE(tenant_id, 1) = $2 LIMIT 1',
            [branchId, tenantId]
        );
        const vals = [
            storeName || null, currencySymbol || null, vatRate || null, receiptFooter || null,
            taxId || null, phone || null, monthlyTarget || null, bankName || null,
            bankAccountName || null, bankAccountNumber || null, bankBranch || null,
            momoNumber || null, momoName || null, address || null, email || null, logoUrl || null
        ];
        if (existing.rows.length > 0) {
            await pool.query(`
                UPDATE system_settings SET
                    store_name = COALESCE($1, store_name),
                    currency_symbol = COALESCE($2, currency_symbol),
                    vat_rate = COALESCE($3, vat_rate),
                    receipt_footer = COALESCE($4, receipt_footer),
                    tax_id = COALESCE($5, tax_id),
                    phone = COALESCE($6, phone),
                    monthly_target = COALESCE($7, monthly_target),
                    bank_name = COALESCE($8, bank_name),
                    bank_account_name = COALESCE($9, bank_account_name),
                    bank_account_number = COALESCE($10, bank_account_number),
                    bank_branch = COALESCE($11, bank_branch),
                    momo_number = COALESCE($12, momo_number),
                    momo_name = COALESCE($13, momo_name),
                    address = COALESCE($14, address),
                    email = COALESCE($15, email),
                    logo_url = COALESCE($16, logo_url),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $17 AND COALESCE(tenant_id, 1) = $18
            `, [...vals, existing.rows[0].id, tenantId]);
        } else {
            await pool.query(`
                INSERT INTO system_settings (
                    branch_id, tenant_id, store_name, currency_symbol, vat_rate, receipt_footer, tax_id,
                    phone, monthly_target, bank_name, bank_account_name, bank_account_number,
                    bank_branch, momo_number, momo_name, address, email, logo_url, updated_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, CURRENT_TIMESTAMP)
            `, [branchId, tenantId, ...vals]);
        }
        await logActivity(req, 'UPDATE_SETTINGS', { storeName, vatRate });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error saving settings' });
    }
});

// Delete System VAT (Set to 0)
app.delete('/api/settings/vat', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });
    const branchId = req.user.store_id || 1;
    const tenantId = req.user.tenant_id || 1;
    try {
        const upd = await pool.query(
            'UPDATE system_settings SET vat_rate = 0 WHERE branch_id = $1 AND COALESCE(tenant_id, 1) = $2',
            [branchId, tenantId]
        );
        if (upd.rowCount === 0) {
            await pool.query(
                'INSERT INTO system_settings (branch_id, tenant_id, vat_rate) VALUES ($1, $2, 0)',
                [branchId, tenantId]
            );
        }
        await logActivity(req, 'DELETE_SYSTEM_VAT');
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error removing VAT' });
    }
});

// Add Branch Management Endpoints
app.get('/api/branches', authenticateToken, async (req, res) => {
    try {
        const tenantId = req.user.tenant_id || 1;
        // Join with system_settings to get VAT
        const result = await pool.query(`
            SELECT b.*, COALESCE(ss.vat_rate, 0.00) as vat_rate, COALESCE(b.is_main, FALSE) as is_main 
            FROM branches b
            LEFT JOIN system_settings ss ON b.id = ss.branch_id
            WHERE b.deleted_at IS NULL AND COALESCE(b.tenant_id, 1) = $1
            ORDER BY b.id
        `, [tenantId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/branches', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });
    const { name, location, vat_rate, is_main } = req.body;
    const phone = String(req.body.phone || '').trim().slice(0, 50);
    const manager = String(req.body.manager || '').trim().slice(0, 120);
    const status = ['Active', 'Maintenance', 'Closed'].includes(req.body.status) ? req.body.status : 'Active';
    if (!String(name || '').trim()) return res.status(400).json({ message: 'Give the location a name.' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const tenantId = req.user.tenant_id || 1;
        const resBranch = await client.query(
            'INSERT INTO branches (name, location, is_main, tenant_id, phone, manager, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
            [String(name).trim(), location, is_main || false, tenantId, phone, manager, status]
        );
        const branchId = resBranch.rows[0].id;

        // Create settings for this branch with ON CONFLICT (branch_id)
        await client.query(
            `INSERT INTO system_settings (branch_id, store_name, currency_symbol, vat_rate, receipt_footer, tenant_id)
             VALUES ($1, $2, 'GH₵', $3, 'Thank you for shopping with us!', $4)
             ON CONFLICT (branch_id) DO UPDATE SET 
                 store_name = EXCLUDED.store_name, 
                 vat_rate = EXCLUDED.vat_rate, 
                 tenant_id = EXCLUDED.tenant_id`,
            [branchId, name, vat_rate || 0.0, tenantId]
        );

        await client.query('COMMIT');
        await logActivity(req, 'CREATE_BRANCH', { name, branchId });
        res.json({ success: true, id: branchId });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error creating branch:', err);
        res.status(500).json({ message: 'Error creating branch: ' + (err.message || '') });
    } finally { client.release(); }
});

app.put('/api/branches/:id', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });
    const { id } = req.params;
    const { name, location, vat_rate } = req.body;
    if (!String(name || '').trim()) return res.status(400).json({ message: 'Give the location a name.' });
    // Fields the caller leaves out keep their current value (the Locations page does not send VAT).
    const vatProvided = vat_rate !== undefined && vat_rate !== null && vat_rate !== '';
    const phone = req.body.phone === undefined ? null : String(req.body.phone).trim().slice(0, 50);
    const manager = req.body.manager === undefined ? null : String(req.body.manager).trim().slice(0, 120);
    const status = ['Active', 'Maintenance', 'Closed'].includes(req.body.status) ? req.body.status : null;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const tenantId = req.user.tenant_id || 1;
        await client.query(
            'UPDATE branches SET name = $1, location = $2, phone = COALESCE($5, phone), manager = COALESCE($6, manager), status = COALESCE($7, status) WHERE id = $3 AND (tenant_id = $4 OR tenant_id IS NULL)',
            [String(name).trim(), location, id, tenantId, phone, manager, status]
        );

        // Update VAT in settings
        await client.query(`
            INSERT INTO system_settings (branch_id, store_name, currency_symbol, vat_rate, receipt_footer, tenant_id)
            VALUES ($1, $2, 'GH₵', $3, 'Thank you for shopping with us!', $4)
            ON CONFLICT (branch_id) DO UPDATE SET 
                vat_rate = CASE WHEN $5 THEN EXCLUDED.vat_rate ELSE system_settings.vat_rate END,
                store_name = EXCLUDED.store_name,
                tenant_id = EXCLUDED.tenant_id
        `, [id, String(name).trim(), vat_rate || 0.0, tenantId, vatProvided]);

        await client.query('COMMIT');
        await logActivity(req, 'UPDATE_BRANCH', { id, vat_rate });
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error updating branch:', err);
        res.status(500).json({ message: 'Error updating branch: ' + (err.message || '') });
    } finally { client.release(); }
});

// Delete Branch
app.delete('/api/branches/:id', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') {
        return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const branchId = parseInt(req.params.id, 10);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const tenantId = req.user.tenant_id || 1;

        // Ensure this branch belongs to the user's tenant (or tenant_id is null)
        const checkBranch = await client.query('SELECT name, is_main FROM branches WHERE id = $1 AND (tenant_id = $2 OR tenant_id IS NULL)', [branchId, tenantId]);
        if (checkBranch.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Branch not found.' });
        }

        // A company must keep at least one location
        const remaining = await client.query(
            'SELECT COUNT(*)::int AS n FROM branches WHERE deleted_at IS NULL AND id <> $1 AND (tenant_id = $2 OR tenant_id IS NULL)',
            [branchId, tenantId]
        );
        if (remaining.rows[0].n === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'You cannot delete your only location.' });
        }

        // Soft delete: the row and all its history stay in the database, hidden from every list.
        // To bring one back, clear deleted_at on that branch.
        const wasMain = checkBranch.rows[0].is_main;
        await client.query('UPDATE branches SET deleted_at = NOW(), is_main = FALSE WHERE id = $1', [branchId]);

        // If deleted branch was main, promote the first remaining active branch of the same company
        if (wasMain) {
            await client.query(`
                UPDATE branches SET is_main = TRUE
                WHERE id = (SELECT id FROM branches WHERE deleted_at IS NULL AND (tenant_id = $1 OR tenant_id IS NULL) ORDER BY id ASC LIMIT 1)
            `, [tenantId]);
        }

        await client.query('COMMIT');

        await logActivity(req, 'DELETE_BRANCH', { branchId, branchName: checkBranch.rows[0].name });
        res.json({ success: true, message: 'Branch removed. Its history is kept.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Delete Branch Error:', err);

        // If a DB constrained error occurs (e.g. Sales exist pointing to branch ID)
        if (err.code === '23503') {
            return res.status(400).json({ success: false, message: 'Cannot delete branch because historical transaction data or active users are currently tied to it.' });
        }
        res.status(500).json({ success: false, message: 'Server error' });
    } finally {
        client.release();
    }
});

// Get current main branch
app.get('/api/branches/main', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, name, location FROM branches WHERE is_main = TRUE AND deleted_at IS NULL LIMIT 1`
        );
        if (result.rows.length === 0) {
            // Fallback: return branch id=1
            const fallback = await pool.query('SELECT id, name, location FROM branches WHERE id = 1 LIMIT 1');
            return res.json(fallback.rows[0] || { id: 1, name: 'Main Branch', location: 'Main Branch' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Set a branch as the main branch (CEO/admin only)
app.patch('/api/branches/:id/set-main', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') {
        return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const branchId = parseInt(req.params.id, 10);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Verify branch exists and is not deleted
        const check = await client.query(
            'SELECT id, name FROM branches WHERE id = $1 AND deleted_at IS NULL', [branchId]
        );
        if (check.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Branch not found.' });
        }
        // Atomically unset all mains, then set the chosen one
        await client.query('UPDATE branches SET is_main = FALSE WHERE is_main = TRUE');
        await client.query('UPDATE branches SET is_main = TRUE WHERE id = $1', [branchId]);
        await client.query('COMMIT');
        await logActivity(req, 'SET_MAIN_BRANCH', { branchId, branchName: check.rows[0].name });
        res.json({ success: true, message: `"${check.rows[0].name}" is now the main branch.` });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Set Main Branch Error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    } finally {
        client.release();
    }
});

// --- CREDIT AUTHORIZATION CODE ---
const FACTORY_AUTH_CODE = '123456'; // the old built-in default: refused until a manager sets a real one
const safeEqual = (a, b) => {
    const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

app.post('/api/verify-auth-code', authenticateToken, async (req, res) => {
    const { code } = req.body;
    const tenantId = req.user.tenant_id || 1;
    const attemptKey = `authcode:${tenantId}:${req.user.id}`;
    const attempt = await hitCounter(attemptKey, 60000);
    if (attempt.count > 10) {
        return res.status(429).json({ success: false, message: 'Too many authorization attempts. Try again in a minute.' });
    }

    try {
        // Refresh user store_id from DB to ensure accuracy
        const userCheck = await pool.query('SELECT store_id FROM users WHERE id = $1 AND COALESCE(tenant_id, 1) = $2', [req.user.id, tenantId]);
        const dbStoreId = userCheck.rows[0]?.store_id;
        const branchId = dbStoreId || req.user.store_id || 1;

        const inputCode = String(code || '').trim();

        // 1. Check User's Branch (tenant-scoped)
        const branchRes = await pool.query('SELECT credit_auth_code, credit_auth_code_expiry FROM system_settings WHERE branch_id = $1 AND COALESCE(tenant_id, 1) = $2', [branchId, tenantId]);

        // 2. Check Main Branch Fallback (tenant-scoped)
        const mainRes = await pool.query('SELECT credit_auth_code, credit_auth_code_expiry FROM system_settings WHERE branch_id = 1 AND COALESCE(tenant_id, 1) = $1', [tenantId]);

        const checkCode = (row) => {
            if (!row || !row.credit_auth_code) return false;
            const dbCode = String(row.credit_auth_code).trim();

            if (safeEqual(dbCode, inputCode)) {
                if (dbCode === FACTORY_AUTH_CODE) return 'default';
                if (row.credit_auth_code_expiry && new Date() > new Date(row.credit_auth_code_expiry)) {
                    return 'expired';
                }
                return 'valid';
            }
            return false;
        };

        let status = false;
        if (branchRes.rows.length > 0) {
            status = checkCode(branchRes.rows[0]);
        }
        if (status !== 'valid' && branchId !== 1 && mainRes.rows.length > 0) {
            const mainStatus = checkCode(mainRes.rows[0]);
            if (mainStatus === 'valid') status = 'valid';
            else if (mainStatus === 'default' && status !== 'valid') status = 'default';
            else if (mainStatus === 'expired' && status !== 'expired') status = 'expired';
        }

        if (status === 'valid') {
            await clearHits(attemptKey);
            res.json({ success: true });
        } else if (status === 'default') {
            res.status(401).json({ success: false, message: 'The authorization code is still the factory default (123456). A manager must set a new code in Credit Management before it can be used.' });
        } else if (status === 'expired') {
            res.status(401).json({ success: false, message: 'Authorization code has expired' });
        } else {
            res.status(401).json({ success: false, message: 'Invalid authorization code' });
        }
    } catch (err) {
        console.error('[AUTH-VERIFY] Error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.get('/api/settings/auth-code', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    const branchId = req.user.store_id || 1;
    const tenantId = req.user.tenant_id || 1;
    try {
        const result = await pool.query('SELECT credit_auth_code, credit_auth_code_expiry FROM system_settings WHERE branch_id = $1 AND COALESCE(tenant_id, 1) = $2', [branchId, tenantId]);
        if (result.rows.length > 0) {
            res.json(result.rows[0]);
        } else {
            res.json({});
        }
    } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

app.post('/api/settings/auth-code', authenticateToken, requireRole(MANAGER_ROLES), requirePermission('settings', 'edit'), async (req, res) => {
    const tenantId = req.user.tenant_id || 1;
    const userCheck = await pool.query('SELECT store_id FROM users WHERE id = $1 AND COALESCE(tenant_id, 1) = $2', [req.user.id, tenantId]);
    const branchId = userCheck.rows[0]?.store_id || req.user.store_id || 1;

    // Generate 6-digit code and set 24h expiry
    const code = crypto.randomInt(100000, 1000000).toString();
    const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

    try {
        const check = await pool.query('SELECT id FROM system_settings WHERE branch_id = $1 AND COALESCE(tenant_id, 1) = $2', [branchId, tenantId]);

        if (check.rows.length > 0) {
            await pool.query('UPDATE system_settings SET credit_auth_code = $1, credit_auth_code_expiry = $2 WHERE id = $3 AND COALESCE(tenant_id, 1) = $4', [code, expiry, check.rows[0].id, tenantId]);
        } else {
            await pool.query(`
                INSERT INTO system_settings (branch_id, tenant_id, credit_auth_code, credit_auth_code_expiry, store_name, currency_symbol, vat_rate)
                VALUES ($1, $2, $3, $4, 'OKWESIWA LTD', '₵ (GHS)', 0.00)
            `, [branchId, tenantId, code, expiry]);
        }

        await logActivity(req, 'GENERATE_AUTH_CODE');
        res.json({ success: true, code, expiry });
    } catch (err) {
        console.error('[AUTH-GEN] Error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// ============ CUSTOMER MANAGEMENT ENDPOINTS ============

app.get('/api/customers', authenticateToken, async (req, res) => {
    const tenantId = req.user.tenant_id || 1;
    try {
        const result = await pool.query('SELECT * FROM customers WHERE COALESCE(tenant_id, 1) = $1 AND deleted_at IS NULL ORDER BY name', [tenantId]);
        await logActivity(req, 'VIEW_CUSTOMER_LIST');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

app.post('/api/customers', authenticateToken, requireRole(PAGE_ROLES.STAFF_ALL), async (req, res) => {
    const { name, phone, email, creditLimit, status } = req.body;
    const tenantId = req.user.tenant_id || 1;
    try {
        const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [req.user.id]);
        if (userCheck.rows.length === 0) return res.status(401).json({ message: 'User session invalid. Please logout and login again.' });

        if (!name) return res.status(400).json({ message: 'Customer name is required' });

        const limit = Math.max(0, parseFloat(creditLimit) || 0);

        // Restore if a soft-deleted customer with same phone exists in this tenant
        if (phone) {
            const deletedRes = await pool.query(
                'SELECT id, account_number FROM customers WHERE phone = $1 AND COALESCE(tenant_id, 1) = $2 AND deleted_at IS NOT NULL LIMIT 1',
                [phone, tenantId]
            );
            if (deletedRes.rows.length > 0) {
                await pool.query(
                    'UPDATE customers SET name=$1, email=$2, credit_limit=$3, status=$4, deleted_at=NULL WHERE id=$5 AND COALESCE(tenant_id, 1) = $6',
                    [name, email, limit, status || 'Active', deletedRes.rows[0].id, tenantId]
                );
                await logActivity(req, 'RESTORE_CUSTOMER', { name, accountNumber: deletedRes.rows[0].account_number });
                return res.json({ success: true, restored: true, accountNumber: deletedRes.rows[0].account_number });
            }
        }

        const accountNumber = String(Date.now()).slice(-7) + String(crypto.randomInt(100, 999));

        await pool.query(
            'INSERT INTO customers (tenant_id, name, phone, email, credit_limit, account_number, status, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [tenantId, name, phone, email, limit, accountNumber, status || 'Active', req.user.id]
        );
        await logActivity(req, 'CREATE_CUSTOMER', { name, accountNumber });
        res.json({ success: true, accountNumber });
    } catch (err) {
        console.error('Error creating customer:', err);
        res.status(500).json({ message: 'Error creating customer' });
    }
});

app.post('/api/customers/:id/payment', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const tenantId = req.user.tenant_id || 1;
    const paid = parseFloat(req.body.amount);
    if (!Number.isFinite(paid) || paid <= 0) {
        return res.status(400).json({ message: 'amount must be a positive number' });
    }
    const userId = req.user.id;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const curRes = await client.query(
            'SELECT id, current_balance FROM customers WHERE id = $1 AND COALESCE(tenant_id, 1) = $2 AND deleted_at IS NULL FOR UPDATE',
            [id, tenantId]
        );
        if (curRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Customer not found' });
        }
        const currentBal = Number(curRes.rows[0].current_balance || 0);
        if (paid > currentBal + 0.01) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: `Payment exceeds customer balance (owed: GH₵ ${currentBal.toFixed(2)})` });
        }

        const custRes = await client.query(
            'UPDATE customers SET current_balance = GREATEST(0, current_balance - $1) WHERE id = $2 AND COALESCE(tenant_id, 1) = $3 RETURNING current_balance',
            [paid, id, tenantId]
        );
        const newBalance = custRes.rows[0].current_balance;

        // Record Payment for Statement
        await client.query(
            'INSERT INTO customer_payments (customer_id, amount, recorded_by) VALUES ($1, $2, $3)',
            [id, paid, userId]
        );

        // Add to Ledger (Part 2)
        await client.query(
            `INSERT INTO customer_ledger (customer_id, date, description, type, credit, balance) 
             VALUES ($1, NOW(), 'Payment Received', 'PAYMENT', $2, $3)`,
            [id, paid, newBalance]
        );

        await client.query('COMMIT');
        await logActivity(req, 'CUSTOMER_DEBT_PAYMENT', { customerId: id, amount: paid });
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ message: 'Error processing payment' });
    } finally {
        client.release();
    }
});

app.get('/api/customers/:id', authenticateToken, async (req, res) => {
    const tenantId = req.user.tenant_id || 1;
    try {
        const result = await pool.query('SELECT * FROM customers WHERE id = $1 AND COALESCE(tenant_id, 1) = $2 AND deleted_at IS NULL', [req.params.id, tenantId]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'Customer not found' });
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

app.put('/api/customers/:id', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    const { id } = req.params;
    const tenantId = req.user.tenant_id || 1;
    const { name, phone, email, creditLimit } = req.body;

    try {
        const currentRes = await pool.query('SELECT * FROM customers WHERE id = $1 AND COALESCE(tenant_id, 1) = $2 AND deleted_at IS NULL', [id, tenantId]);
        if (currentRes.rows.length === 0) return res.status(404).json({ message: 'Customer not found' });

        const current = currentRes.rows[0];
        const newName = name || current.name;
        const newPhone = phone || current.phone;
        const newEmail = email || current.email;

        let message = 'Customer updated successfully';
        let newLimit = current.credit_limit;

        // Handle Credit Limit Change
        if (creditLimit !== undefined && parseFloat(creditLimit) !== parseFloat(current.credit_limit)) {
            if (req.user.role === 'super_admin' || req.user.role === 'ceo' || req.user.role === 'admin') {
                newLimit = parseFloat(creditLimit);
                await pool.query('UPDATE customers SET name = $1, phone = $2, email = $3, credit_limit = $4, pending_credit_limit = NULL WHERE id = $5 AND COALESCE(tenant_id, 1) = $6', [newName, newPhone, newEmail, newLimit, id, tenantId]);
            } else {
                await pool.query('UPDATE customers SET name = $1, phone = $2, email = $3, pending_credit_limit = $4 WHERE id = $5 AND COALESCE(tenant_id, 1) = $6', [newName, newPhone, newEmail, parseFloat(creditLimit), id, tenantId]);
                message = 'Credit limit increase requested. Sent to CEO for approval.';
            }
        } else {
            await pool.query('UPDATE customers SET name = $1, phone = $2, email = $3 WHERE id = $4 AND COALESCE(tenant_id, 1) = $5', [newName, newPhone, newEmail, id, tenantId]);
        }

        await logActivity(req, 'UPDATE_CUSTOMER', { id, creditLimit: newLimit });
        res.json({ success: true, message });
    } catch (err) { res.status(500).json({ message: 'Error updating customer' }); }
});

app.delete('/api/customers/:id', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    const { id } = req.params;
    const tenantId = req.user.tenant_id || 1;
    const client = await pool.connect();
    try {
        const result = await client.query(
            'UPDATE customers SET deleted_at = NOW() WHERE id = $1 AND COALESCE(tenant_id, 1) = $2 AND deleted_at IS NULL RETURNING id',
            [id, tenantId]
        );

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Customer not found' });
        }

        await client.query('COMMIT');
        await logActivity(req, 'SOFT_DELETE_CUSTOMER', { id });
        res.json({ success: true, message: 'Customer hidden (payment history & records retained for compliance)' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error deleting customer:', err);
        res.status(500).json({ message: 'Error deleting customer: ' + err.message });
    } finally {
        client.release();
    }
});

// --- CUSTOMER STATEMENTS & REPORTING ---

async function getCustomerStatementData(customerId, month, year) {
    const now = new Date();
    const targetYear = year || now.getFullYear();
    const targetMonth = month || (now.getMonth() + 1); // 1-12

    const startDate = `${targetYear}-${targetMonth}-01`;
    // Calculate end date (last day of the month)
    const endDate = new Date(targetYear, targetMonth, 0).toISOString().split('T')[0];

    // Get Customer
    const custRes = await pool.query('SELECT * FROM customers WHERE id = $1 AND deleted_at IS NULL', [customerId]);
    if (custRes.rows.length === 0) throw new Error('Customer not found');
    const customer = custRes.rows[0];

    // Get Purchases (Credit Transactions)
    const purchasesRes = await pool.query(`
        SELECT id, receipt_number, total_amount, created_at, items 
        FROM transactions 
        WHERE customer_id = $1 AND payment_method = 'credit' 
        AND created_at >= $2::date AND created_at <= ($3::date + INTERVAL '1 day')
        ORDER BY created_at ASC
    `, [customerId, startDate, endDate]);

    // Get Payments
    const paymentsRes = await pool.query(`
        SELECT id, amount, payment_date 
        FROM customer_payments 
        WHERE customer_id = $1 
        AND payment_date >= $2::date AND payment_date <= ($3::date + INTERVAL '1 day')
        ORDER BY payment_date ASC
    `, [customerId, startDate, endDate]);

    return { customer, purchases: purchasesRes.rows, payments: paymentsRes.rows, period: { month: targetMonth, year: targetYear } };
}

app.get('/api/customers/:id/statement', authenticateToken, async (req, res) => {
    try {
        const data = await getCustomerStatementData(req.params.id, req.query.month, req.query.year);
        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err.message || 'Error generating statement' });
    }
});

// New endpoint for detailed statement data (with transaction-level debit/credit/balance)
app.get('/api/customers/:id/statement-data', authenticateToken, requireRole(PAGE_ROLES.STAFF_ALL), async (req, res) => {
    try {
        const customerId = req.params.id;
        const month = req.query.month || new Date().getMonth() + 1;
        const year = req.query.year || new Date().getFullYear();

        const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
        const endDate = new Date(year, month, 0).toISOString().split('T')[0];

        // Get Customer
        const custRes = await pool.query('SELECT * FROM customers WHERE id = $1 AND COALESCE(tenant_id, 1) = $2 AND deleted_at IS NULL', [customerId, req.user.tenant_id || 1]);
        if (custRes.rows.length === 0) {
            return res.status(404).json({ message: 'Customer not found' });
        }
        const customer = custRes.rows[0];

        // Get opening balance - all credit purchases minus all payments before this month
        const prevMonthEnd = new Date(year, month - 1, 0).toISOString().split('T')[0];
        const prevBalanceRes = await pool.query(`
            SELECT COALESCE(SUM(debit - credit), 0) as balance 
            FROM customer_ledger 
            WHERE customer_id = $1 AND date <= $2::date
        `, [customerId, prevMonthEnd]);

        const openingBalance = parseFloat(prevBalanceRes.rows[0].balance || 0);

        // Get all transactions for the month from Ledger
        const transactionsRes = await pool.query(`
            SELECT * FROM customer_ledger 
            WHERE customer_id = $1 
            AND date >= $2::date AND date < ($3::date + INTERVAL '1 day')
            ORDER BY date ASC
        `, [customerId, startDate, endDate]);

        // Calculate running balance
        let runningBalance = openingBalance;
        const transactions = transactionsRes.rows.map(t => {
            const debit = parseFloat(t.debit) || 0;
            const credit = parseFloat(t.credit) || 0;
            runningBalance += debit - credit;
            return {
                date: t.date,
                description: t.description,
                debit: debit,
                credit: credit,
                balance: runningBalance
            };
        });

        const closingBalance = runningBalance;

        res.json({
            customer: {
                id: customer.id,
                name: customer.name,
                phone: customer.phone,
                email: customer.email
            },
            openingBalance,
            transactions,
            closingBalance,
            period: { month: parseInt(month), year: parseInt(year) }
        });
    } catch (err) {
        console.error('Error fetching statement data:', err);
        res.status(500).json({ message: err.message || 'Error fetching statement data' });
    }
});

app.post('/api/customers/:id/email-statement', authenticateToken, requireRole(PAGE_ROLES.STAFF_ALL), async (req, res) => {
    try {
        const customerId = req.params.id;
        let { month, year, pdfData: clientPdf } = req.body;

        // Validate and default month/year
        if (!month || !year) {
            const now = new Date();
            month = month || now.getMonth() + 1;
            year = year || now.getFullYear();
        }

        // Validate month and year ranges
        month = parseInt(month);
        year = parseInt(year);

        if (isNaN(month) || month < 1 || month > 12) {
            return res.status(400).json({ message: 'Invalid month. Please provide month between 1 and 12' });
        }

        if (isNaN(year) || year < 2020 || year > new Date().getFullYear() + 1) {
            return res.status(400).json({ message: 'Invalid year' });
        }


        // Calculate month name (needed for PDF and email)
        const monthName = new Date(year, month - 1).toLocaleString('default', { month: 'long' });

        // Get detailed statement data for PDF
        const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
        const endDate = new Date(year, month, 0).toISOString().split('T')[0];

        // Get Customer
        const custRes = await pool.query('SELECT * FROM customers WHERE id = $1 AND COALESCE(tenant_id, 1) = $2 AND deleted_at IS NULL', [customerId, req.user.tenant_id || 1]);
        if (custRes.rows.length === 0) {
            return res.status(404).json({ message: 'Customer not found' });
        }
        const customer = custRes.rows[0];
        const customerName = customer.name;

        if (!customer.email) return res.status(400).json({ message: 'Customer has no email address' });

        // Use current balance for "Amount Used" display (all-time debt)
        const amountUsed = parseFloat(customer.current_balance || 0);

        let pdfData;

        // Always use server-side PDF generation for accuracy
        {

            // 1. REBUILD LEDGER FOR THIS CUSTOMER inside a transaction
            // Wrapped in BEGIN/COMMIT so a crash between DELETE and INSERT can't wipe the ledger
            const ledgerClient = await pool.connect();
            try {
                await ledgerClient.query('BEGIN');

                await ledgerClient.query('DELETE FROM customer_ledger WHERE customer_id = $1', [customerId]);

                // Insert Sales (Credit Transactions)
                await ledgerClient.query(`
                    INSERT INTO customer_ledger (customer_id, date, description, type, debit, credit, transaction_id)
                    SELECT customer_id, created_at, COALESCE(receipt_number, 'TRX') || ' (Sale)', 'SALE', total_amount, 0, id
                    FROM transactions 
                    WHERE customer_id = $1 AND status = 'completed'
                `, [customerId]);

                // Insert Payments
                await ledgerClient.query(`
                    INSERT INTO customer_ledger (customer_id, date, description, type, debit, credit)
                    SELECT customer_id, payment_date, 'Payment Received', 'PAYMENT', 0, amount 
                    FROM customer_payments 
                    WHERE customer_id = $1
                `, [customerId]);

                await ledgerClient.query('COMMIT');
            } catch (ledgerErr) {
                await ledgerClient.query('ROLLBACK');
                throw new Error('Failed to rebuild customer ledger: ' + ledgerErr.message);
            } finally {
                ledgerClient.release();
            }

            // 2. CALCULATE OPENING BALANCE
            // Sum of all activity BEFORE the start date
            const openBalRes = await pool.query(`
                SELECT COALESCE(SUM(debit - credit), 0) as balance 
                FROM customer_ledger 
                WHERE customer_id = $1 AND date < $2::date
            `, [customerId, startDate]);
            const openingBalance = parseFloat(openBalRes.rows[0].balance || 0);

            // 3. FETCH STATEMENT TRANSACTIONS
            // Get ledger entries for the month, joined with transactions to get item details
            const ledgerRes = await pool.query(`
                SELECT cl.*, t.items
                FROM customer_ledger cl
                LEFT JOIN transactions t ON cl.transaction_id = t.id
                WHERE cl.customer_id = $1 
                AND cl.date >= $2::date AND cl.date <= $3::date::date + INTERVAL '1 day' - INTERVAL '1 second'
                ORDER BY cl.date ASC, cl.id ASC
            `, [customerId, startDate, endDate]);


            // Fetch VAT rate from system settings
            let vatRate = 0.0; // Default VAT rate
            try {
                const vatRes = await pool.query('SELECT vat_rate FROM system_settings WHERE branch_id = 1 LIMIT 1');
                if (vatRes.rows.length > 0) {
                    vatRate = parseFloat(vatRes.rows[0].vat_rate);
                }
            } catch (e) {
                console.warn('Could not fetch VAT rate, using default 15%');
            }

            // Generate PDF with password protection
            const pdfPromise = new Promise((resolve, reject) => {
                try {
                    const pdfBuffer = [];

                    const doc = new PDFDocument({
                        size: 'A4',
                        margin: 50,
                        permissions: {
                            printing: 'highResolution',
                            modifying: false,
                            copying: false
                        }
                    });

                    // Collect PDF output
                    doc.on('data', (chunk) => pdfBuffer.push(chunk));
                    doc.on('end', () => {
                        resolve(Buffer.concat(pdfBuffer));
                    });

                    doc.on('error', (err) => {
                        reject(err);
                    });

                    // ===== BUILD PDF =====

                    // Header
                    doc.fontSize(18).font('Helvetica-Bold').fillColor('#1a2a6c').text('CUSTOMER STATEMENT', { align: 'center' });
                    doc.fontSize(11).font('Helvetica').fillColor('#666').text(`${monthName} ${year}`, { align: 'center' });
                    doc.moveDown(0.5);

                    // Account Details Section
                    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1a2a6c').text('ACCOUNT DETAILS', { underline: true });
                    doc.fontSize(9).font('Helvetica').fillColor('#000');

                    const creditAvailable = parseFloat(customer.credit_limit) - amountUsed;

                    const detailsBox = [
                        ['Customer Name:', customer.name],
                        ['Account Number:', customer.account_number || `#${customer.id}`],
                        ['Phone Number:', customer.phone || 'N/A'],
                        ['Statement Date:', new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })]
                    ];

                    detailsBox.forEach(([label, value]) => {
                        doc.text(`${label} ${value}`);
                    });
                    doc.moveDown(0.5);

                    // Summary Box with credit information
                    const summaryY = doc.y;
                    doc.rect(50, summaryY, 495, 85).stroke('#1a2a6c');

                    doc.fontSize(10).font('Helvetica-Bold').fillColor('#fff').rect(50, summaryY, 495, 20).fill('#1a2a6c');
                    doc.fillColor('#fff').text('ACCOUNT SUMMARY', 60, summaryY + 3);

                    doc.fontSize(9).font('Helvetica').fillColor('#000').text(`Credit Limit`, 60, summaryY + 25);
                    doc.fontSize(10).font('Helvetica-Bold').text(`GHS ${parseFloat(customer.credit_limit).toFixed(2)}`, 280, summaryY + 25);

                    doc.fontSize(9).font('Helvetica').text(`Amount Owed`, 60, summaryY + 40);
                    doc.fontSize(10).font('Helvetica-Bold').fillColor('#c62828').text(`GHS ${amountUsed.toFixed(2)}`, 280, summaryY + 40);

                    doc.fontSize(9).font('Helvetica').fillColor('#000').text(`Available Credit`, 60, summaryY + 55);
                    doc.fontSize(10).font('Helvetica-Bold').fillColor('#27ae60').text(`GHS ${creditAvailable.toFixed(2)}`, 280, summaryY + 55);

                    doc.fillColor('#000');
                    doc.y = summaryY + 90;
                    doc.moveDown(0.3);

                    // Item-based Table Header
                    const tableY = doc.y;
                    const tableX = 50;
                    const pageWidth = doc.page.width - 100;

                    // International Statement Title - aligned to the left
                    doc.fontSize(13).font('Helvetica-Bold').fillColor('#1a2a6c').text('STATEMENT OF PURCHASES', tableX, tableY, { width: pageWidth, align: 'left' });
                    doc.moveDown(0.4);

                    doc.rect(tableX, tableY, pageWidth, 18).fill('#1a2a6c');

                    // Table Headers - International style
                    doc.fontSize(9).font('Helvetica-Bold').fillColor('#fff');
                    doc.text('Date', tableX + 5, tableY + 2, { width: 60 });
                    doc.text('Item Description', tableX + 70, tableY + 2, { width: 210 });
                    doc.text('Qty', tableX + 290, tableY + 2, { width: 40, align: 'center' });
                    doc.text('Amount', tableX + 340, tableY + 2, { width: 80, align: 'right' });

                    doc.y = tableY + 20;

                    // Collect all items from all transactions for clean display
                    let allItems = [];
                    let totalAmount = 0;

                    // 1. Add Opening Balance Row if exists
                    if (Math.abs(openingBalance) > 0.01) {
                        allItems.push({
                            date: '',
                            name: 'Opening Balance (Previous Debt)',
                            qty: '-',
                            total: openingBalance,
                            isBold: true
                        });
                        totalAmount += openingBalance;
                    }

                    ledgerRes.rows.forEach((t) => {
                        const txnDate = new Date(t.date); // Ledger date
                        const formattedDate = txnDate.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });

                        if (t.type === 'PAYMENT') {
                            // Handle Payments
                            const amount = parseFloat(t.credit);
                            allItems.push({
                                date: formattedDate,
                                name: 'Payment Received',
                                qty: '-',
                                total: -amount, // Negative to reduce debt
                                isPayment: true
                            });
                            totalAmount -= amount;
                        } else if (t.type === 'SALE') {
                            let itemsArray = t.items;
                            if (typeof t.items === 'string') {
                                try {
                                    itemsArray = JSON.parse(t.items);
                                } catch (e) {
                                    itemsArray = [];
                                }
                            }

                            if (Array.isArray(itemsArray) && itemsArray.length > 0) {
                                itemsArray.forEach((item) => {
                                    const qty = parseFloat(item.quantity || item.qty || 0);
                                    const price = parseFloat(item.price || item.unit_price || 0);
                                    const subtotal = qty * price;
                                    // Calculate tax on the item (VAT is typically added on top)
                                    const taxAmount = subtotal * (vatRate / 100);
                                    const itemTotal = subtotal + taxAmount;
                                    totalAmount += itemTotal;

                                    allItems.push({
                                        date: formattedDate,
                                        name: item.name || item.product_name || 'Item',
                                        qty: qty,
                                        price: price,
                                        subtotal: subtotal,
                                        tax: taxAmount,
                                        total: itemTotal
                                    });
                                });
                            } else {
                                // Fallback for transactions with no items (Legacy/Manual)
                                const txnTotal = parseFloat(t.debit || 0);
                                totalAmount += txnTotal;
                                allItems.push({
                                    date: formattedDate,
                                    name: t.description || 'Transaction (No details)',
                                    qty: '-',
                                    total: txnTotal,
                                    isBold: false
                                });
                            }
                        }
                    });

                    // Display all items in clean international format
                    doc.fontSize(8).font('Helvetica').fillColor('#000');
                    let rowIdx = 0;

                    allItems.forEach((item) => {
                        if (doc.y > 700) {
                            doc.addPage();
                        }

                        const rowBg = rowIdx % 2 === 0 ? '#ffffff' : '#f8f8f8';
                        const itemY = doc.y;

                        doc.fillColor(rowBg).rect(tableX, itemY, pageWidth, 16).fill();
                        doc.rect(tableX, itemY, pageWidth, 16).stroke('#e8e8e8');

                        doc.fillColor(item.isPayment ? '#27ae60' : '#000').fontSize(8).font(item.isBold ? 'Helvetica-Bold' : 'Helvetica');
                        doc.text(item.date, tableX + 5, itemY + 3, { width: 60 });
                        doc.text(item.name.substring(0, 45), tableX + 70, itemY + 3, { width: 210 });
                        doc.text(item.qty.toString(), tableX + 290, itemY + 3, { width: 40, align: 'center' });

                        doc.fillColor('#1a2a6c').font('Helvetica-Bold');
                        if (item.isPayment) doc.fillColor('#27ae60'); // Green for payments
                        doc.text(`GHS ${Math.abs(item.total).toFixed(2)} ${item.isPayment ? '(CR)' : ''}`, tableX + 340, itemY + 3, { width: 80, align: 'right' });

                        doc.y = itemY + 17;
                        rowIdx++;
                    });

                    // Total Summary Row
                    if (doc.y > 680) {
                        doc.addPage();
                    }
                    const totalY = doc.y;
                    doc.fillColor('#1a2a6c').rect(tableX, totalY, pageWidth, 20).fill();
                    doc.fillColor('#fff').fontSize(9).font('Helvetica-Bold');
                    doc.text('CLOSING BALANCE', tableX + 5, totalY + 2, { width: 325 });
                    doc.fontSize(11).text(`GHS ${totalAmount.toFixed(2)}`, tableX + 340, totalY + 2, { width: 80, align: 'right' });

                    doc.y = totalY + 30;
                    doc.moveDown(0.5);

                    // Footer
                    doc.fontSize(9).font('Helvetica').fillColor('#1a2a6c').text('Thank you for your business.', { align: 'center' });
                    doc.fontSize(8).fillColor('#999').text('For account enquiries, please contact us at accounts@okwesiwa.com', { align: 'center' });

                    doc.end();
                } catch (err) {
                    reject(err);
                }
            });

            // Wait for PDF to be generated
            pdfData = await pdfPromise;
        }

        // Prepare email with PDF attachment
        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: process.env.SMTP_PORT,
            secure: process.env.SMTP_SECURE === 'true',
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        });


        const emailHtml = `
            <div style="font-family: 'Arial', sans-serif; line-height: 1.6; color: #333; max-width: 600px;">
                <div style="background: linear-gradient(135deg, #1a2a6c, #b21f1f); padding: 30px; border-radius: 8px 8px 0 0; color: white; text-align: center;">
                    <h1 style="margin: 0; font-size: 28px;">OKWESIWA LTD</h1>
                    <p style="margin: 10px 0 0 0; font-size: 14px; opacity: 0.9;">Account Statement</p>
                </div>
                
                <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; border: 1px solid #e0e0e0;">
                    <p style="font-size: 14px; margin-bottom: 20px;">Dear <strong>${customer.name}</strong>,</p>
                    
                    <p style="font-size: 14px; margin-bottom: 20px;">
                        Please find attached your account statement for <strong style="color: #1a2a6c;">${monthName} ${year}</strong>.
                    </p>
                    
                    <div style="background: white; padding: 20px; border-left: 4px solid #b21f1f; margin: 20px 0; border-radius: 4px;">
                        <div style="display: flex; justify-content: space-between; margin-bottom: 15px;">
                            <span style="font-size: 13px; color: #666;">Credit Limit:</span>
                            <span style="font-size: 14px; font-weight: bold;">GHS ${parseFloat(customer.credit_limit).toFixed(2)}</span>
                        </div>
                            <div style="display: flex; justify-content: space-between; margin-bottom: 15px;">
                            <span style="font-size: 13px; color: #666;">Amount Used:</span>
                            <span style="font-size: 14px; font-weight: bold; color: #c62828;">GHS ${amountUsed.toFixed(2)}</span>
                        </div>
                        <div style="display: flex; justify-content: space-between; margin-bottom: 15px;">
                            <span style="font-size: 13px; color: #666;">Available Credit:</span>
                            <span style="font-size: 14px; font-weight: bold; color: #27ae60;">GHS ${(parseFloat(customer.credit_limit) - amountUsed).toFixed(2)}</span>
                        </div>
                    </div>
                    
                    <p style="font-size: 13px; color: #666; margin: 25px 0 15px 0;">
                        If you have any questions regarding your statement or account, please don't hesitate to contact us.
                    </p>
                    
                    <p style="font-size: 13px; color: #666; margin: 15px 0;">
                        <strong>Contact Us:</strong><br>
                        Phone: +233 (0) XXX XXX XXX<br>
                        Email: accounts@okwesiwa.com
                    </p>
                    
                    <p style="font-size: 12px; color: #999; margin-top: 30px; border-top: 1px solid #eee; padding-top: 20px;">
                        This is an automated message. Please do not reply to this email.<br>
                        © 2026 OKWESIWA LTD. All rights reserved.
                    </p>
                </div>
            </div>
        `;

        const mailOptions = {
            from: `"OKWESIWA LTD Accounts" <${process.env.ADMIN_EMAIL}>`,
            to: customer.email,
            subject: `Account Statement - ${monthName} ${year}`,
            html: emailHtml,
            attachments: [{
                filename: `Statement_${monthName}_${year}_${customer.name.replace(/\s+/g, '_')}.pdf`,
                content: pdfData,
                contentType: 'application/pdf'
            }]
        };

        const info = await transporter.sendMail(mailOptions);

        await logActivity(req, 'EMAIL_STATEMENT', { customerId: req.params.id, month, year, messageId: info.messageId });
        res.json({
            success: true,
            message: 'Statement emailed successfully to ' + customer.email,
            details: {
                recipient: customer.email,
                month: monthName,
                year: year,
                messageId: info.messageId
            }
        });
    } catch (err) {
        console.error('❌ Email Statement Error:', err.message);
        console.error('Stack:', err.stack);

        // Provide specific error messages
        let errorMessage = 'Error sending statement: ' + err.message;
        let errorCode = 'STATEMENT_ERROR';

        if (err.message.includes('SMTP') || err.message.includes('connect')) {
            errorMessage = 'Email configuration error. Please check SMTP settings.';
            errorCode = 'SMTP_CONFIG_ERROR';
        } else if (err.message.includes('Authentication')) {
            errorMessage = 'Email authentication failed. Please check SMTP credentials.';
            errorCode = 'SMTP_AUTH_ERROR';
        } else if (err.message.includes('Customer not found')) {
            errorMessage = 'Customer not found';
            errorCode = 'CUSTOMER_NOT_FOUND';
        } else if (err.message.includes('no email')) {
            errorMessage = 'Customer does not have an email address on file';
            errorCode = 'NO_CUSTOMER_EMAIL';
        }

        res.status(500).json({
            success: false,
            message: errorMessage,
            code: errorCode,
            details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    }
});

// Reset Password Route (after email confirmation)
app.post('/api/reset-password', authLimiter, async (req, res) => {
    const { token, newPassword } = req.body;

    try {
        // Hash the token from the user to compare with the stored hashed token
        const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

        // 1. Validate token and expiry
        const userRes = await pool.query(
            'SELECT id FROM users WHERE reset_token = $1 AND reset_token_expiry > NOW()',
            [hashedToken]
        );

        if (userRes.rows.length === 0) {
            return res.status(400).json({ message: 'Invalid or expired reset link. Please try again.' });
        }

        const userId = userRes.rows[0].id;

        // 2. Hash new password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        // 3. Update password and clear reset token fields
        await pool.query(
            'UPDATE users SET password = $1, reset_token = NULL, reset_token_expiry = NULL WHERE id = $2',
            [hashedPassword, userId]
        );

        // Log activity
        await logActivity({ user: { id: userId } }, 'PASSWORD_RESET_CONFIRMED', { userId });

        res.json({ success: true, message: 'Password has been reset successfully.' });

    } catch (error) {
        console.error('Password reset confirmation error:', error);
        res.status(500).json({ message: 'Error resetting password. Please try again.' });
    }
});

// ============ MODULAR FOUNDATION ROUTES (Roles, Audit, Backups, POS) ============
const rolesRouter = require('./routes/roles');
const auditRouter = require('./routes/audit');
const { router: backupsRouter, startNightlyBackupScheduler } = require('./routes/backups');
const posRouter = require('./routes/pos');
const dailyCloseRouter = require('./routes/daily-close');
const coreReportsRouter = require('./routes/reports-core');
const catalogOpsRouter = require('./routes/catalog-ops');
const allReportsRouter = require('./routes/reports-all');
const ceoLiveRouter = require('./routes/ceo-live');
const extrasRouter = require('./routes/extras');
const businessConfigRouter = require('./routes/business-config');
const expensesRouter = require('./routes/expenses');
const accountingRouter = require('./routes/accounting');
const payrollRouter = require('./routes/payroll');
app.use(rolesRouter);
app.use(businessConfigRouter);
app.use(expensesRouter);
app.use(accountingRouter);
app.use(payrollRouter);
app.use(auditRouter);
app.use(backupsRouter);
app.use(posRouter);
app.use(dailyCloseRouter);
app.use(coreReportsRouter);
app.use(catalogOpsRouter);
app.use(allReportsRouter);
app.use(ceoLiveRouter);
app.use(extrasRouter);

// ============ TAX MANAGEMENT (CEO Portal) ============

// Get active tax rules (Public for POS - isolated per branch)
app.get('/api/taxes/active', authenticateToken, async (req, res) => {
    try {
        const branchId = req.user.store_id || 1;
        const userType = req.user.type || 'staff';

        // 1. Fetch Additional Taxes
        const tenantId = req.user.tenant_id || 1;
        let query = "SELECT id, name, rate FROM tax_rules WHERE status = 'Active' AND branch_id = $1 AND COALESCE(tenant_id, 1) = $2 AND deleted_at IS NULL ORDER BY name ASC";
        let params = [branchId, tenantId];

        // Refined Isolation: Global taxes (Branch 1) flow to ALL physical branches of the same company but NOT to Company Portals
        if (userType !== 'company') {
            query = "SELECT id, name, rate FROM tax_rules WHERE status = 'Active' AND (branch_id = $1 OR branch_id = 1) AND COALESCE(tenant_id, 1) = $2 AND deleted_at IS NULL ORDER BY name ASC";
        }

        const rulesRes = await pool.query(query, params);
        let rules = rulesRes.rows;

        // 2. Fetch System VAT (for consistency with POS expectations)
        let settingsRes = await pool.query("SELECT vat_rate FROM system_settings WHERE branch_id = $1 AND COALESCE(tenant_id, 1) = $2", [branchId, tenantId]);
        if (settingsRes.rows.length === 0) {
            settingsRes = await pool.query("SELECT vat_rate FROM system_settings WHERE COALESCE(tenant_id, 1) = $1 ORDER BY branch_id ASC LIMIT 1", [tenantId]);
        }

        const vatRate = settingsRes.rows.length > 0 ? parseFloat(settingsRes.rows[0].vat_rate) : 0;

        // 3. Combine (add VAT if it's not already explicitly in the list)
        if (vatRate > 0 && !rules.some(r => r.name.toUpperCase() === 'VAT')) {
            rules.unshift({ id: 'vat', name: 'VAT', rate: vatRate, status: 'Active' });
        }

        res.json(rules);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get all tax rules for Management (isolated per portal)
app.get('/api/taxes', authenticateToken, async (req, res) => {
    // Allow admin, ceo, or company users
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo' && req.user.type !== 'company') {
        return res.status(403).json({ message: 'Unauthorized' });
    }

    try {
        const branchId = req.user.store_id || 1;
        const userType = req.user.type || 'staff';

        let query = 'SELECT * FROM tax_rules WHERE branch_id = $1 AND COALESCE(tenant_id, 1) = $2 AND deleted_at IS NULL ORDER BY created_at DESC';
        let params = [branchId, req.user.tenant_id || 1];

        // Management Isolation: CEO/Admin can see all of their own company's tax rules (never another company's)
        if (userType !== 'company' && (req.user.role === 'super_admin' || req.user.role === 'ceo' || req.user.role === 'admin')) {
            query = 'SELECT * FROM tax_rules WHERE COALESCE(tenant_id, 1) = $1 AND deleted_at IS NULL ORDER BY created_at DESC';
            params = [req.user.tenant_id || 1];
        }

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Add tax rule (auto-assign to current branch/portal)
app.post('/api/taxes', authenticateToken, async (req, res) => {
    // Allow admin, ceo, or company users
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo' && req.user.type !== 'company') {
        return res.status(403).json({ message: 'Unauthorized' });
    }

    const { name, rate } = req.body;
    try {
        const branchId = req.user.store_id || 1;
        const tenantId = req.user.tenant_id || 1;
        // Restore if soft-deleted tax rule with same name exists for this branch
        const deletedRes = await pool.query(
            'SELECT id FROM tax_rules WHERE name = $1 AND branch_id = $2 AND COALESCE(tenant_id, 1) = $3 AND deleted_at IS NOT NULL LIMIT 1',
            [name, branchId, tenantId]
        );
        if (deletedRes.rows.length > 0) {
            await pool.query(
                'UPDATE tax_rules SET rate = $1, deleted_at = NULL, status = $2 WHERE id = $3',
                [rate, 'Active', deletedRes.rows[0].id]
            );
            await logActivity(req, 'RESTORE_TAX_RULE', { name, rate, branchId });
            return res.json({ success: true, restored: true });
        }
        await pool.query('INSERT INTO tax_rules (name, rate, branch_id, tenant_id) VALUES ($1, $2, $3, $4)', [name, rate, branchId, tenantId]);
        await logActivity(req, 'CREATE_TAX_RULE', { name, rate, branchId });
        res.json({ success: true });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ message: `Tax rule "${name}" already exists.` });
        console.error(err);
        res.status(500).json({ message: 'Error creating tax rule' });
    }
});

// Update tax rule
app.put('/api/taxes/:id', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });
    const { id } = req.params;
    const { name, rate, status } = req.body;
    try {
        const upd = await pool.query(
            'UPDATE tax_rules SET name = COALESCE($1, name), rate = COALESCE($2, rate), status = COALESCE($3, status) WHERE id = $4 AND COALESCE(tenant_id, 1) = $5',
            [name, rate, status, id, req.user.tenant_id || 1]
        );
        if (upd.rowCount === 0) return res.status(404).json({ message: 'Tax rule not found.' });
        await logActivity(req, 'UPDATE_TAX_RULE', { id, name, rate, status });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error updating tax rule' });
    }
});

// Delete tax rule
app.delete('/api/taxes/:id', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });
    const { id } = req.params;
    try {
        // Soft delete: tax rule hidden but retained for historical transaction accuracy
        const del = await pool.query('UPDATE tax_rules SET deleted_at = NOW() WHERE id = $1 AND COALESCE(tenant_id, 1) = $2', [id, req.user.tenant_id || 1]);
        if (del.rowCount === 0) return res.status(404).json({ message: 'Tax rule not found.' });
        await logActivity(req, 'DELETE_TAX_RULE', { id });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error deleting tax rule' });
    }
});

// Calculate Tax Liability Report
app.get('/api/ceo/tax-report', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && req.user.role !== 'ceo') return res.status(403).json({ message: 'Unauthorized' });

    const { startDate, endDate, branch } = req.query;

    try {
        // 1. Get Active Tax Rules (for Columns) - only this company's rules
        const tenantId = req.user.tenant_id || 1;
        const branchId = req.user.store_id || 1;
        const rulesRes = await pool.query(
            "SELECT * FROM tax_rules WHERE status = 'Active' AND deleted_at IS NULL AND COALESCE(tenant_id, 1) = $2 AND (branch_id = $1 OR branch_id = 1) ORDER BY created_at DESC",
            [branchId, tenantId]
        );
        const activeRules = rulesRes.rows;

        // Fetch System VAT (Default to Branch 1)
        const settingsRes = await pool.query(
            "SELECT vat_rate FROM system_settings WHERE COALESCE(tenant_id, 1) = $1 ORDER BY branch_id ASC LIMIT 1",
            [tenantId]
        );
        const systemVat = settingsRes.rows.length > 0 ? parseFloat(settingsRes.rows[0].vat_rate) : 0.0;

        // Define Report Columns (VAT + Active Rules)
        // Using 'VAT' to match POS storage naming
        const reportRules = [{ name: 'VAT', rate: systemVat }, ...activeRules];

        // 2. Build Transaction Query
        let whereClause = "LOWER(status) = 'completed' AND COALESCE(tenant_id, 1) = $1";
        let params = [tenantId];

        if (startDate && endDate) {
            whereClause += ` AND created_at >= $${params.length + 1} AND created_at <= $${params.length + 2}::date + INTERVAL '1 day' - INTERVAL '1 second'`;
            params.push(startDate, endDate);
        }

        if (branch && branch !== 'All Branches') {
            whereClause += ` AND (LOWER(store_location) = LOWER($${params.length + 1}) OR store_location ILIKE '%' || $${params.length + 1} || '%')`;
            params.push(branch);
        }

        // 3. Aggregate Data from Transactions
        const txRes = await pool.query(`
            SELECT 
                COALESCE(store_location, 'Main Branch') as branch,
                total_amount,
                tax_breakdown
            FROM transactions
            WHERE ${whereClause}
        `, params);

        const branchData = {};
        const initBranch = (b) => { if (!branchData[b]) branchData[b] = { gross: 0, taxes: {} }; };

        txRes.rows.forEach(row => {
            const b = row.branch;
            const gross = parseFloat(row.total_amount) || 0;
            initBranch(b);
            branchData[b].gross += gross;

            let breakdown = row.tax_breakdown;
            if (typeof breakdown === 'string') {
                try { breakdown = JSON.parse(breakdown); } catch (e) { breakdown = []; }
            }

            if (Array.isArray(breakdown) && breakdown.length > 0) {
                breakdown.forEach(elem => {
                    const tName = elem.name || 'VAT';
                    const tAmt = parseFloat(elem.amount) || 0;
                    branchData[b].taxes[tName] = (branchData[b].taxes[tName] || 0) + tAmt;
                });
            } else if (systemVat > 0) {
                // If System VAT is configured, calculate VAT portion
                const net = gross / (1 + (systemVat / 100));
                const vat = gross - net;
                branchData[b].taxes['VAT'] = (branchData[b].taxes['VAT'] || 0) + vat;
            }
        });

        // 4. Format Output
        const report = Object.keys(branchData).map(bName => {
            const data = branchData[bName];
            const totalTax = Object.values(data.taxes).reduce((a, b) => a + b, 0);
            const netRevenue = data.gross - totalTax;

            // Map to columns defined in reportRules
            const breakdown = reportRules.map(rule => ({
                name: rule.name,
                rate: rule.rate,
                amount: data.taxes[rule.name] || 0
            }));

            return {
                branch: bName,
                grossRevenue: data.gross,
                netRevenue: netRevenue,
                totalTax: totalTax,
                breakdown: breakdown
            };
        });

        await logActivity(req, 'GENERATE_TAX_REPORT', { startDate, endDate, branch });

        res.json({
            period: { start: startDate || 'Month Start', end: endDate || 'Now' },
            rules: reportRules,
            report: report
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error generating tax report' });
    }
});

// ============ COMPANY PORTAL ENDPOINTS ============

const COMPANY_PORTAL_ROLES = ['super_admin', 'ceo', 'admin', 'manager', 'store_manager', 'business_client', 'company'];

// Company Dashboard Data
app.get('/api/company/dashboard', authenticateToken, requireRole(COMPANY_PORTAL_ROLES), async (req, res) => {
    try {
        const companyId = req.user.id;
        const tenantId = req.user.tenant_id || 1;

        // Get dashboard statistics including credit metrics (scoped to tenant)
        const [proformaResult, salesResult, revenueResult, balanceResult, draftProformaResult, creditResult] = await Promise.all([
            pool.query('SELECT COUNT(*) as count FROM proforma_invoices WHERE created_by = $1', [companyId]),
            pool.query('SELECT COUNT(*) as count FROM sales_invoices WHERE created_by = $1', [companyId]),
            pool.query('SELECT COALESCE(SUM(total_amount), 0) as total FROM sales_invoices WHERE created_by = $1', [companyId]),
            pool.query('SELECT COALESCE(SUM(total_amount - paid_amount), 0) as total FROM sales_invoices WHERE created_by = $1 AND status != $2', [companyId, 'Paid']),
            pool.query("SELECT COUNT(*) as count FROM proforma_invoices WHERE created_by = $1 AND status ILIKE 'Draft'", [companyId]),
            pool.query(`
                SELECT 
                    COALESCE(SUM(current_balance), 0) as total_owed,
                    COALESCE(SUM(credit_limit), 0) as total_limit,
                    COUNT(*) FILTER (WHERE current_balance > 0) as active_debtors
                FROM customers
                WHERE COALESCE(tenant_id, 1) = $1 AND deleted_at IS NULL
            `, [tenantId])
        ]);

        // Get recent activity
        const recentQuery = `
            SELECT 'Proforma' as type, invoice_number, issue_date as date, total_amount as amount, status
            FROM proforma_invoices 
            WHERE created_by = $1
            UNION ALL
            SELECT 'Sales' as type, invoice_number, issue_date as date, total_amount as amount, status
            FROM sales_invoices 
            WHERE created_by = $1
            ORDER BY date DESC 
            LIMIT 10
        `;
        const recentResult = await pool.query(recentQuery, [companyId]);

        const totalOwed = parseFloat(creditResult.rows[0].total_owed);
        const totalLimit = parseFloat(creditResult.rows[0].total_limit);
        const usageRate = totalLimit > 0 ? (totalOwed / totalLimit) * 100 : 0;

        res.json({
            totalProforma: parseInt(proformaResult.rows[0].count),
            totalSales: parseInt(salesResult.rows[0].count),
            totalRevenue: parseFloat(revenueResult.rows[0].total),
            outstandingBalance: parseFloat(balanceResult.rows[0].total),
            pendingPayments: parseInt(draftProformaResult.rows[0].count),
            totalCreditOwed: totalOwed,
            creditUsageRate: usageRate.toFixed(1),
            activeDebtors: parseInt(creditResult.rows[0].active_debtors),
            recentActivity: recentResult.rows
        });

    } catch (error) {
        console.error('Company dashboard error:', error);
        res.status(500).json({ message: 'Error loading dashboard data' });
    }
});

// Get Proforma Invoices
app.get('/api/company/proforma-invoices', authenticateToken, requireRole(COMPANY_PORTAL_ROLES), async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM proforma_invoices WHERE created_by = $1 ORDER BY issue_date DESC',
            [req.user.id]
        );

        res.json(result.rows);

    } catch (error) {
        console.error('Proforma invoices error:', error);
        res.status(500).json({ message: 'Error loading proforma invoices' });
    }
});

// Create Proforma Invoice
app.post('/api/company/proforma-invoices', authenticateToken, requireRole(COMPANY_PORTAL_ROLES), async (req, res) => {
    try {
        const tenantId = req.user.tenant_id || 1;
        const {
            invoice_number, expiry_date, items, subtotal,
            markup_type, markup_value, markup_amount,
            discount_type, discount_value, discount_amount,
            total_amount, notes
        } = req.body;

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            // Get company ID scoped to tenant
            const companyResult = await client.query(
                'SELECT id FROM companies WHERE COALESCE(tenant_id, 1) = $1 ORDER BY id LIMIT 1',
                [tenantId]
            );
            if (!companyResult.rows.length) {
                await client.query('ROLLBACK');
                return res.status(404).json({ message: 'Company profile not found for this tenant' });
            }
            const companyId = req.user.company_id || companyResult.rows[0].id;

            // Create proforma invoice
            const proformaResult = await client.query(`
                INSERT INTO proforma_invoices (
                    tenant_id, company_id, invoice_number, issue_date, expiry_date,
                    subtotal, markup_type, markup_value, markup_amount,
                    discount_type, discount_value, discount_amount,
                    total_amount, notes, created_by
                ) VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                RETURNING *
            `, [
                tenantId, companyId, invoice_number, expiry_date, subtotal,
                markup_type, markup_value, markup_amount,
                discount_type, discount_value, discount_amount,
                total_amount, notes, req.user.id
            ]);

            const proformaId = proformaResult.rows[0].id;

            // Insert items
            for (const item of items) {
                await client.query(`
                    INSERT INTO proforma_invoice_items (
                        tenant_id, proforma_id, product_name, quantity, unit_price, line_total, product_id, barcode
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                `, [tenantId, proformaId, item.product_name, item.quantity, item.unit_price, item.line_total, item.product_id, item.barcode]);
            }

            await client.query('COMMIT');
            res.json({ success: true, id: proformaId });

        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }

    } catch (error) {
        console.error('Create proforma invoice error:', error);
        res.status(500).json({ message: 'Error creating proforma invoice' });
    }
});

// Get Sales Invoices
app.get('/api/company/sales-invoices', authenticateToken, requireRole(COMPANY_PORTAL_ROLES), async (req, res) => {
    try {
        const tenantId = req.user.tenant_id || 1;
        const result = await pool.query(
            'SELECT * FROM sales_invoices WHERE created_by = $1 AND COALESCE(tenant_id, 1) = $2 ORDER BY issue_date DESC',
            [req.user.id, tenantId]
        );

        res.json(result.rows);

    } catch (error) {
        console.error('Sales invoices error:', error);
        res.status(500).json({ message: 'Error loading sales invoices' });
    }
});

// Create Sales Invoice
app.post('/api/company/sales-invoices', authenticateToken, requireRole(COMPANY_PORTAL_ROLES), async (req, res) => {
    try {
        const tenantId = req.user.tenant_id || 1;
        const {
            invoice_number, due_date, items, subtotal,
            markup_type, markup_value, markup_amount,
            discount_type, discount_value, discount_amount,
            total_amount, notes
        } = req.body;

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            // Get company ID scoped to tenant
            const companyResult = await client.query(
                'SELECT id FROM companies WHERE COALESCE(tenant_id, 1) = $1 ORDER BY id LIMIT 1',
                [tenantId]
            );
            if (!companyResult.rows.length) {
                await client.query('ROLLBACK');
                return res.status(404).json({ message: 'Company profile not found for this tenant' });
            }
            const companyId = req.user.company_id || companyResult.rows[0].id;

            // Create sales invoice
            const salesResult = await client.query(`
                INSERT INTO sales_invoices (
                    tenant_id, company_id, invoice_number, issue_date, due_date,
                    subtotal, markup_type, markup_value, markup_amount,
                    discount_type, discount_value, discount_amount,
                    total_amount, notes, created_by
                ) VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                RETURNING *
            `, [
                tenantId, companyId, invoice_number, due_date, subtotal,
                markup_type, markup_value, markup_amount,
                discount_type, discount_value, discount_amount,
                total_amount, notes, req.user.id
            ]);

            const salesId = salesResult.rows[0].id;

            // Insert items
            for (const item of items) {
                await client.query(`
                    INSERT INTO sales_invoice_items (
                        tenant_id, invoice_id, product_name, quantity, unit_price, line_total, product_id, barcode
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                `, [tenantId, salesId, item.product_name, item.quantity, item.unit_price, item.line_total, item.product_id, item.barcode]);
            }

            await client.query('COMMIT');
            res.json({ success: true, id: salesId });

        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }

    } catch (error) {
        console.error('Create sales invoice error:', error);
        res.status(500).json({ message: 'Error creating sales invoice' });
    }
});

// Get Transactions
app.get('/api/company/transactions', authenticateToken, requireRole(COMPANY_PORTAL_ROLES), async (req, res) => {
    try {
        const tenantId = req.user.tenant_id || 1;
        const query = `
            SELECT ct.*, si.invoice_number
            FROM company_transactions ct
            LEFT JOIN sales_invoices si ON ct.invoice_id = si.id AND COALESCE(si.tenant_id, 1) = $1
            WHERE COALESCE(ct.tenant_id, 1) = $1
              AND ct.company_id = COALESCE($2::int, (SELECT id FROM companies WHERE COALESCE(tenant_id, 1) = $1 ORDER BY id LIMIT 1))
            ORDER BY ct.created_at DESC
        `;

        const result = await pool.query(query, [tenantId, req.user.company_id || null]);
        res.json(result.rows);

    } catch (error) {
        console.error('Transactions error:', error);
        res.status(500).json({ message: 'Error loading transactions' });
    }
});

// Quick Sale Processing
app.post('/api/company/quick-sale', authenticateToken, requireRole(COMPANY_PORTAL_ROLES), async (req, res) => {
    const client = await pool.connect();
    try {
        const tenantId = req.user.tenant_id || 1;
        const { items, discount, tax, tax_details, payment_method, customer_name, skip_stock, type, proforma_id, customer_id } = req.body;
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ message: 'At least one item is required' });
        }

        let newId;
        await client.query('BEGIN');

        // Resolve company_id scoped to tenant
        let companyResult;
        if (req.user.company_id && /^\d+$/.test(String(req.user.company_id))) {
            companyResult = await client.query(
                'SELECT id FROM companies WHERE id = $1 AND COALESCE(tenant_id, 1) = $2 LIMIT 1',
                [parseInt(req.user.company_id, 10), tenantId]
            );
        }
        if (!companyResult || companyResult.rows.length === 0) {
            companyResult = await client.query(
                'SELECT id FROM companies WHERE COALESCE(tenant_id, 1) = $1 ORDER BY id LIMIT 1',
                [tenantId]
            );
        }
        if (companyResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Company record not found' });
        }
        const companyId = companyResult.rows[0].id;

        // Verify items in tenant catalog and compute server-authoritative amounts
        let authoritativeSubtotal = 0;
        const verifiedItems = [];
        for (const item of items) {
            const qty = Number(item.quantity);
            const pid = item.id || item.product_id;
            const barcode = (item.barcode && item.barcode !== 'N/A') ? String(item.barcode) : null;
            if ((!pid && !barcode) || !Number.isFinite(qty) || qty <= 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'Each item must specify a valid product and positive quantity' });
            }
            const prodRes = await client.query(
                `SELECT id, barcode, name, price, stock_levels FROM products WHERE ${pid ? 'id = $1' : 'barcode = $1'} AND COALESCE(tenant_id, 1) = $2 LIMIT 1 FOR UPDATE`,
                [pid || barcode, tenantId]
            );
            if (prodRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: `Product ${pid || barcode} not found` });
            }
            const prod = prodRes.rows[0];
            const unitPrice = Number(prod.price || 0);
            const lineTotal = Number((unitPrice * qty).toFixed(2));
            authoritativeSubtotal += lineTotal;
            verifiedItems.push({
                product_id: prod.id,
                barcode: prod.barcode,
                product_name: prod.name,
                quantity: qty,
                unit_price: unitPrice,
                line_total: lineTotal,
                stock_levels: prod.stock_levels
            });
        }
        authoritativeSubtotal = Number(authoritativeSubtotal.toFixed(2));

        const role = (req.user.role || '').toLowerCase();
        const capPct = (role === 'ceo' || role === 'admin') ? 100 : (MANAGER_ROLES.includes(role) ? 20 : 5);
        const maxDiscount = (authoritativeSubtotal * capPct) / 100;
        const safeDiscount = Number(Math.max(0, Math.min(Number(discount || 0), maxDiscount, authoritativeSubtotal)).toFixed(2));
        const safeTax = Number(Math.max(0, Number(tax || 0)).toFixed(2));
        const authoritativeTotal = Number((authoritativeSubtotal - safeDiscount + safeTax).toFixed(2));
        const payMethod = String(payment_method || 'cash').toLowerCase();

        const invoiceNumber = (type === 'proforma' ? 'PRO-Q-' : 'INV-Q-') + Date.now();

        if (type === 'proforma') {
            const proformaResult = await client.query(`
                INSERT INTO proforma_invoices (
                    tenant_id, company_id, invoice_number, issue_date, expiry_date,
                    subtotal, discount_amount, tax_amount, tax_details, total_amount, notes, created_by, client_name, payment_method, customer_id
                ) VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '30 days', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                RETURNING id
            `, [tenantId, companyId, invoiceNumber, authoritativeSubtotal, safeDiscount, safeTax, JSON.stringify(tax_details || []), authoritativeTotal, `Quick Document for ${customer_name || ''}`, req.user.id, customer_name || null, payMethod, customer_id || null]);

            newId = proformaResult.rows[0].id;

            for (const item of verifiedItems) {
                await client.query(`
                    INSERT INTO proforma_invoice_items (
                        proforma_id, product_name, quantity, unit_price, line_total, product_id, barcode
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
                `, [newId, item.product_name, item.quantity, item.unit_price, item.line_total, item.product_id, item.barcode]);
            }
        } else {
            // Create sales invoice
            const status = payMethod === 'credit' ? 'Unpaid' : 'Paid';
            const salesResult = await client.query(`
                INSERT INTO sales_invoices (
                    tenant_id, company_id, invoice_number, issue_date, due_date,
                    subtotal, discount_amount, tax_amount, tax_details, total_amount, notes, created_by, client_name, payment_method, status, customer_id
                ) VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '30 days', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                RETURNING id
            `, [tenantId, companyId, invoiceNumber, authoritativeSubtotal, safeDiscount, safeTax, JSON.stringify(tax_details || []), authoritativeTotal, `Quick Document for ${customer_name || ''}`, req.user.id, customer_name || null, payMethod, status, customer_id || null]);

            newId = salesResult.rows[0].id;

            // If credit payment, update customer balance (scoped to tenant)
            if (payMethod === 'credit' && customer_id) {
                const custRes = await client.query(
                    'SELECT credit_limit, current_balance FROM customers WHERE id = $1 AND COALESCE(tenant_id, 1) = $2 AND deleted_at IS NULL FOR UPDATE',
                    [customer_id, tenantId]
                );
                if (custRes.rows.length === 0) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({ message: 'Customer not found' });
                }
                const cust = custRes.rows[0];
                const newBalance = parseFloat(cust.current_balance || 0) + authoritativeTotal;
                if (newBalance > parseFloat(cust.credit_limit || 0)) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: 'Credit limit exceeded' });
                }
                await client.query(
                    'UPDATE customers SET current_balance = COALESCE(current_balance, 0) + $1 WHERE id = $2 AND COALESCE(tenant_id, 1) = $3',
                    [authoritativeTotal, customer_id, tenantId]
                );
            }

            for (const item of verifiedItems) {
                await client.query(`
                    INSERT INTO sales_invoice_items (
                        invoice_id, product_name, quantity, unit_price, line_total, product_id, barcode
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
                `, [newId, item.product_name, item.quantity, item.unit_price, item.line_total, item.product_id, item.barcode]);
            }

            // Record in transaction history for Sales Invoices/Quick Sales
            await client.query(`
                INSERT INTO company_transactions (tenant_id, company_id, invoice_id, transaction_type, amount, created_by)
                VALUES ($1, $2, $3, 'Sale', $4, $5)
            `, [tenantId, companyId, newId, authoritativeTotal, req.user.id]);

            // If this sale came from a proforma, mark it as completed within tenant
            if (proforma_id) {
                await client.query(
                    `UPDATE proforma_invoices SET status = 'Completed' WHERE id = $1 AND COALESCE(tenant_id, 1) = $2`,
                    [proforma_id, tenantId]
                );
            }

            // --- INVENTORY DEDUCTION LOGIC (Company Portal Sales) ---
            if (!skip_stock) {
                const userStoreLocation = req.user.store_location || null;
                const branchLookupRes = await client.query(`
                    SELECT name FROM branches
                    WHERE COALESCE(tenant_id, 1) = $2
                    ORDER BY CASE WHEN ($1::text IS NOT NULL AND (name ILIKE $1 OR location ILIKE $1)) THEN 0 ELSE 1 END, is_main DESC NULLS LAST, id ASC
                    LIMIT 1
                `, [userStoreLocation, tenantId]);

                const targetBranch = branchLookupRes.rows.length > 0 ? branchLookupRes.rows[0].name : (userStoreLocation || 'Main Warehouse');

                for (const item of verifiedItems) {
                    let actualKey = null;
                    const levels = item.stock_levels || {};
                    const match = Object.keys(levels).find(k => k.toUpperCase() === targetBranch.toUpperCase());
                    if (match) actualKey = match;

                    if (actualKey) {
                        await client.query(`
                            UPDATE products
                            SET
                                stock_levels = jsonb_set(
                                    COALESCE(stock_levels, '{}'::jsonb),
                                    ARRAY[$1],
                                    (COALESCE((stock_levels->>$1)::int, 0) - $2)::text::jsonb
                                ),
                                stock = COALESCE(stock, 0) - $2
                            WHERE id = $3 AND COALESCE(tenant_id, 1) = $4
                        `, [actualKey, item.quantity, item.product_id, tenantId]);
                    } else {
                        await client.query(`
                            UPDATE products
                            SET stock = COALESCE(stock, 0) - $1
                            WHERE id = $2 AND COALESCE(tenant_id, 1) = $3
                        `, [item.quantity, item.product_id, tenantId]);
                    }

                    await client.query(`
                        INSERT INTO inventory_audit_log (
                            tenant_id, action_type, product_barcode, quantity_before, quantity_after,
                            reference_id, reference_type, user_id, branch_id, notes
                        )
                        SELECT
                            $7::int, 'Stock Out', $1::text, (COALESCE((stock_levels->>$2::text)::int, 0) + $3::int),
                            (COALESCE((stock_levels->>$2::text)::int, 0)), $4::int, 'Quick Sale', $5::int,
                            (SELECT id FROM branches WHERE name = $2::text AND COALESCE(tenant_id, 1) = $7::int LIMIT 1), 'Company Portal Quick Sale (' || $2 || ')'
                        FROM products WHERE id = $6 AND COALESCE(tenant_id, 1) = $7::int
                    `, [item.barcode || '', actualKey || targetBranch, item.quantity, newId, req.user.id, item.product_id, tenantId]);
                }
            }
        }

        const activityType = skip_stock ? `COMPANY_${payMethod.toUpperCase()}_GENERATED` : 'COMPANY_QUICK_SALE';
        await logActivity(req, activityType, { invoiceNumber, total: authoritativeTotal, customer_name, items_count: verifiedItems.length });

        await client.query('COMMIT');
        res.json({ success: true, invoice_number: invoiceNumber, id: newId, total: authoritativeTotal, subtotal: authoritativeSubtotal });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Quick sale error:', error);
        res.status(500).json({ message: 'Error processing sale' });
    } finally {
        client.release();
    }
});

// Convert Proforma to Sales Invoice
app.post('/api/company/proforma-invoices/:id/convert', authenticateToken, requireRole(COMPANY_PORTAL_ROLES), async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        if (!(await companyDocAllowed(req, 'proforma_invoices', id, client))) {
            return res.status(404).json({ message: 'Proforma not found' });
        }
        await client.query('BEGIN');

        const proRes = await client.query('SELECT * FROM proforma_invoices WHERE id = $1', [id]);
        if (proRes.rows.length === 0) throw new Error('Proforma not found');
        const pro = proRes.rows[0];

        const itemsRes = await client.query('SELECT * FROM proforma_invoice_items WHERE proforma_id = $1', [id]);

        const invNum = 'INV-C-' + Date.now();
        const salesRes = await client.query(`
            INSERT INTO sales_invoices (
                company_id, invoice_number, proforma_id, issue_date, due_date,
                subtotal, discount_amount, tax_amount, tax_details, total_amount, notes, created_by, status, client_name
            ) VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '30 days', $4, $5, $6, $7, $8, $9, $10, 'Unpaid', $11)
            RETURNING id
        `, [pro.company_id, invNum, id, pro.subtotal, pro.discount_amount, pro.tax_amount, pro.tax_details, pro.total_amount, pro.notes, req.user.id, pro.client_name]);

        const salesId = salesRes.rows[0].id;

        for (const item of itemsRes.rows) {
            await client.query(`
                INSERT INTO sales_invoice_items (
                    invoice_id, product_name, quantity, unit_price, line_total, product_id, barcode
                ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [salesId, item.product_name, item.quantity, item.unit_price, item.line_total, item.product_id, item.barcode]);
        }

        await client.query("UPDATE proforma_invoices SET status = 'Converted' WHERE id = $1", [id]);

        await logActivity(req, 'COMPANY_PROFORMA_CONVERTED', { proforma_id: id, invoice_number: invNum, total: pro.total_amount });

        await client.query('COMMIT');
        res.json({ success: true, invoice_number: invNum });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).json({ message: error.message });
    } finally { client.release(); }
});

// Update Proforma Status to Sent
app.post('/api/company/proforma-invoices/:id/send', authenticateToken, requireRole(COMPANY_PORTAL_ROLES), async (req, res) => {
    try {
        if (!(await companyDocAllowed(req, 'proforma_invoices', req.params.id))) return res.status(404).json({ message: 'Proforma not found' });
        await pool.query("UPDATE proforma_invoices SET status = 'Sent' WHERE id = $1", [req.params.id]);
        await logActivity(req, 'COMPANY_PROFORMA_SENT', { proforma_id: req.params.id });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ message: 'Error sending proforma' });
    }
});

// Record Payment for Sales Invoice
app.post('/api/company/sales-invoices/:id/payment', authenticateToken, requireRole(COMPANY_PORTAL_ROLES), async (req, res) => {
    const { id } = req.params;
    const paid = parseFloat(req.body.amount);
    if (!Number.isFinite(paid) || paid <= 0) {
        return res.status(400).json({ message: 'amount must be a positive number' });
    }
    const client = await pool.connect();
    try {
        if (!(await companyDocAllowed(req, 'sales_invoices', id, client))) {
            return res.status(404).json({ message: 'Invoice not found' });
        }
        await client.query('BEGIN');
        // Locking the invoice makes concurrent payments additive rather than last-write-wins.
        const invRes = await client.query(
            'SELECT total_amount, paid_amount FROM sales_invoices WHERE id = $1 FOR UPDATE',
            [id]
        );
        if (invRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Invoice not found' });
        }
        const inv = invRes.rows[0];
        const outstanding = parseFloat(inv.total_amount || 0) - parseFloat(inv.paid_amount || 0);
        if (paid > outstanding) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: `Payment exceeds the outstanding balance of ${outstanding}` });
        }

        const updateRes = await client.query(`
            UPDATE sales_invoices
            SET paid_amount = COALESCE(paid_amount, 0) + $1,
                status = CASE WHEN COALESCE(paid_amount, 0) + $1 >= total_amount THEN 'Paid' ELSE 'Partially Paid' END
            WHERE id = $2
            RETURNING paid_amount, status
        `, [paid, id]);

        const newPaid = parseFloat(updateRes.rows[0].paid_amount);
        await logActivity(req, 'COMPANY_PAYMENT_RECORDED', { invoice_id: id, amount: paid, new_paid_total: newPaid, status: updateRes.rows[0].status });

        await client.query('COMMIT');
        res.json({ success: true, paid_amount: newPaid, status: updateRes.rows[0].status });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Company payment error:', error);
        res.status(500).json({ message: 'Error recording payment' });
    } finally { client.release(); }
});

// Get Single Proforma Detail
app.get('/api/company/proforma-invoices/:id', authenticateToken, requireRole(COMPANY_PORTAL_ROLES), async (req, res) => {
    try {
        const id = req.params.id;
        if (!(await companyDocAllowed(req, 'proforma_invoices', id))) return res.status(404).json({ message: 'Proforma not found' });
        const mainRes = await pool.query('SELECT * FROM proforma_invoices WHERE id = $1', [id]);
        if (mainRes.rows.length === 0) return res.status(404).json({ message: 'Proforma not found' });

        const itemsRes = await pool.query('SELECT * FROM proforma_invoice_items WHERE proforma_id = $1', [id]);
        const data = mainRes.rows[0];
        data.items = itemsRes.rows;
        res.json(data);
    } catch (e) {
        res.status(500).json({ message: 'Error fetching proforma detail' });
    }
});

// Get Single Sales Invoice Detail
app.get('/api/company/sales-invoices/:id', authenticateToken, requireRole(COMPANY_PORTAL_ROLES), async (req, res) => {
    try {
        const id = req.params.id;
        if (!(await companyDocAllowed(req, 'sales_invoices', id))) return res.status(404).json({ message: 'Invoice not found' });
        const mainRes = await pool.query('SELECT * FROM sales_invoices WHERE id = $1', [id]);
        if (mainRes.rows.length === 0) return res.status(404).json({ message: 'Invoice not found' });

        const itemsRes = await pool.query('SELECT * FROM sales_invoice_items WHERE invoice_id = $1', [id]);
        const data = mainRes.rows[0];
        data.items = itemsRes.rows;
        res.json(data);
    } catch (e) {
        res.status(500).json({ message: 'Error fetching invoice detail' });
    }
});

// Company Tax Management Endpoints
app.get('/api/company/taxes', authenticateToken, async (req, res) => {
    try {
        // Strict isolation: Only return taxes belonging to THIS company account
        const companyBranchId = req.user.store_id;
        if (!companyBranchId) {
            return res.json([]); // No store context = no taxes
        }
        const result = await pool.query(
            'SELECT * FROM tax_rules WHERE branch_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC',
            [companyBranchId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Company taxes error:', error);
        res.status(500).json({ message: 'Error loading tax rules' });
    }
});

app.post('/api/company/taxes', authenticateToken, async (req, res) => {
    try {
        const { name, rate } = req.body;

        if (!name || rate === undefined || rate === null) {
            return res.status(400).json({ message: 'Tax name and rate are required' });
        }

        // Assign this tax to the company's unique store_id
        const companyBranchId = req.user.store_id;
        if (!companyBranchId) {
            return res.status(400).json({ message: 'No company context found. Please log out and log back in.' });
        }

        const result = await pool.query(
            'INSERT INTO tax_rules (name, rate, branch_id, status, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING *',
            [name, rate, companyBranchId, 'Active']
        );

        await logActivity(req, 'COMPANY_TAX_CREATED', { name, rate });

        res.json(result.rows[0]);
    } catch (error) {
        console.error('Add tax error:', error);
        res.status(500).json({ message: 'Error adding tax rule' });
    }
});

app.put('/api/company/taxes/:id/toggle', authenticateToken, async (req, res) => {
    try {
        const taxId = req.params.id;
        const companyBranchId = req.user.store_id;

        // Only allow toggling taxes that belong to THIS company
        const currentResult = await pool.query(
            'SELECT status FROM tax_rules WHERE id = $1 AND branch_id = $2 AND deleted_at IS NULL',
            [taxId, companyBranchId]
        );
        if (currentResult.rows.length === 0) {
            return res.status(404).json({ message: 'Tax rule not found' });
        }

        const currentStatus = currentResult.rows[0].status;
        const newStatus = currentStatus === 'Active' ? 'Inactive' : 'Active';

        const result = await pool.query(
            'UPDATE tax_rules SET status = $1 WHERE id = $2 AND branch_id = $3 RETURNING *',
            [newStatus, taxId, companyBranchId]
        );

        await logActivity(req, 'COMPANY_TAX_TOGGLED', { tax_id: taxId, new_status: newStatus });

        res.json(result.rows[0]);
    } catch (error) {
        console.error('Toggle tax error:', error);
        res.status(500).json({ message: 'Error updating tax rule' });
    }
});

app.delete('/api/company/taxes/:id', authenticateToken, async (req, res) => {
    try {
        const taxId = req.params.id;
        const companyBranchId = req.user.store_id;

        // Only allow deleting taxes that belong to THIS company
        const result = await pool.query(
            'UPDATE tax_rules SET deleted_at = NOW() WHERE id = $1 AND branch_id = $2 AND deleted_at IS NULL RETURNING *',
            [taxId, companyBranchId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Tax rule not found' });
        }

        res.json({ message: 'Tax rule deleted successfully' });
    } catch (error) {
        console.error('Delete tax error:', error);
        res.status(500).json({ message: 'Error deleting tax rule' });
    }
});

// Company Tax Report from Transactions
app.get('/api/company/tax-report', authenticateToken, async (req, res) => {
    try {
        const { startDate, endDate } = req.query;

        let whereClause = 'ct.company_id = (SELECT id FROM companies ORDER BY id LIMIT 1)';
        let params = [];

        if (startDate && endDate) {
            whereClause += ` AND ct.created_at >= $1 AND ct.created_at <= $2::date + INTERVAL '1 day' - INTERVAL '1 second'`;
            params.push(startDate, endDate);
        }

        const query = `
            SELECT 
                SUM(ct.amount) as gross_sales,
                SUM(COALESCE(si.tax_amount, 0)) as total_tax,
                SUM(ct.amount - COALESCE(si.tax_amount, 0)) as net_sales
            FROM company_transactions ct
            LEFT JOIN sales_invoices si ON ct.invoice_id = si.id
            WHERE ${whereClause}
        `;

        const result = await pool.query(query, params);
        const row = result.rows[0];

        if (!row || !row.gross_sales) {
            return res.json([{
                period: startDate && endDate ? `${startDate} to ${endDate}` : 'All Time',
                gross_sales: 0,
                net_sales: 0,
                total_tax: 0
            }]);
        }

        res.json([{
            period: startDate && endDate ? `${startDate} to ${endDate}` : 'All Time',
            gross_sales: parseFloat(row.gross_sales) || 0,
            net_sales: parseFloat(row.net_sales) || 0,
            total_tax: parseFloat(row.total_tax) || 0
        }]);

    } catch (error) {
        console.error('Company tax report error:', error);
        res.status(500).json({ message: 'Error generating report' });
    }
});

// Strict Static Asset Security Filter: Prevent access to database dumps, schemas, server code, and internal configs
app.use((req, res, next) => {
    const blockedExts = ['.sql', '.env', '.json', '.md', '.py', '.sh', '.yml', '.yaml', '.lock', '.log', '.xlsx', '.csv', '.txt', '.map', '.cjs', '.mjs', '.ds_store'];
    const lowerPath = req.path.toLowerCase();

    // Block dangerous extensions
    if (blockedExts.some(ext => lowerPath.endsWith(ext))) {
        return res.status(403).send('Access Denied');
    }

    // Block all server-side JS files from root (only whitelist allowed client scripts)
    if (lowerPath.endsWith('.js')) {
        const allowedClientScripts = [
            '/auth-guard.js',
            '/user-session.js',
            '/currency.js',
            '/emulator.js',
            '/sw.js',
            '/instant-nav.js',
            '/telemetry-guard.js',
            '/offline-queue.js',
            '/lazy-libs.js',
            '/layout.js',
            '/ui-components.js',
            '/pos-upgrade.js'
        ];
        if (!allowedClientScripts.includes(lowerPath)) {
            return res.status(403).send('Access Denied');
        }
    }

    next();
});
app.use(express.static(path.join(__dirname), {
    extensions: ['html'],
    redirect: false,
    maxAge: 0,
    setHeaders: (res, filePath) => {
        // HTML and shared JS/CSS must revalidate so every page renders the same
        // layout.js/sidebar.css instead of a day-old cached copy.
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
        } else if (filePath.endsWith('.png') || filePath.endsWith('.ico') || filePath.endsWith('.svg') || filePath.endsWith('.woff2')) {
            res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
        }
    }
}));

// Handle 404 for API routes (prevents HTML response for API errors)
app.use('/api', (req, res) => {
    res.status(404).json({ message: 'API endpoint not found' });
});

// Error handling middleware - Must be last
app.use((err, req, res, next) => {
    console.error(err.stack);

    // Handle other errors
    res.status(500).json({
        success: false,
        message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong!'
    });
});

// Attach pool to app for external consumers
app.pool = pool;

// Start server if run directly (node server.js), otherwise export for Vercel/serverless
if (require.main === module && !process.env.VERCEL) {
    startNightlyBackupScheduler();
    const server = app.listen(port, '0.0.0.0', () => {
        console.log(`Server running on port ${port} (HTTP)`);
        console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
        console.log(`Server should stay running - press Ctrl+C to stop`);
    });

    // Keep the event loop alive with a heartbeat
    const heartbeat = setInterval(() => { }, 5000);

    server.on('close', () => {
        console.log('Server closed');
        clearInterval(heartbeat);
    });

    server.on('error', (err) => {
        console.error('Server error:', err);
    });
}

module.exports = app;