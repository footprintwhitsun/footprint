const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const fs = require('fs');
require('dotenv').config();

let pool;
try {
    const connStr = process.env.DATABASE_URL;
    const isProduction = process.env.NODE_ENV === 'production';
    const isSupabase = connStr && (
        connStr.includes('supabase.co') || 
        connStr.includes('supabase.com') || 
        connStr.includes('sslmode=require')
    );
    const ssl = (isProduction || isSupabase) ? { rejectUnauthorized: false } : false;

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

    pool = new Pool({ connectionString: cleanConnStr, ssl });
} catch (error) {
    console.error('Database connection error:', error);
    process.exit(1);
}

const run = async () => {
    try {
        console.log('Initializing database schema...');
        const schema = fs.readFileSync('fullschema.sql', 'utf8');
        // We will execute the schema. But since fullschema doesn't have IF NOT EXISTS, 
        // it might fail if tables exist. We'll ignore errors from schema creation.
        try {
            await pool.query(schema);
            console.log('Schema executed successfully.');
        } catch (e) {
            console.log('Schema execution message (probably tables already exist):', e.message);
        }

        const requirePass = (specificKey) => {
            const val = process.env[specificKey] || process.env.SEED_DEFAULT_PASSWORD;
            if (!val) throw new Error(`Missing required password env var: set ${specificKey} or SEED_DEFAULT_PASSWORD`);
            return val;
        };

        console.log('Creating users...');
        const usersToCreate = [
            {
                name: 'Ceo profile',
                email: 'ceo@faithway.com',
                password: requirePass('DEFAULT_CEO_PASS'),
                role: 'ceo',
                location: process.env.MAIN_BRANCH_LOCATION || 'Amasaman'
            },
            {
                name: 'Manager',
                email: 'Manager@faithway.com',
                password: requirePass('DEFAULT_MANAGER_PASS'),
                role: 'manager',
                location: process.env.MAIN_BRANCH_LOCATION || 'Amasaman'
            },
            {
                name: 'Cashier',
                email: 'Cashier@faithway.com',
                password: requirePass('DEFAULT_CASHIER_PASS'),
                role: 'cashier',
                location: 'Accra Branch'
            }
        ];

        for (const user of usersToCreate) {
            const hash = await bcrypt.hash(user.password, 10);
            const res = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [user.email]);
            
            if (res.rows.length === 0) {
                await pool.query(
                    'INSERT INTO users (name, email, password, role, store_location) VALUES ($1, $2, $3, $4, $5)',
                    [user.name, user.email, hash, user.role, user.location]
                );
                console.log(`User created successfully: ${user.email} (${user.role})`);
            } else {
                await pool.query('UPDATE users SET name = $1, password = $2, role = $3, store_location = $4 WHERE LOWER(email) = LOWER($5)', 
                    [user.name, hash, user.role, user.location, user.email]);
                console.log(`User updated successfully: ${user.email} (${user.role})`);
            }
        }
    } catch (e) {
        console.error('Error creating users:', e);
    } finally {
        pool.end();
        process.exit(0);
    }
};

run();
