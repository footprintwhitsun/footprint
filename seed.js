const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const connStr = process.env.DATABASE_URL;
const ssl = connStr && (connStr.includes('sslmode=require') || connStr.includes('supabase')) 
    ? { rejectUnauthorized: false } 
    : false;

// Remove sslmode=require to prevent conflict with ssl object
const pool = new Pool({ connectionString: connStr.replace('sslmode=require', ''), ssl });

const run = async () => {
    try {
        console.log('Creating users table...');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100),
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(50) DEFAULT 'staff',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('Recreating transactions table...');
        await pool.query('DROP TABLE IF EXISTS transactions CASCADE');
        await pool.query(`
            CREATE TABLE transactions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                store_location VARCHAR(100),
                total_amount DECIMAL(10, 2),
                payment_method VARCHAR(50),
                receipt_number VARCHAR(100),
                items JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('Recreating shifts table...');
        await pool.query('DROP TABLE IF EXISTS shifts CASCADE');
        await pool.query(`
            CREATE TABLE shifts (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                end_time TIMESTAMP,
                start_cash DECIMAL(10, 2),
                end_cash DECIMAL(10, 2),
                notes TEXT,
                status VARCHAR(20) DEFAULT 'open'
            );
        `);

        console.log('Recreating products table...');
        await pool.query('DROP TABLE IF EXISTS products CASCADE');
        await pool.query(`
            CREATE TABLE products (
                barcode VARCHAR(50) PRIMARY KEY,
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
        `);

        console.log('Recreating promotions table...');
        await pool.query('DROP TABLE IF EXISTS promotions CASCADE');
        await pool.query(`
            CREATE TABLE promotions (
                code VARCHAR(50) PRIMARY KEY,
                discount_percentage DECIMAL(5,2) NOT NULL,
                total_discounted DECIMAL(10,2) DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('Creating suppliers table...');
        await pool.query('DROP TABLE IF EXISTS suppliers CASCADE');
        await pool.query(`
            CREATE TABLE suppliers (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                contact_person VARCHAR(100),
                phone VARCHAR(50),
                email VARCHAR(255),
                address TEXT,
                rating INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('Creating purchase orders tables...');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS purchase_orders (
                id SERIAL PRIMARY KEY,
                supplier_id INTEGER REFERENCES suppliers(id),
                status VARCHAR(50) DEFAULT 'Pending',
                total_amount DECIMAL(10, 2) DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS purchase_order_items (
                id SERIAL PRIMARY KEY,
                po_id INTEGER REFERENCES purchase_orders(id) ON DELETE CASCADE,
                product_barcode VARCHAR(50) REFERENCES products(barcode) ON DELETE CASCADE,
                quantity INTEGER NOT NULL,
                unit_cost DECIMAL(10, 2) NOT NULL
            );
        `);

        console.log('Creating stock transfer tables...');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS stock_transfers (
                id SERIAL PRIMARY KEY,
                from_location VARCHAR(100),
                to_location VARCHAR(100),
                status VARCHAR(50) DEFAULT 'Pending',
                items JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('Creating product batches table...');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS product_batches (
                id SERIAL PRIMARY KEY,
                product_barcode VARCHAR(50) REFERENCES products(barcode) ON DELETE CASCADE,
                batch_number VARCHAR(100),
                expiry_date DATE,
                quantity INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Add store_location column if it doesn't exist
        try {
            await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS store_location VARCHAR(100)`);
        } catch (err) {
            console.log('Note: store_location column check finished.');
        }

        // Fix: Rename legacy columns if they exist
        try {
            // Check for password_hash
            const pwdCheck = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'password_hash'");
            if (pwdCheck.rows.length > 0) {
                console.log('Renaming password_hash to password...');
                await pool.query('ALTER TABLE users RENAME COLUMN password_hash TO password');
            }

            // Check for full_name
            const nameCheck = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'full_name'");
            if (nameCheck.rows.length > 0) {
                console.log('Renaming full_name to name...');
                await pool.query('ALTER TABLE users RENAME COLUMN full_name TO name');
            }
        } catch (err) {
            console.log('Legacy column migration failed:', err.message);
        }

        // Fix: Remove NOT NULL constraint from username if it exists (legacy schema support)
        try {
            await pool.query(`ALTER TABLE users ALTER COLUMN username DROP NOT NULL`);
        } catch (err) {
            // Column likely doesn't exist or other error, ignore
        }
        
        const requirePass = (specificKey) => {
            const val = process.env[specificKey] || process.env.SEED_DEFAULT_PASSWORD;
            if (!val) throw new Error(`Missing required password env var: set ${specificKey} or SEED_DEFAULT_PASSWORD`);
            return val;
        };

        const email = 'admin@okwesiwaltd.com';
        const password = requirePass('DEFAULT_ADMIN_PASS');
        const hash = await bcrypt.hash(password, 10);
        
        // Check if user exists
        const res = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (res.rows.length === 0) {
            await pool.query(
                'INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4)',
                ['Admin User', email, hash, 'admin']
            );
            console.log(`User created successfully.\nEmail: ${email}`);
        } else {
            await pool.query('UPDATE users SET password = $1 WHERE email = $2', [hash, email]);
            console.log(`Default user exists. Password reset.`);
        }

        // Create Cashier User
        const cashierEmail = 'cashier@okwesiwaltd.com';
        const cashierPass = requirePass('DEFAULT_CASHIER_PASS');
        const cashierHash = await bcrypt.hash(cashierPass, 10);
        const cashierRes = await pool.query('SELECT * FROM users WHERE email = $1', [cashierEmail]);

        if (cashierRes.rows.length === 0) {
            await pool.query(
                'INSERT INTO users (name, email, password, role, store_location) VALUES ($1, $2, $3, $4, $5)',
                ['Kelvin Van-Dyck (Cashier)', cashierEmail, cashierHash, 'cashier', 'Accra Branch']
            );
            console.log(`Cashier created successfully.\nEmail: ${cashierEmail}\nStore: Accra Branch`);
        } else {
            await pool.query('UPDATE users SET name = $4, password = $1, store_location = $3 WHERE email = $2', [cashierHash, cashierEmail, 'Accra Branch', 'Kelvin Van-Dyck (Cashier)']);
            console.log(`Cashier user updated.`);
        }



        // Create Manager User
        const managerEmail = 'manager@okwesiwaltd.com';
        const managerPass = requirePass('DEFAULT_MANAGER_PASS');
        const managerHash = await bcrypt.hash(managerPass, 10);
        const managerRes = await pool.query('SELECT * FROM users WHERE email = $1', [managerEmail]);

        if (managerRes.rows.length === 0) {
            await pool.query(
                'INSERT INTO users (name, email, password, role, store_location) VALUES ($1, $2, $3, $4, $5)',
                ['Store Manager', managerEmail, managerHash, 'manager', 'Accra Branch']
            );
            console.log(`Manager created successfully.\nEmail: ${managerEmail}\nStore: Accra Branch`);
        } else {
            await pool.query('UPDATE users SET password = $1, role = $3, store_location = $4 WHERE email = $2', [managerHash, managerEmail, 'manager', 'Accra Branch']);
            console.log(`Manager user updated.`);
        }
    } catch (e) {
        console.error('Error seeding database:', e);
    } finally {
        pool.end();
    }
};

run();