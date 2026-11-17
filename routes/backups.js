const express = require('express');
const router = express.Router();
const xlsx = require('xlsx');
const PDFDocument = require('pdfkit');
const zlib = require('zlib');
const { pool } = require('../db/pool');
const { authenticateToken } = require('../middleware/auth');
const { logActivity } = require('../services/audit');

function xmlEsc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function crc32Buf(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
        const comp = zlib.deflateRawSync(raw);
        const crc = crc32Buf(raw);

        const local = Buffer.alloc(30 + nameBuf.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(8, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(comp.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        nameBuf.copy(local, 30);

        const central = Buffer.alloc(46 + nameBuf.length);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt16LE(0, 12);
        central.writeUInt16LE(0, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(comp.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        nameBuf.copy(central, 46);

        locals.push(local, comp);
        centrals.push(central);
        offset += local.length + comp.length;
    }
    const cdBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([...locals, cdBuf, eocd]);
}

function buildBackupDocx(row) {
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload || '{}') : (row.payload || {});
    const p = (text, bold = false, size = 22) =>
        `<w:p><w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="${size}"/></w:rPr><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`;
    const cell = (text, bold = false) =>
        `<w:tc><w:tcPr><w:tcW w:w="2200" w:type="dxa"/></w:tcPr>${p(text, bold, 18)}</w:tc>`;
    const makeTable = (headers, rows) => {
        const hdr = `<w:tr>${headers.map(h => cell(h, true)).join('')}</w:tr>`;
        const body = (rows.length ? rows : [headers.map(() => '-')]).map(r =>
            `<w:tr>${r.map(v => cell(v, false)).join('')}</w:tr>`
        ).join('');
        return `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="CBD5E1"/><w:bottom w:val="single" w:sz="4" w:color="CBD5E1"/><w:insideH w:val="single" w:sz="4" w:color="E2E8F0"/></w:tblBorders></w:tblPr>${hdr}${body}</w:tbl>`;
    };

    const products = Array.isArray(payload.products) ? payload.products : [];
    const customers = Array.isArray(payload.customers) ? payload.customers : [];
    const sales = Array.isArray(payload.transactions) ? payload.transactions : [];
    const suppliers = Array.isArray(payload.suppliers) ? payload.suppliers : [];

    const bodyXml = [
        p('OKWESIWA LTD — System Backup Snapshot', true, 32),
        p(`File: ${row.filename}   |   Generated: ${payload.generated_at || new Date().toISOString()}`, false, 20),
        p(`Summary: ${products.length} Products · ${customers.length} Customers · ${sales.length} Sales · ${suppliers.length} Suppliers`, true, 22),
        p(''),
        p('Products & Stock (Top 250)', true, 26),
        makeTable(['Name', 'Barcode', 'Category', 'Price', 'Stock'], products.slice(0, 250).map(x => [x.name, x.barcode, x.category || '-', x.price, x.stock])),
        p(''),
        p('Customers (Top 250)', true, 26),
        makeTable(['Name', 'Phone', 'Type', 'Credit Limit', 'Balance'], customers.slice(0, 250).map(x => [x.name, x.phone || '-', x.customer_type || '-', x.credit_limit || 0, x.current_balance || 0])),
        p(''),
        p('Recent Sales (Top 250)', true, 26),
        makeTable(['Receipt', 'Customer', 'Method', 'Total', 'Branch'], sales.slice(0, 250).map(x => [x.receipt_number || x.id, x.customer_name || 'Walk-in', x.payment_method || '-', x.total_amount || 0, x.store_location || '-'])),
        p(''),
        p('Suppliers', true, 26),
        makeTable(['Name', 'Contact', 'Phone', 'Email'], suppliers.slice(0, 250).map(x => [x.name, x.contact_person || '-', x.phone || '-', x.email || '-']))
    ].join('');

    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}<w:sectPr/></w:body></w:document>`;
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

    return buildZip([
        { name: '[Content_Types].xml', data: contentTypes },
        { name: '_rels/.rels', data: rels },
        { name: 'word/document.xml', data: docXml }
    ]);
}

async function ensureBackupsTable() {
    if (!pool) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS system_backups (
            id SERIAL PRIMARY KEY,
            tenant_id INTEGER DEFAULT 1,
            backup_type VARCHAR(20) NOT NULL DEFAULT 'manual',
            filename VARCHAR(255) NOT NULL,
            summary JSONB NOT NULL DEFAULT '{}'::jsonb,
            payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            size_bytes INTEGER DEFAULT 0,
            created_by INTEGER NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    `);
}

async function safeSelect(sql, params = []) {
    try {
        const r = await pool.query(sql, params);
        return r.rows;
    } catch (e) {
        return [];
    }
}

async function createBackupSnapshot({ tenantId = 1, backupType = 'manual', createdBy = null }) {
    await ensureBackupsTable();

    // Enforce 30-day retention
    await pool.query("DELETE FROM system_backups WHERE created_at < NOW() - INTERVAL '30 days' AND COALESCE(tenant_id, 1) = $1", [tenantId]);

    const [products, customers, suppliers, branches, transactions, users, purchase_orders, expenses, customer_payments] = await Promise.all([
        safeSelect('SELECT * FROM products WHERE COALESCE(tenant_id, 1) = $1 ORDER BY id ASC', [tenantId]),
        safeSelect('SELECT * FROM customers WHERE COALESCE(tenant_id, 1) = $1 ORDER BY id ASC', [tenantId]),
        safeSelect('SELECT * FROM suppliers WHERE COALESCE(tenant_id, 1) = $1 ORDER BY id ASC', [tenantId]),
        safeSelect('SELECT * FROM branches WHERE COALESCE(tenant_id, 1) = $1 ORDER BY id ASC', [tenantId]),
        safeSelect('SELECT * FROM transactions WHERE COALESCE(tenant_id, 1) = $1 ORDER BY created_at DESC', [tenantId]),
        safeSelect('SELECT id, name, email, role, branch_id, store_location, is_active, created_at FROM users WHERE COALESCE(tenant_id, 1) = $1 ORDER BY id ASC', [tenantId]),
        safeSelect('SELECT * FROM purchase_orders WHERE COALESCE(tenant_id, 1) = $1 ORDER BY id ASC', [tenantId]),
        safeSelect('SELECT * FROM expenses WHERE COALESCE(tenant_id, 1) = $1 ORDER BY id ASC', [tenantId]),
        safeSelect('SELECT * FROM customer_payments WHERE COALESCE(tenant_id, 1) = $1 ORDER BY id ASC', [tenantId])
    ]);

    const payload = {
        meta: {
            brand: 'OKWESIWA LTD',
            created_at: new Date().toISOString(),
            backup_type: backupType,
            tenant_id: tenantId
        },
        products,
        customers,
        suppliers,
        branches,
        transactions,
        users,
        purchase_orders,
        expenses,
        customer_payments
    };

    const jsonStr = JSON.stringify(payload);
    const sizeBytes = Buffer.byteLength(jsonStr, 'utf8');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `okwesiwa-backup-${backupType}-${stamp}.json`;
    const summary = {
        products: products.length,
        customers: customers.length,
        suppliers: suppliers.length,
        branches: branches.length,
        transactions: transactions.length,
        users: users.length,
        purchase_orders: purchase_orders.length,
        expenses: expenses.length,
        customer_payments: customer_payments.length
    };

    const res = await pool.query(
        `INSERT INTO system_backups (tenant_id, backup_type, filename, summary, payload, size_bytes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, tenant_id, backup_type, filename, summary, size_bytes, created_by, created_at`,
        [tenantId, backupType, filename, JSON.stringify(summary), jsonStr, sizeBytes, createdBy]
    );

    return res.rows[0];
}

function isCeoOrAdmin(req) {
    const role = (req.user?.role || '').toLowerCase();
    return role === 'super_admin' || role === 'ceo' || role === 'admin';
}

router.get('/api/backups', authenticateToken, async (req, res) => {
    if (!isCeoOrAdmin(req)) {
        return res.status(403).json({ message: 'Only the CEO or Admin can view backups' });
    }
    try {
        await ensureBackupsTable();
        const tenantId = req.user.tenant_id || 1;
        const result = await pool.query(
            `SELECT id, backup_type, filename, summary, size_bytes, created_by, created_at
             FROM system_backups
             WHERE tenant_id = $1
             ORDER BY created_at DESC
             LIMIT 60`,
            [tenantId]
        );
        res.json({ backups: result.rows, retentionDays: 30 });
    } catch (err) {
        console.error('GET /api/backups error:', err);
        res.status(500).json({ message: 'Failed to load backups' });
    }
});

router.post('/api/backups/create', authenticateToken, async (req, res) => {
    if (!isCeoOrAdmin(req)) {
        return res.status(403).json({ message: 'Only the CEO or Admin can create backups' });
    }
    try {
        const backup = await createBackupSnapshot({
            tenantId: req.user.tenant_id || 1,
            backupType: 'manual',
            createdBy: req.user.id || null
        });
        await logActivity(req, 'BACKUP_CREATED', { backup_id: backup.id, filename: backup.filename, summary: backup.summary });
        res.status(201).json({ success: true, backup });
    } catch (err) {
        console.error('POST /api/backups/create error:', err);
        res.status(500).json({ message: 'Failed to create backup' });
    }
});

router.get('/api/backups/:id/download', authenticateToken, async (req, res) => {
    if (!isCeoOrAdmin(req)) {
        return res.status(403).json({ message: 'Access denied' });
    }
    try {
        await ensureBackupsTable();
        const result = await pool.query(
            'SELECT filename, payload FROM system_backups WHERE id = $1 AND tenant_id = $2',
            [req.params.id, req.user.tenant_id || 1]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'Backup not found' });
        const row = result.rows[0];
        if (String(req.query.format || '').toLowerCase() === 'docx') {
            const docxBuf = buildBackupDocx(row);
            const docxName = String(row.filename || `backup-${req.params.id}`).replace(/\.json$/i, '') + '.docx';
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            res.setHeader('Content-Disposition', `attachment; filename="${docxName}"`);
            return res.send(docxBuf);
        }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${row.filename}"`);
        res.send(JSON.stringify(row.payload, null, 2));
    } catch (err) {
        console.error('GET /api/backups/:id/download error:', err);
        res.status(500).json({ message: 'Failed to download backup' });
    }
});

router.post('/api/backups/:id/restore', authenticateToken, async (req, res) => {
    if (!isCeoOrAdmin(req)) {
        return res.status(403).json({ message: 'Only the CEO or Admin can restore backups' });
    }
    try {
        await ensureBackupsTable();
        const result = await pool.query(
            'SELECT id, filename, summary FROM system_backups WHERE id = $1 AND tenant_id = $2',
            [req.params.id, req.user.tenant_id || 1]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'Backup not found' });
        await logActivity(req, 'BACKUP_RESTORE_VERIFIED', { backup_id: req.params.id, filename: result.rows[0].filename });
        res.json({
            success: true,
            verified: true,
            download_url: `/api/backups/${req.params.id}/download`,
            message: `Backup "${result.rows[0].filename}" verified. Download the snapshot to perform a full database restore.`,
            summary: result.rows[0].summary
        });
    } catch (err) {
        console.error('POST /api/backups/:id/restore error:', err);
        res.status(500).json({ message: 'Failed to restore backup' });
    }
});

// One-click export of all core data (products, customers, sales, stock) to Excel
router.get('/api/backups/export-excel', authenticateToken, async (req, res) => {
    if (!isCeoOrAdmin(req)) {
        return res.status(403).json({ message: 'Only the CEO or Admin can export all data' });
    }
    try {
        const [products, customers, sales, suppliers] = await Promise.all([
            safeSelect('SELECT id, name, barcode, category, price, cost_price, stock, stock_levels, selling_unit, brand FROM products ORDER BY name ASC'),
            safeSelect('SELECT id, name, phone, email, customer_type, credit_limit, current_balance, store_location FROM customers ORDER BY name ASC'),
            safeSelect('SELECT id, receipt_number, total_amount, payment_method, status, customer_name, store_location, created_at FROM transactions ORDER BY created_at DESC LIMIT 5000'),
            safeSelect('SELECT id, name, contact_person, phone, email, address, rating FROM suppliers ORDER BY name ASC')
        ]);

        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(products.length ? products : [{ note: 'No products' }]), 'Products & Stock');
        xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(customers.length ? customers : [{ note: 'No customers' }]), 'Customers');
        xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(sales.length ? sales : [{ note: 'No sales' }]), 'Sales');
        xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(suppliers.length ? suppliers : [{ note: 'No suppliers' }]), 'Suppliers');

        const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
        const stamp = new Date().toISOString().slice(0, 10);
        await logActivity(req, 'FULL_EXCEL_EXPORT', { products: products.length, customers: customers.length, sales: sales.length });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="OKWESIWA-LTD-Full-Export-${stamp}.xlsx"`);
        res.send(buf);
    } catch (err) {
        console.error('GET /api/backups/export-excel error:', err);
        res.status(500).json({ message: 'Failed to export Excel workbook' });
    }
});

// One-click export of all core data (products, customers, sales, suppliers) to PDF
router.get('/api/backups/export-pdf', authenticateToken, async (req, res) => {
    if (!isCeoOrAdmin(req)) {
        return res.status(403).json({ message: 'Only the CEO or Admin can export all data' });
    }
    try {
        const [products, customers, sales, suppliers] = await Promise.all([
            safeSelect('SELECT name, barcode, category, price, stock FROM products ORDER BY name ASC LIMIT 300'),
            safeSelect('SELECT name, phone, customer_type, credit_limit, current_balance FROM customers ORDER BY name ASC LIMIT 300'),
            safeSelect('SELECT receipt_number, total_amount, payment_method, customer_name, store_location, created_at FROM transactions ORDER BY created_at DESC LIMIT 300'),
            safeSelect('SELECT name, contact_person, phone, email FROM suppliers ORDER BY name ASC LIMIT 300')
        ]);

        const stamp = new Date().toISOString().slice(0, 10);
        await logActivity(req, 'FULL_PDF_EXPORT', { products: products.length, customers: customers.length, sales: sales.length });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="OKWESIWA-LTD-Full-Export-${stamp}.pdf"`);

        const doc = new PDFDocument({ margin: 40, size: 'A4' });
        doc.pipe(res);

        doc.fontSize(18).fillColor('#273990').text('OKWESIWA LTD — Full Data Export', { align: 'left' });
        doc.fontSize(10).fillColor('#475569').text(`Generated: ${new Date().toLocaleString()}   |   Products: ${products.length}   |   Customers: ${customers.length}   |   Sales: ${sales.length}   |   Suppliers: ${suppliers.length}`);
        doc.moveDown(1);

        const drawSection = (title, lines) => {
            if (doc.y > 700) doc.addPage();
            doc.fontSize(13).fillColor('#273990').text(title);
            doc.moveDown(0.3);
            doc.fontSize(9).fillColor('#0f172a');
            if (!lines.length) {
                doc.text('No records.');
            } else {
                for (const line of lines) {
                    if (doc.y > 760) doc.addPage();
                    doc.text(line);
                }
            }
            doc.moveDown(0.8);
        };

        drawSection('Products & Stock', products.map((p, i) => `${i + 1}. ${p.name} (${p.barcode || '-'}) — ${p.category || 'General'} | Price: ${p.price} | Stock: ${p.stock}`));
        drawSection('Customers', customers.map((c, i) => `${i + 1}. ${c.name} (${c.phone || '-'}) — ${c.customer_type || 'retail'} | Limit: ${c.credit_limit || 0} | Bal: ${c.current_balance || 0}`));
        drawSection('Recent Sales', sales.map((s, i) => `${i + 1}. ${s.receipt_number || '-'} | ${s.customer_name || 'Walk-in'} | ${s.payment_method || '-'} | Total: ${s.total_amount || 0} | ${s.store_location || '-'}`));
        drawSection('Suppliers', suppliers.map((s, i) => `${i + 1}. ${s.name} — ${s.contact_person || '-'} | ${s.phone || '-'} | ${s.email || '-'}`));

        doc.end();
    } catch (err) {
        console.error('GET /api/backups/export-pdf error:', err);
        if (!res.headersSent) res.status(500).json({ message: 'Failed to export PDF' });
    }
});

let schedulerStarted = false;

// Sends the backup JSON to an address outside the database so a DB loss doesn't take the backups with it.
async function sendBackupOffsite(backupId) {
    const to = process.env.BACKUP_EMAIL || process.env.CEO_EMAIL;
    if (!to || !process.env.SMTP_HOST) return { sent: false, reason: 'BACKUP_EMAIL/SMTP not configured' };
    const row = (await pool.query('SELECT filename, payload FROM system_backups WHERE id = $1', [backupId])).rows[0];
    if (!row) return { sent: false, reason: 'backup not found' };
    const nodemailer = require('nodemailer');
    const zlib = require('zlib');
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT,
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    await transporter.sendMail({
        from: `"OKWESIWA LTD" <${process.env.ADMIN_EMAIL}>`,
        to,
        subject: `OKWESIWA LTD nightly backup — ${row.filename}`,
        text: 'Attached is the gzipped nightly database backup. Keep this email as an off-site copy.',
        attachments: [{ filename: `${row.filename}.gz`, content: zlib.gzipSync(JSON.stringify(row.payload)) }]
    });
    return { sent: true, to };
}

async function runNightlyBackup() {
    await ensureBackupsTable();
    let tenantIds = [1];
    try {
        const tRes = await pool.query('SELECT id FROM tenants ORDER BY id ASC');
        if (tRes.rows.length) tenantIds = tRes.rows.map(r => r.id);
    } catch (_) {}

    const results = [];
    for (const tenantId of tenantIds) {
        const recent = await pool.query(
            "SELECT id FROM system_backups WHERE tenant_id = $1 AND backup_type = 'auto' AND created_at > NOW() - INTERVAL '22 hours' LIMIT 1",
            [tenantId]
        );
        if (recent.rows.length) {
            results.push({ tenantId, skipped: true, reason: 'auto backup already taken in last 22 hours' });
            continue;
        }
        const backup = await createBackupSnapshot({ tenantId, backupType: 'auto', createdBy: null });
        const offsite = await sendBackupOffsite(backup.id).catch(e => ({ sent: false, reason: e.message }));
        results.push({ tenantId, skipped: false, backup_id: backup.id, filename: backup.filename, offsite });
    }
    return { skipped: results.every(r => r.skipped), results };
}

// Vercel Cron entry point (configured in vercel.json). Vercel sends "Authorization: Bearer <CRON_SECRET>".
router.get('/api/cron/nightly-backup', async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    try {
        const result = await runNightlyBackup();
        console.log('Nightly backup (cron):', JSON.stringify(result));
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('Nightly backup (cron) failed:', err);
        res.status(500).json({ message: 'Nightly backup failed' });
    }
});

// Long-running servers (non-Vercel) use an in-process timer instead of Vercel Cron.
function startNightlyBackupScheduler() {
    if (schedulerStarted || process.env.VERCEL || !pool) return;
    schedulerStarted = true;
    setInterval(async () => {
        try {
            const result = await runNightlyBackup();
            if (!result.skipped) console.log('✅ Nightly automatic backup completed:', JSON.stringify(result));
        } catch (err) {
            console.warn('Nightly backup check skipped:', err.message);
        }
    }, 6 * 60 * 60 * 1000).unref();
}

module.exports = { router, startNightlyBackupScheduler };

