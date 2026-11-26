const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { authenticateToken, requirePermission, MANAGER_ROLES } = require('../middleware/auth');
const { logActivity } = require('../services/audit');

const isCeoOrAdmin = (req) => ['super_admin', 'ceo', 'admin'].includes(String(req.user?.role || '').toLowerCase());

const PERMISSION_MODULES = [
    { key: 'home', label: '1. Home & Dashboard', actions: ['view'] },
    { key: 'users', label: '2.1 Users', actions: ['view', 'create', 'edit', 'delete'] },
    { key: 'roles', label: '2.2 Roles & Permissions', actions: ['view', 'create', 'edit', 'delete'] },
    { key: 'sales_agents', label: '2.3 Sales Agents', actions: ['view', 'create', 'edit', 'delete'] },
    { key: 'attendance', label: '2.4 Attendance', actions: ['view', 'create', 'edit'] },
    { key: 'customers', label: '3. Customers & Groups', actions: ['view', 'create', 'edit', 'delete', 'approve'] },
    { key: 'suppliers', label: '3.3 Suppliers', actions: ['view', 'create', 'edit', 'delete'] },
    { key: 'products', label: '4. Products, Brands & Units', actions: ['view', 'create', 'edit', 'delete'] },
    { key: 'prices', label: '4.3 Prices & Price Groups', actions: ['view', 'edit', 'approve'] },
    { key: 'sales', label: '5. Sales & POS', actions: ['view', 'create', 'edit', 'delete', 'approve'] },
    { key: 'quotations', label: '5.3 Quotations', actions: ['view', 'create', 'edit', 'delete'] },
    { key: 'deliveries', label: '5.7 Deliveries', actions: ['view', 'create', 'edit'] },
    { key: 'purchases', label: '6. Purchases & Reorder', actions: ['view', 'create', 'edit', 'approve'] },
    { key: 'stock', label: '7-8. Stock, Transfers & Counts', actions: ['view', 'create', 'edit', 'approve'] },
    { key: 'daily_close', label: '9. Daily Close', actions: ['view', 'create', 'export'] },
    { key: 'expenses', label: '10. Expenses', actions: ['view', 'create', 'edit', 'delete'] },
    { key: 'accounts', label: '11. Accounts & Cash Book', actions: ['view', 'create', 'edit'] },
    { key: 'reports', label: '12. Reports & Analytics', actions: ['view', 'export'] },
    { key: 'notifications', label: '13. Notifications (SMS/WhatsApp)', actions: ['view', 'create', 'edit'] },
    { key: 'settings', label: '14. Settings & Backups', actions: ['view', 'edit', 'export'] }
];

const GRANULAR_PERMISSION_GROUPS = [
    { key: 'others', label: 'Others', selectAll: true, items: [
        { key: 'others.export_buttons', label: 'View export to buttons (csv/excel/print/pdf) on tables' },
        { key: 'others.notify_payment_received', label: 'Send Payment Received Notification' },
        { key: 'others.notify_payment_reminder', label: 'Send Payment Reminder Notification' }
    ]},
    { key: 'users', label: 'User', selectAll: true, items: [
        { key: 'users.view', label: 'View user' },
        { key: 'users.create', label: 'Add user' },
        { key: 'users.edit', label: 'Edit user' },
        { key: 'users.delete', label: 'Delete user' }
    ]},
    { key: 'roles', label: 'Roles', selectAll: true, items: [
        { key: 'roles.view', label: 'View role' },
        { key: 'roles.create', label: 'Add Role' },
        { key: 'roles.edit', label: 'Edit Role' },
        { key: 'roles.delete', label: 'Delete role' }
    ]},
    { key: 'suppliers', label: 'Supplier', selectAll: true, items: [
        { key: 'suppliers.view_all', label: 'View all supplier' },
        { key: 'suppliers.view_own', label: 'View own supplier' },
        { key: 'suppliers.create', label: 'Add supplier' },
        { key: 'suppliers.edit', label: 'Edit supplier' },
        { key: 'suppliers.delete', label: 'Delete supplier' }
    ]},
    { key: 'customers', label: 'Customer', selectAll: true, items: [
        { key: 'customers.view_all', label: 'View all customer' },
        { key: 'customers.view_own', label: 'View own customer' },
        { key: 'customers.no_sell_1m', label: 'View customers with no sell from one month only' },
        { key: 'customers.no_sell_3m', label: 'View customers with no sell from three months only' },
        { key: 'customers.no_sell_6m', label: 'View customers with no sell from six months only' },
        { key: 'customers.no_sell_1y', label: 'View customers with no sell from one year only' },
        { key: 'customers.view_irrespective', label: 'View customers irrespective of their sell' },
        { key: 'customers.create', label: 'Add customer' },
        { key: 'customers.edit', label: 'Edit customer' },
        { key: 'customers.delete', label: 'Delete customer' }
    ]},
    { key: 'products', label: 'Product', selectAll: true, items: [
        { key: 'products.view', label: 'View product' },
        { key: 'products.create', label: 'Add product' },
        { key: 'products.edit', label: 'Edit product' },
        { key: 'products.delete', label: 'Delete product' },
        { key: 'products.opening_stock', label: 'Add Opening Stock' },
        { key: 'products.view_purchase_price', label: 'View Purchase Price' }
    ]},
    { key: 'purchases', label: 'Purchase', selectAll: true, items: [
        { key: 'purchases.view_all', label: 'View all Purchase' },
        { key: 'purchases.view_own', label: 'View own Purchase' },
        { key: 'purchases.create', label: 'Add purchase' },
        { key: 'purchases.edit', label: 'Edit purchase' },
        { key: 'purchases.delete', label: 'Delete purchase' },
        { key: 'purchases.add_payment', label: 'Add purchase payment' },
        { key: 'purchases.edit_payment', label: 'Edit purchase payment' },
        { key: 'purchases.delete_payment', label: 'Delete purchase payment' },
        { key: 'purchases.update_status', label: 'Update Status' },
        { key: 'purchases.hide_price', label: 'Hide Price Details' }
    ]},
    { key: 'stock_adjustment', label: 'Stock Adjustment', selectAll: true, items: [
        { key: 'stock_adjustment.view_all', label: 'View all stock adjustment' },
        { key: 'stock_adjustment.view_own', label: 'View own stock adjustment' },
        { key: 'stock_adjustment.create', label: 'Add stock adjustment' },
        { key: 'stock_adjustment.edit', label: 'Edit stock adjustment' },
        { key: 'stock_adjustment.delete', label: 'Delete stock adjustment' }
    ]},
    { key: 'stock_transfer', label: 'Stock Transfer', selectAll: true, items: [
        { key: 'stock_transfer.view_all', label: 'View all stock transfer' },
        { key: 'stock_transfer.view_own', label: 'View own stock transfer' },
        { key: 'stock_transfer.create', label: 'Add stock transfer' },
        { key: 'stock_transfer.edit', label: 'Edit stock transfer' },
        { key: 'stock_transfer.delete', label: 'Delete stock transfer' }
    ]},
    { key: 'pos', label: 'POS', selectAll: true, items: [
        { key: 'pos.view', label: 'View POS sell' },
        { key: 'pos.create', label: 'Add POS sell' },
        { key: 'pos.edit', label: 'Edit POS sell' },
        { key: 'pos.delete', label: 'Delete POS sell' },
        { key: 'pos.edit_price', label: 'Edit product price from POS screen' },
        { key: 'pos.edit_discount', label: 'Edit product discount from POS screen' },
        { key: 'pos.redeem_points', label: 'Redeem reward points from POS screen' },
        { key: 'pos.add_edit_payment', label: 'Add/Edit Payment' },
        { key: 'pos.print_invoice', label: 'Print Invoice' },
        { key: 'pos.disable_multiple_pay', label: 'Disable Multiple Pay' },
        { key: 'pos.disable_draft', label: 'Disable Draft' },
        { key: 'pos.disable_express_checkout', label: 'Disable Express Checkout' },
        { key: 'pos.disable_discount', label: 'Disable Discount' },
        { key: 'pos.disable_suspend', label: 'Disable Suspend Sale' },
        { key: 'pos.disable_credit', label: 'Disable credit sale button' },
        { key: 'pos.disable_quotation', label: 'Disable Quotation' },
        { key: 'pos.disable_card', label: 'Disable Card' }
    ]},
    { key: 'sales', label: 'Sell', selectAll: true, items: [
        { key: 'sales.view_all', label: 'View all sell' },
        { key: 'sales.view_own', label: 'View own sell only' },
        { key: 'sales.view_paid', label: 'View paid sells only' },
        { key: 'sales.view_due', label: 'View due sells only' },
        { key: 'sales.view_partial', label: 'View partially paid sells only' },
        { key: 'sales.view_overdue', label: 'View overdue sells only' },
        { key: 'sales.create', label: 'Add Sell' },
        { key: 'sales.edit', label: 'Update Sell' },
        { key: 'sales.delete', label: 'Delete Sell' },
        { key: 'sales.commission_own', label: 'Commission agent can view their own sell' },
        { key: 'sales.add_payment', label: 'Add sell payment' },
        { key: 'sales.edit_payment', label: 'Edit sell payment' },
        { key: 'sales.delete_payment', label: 'Delete sell payment' },
        { key: 'sales.edit_price', label: 'Edit product price from sales screen' },
        { key: 'sales.edit_discount', label: 'Edit product discount from Sale screen' },
        { key: 'sales.manage_discount', label: 'Add/Edit/Delete Discount' },
        { key: 'sales.exchange_rate', label: 'Set exchange rate' },
        { key: 'sales.return_all', label: 'Access all sell return' },
        { key: 'sales.return_own', label: 'Access own sell return' },
        { key: 'sales.edit_invoice_no', label: 'Add edit invoice number' }
    ]},
    { key: 'drafts', label: 'Draft', selectAll: true, items: [
        { key: 'drafts.view_all', label: 'View all drafts' },
        { key: 'drafts.view_own', label: 'View own drafts' },
        { key: 'drafts.edit', label: 'Edit draft' },
        { key: 'drafts.delete', label: 'Delete draft' }
    ]},
    { key: 'quotations', label: 'Quotation', selectAll: true, items: [
        { key: 'quotations.view_all', label: 'View all quotations' },
        { key: 'quotations.view_own', label: 'View own quotations' },
        { key: 'quotations.edit', label: 'Edit quotation' },
        { key: 'quotations.delete', label: 'Delete quotation' }
    ]},
    { key: 'shipments', label: 'Shipments', selectAll: true, items: [
        { key: 'shipments.access_all', label: 'Access all shipments' },
        { key: 'shipments.access_own', label: 'Access own shipments' },
        { key: 'shipments.access_pending', label: 'Access pending shipments only' },
        { key: 'shipments.commission_own', label: 'Commission agent can access their own shipments' }
    ]},
    { key: 'cash_register', label: 'Cash Register', selectAll: true, items: [
        { key: 'cash_register.view', label: 'View cash register' },
        { key: 'cash_register.close', label: 'Close cash register' }
    ]},
    { key: 'brands', label: 'Brand', selectAll: true, items: [
        { key: 'brands.view', label: 'View brand' },
        { key: 'brands.create', label: 'Add brand' },
        { key: 'brands.edit', label: 'Edit brand' },
        { key: 'brands.delete', label: 'Delete brand' }
    ]},
    { key: 'tax_rates', label: 'Tax rate', selectAll: true, items: [
        { key: 'tax_rates.view', label: 'View tax rate' },
        { key: 'tax_rates.create', label: 'Add tax rate' },
        { key: 'tax_rates.edit', label: 'Edit tax rate' },
        { key: 'tax_rates.delete', label: 'Delete tax rate' }
    ]},
    { key: 'units', label: 'Unit', selectAll: true, items: [
        { key: 'units.view', label: 'View unit' },
        { key: 'units.create', label: 'Add unit' },
        { key: 'units.edit', label: 'Edit unit' },
        { key: 'units.delete', label: 'Delete unit' }
    ]},
    { key: 'categories', label: 'Category', selectAll: true, items: [
        { key: 'categories.view', label: 'View category' },
        { key: 'categories.create', label: 'Add category' },
        { key: 'categories.edit', label: 'Edit category' },
        { key: 'categories.delete', label: 'Delete category' }
    ]},
    { key: 'reports', label: 'Report', selectAll: true, items: [
        { key: 'reports.purchase_sell', label: 'View purchase & sell report' },
        { key: 'reports.tax', label: 'View Tax report' },
        { key: 'reports.supplier_customer', label: 'View Supplier & Customer report' },
        { key: 'reports.expense', label: 'View expense report' },
        { key: 'reports.profit_loss', label: 'View profit/loss report' },
        { key: 'reports.stock', label: 'View stock report, stock adjustment report & stock expiry report' },
        { key: 'reports.trending', label: 'View trending product report' },
        { key: 'reports.register', label: 'View register report' },
        { key: 'reports.sales_rep', label: 'View sales representative report' },
        { key: 'reports.stock_value', label: 'View product stock value' }
    ]},
    { key: 'settings', label: 'Settings', selectAll: true, items: [
        { key: 'settings.business', label: 'Access business settings' },
        { key: 'settings.barcode', label: 'Access barcode settings' },
        { key: 'settings.invoice', label: 'Access invoice settings' },
        { key: 'settings.printers', label: 'Access printers' }
    ]},
    { key: 'expenses', label: 'Expense', selectAll: true, items: [
        { key: 'expenses.access_all', label: 'Access all expenses' },
        { key: 'expenses.view_own', label: 'View own expense only' },
        { key: 'expenses.create', label: 'Add Expense' },
        { key: 'expenses.edit', label: 'Edit Expense' },
        { key: 'expenses.delete', label: 'Delete Expense' }
    ]},
    { key: 'home', label: 'Home', selectAll: false, items: [
        { key: 'home.view', label: 'View Home data' }
    ]},
    { key: 'accounts', label: 'Account', selectAll: false, items: [
        { key: 'accounts.access', label: 'Access Accounts' },
        { key: 'accounts.edit_tx', label: 'Edit account transaction' },
        { key: 'accounts.delete_tx', label: 'Delete account transaction' }
    ]},
    { key: 'selling_price_groups', label: 'Access selling price groups', selectAll: false, items: [
        { key: 'selling_price_groups.default', label: 'Default Selling Price' }
    ]},
    { key: 'accounting', label: 'Accounting', selectAll: false, items: [
        { key: 'accounting.access', label: 'Access Accounting Module' },
        { key: 'accounting.manage_accounts', label: 'Manage Accounts' },
        { key: 'accounting.view_journal', label: 'View Journal' },
        { key: 'accounting.add_journal', label: 'Add Journal' },
        { key: 'accounting.edit_journal', label: 'Edit Journal' },
        { key: 'accounting.delete_journal', label: 'Delete Journal' },
        { key: 'accounting.map_transactions', label: 'Map Transactions' },
        { key: 'accounting.view_transfer', label: 'View Transfer' },
        { key: 'accounting.add_transfer', label: 'Add Transfer' },
        { key: 'accounting.edit_transfer', label: 'Edit Transfer' },
        { key: 'accounting.delete_transfer', label: 'Delete Transfer' },
        { key: 'accounting.manage_budget', label: 'Manage Budget' },
        { key: 'accounting.view_reports', label: 'View Reports' }
    ]},
    { key: 'asset_management', label: 'AssetManagement', selectAll: false, items: [
        { key: 'asset.view', label: 'View Asset' },
        { key: 'asset.create', label: 'Add asset' },
        { key: 'asset.edit', label: 'Edit asset' },
        { key: 'asset.delete', label: 'Delete asset' },
        { key: 'asset.view_all_maintenance', label: 'View all maintenance' },
        { key: 'asset.view_own_maintenance', label: 'View own maintenance' }
    ]},
    { key: 'crm', label: 'Crm', selectAll: false, items: [
        { key: 'crm.follow_up_all', label: 'Access all follow up' },
        { key: 'crm.follow_up_own', label: 'Access own follow up' },
        { key: 'crm.leads_all', label: 'Access all leads' },
        { key: 'crm.leads_own', label: 'Access own leads' },
        { key: 'crm.campaigns_all', label: 'Access all campaigns' },
        { key: 'crm.campaigns_own', label: 'Access own campaigns' },
        { key: 'crm.contact_login', label: 'Access contact login' },
        { key: 'crm.sources', label: 'Access sources' },
        { key: 'crm.life_stage', label: 'Access life stage' },
        { key: 'crm.proposal', label: 'Access proposal' }
    ]},
    { key: 'essentials', label: 'Essentials', selectAll: false, items: [
        { key: 'essentials.leave_type', label: 'Add/Edit/View/Delete leave type' },
        { key: 'essentials.leave_all', label: 'Add/Edit/View/Delete all leave' },
        { key: 'essentials.leave_own', label: 'Add/View own leave' },
        { key: 'essentials.approve_leave', label: 'Approve Leave' },
        { key: 'essentials.attendance_all', label: 'Add/Edit/View/Delete all attendance' },
        { key: 'essentials.attendance_own', label: 'View own attendance' },
        { key: 'essentials.attendance_web', label: 'Allow users to enter their own attendance from web' },
        { key: 'essentials.attendance_api', label: 'Allow users to enter their own attendance from api' },
        { key: 'essentials.pay_component_view', label: 'View Pay Component' },
        { key: 'essentials.pay_component_add', label: 'Add Pay Component' },
        { key: 'essentials.department', label: 'Add/Edit/View/Delete department' },
        { key: 'essentials.designation', label: 'Add/Edit/View/Delete designation' },
        { key: 'essentials.payroll_view', label: 'View all Payroll' },
        { key: 'essentials.payroll_add', label: 'Add Payroll' },
        { key: 'essentials.payroll_edit', label: 'Edit Payroll' },
        { key: 'essentials.payroll_delete', label: 'Delete Payroll' },
        { key: 'essentials.todo_assign', label: "Assign To Do's to others" },
        { key: 'essentials.todo_add', label: "Add To Do's" },
        { key: 'essentials.todo_edit', label: "Edit To Do's" },
        { key: 'essentials.todo_delete', label: "Delete To Do's" },
        { key: 'essentials.message_create', label: 'Create Message' },
        { key: 'essentials.message_view', label: 'View Message' },
        { key: 'essentials.sales_targets', label: 'Access Sales Targets' }
    ]},
    { key: 'manufacturing', label: 'Manufacturing', selectAll: false, items: [
        { key: 'manufacturing.view_recipe', label: 'View Recipe' },
        { key: 'manufacturing.add_recipe', label: 'Add Recipe' },
        { key: 'manufacturing.edit_recipe', label: 'Edit Recipe' },
        { key: 'manufacturing.production', label: 'Access Production' }
    ]},
    { key: 'project', label: 'Project', selectAll: false, items: [
        { key: 'project.create', label: 'Create Project' },
        { key: 'project.edit', label: 'Edit Project' },
        { key: 'project.delete', label: 'Delete Project' }
    ]},
    { key: 'repair', label: 'Repair', selectAll: false, items: [
        { key: 'repair.add_invoice', label: 'Add Invoice' },
        { key: 'repair.edit_invoice', label: 'Edit Invoice' },
        { key: 'repair.view_all_invoice', label: 'View all invoice' },
        { key: 'repair.view_own_invoice', label: 'View own invoice' },
        { key: 'repair.delete_invoice', label: 'Delete Invoice' },
        { key: 'repair.change_status', label: 'Change Invoice Status' },
        { key: 'repair.job_sheet_status', label: 'Add/Edit/Delete Job Sheet Status' },
        { key: 'repair.add_job_sheet', label: 'Add job sheet' },
        { key: 'repair.edit_job_sheet', label: 'Edit job sheet' },
        { key: 'repair.delete_job_sheet', label: 'Delete job sheet' },
        { key: 'repair.view_assigned_job_sheet', label: 'View Only Assigned Job Sheet' },
        { key: 'repair.view_all_job_sheets', label: 'View All Job Sheets' }
    ]},
    { key: 'superadmin', label: 'Superadmin', selectAll: false, items: [
        { key: 'superadmin.subscriptions', label: 'Access package subscriptions' }
    ]}
];

const DEFAULT_ROLES = [
    {
        name: 'CEO',
        slug: 'ceo',
        description: 'Full access across all branches, approvals, reports, roles and backups.',
        is_system: true,
        permissions: Object.fromEntries(PERMISSION_MODULES.map(m => [m.key, [...m.actions]]))
    },
    {
        name: 'Manager',
        slug: 'manager',
        description: 'Own branch operations, approvals up to limit, stock, purchases and branch reports.',
        is_system: true,
        permissions: {
            home: ['view'],
            users: ['view', 'create', 'edit'],
            customers: ['view', 'create', 'edit'],
            suppliers: ['view', 'create', 'edit'],
            products: ['view', 'create', 'edit'],
            prices: ['view'],
            sales: ['view', 'create', 'edit', 'approve'],
            quotations: ['view', 'create', 'edit'],
            deliveries: ['view', 'create', 'edit'],
            purchases: ['view', 'create', 'edit'],
            stock: ['view', 'create', 'edit'],
            daily_close: ['view', 'create', 'export'],
            expenses: ['view', 'create', 'edit'],
            accounts: ['view', 'create'],
            reports: ['view', 'export'],
            notifications: ['view', 'create'],
            settings: ['view']
        }
    },
    {
        name: 'Teller',
        slug: 'teller',
        description: 'Open till, POS sales, quotations, drafts, quick-add customer, own shift summary.',
        is_system: true,
        permissions: {
            home: ['view'],
            customers: ['view', 'create'],
            products: ['view'],
            prices: ['view'],
            sales: ['view', 'create'],
            quotations: ['view', 'create'],
            deliveries: ['view', 'create'],
            stock: ['view'],
            daily_close: ['view'],
            reports: ['view']
        }
    },
    {
        name: 'Storekeeper',
        slug: 'storekeeper',
        description: 'Yard, warehouse & shop stock receiving, transfers and physical stock counts.',
        is_system: false,
        permissions: {
            products: ['view'],
            purchases: ['view', 'edit'],
            stock: ['view', 'create', 'edit'],
            deliveries: ['view', 'edit']
        }
    },
    {
        name: 'Driver',
        slug: 'driver',
        description: 'Site deliveries, waybills and delivery signature capture.',
        is_system: false,
        permissions: {
            deliveries: ['view', 'edit'],
            customers: ['view']
        }
    }
];

async function ensureRolesTable() {
    if (!pool) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS roles (
            id SERIAL PRIMARY KEY,
            tenant_id INTEGER DEFAULT 1,
            name VARCHAR(100) NOT NULL,
            slug VARCHAR(100) NOT NULL,
            description TEXT DEFAULT '',
            is_system BOOLEAN DEFAULT false,
            permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(tenant_id, slug)
        );
    `);

    const countRes = await pool.query('SELECT COUNT(*)::int AS cnt FROM roles');
    if (countRes.rows[0].cnt === 0) {
        for (const r of DEFAULT_ROLES) {
            await pool.query(
                `INSERT INTO roles (tenant_id, name, slug, description, is_system, permissions)
                 VALUES (1, $1, $2, $3, $4, $5)
                 ON CONFLICT (tenant_id, slug) DO NOTHING`,
                [r.name, r.slug, r.description, r.is_system, JSON.stringify(r.permissions)]
            );
        }
    }
}

function canManageRoles(req) {
    const role = (req.user?.role || '').toLowerCase();
    return MANAGER_ROLES.includes(role);
}

router.get('/api/roles/modules', authenticateToken, (req, res) => {
    res.json({ modules: PERMISSION_MODULES, groups: GRANULAR_PERMISSION_GROUPS });
});

router.get('/api/roles', authenticateToken, async (req, res) => {
    try {
        await ensureRolesTable();
        const tenantId = req.user.tenant_id || 1;
        const result = await pool.query(
            'SELECT id, name, slug, description, is_system, permissions, created_at, updated_at FROM roles WHERE tenant_id = $1 ORDER BY is_system DESC, id ASC',
            [tenantId]
        );
        res.json({ roles: result.rows, modules: PERMISSION_MODULES, groups: GRANULAR_PERMISSION_GROUPS });
    } catch (err) {
        console.error('GET /api/roles error:', err);
        res.status(500).json({ message: 'Failed to load roles' });
    }
});

router.post('/api/roles', authenticateToken, requirePermission('roles', 'create'), async (req, res) => {
    if (!canManageRoles(req)) {
        return res.status(403).json({ message: 'Manager or CEO access required to create roles' });
    }
    try {
        await ensureRolesTable();
        const { name, description = '', permissions = {} } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ message: 'Role name is required' });
        }
        const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        const tenantId = req.user.tenant_id || 1;
        const result = await pool.query(
            `INSERT INTO roles (tenant_id, name, slug, description, is_system, permissions)
             VALUES ($1, $2, $3, $4, false, $5)
             RETURNING *`,
            [tenantId, name.trim(), slug, description, JSON.stringify(permissions)]
        );
        await logActivity(req, 'ROLE_CREATED', { role_id: result.rows[0].id, name: name.trim() });
        res.status(201).json({ success: true, role: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ message: 'A role with this name already exists' });
        }
        console.error('POST /api/roles error:', err);
        res.status(500).json({ message: 'Failed to create role' });
    }
});

router.put('/api/roles/:id', authenticateToken, requirePermission('roles', 'edit'), async (req, res) => {
    if (!canManageRoles(req)) {
        return res.status(403).json({ message: 'Manager or CEO access required to update roles' });
    }
    try {
        await ensureRolesTable();
        const { id } = req.params;
        const { name, description, permissions } = req.body;
        const tenantId = req.user.tenant_id || 1;
        const existing = await pool.query('SELECT * FROM roles WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ message: 'Role not found' });
        }
        const curr = existing.rows[0];
        const nextName = (name && !curr.is_system) ? name.trim() : curr.name;
        const nextDesc = description !== undefined ? description : curr.description;
        const nextPerms = permissions !== undefined ? permissions : curr.permissions;

        const result = await pool.query(
            `UPDATE roles SET name = $1, description = $2, permissions = $3, updated_at = NOW()
             WHERE id = $4 AND tenant_id = $5 RETURNING *`,
            [nextName, nextDesc, JSON.stringify(nextPerms), id, tenantId]
        );
        await logActivity(req, 'ROLE_UPDATED', { role_id: id, name: nextName });
        res.json({ success: true, role: result.rows[0] });
    } catch (err) {
        console.error('PUT /api/roles/:id error:', err);
        res.status(500).json({ message: 'Failed to update role' });
    }
});

router.post('/api/roles/:id/copy', authenticateToken, async (req, res) => {
    if (!canManageRoles(req)) {
        return res.status(403).json({ message: 'Manager or CEO access required to copy roles' });
    }
    try {
        await ensureRolesTable();
        const { id } = req.params;
        const tenantId = req.user.tenant_id || 1;
        const src = await pool.query('SELECT * FROM roles WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
        if (src.rows.length === 0) {
            return res.status(404).json({ message: 'Source role not found' });
        }
        const source = src.rows[0];
        const newName = (req.body && req.body.name) ? req.body.name.trim() : `${source.name} (Copy)`;
        const slug = `${newName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${Date.now().toString().slice(-4)}`;
        const result = await pool.query(
            `INSERT INTO roles (tenant_id, name, slug, description, is_system, permissions)
             VALUES ($1, $2, $3, $4, false, $5) RETURNING *`,
            [tenantId, newName, slug, source.description, JSON.stringify(source.permissions)]
        );
        await logActivity(req, 'ROLE_COPIED', { source_id: id, new_id: result.rows[0].id, name: newName });
        res.status(201).json({ success: true, role: result.rows[0] });
    } catch (err) {
        console.error('POST /api/roles/:id/copy error:', err);
        res.status(500).json({ message: 'Failed to copy role' });
    }
});

router.delete('/api/roles/:id', authenticateToken, async (req, res) => {
    if (!isCeoOrAdmin(req)) {
        return res.status(403).json({ message: 'Only the CEO or Admin can delete roles' });
    }
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid role id' });
        const tenantId = req.user.tenant_id || 1;
        const existing = await pool.query('SELECT * FROM roles WHERE id = $1 AND COALESCE(tenant_id, 1) = $2', [id, tenantId]);
        if (existing.rows.length === 0) return res.status(404).json({ message: 'Role not found' });
        if (existing.rows[0].is_system) {
            return res.status(400).json({ message: 'System roles cannot be deleted' });
        }
        await pool.query('DELETE FROM roles WHERE id = $1 AND COALESCE(tenant_id, 1) = $2', [id, tenantId]);
        await logActivity(req, 'ROLE_DELETED', { role_id: id, name: existing.rows[0].name });
        res.json({ success: true });
    } catch (err) {
        console.error('DELETE /api/roles/:id error:', err);
        res.status(500).json({ message: 'Failed to delete role' });
    }
});

module.exports = router;

