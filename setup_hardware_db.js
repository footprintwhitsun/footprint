const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const connStr = process.env.DATABASE_URL;
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

async function setupDatabase() {
    console.log('Connecting to database:', cleanConnStr.split('@')[1] || 'Supabase');
    const client = await pool.connect();

    try {
        console.log('--- Step 1: Creating Core Tables for Hardware Store (No Expiry) ---');

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

            -- System Settings
            CREATE TABLE IF NOT EXISTS system_settings (
                id INT PRIMARY KEY,
                branch_id INT UNIQUE DEFAULT 1,
                store_name VARCHAR(255) DEFAULT 'OKWESIWA CO LTD',
                currency_symbol VARCHAR(50) DEFAULT 'GH₵',
                vat_rate DECIMAL(5,2) DEFAULT 0.00,
                receipt_footer TEXT DEFAULT 'Thank you for your business!',
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
            VALUES (1, 1, 'OKWESIWA CO LTD', 'GH₵', 0.00, 50000.00)
            ON CONFLICT (id) DO NOTHING;

            -- Users Table
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(100) UNIQUE,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(50) DEFAULT 'staff',
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

            -- Products Table (HARDWARE: track_expiry defaults to FALSE, no required expiry)
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

            -- Product Batches Table (HARDWARE: expiry_date is NULLABLE)
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

            -- Goods Received (expiry_date is NULLABLE)
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
                counted_at TIMESTAMP,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1
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
                branch_id INTEGER DEFAULT 1,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                acknowledged_at TIMESTAMP,
                UNIQUE(product_barcode)
            );

            -- Shelf Management
            CREATE TABLE IF NOT EXISTS shelf_inventory (
                id SERIAL PRIMARY KEY,
                product_barcode VARCHAR(50),
                quantity_on_shelf INTEGER DEFAULT 0,
                store_quantity INTEGER DEFAULT 0,
                branch_id INTEGER DEFAULT 1,
                last_verified TIMESTAMP,
                staff_id INTEGER,
                notes TEXT,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(product_barcode, branch_id)
            );

            CREATE TABLE IF NOT EXISTS shelf_movements (
                id SERIAL PRIMARY KEY,
                product_barcode VARCHAR(50),
                movement_type VARCHAR(50),
                quantity INTEGER,
                staff_id INTEGER,
                from_location VARCHAR(100),
                to_location VARCHAR(100),
                branch_id INTEGER DEFAULT 1,
                notes TEXT,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Expenses Table
            CREATE TABLE IF NOT EXISTS expenses (
                id SERIAL PRIMARY KEY,
                category VARCHAR(100) NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                description TEXT,
                expense_date DATE DEFAULT CURRENT_DATE,
                branch_id INT DEFAULT 1,
                created_by INT,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
                branch_id INTEGER DEFAULT 1,
                notes TEXT,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Tax Rules
            CREATE TABLE IF NOT EXISTS tax_rules (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                rate DECIMAL(5,2) NOT NULL,
                branch_id INTEGER DEFAULT 1,
                status VARCHAR(20) DEFAULT 'Active',
                deleted_at TIMESTAMPTZ,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Companies & Invoices (B2B Portal)
            CREATE TABLE IF NOT EXISTS companies (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                tax_id VARCHAR(50),
                phone VARCHAR(50),
                email VARCHAR(255),
                address TEXT,
                registration_number VARCHAR(100),
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

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
                tax_details JSONB,
                total_amount DECIMAL(12,2),
                notes TEXT,
                status VARCHAR(20) DEFAULT 'Sent',
                payment_method VARCHAR(50),
                client_name VARCHAR(255),
                customer_id INT,
                created_by INTEGER REFERENCES users(id),
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
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
                line_total DECIMAL(12,2) NOT NULL,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1
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
                client_name VARCHAR(255),
                customer_id INT,
                created_by INTEGER REFERENCES users(id),
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
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
                line_total DECIMAL(12,2) NOT NULL,
                tenant_id INT REFERENCES tenants(id) DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS company_transactions (
                id SERIAL PRIMARY KEY,
                company_id INTEGER REFERENCES companies(id),
                invoice_id INTEGER,
                transaction_type VARCHAR(50),
                amount DECIMAL(12,2),
                created_by INTEGER REFERENCES users(id),
                tenant_id INT REFERENCES tenants(id) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Session store table for connect-pg-simple
            CREATE TABLE IF NOT EXISTS user_sessions (
                sid VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
                sess JSON NOT NULL,
                expire TIMESTAMP(6) NOT NULL
            );
            CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON user_sessions ("expire");
        `);

        console.log('✅ All core tables successfully created with hardware specifications!');

        console.log('--- Step 2: Seeding Hardware Categories ---');
        const hardwareCategories = [
            'Building Materials',
            'Tools & Hardware',
            'Plumbing Supplies',
            'Electrical Supplies',
            'Paints & Finishes',
            'Fasteners & Fixings',
            'Roofing & Timber',
            'Safety & PPE'
        ];

        for (const cat of hardwareCategories) {
            await client.query(`
                INSERT INTO categories (name, description, branch_id)
                VALUES ($1, $2, 1)
                ON CONFLICT (name, branch_id) DO NOTHING
            `, [cat, `${cat} category`]);
        }
        console.log('✅ Hardware categories seeded.');

        console.log('--- Step 3: Seeding Default Users ---');
        const requirePass = (specificKey) => {
            const val = process.env[specificKey] || process.env.SEED_DEFAULT_PASSWORD;
            if (!val) throw new Error(`Missing required password env var: set ${specificKey} or SEED_DEFAULT_PASSWORD`);
            return val;
        };

        const defaultUsers = [
            {
                name: 'OKWESIWA CO LTD Admin',
                email: 'admin@footprintpos.com',
                password: requirePass('DEFAULT_ADMIN_PASS'),
                role: 'admin',
                location: 'Amasaman'
            },
            {
                name: 'OKWESIWA CO LTD Cashier',
                email: 'cashier@footprintpos.com',
                password: requirePass('DEFAULT_CASHIER_PASS'),
                role: 'cashier',
                location: 'Amasaman'
            },
            {
                name: 'OKWESIWA CO LTD Manager',
                email: 'manager@footprintpos.com',
                password: requirePass('DEFAULT_MANAGER_PASS'),
                role: 'manager',
                location: 'Amasaman'
            },
            {
                name: 'CEO',
                email: 'ceo@faithway.com',
                password: requirePass('DEFAULT_CEO_PASS'),
                role: 'ceo',
                location: 'Amasaman'
            },
            {
                name: 'Store Cashier',
                email: 'cashier@okwesiwaltd.com',
                password: requirePass('DEFAULT_CASHIER_PASS'),
                role: 'cashier',
                location: 'Amasaman'
            },
            {
                name: 'OKWESIWA CO LTD Admin',
                email: 'admin@okwesiwaltd.com',
                password: requirePass('DEFAULT_ADMIN_PASS'),
                role: 'admin',
                location: 'Amasaman'
            }
        ];

        for (const u of defaultUsers) {
            const hash = await bcrypt.hash(u.password, 10);
            const userCheck = await client.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [u.email]);
            if (userCheck.rows.length === 0) {
                await client.query(`
                    INSERT INTO users (name, email, password, role, store_location, store_id)
                    VALUES ($1, $2, $3, $4, $5, 1)
                `, [u.name, u.email.toLowerCase(), hash, u.role.toLowerCase(), u.location]);
                console.log(`Created user: ${u.email} (${u.role})`);
            } else {
                await client.query(`
                    UPDATE users SET password = $1, role = $2, store_location = $3 WHERE LOWER(email) = LOWER($4)
                `, [hash, u.role.toLowerCase(), u.location, u.email]);
                console.log(`Updated user: ${u.email}`);
            }
        }

        console.log('--- Step 4: Seeding Initial Hardware Catalog (NO Expiry Dates) ---');
        const hardwareProducts = [
            {
                barcode: 'HW-CEM-001',
                name: 'Portland Cement (50kg Bag)',
                category: 'Building Materials',
                cost_price: 85.00,
                price: 110.00,
                stock: 250,
                selling_unit: 'Bag',
                packaging_unit: 'Pallet',
                conversion_rate: 40,
                reorder_level: 50,
                batch_number: 'LOT-CEM-2026'
            },
            {
                barcode: 'HW-ROD-012',
                name: 'High Tensile Steel Iron Rod 12mm',
                category: 'Building Materials',
                cost_price: 60.00,
                price: 78.00,
                stock: 180,
                selling_unit: 'Piece',
                packaging_unit: 'Bundle',
                conversion_rate: 10,
                reorder_level: 30,
                batch_number: 'LOT-ROD-12'
            },
            {
                barcode: 'HW-PVC-004',
                name: 'PVC Pressure Pipe 4" (6m)',
                category: 'Plumbing Supplies',
                cost_price: 45.00,
                price: 65.00,
                stock: 90,
                selling_unit: 'Length',
                packaging_unit: 'Bundle',
                conversion_rate: 5,
                reorder_level: 20,
                batch_number: 'LOT-PVC-04'
            },
            {
                barcode: 'HW-PNT-020',
                name: 'Premium Acrylic Emulsion Paint White (20L)',
                category: 'Paints & Finishes',
                cost_price: 280.00,
                price: 360.00,
                stock: 45,
                selling_unit: 'Bucket',
                packaging_unit: 'Carton',
                conversion_rate: 1,
                reorder_level: 10,
                batch_number: 'LOT-PNT-W20'
            },
            {
                barcode: 'HW-HAM-016',
                name: 'Claw Hammer 16oz Fiberglass Handle',
                category: 'Tools & Hardware',
                cost_price: 35.00,
                price: 52.00,
                stock: 65,
                selling_unit: 'Piece',
                packaging_unit: 'Box',
                conversion_rate: 12,
                reorder_level: 15,
                batch_number: 'LOT-HAM-16'
            },
            {
                barcode: 'HW-GRN-115',
                name: 'Heavy Duty Angle Grinder 115mm 850W',
                category: 'Tools & Hardware',
                cost_price: 220.00,
                price: 310.00,
                stock: 25,
                selling_unit: 'Unit',
                packaging_unit: 'Box',
                conversion_rate: 1,
                reorder_level: 5,
                batch_number: 'LOT-GRN-850'
            },
            {
                barcode: 'HW-CAB-250',
                name: '2.5mm Twin & Earth Copper Electrical Cable (100m)',
                category: 'Electrical Supplies',
                cost_price: 320.00,
                price: 430.00,
                stock: 35,
                selling_unit: 'Roll',
                packaging_unit: 'Box',
                conversion_rate: 5,
                reorder_level: 8,
                batch_number: 'LOT-CAB-25'
            },
            {
                barcode: 'HW-LED-050',
                name: 'Outdoor LED Flood Light 50W IP66 Waterproof',
                category: 'Electrical Supplies',
                cost_price: 65.00,
                price: 98.00,
                stock: 80,
                selling_unit: 'Piece',
                packaging_unit: 'Carton',
                conversion_rate: 10,
                reorder_level: 20,
                batch_number: 'LOT-LED-50'
            },
            {
                barcode: 'HW-SCR-003',
                name: 'Black Drywall Wood Screws 3.5x25mm (Box 1000)',
                category: 'Fasteners & Fixings',
                cost_price: 28.00,
                price: 42.00,
                stock: 120,
                selling_unit: 'Box',
                packaging_unit: 'Carton',
                conversion_rate: 20,
                reorder_level: 25,
                batch_number: 'LOT-SCR-25'
            },
            {
                barcode: 'HW-TAP-001',
                name: 'Chrome Plated Basin Mixer Tap Brass Body',
                category: 'Plumbing Supplies',
                cost_price: 80.00,
                price: 125.00,
                stock: 50,
                selling_unit: 'Set',
                packaging_unit: 'Box',
                conversion_rate: 6,
                reorder_level: 10,
                batch_number: 'LOT-TAP-01'
            }
        ];

        for (const p of hardwareProducts) {
            const stockLevels = JSON.stringify({ 'Amasaman': p.stock });
            const prodRes = await client.query(`
                INSERT INTO products (
                    barcode, name, category, price, cost_price, stock, stock_levels,
                    selling_unit, packaging_unit, conversion_rate, reorder_level,
                    track_batch, track_expiry, branch_id, tenant_id
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, false, 1, 1)
                ON CONFLICT (tenant_id, barcode, name) WHERE deleted_at IS NULL AND barcode IS NOT NULL AND barcode != ''
                DO UPDATE SET
                    price = EXCLUDED.price,
                    cost_price = EXCLUDED.cost_price,
                    stock = EXCLUDED.stock,
                    stock_levels = EXCLUDED.stock_levels,
                    track_expiry = false
                RETURNING id
            `, [
                p.barcode, p.name, p.category, p.price, p.cost_price, p.stock,
                stockLevels, p.selling_unit, p.packaging_unit, p.conversion_rate,
                p.reorder_level
            ]);

            // Add batch with NO expiry date
            await client.query(`
                INSERT INTO product_batches (
                    product_barcode, batch_number, expiry_date, quantity,
                    quantity_available, quantity_received, branch_id, status, tenant_id
                )
                VALUES ($1, $2, NULL, $3, $3, $3, 1, 'Active', 1)
                ON CONFLICT (product_barcode, batch_number, branch_id)
                DO UPDATE SET
                    quantity = EXCLUDED.quantity,
                    quantity_available = EXCLUDED.quantity_available,
                    expiry_date = NULL
            `, [p.barcode, p.batch_number, p.stock]);
        }

        console.log('✅ Hardware products catalog seeded with 0 expiry dates!');

        console.log('====================================================');
        console.log('🎉 DATABASE SETUP FOR HARDWARE STORE COMPLETE!');
        console.log('====================================================');

    } catch (err) {
        console.error('❌ Error setting up database:', err);
    } finally {
        client.release();
        await pool.end();
    }
}

setupDatabase();
