const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const connStr = process.env.DATABASE_URL;
if (!connStr) {
    console.error('ERROR: DATABASE_URL not set in .env');
    process.exit(1);
}

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

const pool = new Pool({
    connectionString: cleanConnStr,
    ssl: { rejectUnauthorized: false }
});

async function runInitialization() {
    console.log('🚀 Connecting to Database...');
    const client = await pool.connect();

    try {
        console.log('📦 Step 1: Creating all required Schemas & Tables...');
        
        await client.query(`
            -- SaaS Multitenancy Table
            CREATE TABLE IF NOT EXISTS tenants (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                subscription_status VARCHAR(50) DEFAULT 'Active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO tenants (id, name) VALUES (1, 'Default System Business') ON CONFLICT (id) DO NOTHING;

            -- Branches Table
            CREATE TABLE IF NOT EXISTS branches (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                location VARCHAR(255),
                is_main BOOLEAN DEFAULT FALSE,
                deleted_at TIMESTAMPTZ,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO branches (id, name, location, is_main) VALUES (1, 'Amasaman', 'Amasaman', TRUE) ON CONFLICT (id) DO NOTHING;

            -- System Settings Table
            CREATE TABLE IF NOT EXISTS system_settings (
                id INT PRIMARY KEY,
                branch_id INT UNIQUE DEFAULT 1,
                store_name VARCHAR(255) DEFAULT 'FOOTPRINT',
                currency_symbol VARCHAR(50) DEFAULT 'GH₵',
                vat_rate DECIMAL(5,2) DEFAULT 0.00,
                receipt_footer TEXT DEFAULT 'Thank you for your business with FOOTPRINT!',
                tax_id VARCHAR(50),
                phone VARCHAR(50),
                bank_name VARCHAR(255),
                bank_account_name VARCHAR(255),
                bank_account_number VARCHAR(255),
                bank_branch VARCHAR(255),
                momo_number VARCHAR(255),
                momo_name VARCHAR(255),
                credit_auth_code VARCHAR(50) DEFAULT '123456',
                credit_auth_code_expiry TIMESTAMP,
                monthly_target DECIMAL(12,2) DEFAULT 50000.00,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO system_settings (id, branch_id, store_name, currency_symbol, vat_rate, monthly_target)
            VALUES (1, 1, 'FOOTPRINT', 'GH₵', 0.00, 50000.00)
            ON CONFLICT (id) DO UPDATE SET store_name = 'FOOTPRINT';

            -- Users Table
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(100) UNIQUE,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(50) DEFAULT 'cashier',
                phone VARCHAR(50),
                employee_id VARCHAR(50) UNIQUE,
                status VARCHAR(20) DEFAULT 'Active',
                store_location VARCHAR(100) DEFAULT 'Amasaman',
                store_id INT DEFAULT 1,
                reset_token VARCHAR(255),
                reset_token_expiry TIMESTAMPTZ,
                deleted_at TIMESTAMPTZ,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Activity Logs Table
            CREATE TABLE IF NOT EXISTS activity_logs (
                id SERIAL PRIMARY KEY,
                user_id INT,
                action VARCHAR(100),
                details JSONB,
                ip_address VARCHAR(50),
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Categories Table
            CREATE TABLE IF NOT EXISTS categories (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                description TEXT,
                branch_id INT DEFAULT 1,
                deleted_at TIMESTAMPTZ,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT categories_name_branch_id_key UNIQUE (name, branch_id)
            );

            -- Suppliers Table
            CREATE TABLE IF NOT EXISTS suppliers (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                contact_person VARCHAR(100),
                phone VARCHAR(50),
                email VARCHAR(255),
                address TEXT,
                rating INTEGER DEFAULT 0,
                branch_id INT DEFAULT 1,
                deleted_at TIMESTAMPTZ,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Products Table
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
                stock_levels JSONB DEFAULT '{"Amasaman": 0}'::jsonb,
                stock INTEGER DEFAULT 0,
                branch_id INTEGER DEFAULT 1,
                deleted_at TIMESTAMPTZ DEFAULT NULL,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE UNIQUE INDEX IF NOT EXISTS products_barcode_active_idx
                ON products(tenant_id, barcode, name) WHERE deleted_at IS NULL AND barcode IS NOT NULL AND barcode != '';

            -- Product Batches Table
            CREATE TABLE IF NOT EXISTS product_batches (
                id SERIAL PRIMARY KEY,
                product_barcode VARCHAR(255),
                batch_number VARCHAR(255),
                expiry_date DATE DEFAULT NULL,
                quantity INT DEFAULT 0,
                quantity_available INT DEFAULT 0,
                quantity_received INT DEFAULT 0,
                branch_id INT DEFAULT 1,
                status VARCHAR(50) DEFAULT 'Active',
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT product_batches_barcode_batch_branch_key UNIQUE (product_barcode, batch_number, branch_id)
            );

            -- Price Lists
            CREATE TABLE IF NOT EXISTS price_lists (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                list_type VARCHAR(50),
                branch_id INTEGER DEFAULT 1,
                effective_date DATE,
                status VARCHAR(20) DEFAULT 'Active',
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS price_list_items (
                id SERIAL PRIMARY KEY,
                price_list_id INTEGER REFERENCES price_lists(id) ON DELETE CASCADE,
                product_barcode VARCHAR(50),
                markup_percentage DECIMAL(5,2),
                selling_price DECIMAL(10,2),
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Customers Table
            CREATE TABLE IF NOT EXISTS customers (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                phone VARCHAR(50),
                email VARCHAR(255),
                account_number VARCHAR(10) UNIQUE,
                credit_limit DECIMAL(10,2) DEFAULT 0.00,
                current_balance DECIMAL(10,2) DEFAULT 0.00,
                pending_credit_limit DECIMAL(12, 2),
                status VARCHAR(20) DEFAULT 'Active',
                created_by INT,
                deleted_at TIMESTAMPTZ,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Shifts Table
            CREATE TABLE IF NOT EXISTS shifts (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                end_time TIMESTAMP,
                start_cash DECIMAL(10, 2) DEFAULT 0,
                end_cash DECIMAL(10, 2),
                notes TEXT,
                status VARCHAR(20) DEFAULT 'open',
                tenant_id INT REFERENCES tenants(id) DEFAULT 1
            );

            -- Transactions Table
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                customer_id INTEGER,
                customer_name VARCHAR(255),
                store_location VARCHAR(100),
                total_amount DECIMAL(10, 2),
                original_total DECIMAL(10, 2),
                current_total DECIMAL(10, 2),
                payment_method VARCHAR(50),
                receipt_number VARCHAR(100),
                items JSONB,
                tax_breakdown JSONB,
                status VARCHAR(20) DEFAULT 'completed',
                is_return BOOLEAN DEFAULT FALSE,
                original_transaction_id INTEGER,
                return_items JSONB,
                has_returns BOOLEAN DEFAULT FALSE,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Refunds Table
            CREATE TABLE IF NOT EXISTS refunds (
                id SERIAL PRIMARY KEY,
                transaction_id INTEGER REFERENCES transactions(id),
                original_receipt_number VARCHAR(100),
                refund_receipt_number VARCHAR(100),
                refund_amount DECIMAL(10, 2),
                payment_method VARCHAR(50),
                processed_by INTEGER REFERENCES users(id),
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Customer Payments Table
            CREATE TABLE IF NOT EXISTS customer_payments (
                id SERIAL PRIMARY KEY,
                customer_id INTEGER REFERENCES customers(id),
                amount DECIMAL(10, 2) NOT NULL,
                payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                recorded_by INTEGER,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1
            );

            -- Customer Ledger Table
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
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Promotions & Usage
            CREATE TABLE IF NOT EXISTS promotions (
                id SERIAL PRIMARY KEY,
                code VARCHAR(50) UNIQUE NOT NULL,
                discount_percentage DECIMAL(5,2) NOT NULL,
                total_discounted DECIMAL(10,2) DEFAULT 0.00,
                branch_id INT DEFAULT 1,
                deleted_at TIMESTAMPTZ,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS promotion_usage (
                id SERIAL PRIMARY KEY,
                promotion_code VARCHAR(50),
                branch_id INT,
                total_discounted DECIMAL(10,2) DEFAULT 0.00,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                UNIQUE(promotion_code, branch_id)
            );

            -- Purchase Orders & Items
            CREATE TABLE IF NOT EXISTS purchase_orders (
                id SERIAL PRIMARY KEY,
                supplier_id INTEGER REFERENCES suppliers(id),
                status VARCHAR(50) DEFAULT 'Pending',
                total_amount DECIMAL(10, 2) DEFAULT 0,
                branch_id INT DEFAULT 1,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS purchase_order_items (
                id SERIAL PRIMARY KEY,
                po_id INTEGER REFERENCES purchase_orders(id) ON DELETE CASCADE,
                product_barcode VARCHAR(50),
                quantity INTEGER NOT NULL,
                unit_cost DECIMAL(10, 2) NOT NULL,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1
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
                expiry_date DATE DEFAULT NULL,
                received_by INTEGER,
                invoice_number VARCHAR(100),
                branch_id INTEGER DEFAULT 1,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Stock Transfers & Items
            CREATE TABLE IF NOT EXISTS stock_transfers (
                id SERIAL PRIMARY KEY,
                transfer_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                from_branch_id INTEGER,
                to_branch_id INTEGER,
                from_location VARCHAR(255),
                to_location VARCHAR(255),
                status VARCHAR(50) DEFAULT 'Pending',
                items JSONB,
                notes TEXT,
                confirmed_by INT,
                confirmed_at TIMESTAMP,
                created_by INTEGER,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS stock_transfer_items (
                id SERIAL PRIMARY KEY,
                transfer_id INTEGER REFERENCES stock_transfers(id) ON DELETE CASCADE,
                product_barcode VARCHAR(50),
                quantity_sent INTEGER,
                quantity_received INTEGER,
                unit_cost DECIMAL(10,2),
                batch_number VARCHAR(100),
                expiry_date DATE DEFAULT NULL,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1
            );

            -- Stock Adjustments
            CREATE TABLE IF NOT EXISTS stock_adjustments (
                id SERIAL PRIMARY KEY,
                product_barcode VARCHAR(50),
                adjustment_type VARCHAR(50),
                quantity_adjusted INTEGER,
                reason TEXT,
                approver_id INTEGER,
                branch_id INTEGER DEFAULT 1,
                approved_at TIMESTAMP,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Stock Takes & Items
            CREATE TABLE IF NOT EXISTS stock_takes (
                id SERIAL PRIMARY KEY,
                stock_take_date DATE,
                branch_id INTEGER DEFAULT 1,
                created_by INTEGER,
                approved_by INTEGER,
                status VARCHAR(50) DEFAULT 'In Progress',
                variance_total DECIMAL(10,2),
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS stock_take_items (
                id SERIAL PRIMARY KEY,
                stock_take_id INTEGER REFERENCES stock_takes(id) ON DELETE CASCADE,
                product_barcode VARCHAR(50),
                expected_quantity INTEGER,
                actual_quantity INTEGER,
                variance INTEGER,
                variance_value DECIMAL(10,2),
                tenant_id INT REFERENCES tenants(id) DEFAULT 1
            );

            -- Stock Movements Table
            CREATE TABLE IF NOT EXISTS stock_movements (
                id SERIAL PRIMARY KEY,
                product_id INTEGER,
                product_barcode VARCHAR(50),
                type VARCHAR(50) NOT NULL,
                quantity INTEGER NOT NULL,
                unit_cost DECIMAL(10,2),
                total_cost DECIMAL(10,2),
                reference_type VARCHAR(50),
                reference_id VARCHAR(100),
                from_branch_id INTEGER,
                to_branch_id INTEGER,
                notes TEXT,
                created_by INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                tenant_id INTEGER DEFAULT 1
            );

            -- Negative Stock Logs
            CREATE TABLE IF NOT EXISTS negative_stock_logs (
                id SERIAL PRIMARY KEY,
                product_barcode VARCHAR(50),
                attempted_quantity INTEGER,
                available_quantity INTEGER,
                branch_id INTEGER DEFAULT 1,
                cashier_id INTEGER,
                cashier_name VARCHAR(100),
                authorized_by VARCHAR(100),
                reason TEXT,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                logged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Credit Authorizations
            CREATE TABLE IF NOT EXISTS credit_authorizations (
                id SERIAL PRIMARY KEY,
                customer_id INTEGER REFERENCES customers(id),
                amount DECIMAL(10, 2),
                auth_code VARCHAR(50),
                generated_by INTEGER,
                used BOOLEAN DEFAULT FALSE,
                expires_at TIMESTAMP,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Branch Targets
            CREATE TABLE IF NOT EXISTS branch_targets (
                id SERIAL PRIMARY KEY,
                branch_id INT REFERENCES branches(id) ON DELETE CASCADE,
                period_month VARCHAR(7) NOT NULL,
                target_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (branch_id, period_month, tenant_id)
            );

            -- ==========================================
            -- B2B & CORPORATE PORTAL TABLES
            -- ==========================================

            -- Companies Table
            CREATE TABLE IF NOT EXISTS companies (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                contact_person VARCHAR(255),
                email VARCHAR(255),
                phone VARCHAR(50),
                address TEXT,
                tax_id VARCHAR(100),
                registration_number VARCHAR(100),
                payment_terms VARCHAR(100) DEFAULT 'Net 30',
                credit_limit DECIMAL(12, 2) DEFAULT 50000.00,
                status VARCHAR(50) DEFAULT 'Active',
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Company Users Table
            CREATE TABLE IF NOT EXISTS company_users (
                id SERIAL PRIMARY KEY,
                company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
                company_name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(50) DEFAULT 'business_client',
                contact_person VARCHAR(255),
                phone VARCHAR(50),
                address TEXT,
                status VARCHAR(50) DEFAULT 'Active',
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Proforma Invoices
            CREATE TABLE IF NOT EXISTS proforma_invoices (
                id SERIAL PRIMARY KEY,
                company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
                invoice_number VARCHAR(100) UNIQUE NOT NULL,
                issue_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expiry_date TIMESTAMP,
                subtotal DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
                tax_rate DECIMAL(5, 2) DEFAULT 0.00,
                tax_amount DECIMAL(12, 2) DEFAULT 0.00,
                discount_type VARCHAR(20) DEFAULT 'percentage',
                discount_value DECIMAL(12, 2) DEFAULT 0.00,
                discount_amount DECIMAL(12, 2) DEFAULT 0.00,
                markup_type VARCHAR(20) DEFAULT 'percentage',
                markup_value DECIMAL(12, 2) DEFAULT 0.00,
                markup_amount DECIMAL(12, 2) DEFAULT 0.00,
                total_amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
                status VARCHAR(50) DEFAULT 'Draft',
                notes TEXT,
                created_by INTEGER REFERENCES company_users(id) ON DELETE SET NULL,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Proforma Invoice Items Table
            CREATE TABLE IF NOT EXISTS proforma_invoice_items (
                id SERIAL PRIMARY KEY,
                proforma_id INTEGER REFERENCES proforma_invoices(id) ON DELETE CASCADE,
                product_id INTEGER,
                product_name VARCHAR(255) NOT NULL,
                description TEXT,
                quantity DECIMAL(10, 2) NOT NULL,
                unit_price DECIMAL(12, 2) NOT NULL,
                line_total DECIMAL(12, 2) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Sales Invoices Table
            CREATE TABLE IF NOT EXISTS sales_invoices (
                id SERIAL PRIMARY KEY,
                company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
                invoice_number VARCHAR(100) UNIQUE NOT NULL,
                proforma_id INTEGER REFERENCES proforma_invoices(id) ON DELETE SET NULL,
                issue_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                due_date TIMESTAMP,
                subtotal DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
                tax_rate DECIMAL(5, 2) DEFAULT 0.00,
                tax_amount DECIMAL(12, 2) DEFAULT 0.00,
                discount_type VARCHAR(20) DEFAULT 'percentage',
                discount_value DECIMAL(12, 2) DEFAULT 0.00,
                discount_amount DECIMAL(12, 2) DEFAULT 0.00,
                markup_type VARCHAR(20) DEFAULT 'percentage',
                markup_value DECIMAL(12, 2) DEFAULT 0.00,
                markup_amount DECIMAL(12, 2) DEFAULT 0.00,
                total_amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
                paid_amount DECIMAL(12, 2) DEFAULT 0.00,
                status VARCHAR(50) DEFAULT 'Unpaid',
                payment_status VARCHAR(50) DEFAULT 'Pending',
                notes TEXT,
                created_by INTEGER REFERENCES company_users(id) ON DELETE SET NULL,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Sales Invoice Items Table
            CREATE TABLE IF NOT EXISTS sales_invoice_items (
                id SERIAL PRIMARY KEY,
                invoice_id INTEGER REFERENCES sales_invoices(id) ON DELETE CASCADE,
                product_id INTEGER,
                product_name VARCHAR(255) NOT NULL,
                description TEXT,
                quantity DECIMAL(10, 2) NOT NULL,
                unit_price DECIMAL(12, 2) NOT NULL,
                line_total DECIMAL(12, 2) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Company Transactions Table
            CREATE TABLE IF NOT EXISTS company_transactions (
                id SERIAL PRIMARY KEY,
                company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
                invoice_id INTEGER REFERENCES sales_invoices(id) ON DELETE SET NULL,
                transaction_type VARCHAR(50) NOT NULL,
                amount DECIMAL(12, 2) NOT NULL,
                payment_method VARCHAR(50),
                reference_number VARCHAR(255),
                description TEXT,
                created_by INTEGER REFERENCES company_users(id) ON DELETE SET NULL,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Company Taxes Table
            CREATE TABLE IF NOT EXISTS company_taxes (
                id SERIAL PRIMARY KEY,
                company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
                name VARCHAR(100) NOT NULL,
                rate DECIMAL(5,2) NOT NULL,
                status VARCHAR(20) DEFAULT 'Active',
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ All Core & Corporate Schema tables verified successfully.');

        console.log('👤 Step 2: Creating the 4 User Profiles...');

        // 1. CEO
        const salt = await bcrypt.genSalt(10);
        const ceoHash = await bcrypt.hash('Ceo2026!', salt);
        await client.query(`
            INSERT INTO users (username, name, email, password, role, store_location, status)
            VALUES ('ceo_footprint', 'Executive CEO', 'ceo@footprint.com', $1, 'ceo', 'Headquarters', 'Active')
            ON CONFLICT (email) DO UPDATE SET
                password = $1,
                role = 'ceo',
                name = 'Executive CEO',
                store_location = 'Headquarters',
                status = 'Active';
        `, [ceoHash]);
        console.log('✅ Profile 1 (CEO): ceo@footprint.com / Ceo2026!');

        // 2. STORE MANAGER
        const managerHash = await bcrypt.hash('Manager2026!', salt);
        await client.query(`
            INSERT INTO users (username, name, email, password, role, store_location, status)
            VALUES ('manager_footprint', 'Store Manager', 'manager@footprint.com', $1, 'manager', 'Amasaman', 'Active')
            ON CONFLICT (email) DO UPDATE SET
                password = $1,
                role = 'manager',
                name = 'Store Manager',
                store_location = 'Amasaman',
                status = 'Active';
        `, [managerHash]);
        console.log('✅ Profile 2 (STORE MANAGER): manager@footprint.com / Manager2026!');

        // 3. TELLER (CASHIER)
        const tellerHash = await bcrypt.hash('Teller2026!', salt);
        await client.query(`
            INSERT INTO users (username, name, email, password, role, store_location, status)
            VALUES ('teller_footprint', 'Frontline Teller', 'teller@footprint.com', $1, 'cashier', 'Amasaman', 'Active')
            ON CONFLICT (email) DO UPDATE SET
                password = $1,
                role = 'cashier',
                name = 'Frontline Teller',
                store_location = 'Amasaman',
                status = 'Active';
        `, [tellerHash]);
        console.log('✅ Profile 3 (TELLER): teller@footprint.com / Teller2026!');

        // 4. COMPANY PORTAL (B2B CLIENT)
        // Ensure Company Record exists
        let companyId = 1;
        const compRes = await client.query("SELECT id FROM companies WHERE name ILIKE '%Footprint%' LIMIT 1");
        if (compRes.rows.length > 0) {
            companyId = compRes.rows[0].id;
        } else {
            const insComp = await client.query(`
                INSERT INTO companies (name, email, contact_person, phone, status, credit_limit)
                VALUES ('Footprint B2B Enterprise', 'company@footprint.com', 'Corporate Client Admin', '+233 20 000 0000', 'Active', 50000.00)
                RETURNING id;
            `);
            companyId = insComp.rows[0].id;
        }

        const companyUserHash = await bcrypt.hash('Company2026!', salt);
        await client.query(`
            INSERT INTO company_users (company_id, company_name, contact_person, email, password, role, status)
            VALUES ($1, 'Footprint B2B Enterprise', 'Corporate Client Admin', 'company@footprint.com', $2, 'business_client', 'Active')
            ON CONFLICT (email) DO UPDATE SET
                company_id = $1,
                password = $2,
                role = 'business_client',
                company_name = 'Footprint B2B Enterprise',
                contact_person = 'Corporate Client Admin',
                status = 'Active';
        `, [companyId, companyUserHash]);
        console.log('✅ Profile 4 (COMPANY PORTAL): company@footprint.com / Company2026!');

        // Verify count of tables in database
        const tablesRes = await client.query(`
            SELECT count(*) as count 
            FROM information_schema.tables 
            WHERE table_schema = 'public';
        `);
        console.log(`\n🎉 Initialization Complete! Total public tables in database: ${tablesRes.rows[0].count}`);

    } catch (err) {
        console.error('❌ Error during database setup:', err);
    } finally {
        client.release();
        await pool.end();
        process.exit(0);
    }
}

runInitialization();
