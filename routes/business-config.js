const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { authenticateToken, requireRole, requirePermission, MANAGER_ROLES } = require('../middleware/auth');
const { logActivity } = require('../services/audit');

let schemaReady = false;
async function ensureBusinessConfigSchema() {
    if (schemaReady || !pool) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS business_settings (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL DEFAULT 1 UNIQUE,
                config JSONB NOT NULL DEFAULT '{}'::jsonb,
                updated_by INTEGER NULL,
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS notification_templates (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL DEFAULT 1,
                template_key VARCHAR(80) NOT NULL,
                category VARCHAR(60) NOT NULL DEFAULT 'customer',
                email_subject VARCHAR(255) DEFAULT '',
                cc VARCHAR(255) DEFAULT '',
                bcc VARCHAR(255) DEFAULT '',
                email_body TEXT DEFAULT '',
                sms_body TEXT DEFAULT '',
                whatsapp_text TEXT DEFAULT '',
                auto_send_email BOOLEAN DEFAULT false,
                auto_send_sms BOOLEAN DEFAULT false,
                auto_send_whatsapp BOOLEAN DEFAULT false,
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(tenant_id, template_key)
            );
        `);
        schemaReady = true;
    } catch (e) {
        console.warn('Business config schema notice:', e.message);
    }
}

const DEFAULT_BUSINESS_CONFIG = {
    business_name: 'OKWESIWA CO LTD',
    start_date: '',
    default_profit_percent: 25,
    currency: 'GHS (₵)',
    currency_symbol_placement: 'Before amount',
    timezone: 'Africa/Accra',
    logo_url: '/okwesiwa-logo.svg',
    financial_year_start_month: 'January',
    stock_accounting_method: 'FIFO',
    transaction_edit_days: 30,
    date_format: 'dd/mm/yyyy',
    time_format: '24 Hour',
    currency_precision: 2,
    quantity_precision: 2,
    accept_second_currency: false,
    second_currency: 'USD ($)',
    // Tax
    tax_1_name: 'VAT',
    tax_1_no: '',
    tax_2_name: 'NHIL / GETFund',
    tax_2_no: '',
    enable_inline_tax: false,
    // Product
    sku_prefix: 'OKW',
    enable_product_expiry: false,
    enable_brands: true,
    enable_categories: true,
    enable_sub_categories: false,
    enable_price_tax_info: true,
    default_unit: 'Unit',
    enable_sub_units: true,
    enable_racks: false,
    enable_row: false,
    enable_position: false,
    enable_warranty: false,
    product_image_required: false,
    // Invoice
    invoice_prefix: 'INV',
    invoice_scheme: 'YYYY-0001',
    invoice_layout: 'Default A4 / Thermal',
    show_logo_on_invoice: true,
    invoice_footer_text: 'Thank you for doing business with us!',
    // Barcode
    barcode_type: 'Code 128',
    barcode_width: 2,
    barcode_height: 40,
    show_price_on_barcode: true,
    show_business_name_on_barcode: true,
    // Printers
    printer_name: 'Default Receipt Printer',
    printer_type: 'Browser / ESC-POS',
    paper_width_mm: 80,
    auto_print_receipt: false,
    char_per_line: 42
};

const DEFAULT_TEMPLATES = [
    { template_key: 'send_ledger', category: 'general', email_subject: 'Account Ledger - {business_name}', email_body: 'Dear {contact_name},\n\nPlease find your current account balance due: {balance_due}.\n\nRegards,\n{business_name}' },
    { template_key: 'new_sale', category: 'customer', email_subject: 'Invoice {invoice_number} from {business_name}', email_body: 'Dear {contact_name},\n\nThank you for your purchase. Invoice {invoice_number} total: {total_amount}, Paid: {paid_amount}, Due: {due_amount}.\n\n{business_name}', sms_body: 'Thanks {contact_name}! Invoice {invoice_number}: Total {total_amount}, Paid {paid_amount}. - {business_name}', whatsapp_text: 'Hello {contact_name}, your invoice {invoice_number} from {business_name} is ready. Total: {total_amount}.' },
    { template_key: 'payment_received', category: 'customer', email_subject: 'Payment Received - {invoice_number}', email_body: 'Dear {contact_name},\n\nWe have received your payment of {paid_amount} for invoice {invoice_number}. Remaining due: {due_amount}.', sms_body: 'Payment of {paid_amount} received for {invoice_number}. Thank you! - {business_name}', whatsapp_text: 'Payment of {paid_amount} received for {invoice_number}.' },
    { template_key: 'payment_reminder', category: 'customer', email_subject: 'Payment Reminder - {invoice_number}', email_body: 'Dear {contact_name},\n\nThis is a friendly reminder that {due_amount} is due on {due_date} for invoice {invoice_number}.', sms_body: 'Reminder: {due_amount} is due for {invoice_number} on {due_date}. - {business_name}', whatsapp_text: 'Reminder from {business_name}: {due_amount} is due for {invoice_number}.' },
    { template_key: 'new_booking', category: 'customer', email_subject: 'Booking Confirmation - {business_name}', email_body: 'Dear {contact_name}, your booking at {location_name} is confirmed.' },
    { template_key: 'new_quotation', category: 'customer', email_subject: 'Quotation from {business_name}', email_body: 'Dear {contact_name},\n\nPlease find your quotation total: {total_amount} valid until {due_date}.' },
    { template_key: 'new_order', category: 'supplier', email_subject: 'New Purchase Order {order_ref_number}', email_body: 'Dear {contact_name},\n\nPlease find our new order {order_ref_number} totaling {total_amount} for {location_name}.' },
    { template_key: 'payment_paid', category: 'supplier', email_subject: 'Supplier Payment Advice - {order_ref_number}', email_body: 'Dear {contact_name},\n\nPayment has been made against order {order_ref_number}. Balance due: {due_amount}.' },
    { template_key: 'items_received', category: 'supplier', email_subject: 'Items Received - {order_ref_number}', email_body: 'Dear {contact_name},\n\nItems for order {order_ref_number} have been received at {location_name}.' },
    { template_key: 'items_pending', category: 'supplier', email_subject: 'Pending Items - {order_ref_number}', email_body: 'Dear {contact_name},\n\nSome items on order {order_ref_number} are still pending delivery.' },
    { template_key: 'purchase_order', category: 'supplier', email_subject: 'Purchase Order {order_ref_number} - {business_name}', email_body: 'Dear {contact_name},\n\nAttached is Purchase Order {order_ref_number} ({total_amount}).' }
];

router.get('/api/business-settings', authenticateToken, async (req, res) => {
    await ensureBusinessConfigSchema();
    const tenantId = req.user.tenant_id || 1;
    try {
        const r = await pool.query('SELECT config FROM business_settings WHERE tenant_id = $1 LIMIT 1', [tenantId]);
        const saved = (r.rows[0] && r.rows[0].config) || {};
        res.json({ config: { ...DEFAULT_BUSINESS_CONFIG, ...saved } });
    } catch (err) {
        console.error('GET /api/business-settings error:', err);
        res.status(500).json({ message: 'Failed to load business settings' });
    }
});

router.put('/api/business-settings', authenticateToken, requireRole(MANAGER_ROLES), requirePermission('settings', 'edit'), async (req, res) => {
    await ensureBusinessConfigSchema();
    const tenantId = req.user.tenant_id || 1;
    const incoming = (req.body && req.body.config) || req.body || {};
    try {
        const existing = await pool.query('SELECT config FROM business_settings WHERE tenant_id = $1 LIMIT 1', [tenantId]);
        const merged = { ...DEFAULT_BUSINESS_CONFIG, ...((existing.rows[0] && existing.rows[0].config) || {}), ...incoming };
        await pool.query(
            `INSERT INTO business_settings (tenant_id, config, updated_by, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (tenant_id) DO UPDATE SET config = EXCLUDED.config, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
            [tenantId, JSON.stringify(merged), req.user.id || null]
        );
        // Sync key fields back to system_settings so Print/PDF/Excel exports use updated name & logo
        try {
            await pool.query(
                `UPDATE system_settings SET store_name = COALESCE(NULLIF($1, ''), store_name), logo_url = COALESCE(NULLIF($2, ''), logo_url), tax_id = COALESCE(NULLIF($3, ''), tax_id) WHERE COALESCE(tenant_id, 1) = $4`,
                [merged.business_name || '', merged.logo_url || '', merged.tax_1_no || '', tenantId]
            );
        } catch (_) {}
        await logActivity(req, 'BUSINESS_SETTINGS_UPDATED', { business_name: merged.business_name });
        res.json({ success: true, config: merged });
    } catch (err) {
        console.error('PUT /api/business-settings error:', err);
        res.status(500).json({ message: 'Failed to save business settings' });
    }
});

router.get('/api/notification-templates', authenticateToken, async (req, res) => {
    await ensureBusinessConfigSchema();
    const tenantId = req.user.tenant_id || 1;
    try {
        const r = await pool.query('SELECT * FROM notification_templates WHERE tenant_id = $1 ORDER BY id ASC', [tenantId]);
        const byKey = new Map(r.rows.map(row => [row.template_key, row]));
        const templates = DEFAULT_TEMPLATES.map(def => ({
            cc: '', bcc: '', sms_body: '', whatsapp_text: '',
            auto_send_email: false, auto_send_sms: false, auto_send_whatsapp: false,
            ...def,
            ...(byKey.get(def.template_key) || {})
        }));
        res.json({ templates });
    } catch (err) {
        console.error('GET /api/notification-templates error:', err);
        res.status(500).json({ message: 'Failed to load notification templates' });
    }
});

router.put('/api/notification-templates/:templateKey', authenticateToken, requireRole(MANAGER_ROLES), requirePermission('settings', 'edit'), async (req, res) => {
    await ensureBusinessConfigSchema();
    const tenantId = req.user.tenant_id || 1;
    const key = String(req.params.templateKey || '').trim();
    const def = DEFAULT_TEMPLATES.find(t => t.template_key === key);
    if (!def) return res.status(404).json({ message: 'Unknown template key' });
    const b = req.body || {};
    try {
        const r = await pool.query(
            `INSERT INTO notification_templates (
                tenant_id, template_key, category, email_subject, cc, bcc, email_body, sms_body, whatsapp_text,
                auto_send_email, auto_send_sms, auto_send_whatsapp, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
            ON CONFLICT (tenant_id, template_key) DO UPDATE SET
                email_subject = EXCLUDED.email_subject,
                cc = EXCLUDED.cc,
                bcc = EXCLUDED.bcc,
                email_body = EXCLUDED.email_body,
                sms_body = EXCLUDED.sms_body,
                whatsapp_text = EXCLUDED.whatsapp_text,
                auto_send_email = EXCLUDED.auto_send_email,
                auto_send_sms = EXCLUDED.auto_send_sms,
                auto_send_whatsapp = EXCLUDED.auto_send_whatsapp,
                updated_at = NOW()
            RETURNING *`,
            [
                tenantId, key, def.category,
                String(b.email_subject || ''), String(b.cc || ''), String(b.bcc || ''),
                String(b.email_body || ''), String(b.sms_body || ''), String(b.whatsapp_text || ''),
                Boolean(b.auto_send_email), Boolean(b.auto_send_sms), Boolean(b.auto_send_whatsapp)
            ]
        );
        await logActivity(req, 'NOTIFICATION_TEMPLATE_UPDATED', { template_key: key });
        res.json({ success: true, template: r.rows[0] });
    } catch (err) {
        console.error('PUT /api/notification-templates error:', err);
        res.status(500).json({ message: 'Failed to save notification template' });
    }
});

router.post('/api/notification-templates/test-email', authenticateToken, requireRole(MANAGER_ROLES), async (req, res) => {
    const { to, subject, body } = req.body || {};
    if (!to || !String(to).includes('@')) {
        return res.status(400).json({ message: 'Valid recipient email is required' });
    }
    const host = process.env.SMTP_HOST;
    const user = process.env.SMTP_USER || process.env.EMAIL_USER;
    const pass = process.env.SMTP_PASS || process.env.EMAIL_PASS;
    if (!host && !user) {
        return res.status(400).json({ message: 'SMTP is not configured in environment (.env)' });
    }
    try {
        const nodemailer = require('nodemailer');
        const transporter = host
            ? nodemailer.createTransport({
                host,
                port: parseInt(process.env.SMTP_PORT || '587', 10),
                secure: String(process.env.SMTP_PORT) === '465',
                auth: user ? { user, pass } : undefined
            })
            : nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });

        await transporter.sendMail({
            from: process.env.EMAIL_FROM || user || 'no-reply@okwesiwa.local',
            to: String(to).trim(),
            subject: String(subject || 'OKWESIWA CO LTD Notification Preview'),
            text: String(body || 'Sample notification message from OKWESIWA CO LTD.')
        });
        await logActivity(req, 'NOTIFICATION_TEST_EMAIL_SENT', { to });
        res.json({ success: true, message: `Test email sent to ${to}` });
    } catch (err) {
        console.error('POST /api/notification-templates/test-email error:', err);
        res.status(500).json({ message: `SMTP send failed: ${err.message}` });
    }
});

module.exports = router;

