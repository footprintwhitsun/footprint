// Runs numbered SQL files in migrations/ once each, in order.
// Usage: npm run migrate
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { pool } = require('../db/pool');

async function main() {
    if (!pool) {
        console.error('DATABASE_URL is not configured. Aborting migrations.');
        process.exit(1);
    }
    const dir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(dir).filter(f => /^\d+_.*\.sql$/.test(f)).sort();

    await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            filename VARCHAR(255) PRIMARY KEY,
            applied_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    const done = new Set((await pool.query('SELECT filename FROM schema_migrations')).rows.map(r => r.filename));

    for (const file of files) {
        if (done.has(file)) {
            console.log(`skip  ${file}`);
            continue;
        }
        const sql = fs.readFileSync(path.join(dir, file), 'utf8');
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
            await client.query('COMMIT');
            console.log(`apply ${file}`);
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            console.error(`FAILED ${file}: ${err.message}`);
            process.exit(1);
        } finally {
            client.release();
        }
    }
    await pool.end();
    console.log('Migrations complete.');
}

main();

