/* ==========================================================================
   OKWESIWA CO LTD — Unified Shell, Topbar, Ctrl+K Search & Theme Manager
   ========================================================================== */
(function (global) {
    'use strict';

    const svg = (paths, size = 18) =>
        `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

    const ICONS = {
        home: svg('<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>'),
        shield: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
        activity: svg('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>'),
        barChart: svg('<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>'),
        layers: svg('<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>'),
        shoppingBag: svg('<path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/>'),
        clock: svg('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
        logOut: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'),
        fileCheck: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><polyline points="9 15 11 17 15 13"/>'),
        trendingUp: svg('<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>'),
        receipt: svg('<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1-2-1z"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="12" y2="16"/>'),
        users: svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
        creditCard: svg('<rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/>'),
        truck: svg('<rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>'),
        package: svg('<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>'),
        tag: svg('<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>'),
        clipboardCheck: svg('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><polyline points="9 14 11 16 15 12"/>'),
        folder: svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
        upload: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'),
        shoppingCart: svg('<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>'),
        pieChart: svg('<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>'),
        dollarSign: svg('<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
        mapPin: svg('<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>'),
        percent: svg('<line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>'),
        lock: svg('<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
        database: svg('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>'),
        settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
        user: svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
        search: svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>', 16),
        bell: svg('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>', 16),
        sun: svg('<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>', 16),
        moon: svg('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>', 16),
        menu: svg('<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>', 16),
        profitChart: svg('<rect x="2" y="3" width="20" height="18" rx="3"/><path d="M7 14l3-3 3 2 4-5"/><polyline points="14 8 17 8 17 11"/>', 16)
    };

    const MODULES = [
        { label: 'Home', url: '/dashboard', roles: ['ceo', 'admin', 'manager', 'store_manager', 'company', 'business_client'], group: 'Core', icon: 'home' },

        // User Management (immediately under Home)
        { label: 'Users', url: '/pos-register?tab=users', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'User Management', icon: 'users' },
        { label: 'Roles', url: '/roles', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'User Management', icon: 'lock' },

        // Contacts (immediately under User Management: Suppliers, Customers, Customer Groups)
        { label: 'Suppliers', url: '/inventory?tab=suppliers', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Contacts', icon: 'truck' },
        { label: 'Customers', url: '/customers', roles: ['ceo', 'admin', 'manager', 'store_manager', 'cashier', 'teller'], group: 'Contacts', icon: 'users' },
        { label: 'Customer Groups', url: '/catalog-ops?tab=groups', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Contacts', icon: 'layers' },

        { label: 'Pending Approvals', url: '/ceo-portal?tab=approvals-pending', roles: ['ceo', 'admin'], group: 'CEO', icon: 'clock' },
        { label: 'Approval History', url: '/ceo-portal?tab=approvals-history', roles: ['ceo', 'admin'], group: 'CEO', icon: 'fileCheck' },
        { label: 'Branches', url: '/ceo-portal?tab=branches', roles: ['ceo', 'admin'], group: 'CEO', icon: 'mapPin' },
        { label: 'Supply Chain Bottlenecks', url: '/ceo-portal?tab=ops-bottlenecks', roles: ['ceo', 'admin'], group: 'CEO', icon: 'activity' },
        { label: 'Branch Performance', url: '/ceo-portal?tab=ops-performance', roles: ['ceo', 'admin'], group: 'CEO', icon: 'barChart' },
        { label: 'Security Settings', url: '/ceo-portal?tab=settings', roles: ['ceo', 'admin'], group: 'CEO', icon: 'lock' },

        { label: 'Proforma Invoices', url: '/company-portal?tab=proforma', roles: ['company', 'business_client'], group: 'Company', icon: 'receipt' },
        { label: 'Company Transactions', url: '/company-portal?tab=transactions', roles: ['company', 'business_client'], group: 'Company', icon: 'activity' },
        { label: 'Quick Sale', url: '/company-portal?tab=quick-sale', roles: ['company', 'business_client'], group: 'Company', icon: 'shoppingCart' },
        { label: 'Company Tax', url: '/company-portal?tab=tax-management', roles: ['company', 'business_client'], group: 'Company', icon: 'percent' },
        { label: 'Company Profile', url: '/company-portal?tab=company-profile', roles: ['company', 'business_client'], group: 'Company', icon: 'users' },
        { label: 'Company Settings', url: '/company-portal?tab=settings', roles: ['company', 'business_client'], group: 'Company', icon: 'settings' },

        // Sales
        { label: 'POS', url: '/pos', roles: ['admin', 'manager', 'store_manager', 'cashier', 'teller'], group: 'Sales', subgroup: 'Sales', icon: 'shoppingBag' },
        { label: 'All Sales', url: '/sell?tab=all', roles: ['admin', 'manager', 'store_manager'], group: 'Sales', subgroup: 'Sales', icon: 'receipt' },
        { label: 'Add Sale', url: '/sell?tab=add', roles: ['admin', 'manager', 'store_manager'], group: 'Sales', subgroup: 'Sales', icon: 'shoppingCart' },
        { label: 'POS Sales', url: '/sell?tab=list_pos', roles: ['admin', 'manager', 'store_manager'], group: 'Sales', subgroup: 'Sales', icon: 'shoppingBag' },
        { label: 'Sale Returns', url: '/sell?tab=returns', roles: ['admin', 'manager', 'store_manager'], group: 'Sales', subgroup: 'Sales', icon: 'truck' },
        { label: 'Shipments', url: '/sell?tab=shipments', roles: ['admin', 'manager', 'store_manager'], group: 'Sales', subgroup: 'Sales', icon: 'truck' },
        { label: 'Lay-away', url: '/extras?tab=layaway', roles: ['admin', 'manager', 'store_manager'], group: 'Sales', subgroup: 'Sales', icon: 'layers' },
        { label: 'Add Draft', url: '/sell?tab=add_draft', roles: ['admin', 'manager', 'store_manager'], group: 'Sales', subgroup: 'Drafts & Quotes', icon: 'fileCheck' },
        { label: 'Drafts', url: '/sell?tab=drafts', roles: ['admin', 'manager', 'store_manager'], group: 'Sales', subgroup: 'Drafts & Quotes', icon: 'fileCheck' },
        { label: 'Add Quotation', url: '/sell?tab=add_quotation', roles: ['admin', 'manager', 'store_manager'], group: 'Sales', subgroup: 'Drafts & Quotes', icon: 'fileCheck' },
        { label: 'Quotations', url: '/sell?tab=quotations', roles: ['admin', 'manager', 'store_manager'], group: 'Sales', subgroup: 'Drafts & Quotes', icon: 'fileCheck' },
        { label: 'Discounts', url: '/sell?tab=discounts', roles: ['admin', 'manager', 'store_manager'], group: 'Sales', subgroup: 'Pricing & Import', icon: 'percent' },
        { label: 'Promotions', url: '/promotions', roles: ['admin', 'manager', 'store_manager'], group: 'Sales', subgroup: 'Pricing & Import', icon: 'tag' },
        { label: 'Import Sales', url: '/sell?tab=import', roles: ['admin', 'manager', 'store_manager'], group: 'Sales', subgroup: 'Pricing & Import', icon: 'upload' },

        // Cash Register (Till)
        { label: 'Open Shift', url: '/open-shift', roles: ['admin', 'manager', 'store_manager', 'cashier', 'teller'], group: 'Till', icon: 'clock' },
        { label: 'Close Shift', url: '/close-shift', roles: ['admin', 'manager', 'store_manager', 'cashier', 'teller'], group: 'Till', icon: 'logOut' },
        { label: 'Daily Close', url: '/daily-close', roles: ['admin', 'manager', 'store_manager', 'cashier', 'teller'], group: 'Till', icon: 'fileCheck' },
        { label: 'Transactions', url: '/transactions', roles: ['admin', 'manager', 'store_manager', 'cashier', 'teller'], group: 'Till', icon: 'receipt' },
        { label: 'Reserved Orders (Part-Pay)', url: '/extras', roles: ['cashier', 'teller'], group: 'Till', icon: 'layers' },

        // Inventory (Current Stock, Purchasing, Movement, Catalog)
        { label: 'Current Stock', url: '/inventory?tab=stock', roles: ['admin', 'manager', 'store_manager'], group: 'Inventory', subgroup: 'Current Stock', icon: 'package' },
        { label: 'Batch & Lot Tracking', url: '/inventory?tab=shelf', roles: ['admin', 'manager', 'store_manager'], group: 'Inventory', subgroup: 'Current Stock', icon: 'layers' },
        { label: 'Stock Taking', url: '/inventory?tab=stocktaking', roles: ['admin', 'manager', 'store_manager'], group: 'Inventory', subgroup: 'Current Stock', icon: 'clipboardCheck' },
        { label: 'Barcode Generator', url: '/inventory?tab=barcodes', roles: ['admin', 'manager', 'store_manager'], group: 'Inventory', subgroup: 'Current Stock', icon: 'tag' },
        { label: 'Negative Stock', url: '/negative-stock', roles: ['admin', 'manager', 'store_manager'], group: 'Inventory', subgroup: 'Current Stock', icon: 'activity' },
        { label: 'Purchase Orders', url: '/inventory?tab=orders', roles: ['admin', 'manager', 'store_manager'], group: 'Inventory', subgroup: 'Purchasing', icon: 'shoppingCart' },
        { label: 'Goods Receiving', url: '/inventory?tab=receiving', roles: ['admin', 'manager', 'store_manager'], group: 'Inventory', subgroup: 'Purchasing', icon: 'clipboardCheck' },
        { label: 'Suppliers', url: '/inventory?tab=suppliers', roles: ['admin', 'manager', 'store_manager'], group: 'Inventory', subgroup: 'Purchasing', icon: 'truck' },
        { label: 'Distribution', url: '/inventory?tab=distribution', roles: ['admin', 'manager', 'store_manager'], group: 'Inventory', subgroup: 'Movement', icon: 'truck' },
        { label: 'Stock Adjustments', url: '/stock-adjustments?tab=list', roles: ['admin', 'manager', 'store_manager'], group: 'Inventory', subgroup: 'Movement', icon: 'layers' },
        { label: 'Add Stock Adjustment', url: '/stock-adjustments?tab=add', roles: ['admin', 'manager', 'store_manager'], group: 'Inventory', subgroup: 'Movement', icon: 'clipboardCheck' },
        { label: 'Bulk Adjustment', url: '/stock-adjustments?tab=bulk', roles: ['admin', 'manager', 'store_manager'], group: 'Inventory', subgroup: 'Movement', icon: 'layers' },
        { label: 'Stock Transfers', url: '/stock-transfers?tab=list', roles: ['admin', 'manager', 'store_manager'], group: 'Inventory', subgroup: 'Movement', icon: 'truck' },
        { label: 'Add Stock Transfer', url: '/stock-transfers?tab=add', roles: ['admin', 'manager', 'store_manager'], group: 'Inventory', subgroup: 'Movement', icon: 'truck' },
        { label: 'Returned Sales', url: '/inventory?tab=returns', roles: ['admin', 'manager', 'store_manager'], group: 'Inventory', subgroup: 'Movement', icon: 'receipt' },
        { label: 'Deliveries & Counts', url: '/operations', roles: ['admin', 'manager', 'store_manager', 'cashier', 'teller', 'storekeeper', 'driver'], group: 'Inventory', subgroup: 'Movement', icon: 'clipboardCheck' },
        { label: 'Categories', url: '/categories', roles: ['admin', 'manager', 'store_manager'], group: 'Inventory', subgroup: 'Catalog', icon: 'folder' },
        { label: 'Brands, Units & Prices', url: '/catalog-ops', roles: ['admin', 'manager', 'store_manager'], group: 'Inventory', subgroup: 'Catalog', icon: 'tag' },
        { label: 'Bulk Import', url: '/bulk-upload', roles: ['admin', 'manager', 'store_manager'], group: 'Inventory', subgroup: 'Catalog', icon: 'upload' },

        // Credit (moved under Sales so Contacts holds strictly Suppliers, Customers, Customer Groups)
        { label: 'Credit Clients', url: '/credit-customers?tab=clients', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Sales', subgroup: 'Credit', icon: 'creditCard' },
        { label: 'Manager Authorization', url: '/credit-customers?tab=auth', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Sales', subgroup: 'Credit', icon: 'lock' },

        // Expenses & Accounts (Money)
        { label: 'List Expenses', url: '/expenses?tab=list', roles: ['admin', 'manager', 'store_manager'], group: 'Accounts', subgroup: 'Expenses & Cash', icon: 'dollarSign' },
        { label: 'Add Expense', url: '/expenses?tab=add', roles: ['admin', 'manager', 'store_manager'], group: 'Accounts', subgroup: 'Expenses & Cash', icon: 'receipt' },
        { label: 'Expense Categories', url: '/expenses?tab=categories', roles: ['admin', 'manager', 'store_manager'], group: 'Accounts', subgroup: 'Expenses & Cash', icon: 'folder' },
        { label: 'Account & Cash', url: '/extras?tab=accounts', roles: ['admin', 'manager', 'store_manager'], group: 'Accounts', subgroup: 'Expenses & Cash', icon: 'creditCard' },
        { label: 'Chart of Accounts', url: '/money?tab=coa', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Accounts', subgroup: 'General Ledger', icon: 'fileCheck' },
        { label: 'Journal Entries', url: '/money?tab=journal', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Accounts', subgroup: 'General Ledger', icon: 'receipt' },
        { label: 'Trial Balance & Balance Sheet', url: '/money?tab=trial-balance', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Accounts', subgroup: 'General Ledger', icon: 'barChart' },
        { label: 'Bank Reconciliation', url: '/money?tab=reconcile', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Accounts', subgroup: 'General Ledger', icon: 'clipboardCheck' },

        // Reports
        { label: 'Reports Overview', url: '/reports?tab=overview', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Overview', icon: 'pieChart' },
        { label: 'Profit / Loss Report', url: '/reports?tab=detailed&report=pnl', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Financial & Tax', icon: 'trendingUp' },
        { label: 'Z Report', url: '/reports?tab=detailed&report=z_report', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Financial & Tax', icon: 'receipt' },
        { label: 'Purchase & Sale', url: '/reports?tab=detailed&report=purchase_sale', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Financial & Tax', icon: 'barChart' },
        { label: 'Tax Report', url: '/reports?tab=detailed&report=tax', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Financial & Tax', icon: 'percent' },
        { label: 'Expense Report', url: '/reports?tab=detailed&report=expense', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Financial & Tax', icon: 'dollarSign' },
        { label: 'Profit by Item', url: '/reports?tab=detailed&report=margin', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Financial & Tax', icon: 'trendingUp' },
        { label: 'Transaction History', url: '/reports?tab=detailed&report=transactions', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Sales & Customers', icon: 'receipt' },
        { label: 'Daily Summary', url: '/reports?tab=detailed&report=daily', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Sales & Customers', icon: 'barChart' },
        { label: 'Sales by Category', url: '/reports?tab=detailed&report=cat', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Sales & Customers', icon: 'pieChart' },
        { label: 'By Payment Method', url: '/reports?tab=detailed&report=method', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Sales & Customers', icon: 'creditCard' },
        { label: 'Hourly Sales', url: '/reports?tab=detailed&report=hourly', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Sales & Customers', icon: 'clock' },
        { label: 'Quotations', url: '/reports?tab=detailed&report=quotes', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Sales & Customers', icon: 'fileCheck' },
        { label: 'Supplier & Customer Report', url: '/reports?tab=detailed&report=supplier_customer', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Sales & Customers', icon: 'users' },
        { label: 'Customer Groups Report', url: '/reports?tab=detailed&report=customer_groups', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Sales & Customers', icon: 'users' },
        { label: 'Register Report', url: '/reports?tab=detailed&report=shifts', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Sales & Customers', icon: 'clock' },
        { label: 'Sales Representative Report', url: '/reports?tab=detailed&report=teller', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Sales & Customers', icon: 'user' },
        { label: 'Stock Report', url: '/reports?tab=detailed&report=stock', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Stock & Products', icon: 'package' },
        { label: 'Stock Adjustment Report', url: '/reports?tab=detailed&report=adj', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Stock & Products', icon: 'layers' },
        { label: 'Stock Count Variance', url: '/reports?tab=detailed&report=variance', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Stock & Products', icon: 'clipboardCheck' },
        { label: 'Trending Products', url: '/reports?tab=detailed&report=trending', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Stock & Products', icon: 'trendingUp' },
        { label: 'Slow Movers (30+ Days)', url: '/reports?tab=detailed&report=slow_movers', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Stock & Products', icon: 'clock' },
        { label: 'Items Report', url: '/reports?tab=detailed&report=items_report', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Stock & Products', icon: 'package' },
        { label: 'Product Purchase Report', url: '/reports?tab=detailed&report=product_purchase', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Stock & Products', icon: 'shoppingCart' },
        { label: 'Product Sell Report', url: '/reports?tab=detailed&report=product_sell', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Stock & Products', icon: 'shoppingBag' },
        { label: 'Daily Sales by Product', url: '/reports?tab=detailed&report=daily_sales_product', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Stock & Products', icon: 'barChart' },
        { label: 'Purchase & Sale Product', url: '/reports?tab=detailed&report=purchase_sale_product', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Stock & Products', icon: 'layers' },
        { label: 'Purchase Payment Report', url: '/reports?tab=detailed&report=purchase_payment', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Payments & Audit', icon: 'creditCard' },
        { label: 'Sell Payment Report', url: '/reports?tab=detailed&report=sell_payment', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Payments & Audit', icon: 'creditCard' },
        { label: 'Payment by Age', url: '/reports?tab=detailed&report=payment_by_age', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Payments & Audit', icon: 'clock' },
        { label: 'Activity Log', url: '/reports?tab=detailed&report=activity_log', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Payments & Audit', icon: 'activity' },
        { label: 'Deleted Transactions', url: '/reports?tab=detailed&report=deleted_transactions', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Reports', subgroup: 'Payments & Audit', icon: 'fileCheck' },

        // Quick Reports (Items, Brands & Customers)
        { label: 'Items Sold Today', url: '/reports?tab=drilldown&view=items_today', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Insights', icon: 'shoppingBag' },
        { label: 'Items Sold (Any Period)', url: '/reports?tab=drilldown&view=items_period', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Insights', icon: 'barChart' },
        { label: 'Sales by Brand', url: '/reports?tab=drilldown&view=by_brand', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Insights', icon: 'tag' },
        { label: 'Top Customers', url: '/reports?tab=drilldown&view=top_customers', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Insights', icon: 'users' },
        { label: 'Customers Owing (Aging)', url: '/reports?tab=drilldown&view=customers_owing', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Insights', icon: 'creditCard' },
        { label: 'Stock on Hand', url: '/reports?tab=drilldown&view=stock_on_hand', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Insights', icon: 'package' },

        // Staff & Payroll (Team)
        { label: 'Onboard New Staff', url: '/pos-register?tab=register', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Staff', icon: 'user' },
        { label: 'Attendance', url: '/extras?tab=attendance', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Staff', icon: 'clock' },
        { label: 'Payroll & Salaries', url: '/team?tab=payroll', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Staff', icon: 'dollarSign' },

        // Store Settings (Business Settings, Locations & Tax, Messages, Security)
        { label: 'Store Profile', url: '/settings?tab=store', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Settings', subgroup: 'Business Settings', icon: 'home' },
        { label: 'Business', url: '/settings?tab=business', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Settings', subgroup: 'Business Settings', icon: 'settings' },
        { label: 'Tax Defaults', url: '/settings?tab=tax', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Settings', subgroup: 'Business Settings', icon: 'percent' },
        { label: 'Product', url: '/settings?tab=product', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Settings', subgroup: 'Business Settings', icon: 'package' },
        { label: 'Invoice', url: '/settings?tab=invoice', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Settings', subgroup: 'Business Settings', icon: 'receipt' },
        { label: 'Barcode', url: '/settings?tab=barcode', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Settings', subgroup: 'Business Settings', icon: 'tag' },
        { label: 'Receipt Printers', url: '/settings?tab=printers', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Settings', subgroup: 'Business Settings', icon: 'fileCheck' },
        { label: 'Locations', url: '/settings?tab=locations', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Settings', subgroup: 'Locations & Tax', icon: 'mapPin' },
        { label: 'Tax Rates & Report', url: '/settings?tab=taxrates', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Settings', subgroup: 'Locations & Tax', icon: 'percent' },
        { label: 'Notification Templates', url: '/settings?tab=notifications', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Settings', subgroup: 'Messages', icon: 'bell' },
        { label: 'Activity Log', url: '/settings?tab=activity', roles: ['ceo', 'admin', 'manager', 'store_manager'], group: 'Settings', subgroup: 'Security', icon: 'activity' },
        { label: 'Backups & Export', url: '/settings?tab=backups', roles: ['ceo', 'admin'], group: 'Settings', subgroup: 'Security', icon: 'database' },

        // Profile
        { label: 'Profile', url: '/profile', roles: ['all'], group: 'Profile', icon: 'user' }
    ];

    function getCurrentUser() {
        try {
            // login.html stores company users under 'companyUser' (staff under 'currentUser')
            const raw = localStorage.getItem('currentUser') || localStorage.getItem('companyUser') || localStorage.getItem('user') || sessionStorage.getItem('user');
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function themeKey() {
        const u = getCurrentUser();
        return u && u.id ? `okwesiwa_theme_${u.id}` : 'okwesiwa_theme';
    }

    function getTheme() {
        return localStorage.getItem(themeKey()) || localStorage.getItem('okwesiwa_theme') || 'light';
    }

    // Hard-coded light surfaces and dark text that the shared dark tokens do not reach.
    // Only fetched in dark mode, so light-mode users never download it.
    function syncDarkFixes(t) {
        let link = document.getElementById('okw-dark-fixes');
        if (t === 'dark' && !link) {
            link = document.createElement('link');
            link.id = 'okw-dark-fixes';
            link.rel = 'stylesheet';
            link.href = '/dark-fixes.css';
            document.head.appendChild(link);
        }
        if (link) link.disabled = t !== 'dark';
    }

    function applyTheme(theme) {
        const t = theme === 'dark' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', t);
        syncDarkFixes(t);
        localStorage.setItem(themeKey(), t);
        localStorage.setItem('okwesiwa_theme', t);
        const btn = document.getElementById('okw-theme-toggle');
        if (btn) {
            btn.innerHTML = t === 'dark' ? `${ICONS.sun}<span>Light</span>` : `${ICONS.moon}<span>Dark</span>`;
            btn.title = t === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode';
        }
    }

    applyTheme(getTheme());

    function toggleTheme() {
        applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
    }

    function openCommandPalette() {
        if (document.getElementById('okw-cmd-modal')) return;
        const user = getCurrentUser();
        const role = (user && user.role ? user.role : 'cashier').toLowerCase().replace(/[\s-]+/g, '_');
        const allowed = MODULES.filter(m => m.roles.includes('all') || m.roles.includes(role));

        const backdrop = document.createElement('div');
        backdrop.id = 'okw-cmd-modal';
        backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(11,16,23,0.62);z-index:10000;display:flex;align-items:flex-start;justify-content:center;padding-top:10vh;';
        backdrop.innerHTML = `
            <div class="okw-card" style="width:100%;max-width:540px;padding:0;overflow:hidden;box-shadow:var(--shadow-lg);">
                <div style="padding:12px 16px;border-bottom:1px solid var(--color-border);display:flex;align-items:center;gap:10px;">
                    <span style="color:var(--color-text-muted);display:inline-flex;">${ICONS.search}</span>
                    <input type="text" id="okw-cmd-input" placeholder="Jump to module or page... (Esc to close)" style="flex:1;border:none;outline:none;background:transparent;color:var(--color-text);font-size:15px;">
                    <span class="okw-kbd">ESC</span>
                </div>
                <div id="okw-cmd-list" style="max-height:360px;overflow-y:auto;padding:8px;"></div>
            </div>
        `;
        document.body.appendChild(backdrop);

        const input = backdrop.querySelector('#okw-cmd-input');
        const list = backdrop.querySelector('#okw-cmd-list');
        const render = (q = '') => {
            const term = q.trim().toLowerCase();
            const hits = allowed.filter(m => m.label.toLowerCase().includes(term) || m.group.toLowerCase().includes(term));
            list.innerHTML = hits.length
                ? hits.map(m => `
                    <a href="${m.url}" style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-radius:6px;text-decoration:none;color:var(--color-text);font-size:14px;" class="okw-cmd-item">
                        <span style="display:inline-flex;align-items:center;gap:10px;">${ICONS[m.icon] || ''}<span>${m.label}</span></span>
                        <span class="okw-badge okw-badge-neutral">${m.group}</span>
                    </a>
                `).join('')
                : '<div style="padding:16px;text-align:center;color:var(--color-text-muted);font-size:13px;">No matching pages</div>';
        };
        render();
        input.focus();
        input.addEventListener('input', () => render(input.value));
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
        const onKey = (e) => {
            if (e.key === 'Escape') {
                backdrop.remove();
                document.removeEventListener('keydown', onKey);
            }
        };
        document.addEventListener('keydown', onKey);
    }

    function setSidebarCollapsed(collapsed) {
        const sidebar = document.querySelector('.sidebar');
        if (!sidebar) return;
        sidebar.classList.toggle('collapsed', collapsed);
        document.body.classList.toggle('sidebar-collapsed', collapsed);
        localStorage.setItem('okwesiwa_sidebar_collapsed', collapsed ? '1' : '0');
        const main = document.querySelector('.main-content');
        if (main) {
            main.style.marginLeft = collapsed ? 'var(--sidebar-collapsed-width)' : '';
        }
    }

    function closeMobileSidebar() {
        const sidebar = document.querySelector('.sidebar');
        if (!sidebar) return;
        sidebar.classList.remove('active');
        const overlay = document.querySelector('.overlay, .sidebar-overlay');
        if (overlay) overlay.classList.remove('active');
    }

    function initMainContentSidebarAutoClose() {
        if (document.documentElement.dataset.okwSidebarAutoCloseBound) return;
        document.documentElement.dataset.okwSidebarAutoCloseBound = '1';
        const handleEnterMain = (e) => {
            const target = e.target;
            if (!target || typeof target.closest !== 'function') return;
            if (!target.closest('.main-content')) return;
            const sidebar = document.querySelector('.sidebar');
            if (!sidebar) return;
            if (window.matchMedia('(max-width: 992px)').matches) {
                if (sidebar.classList.contains('active')) closeMobileSidebar();
            } else if (!sidebar.classList.contains('collapsed')) {
                setSidebarCollapsed(true);
            }
        };
        document.addEventListener('pointerdown', handleEnterMain, true);
        document.addEventListener('focusin', handleEnterMain, true);
    }

    const prefetchedUrls = new Set();

    function prefetchUrl(href) {
        if (!href || href.startsWith('#')) return;
        try {
            const url = new URL(href, window.location.origin);
            if (url.origin !== window.location.origin) return;
            const target = url.pathname + url.search;
            if (target === window.location.pathname + window.location.search) return;
            if (prefetchedUrls.has(target)) return;
            prefetchedUrls.add(target);
            const link = document.createElement('link');
            link.rel = 'prefetch';
            link.as = 'document';
            link.href = target;
            document.head.appendChild(link);
        } catch (e) { /* ignore malformed URLs */ }
    }

    function showNavProgress() {
        let bar = document.getElementById('okw-nav-progress');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'okw-nav-progress';
            bar.style.cssText = 'position:fixed;top:0;left:0;height:2.5px;width:0;background:#F9A51A;z-index:10099;pointer-events:none;transition:width 240ms ease-out;';
            document.body.appendChild(bar);
        }
        requestAnimationFrame(() => { bar.style.width = '72%'; });
    }

    function initSidebarPrefetch(nav) {
        if (!nav || nav.dataset.okwPrefetchBound) return;
        nav.dataset.okwPrefetchBound = '1';
        const onHover = (e) => {
            const a = e.target && typeof e.target.closest === 'function' ? e.target.closest('a.nav-item') : null;
            if (a) prefetchUrl(a.getAttribute('href'));
        };
        nav.addEventListener('pointerenter', onHover, true);
        nav.addEventListener('focusin', onHover, true);
        nav.addEventListener('click', (e) => {
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            const a = e.target && typeof e.target.closest === 'function' ? e.target.closest('a.nav-item') : null;
            if (!a || a.target === '_blank') return;
            const href = a.getAttribute('href');
            if (!href || href.startsWith('#')) return;
            showNavProgress();
        });
    }

    function toggleSidebar() {
        const sidebar = document.querySelector('.sidebar');
        if (!sidebar) return;
        if (window.matchMedia('(max-width: 992px)').matches) {
            const open = sidebar.classList.toggle('active');
            const overlay = document.querySelector('.overlay, .sidebar-overlay');
            if (overlay) overlay.classList.toggle('active', open);
            return;
        }
        setSidebarCollapsed(!sidebar.classList.contains('collapsed'));
    }

    function openTodayProfitModal() {
        const prev = document.getElementById('okw-today-profit-modal');
        if (prev) prev.remove();
        const backdrop = document.createElement('div');
        backdrop.id = 'okw-today-profit-modal';
        backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(11,16,23,0.62);z-index:10050;display:flex;align-items:center;justify-content:center;padding:16px;';
        backdrop.innerHTML = `
            <div style="width:100%;max-width:860px;max-height:90vh;overflow-y:auto;background:var(--color-surface,#fff);color:var(--color-text,#0f172a);border:1px solid var(--color-border,#e2e8f0);border-radius:12px;box-shadow:0 20px 50px rgba(0,0,0,0.3);padding:20px 24px;">
                <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #273990;padding-bottom:10px;margin-bottom:16px;">
                    <h2 style="margin:0;font-size:18px;color:#273990;">Today's profit</h2>
                    <button type="button" id="okw-tp-close" style="background:transparent;border:1px solid var(--color-border,#cbd5e1);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:13px;color:inherit;">Close</button>
                </div>
                <div id="okw-tp-body" style="font-size:13px;color:var(--color-text-muted,#64748b);">Loading today's profit...</div>
            </div>
        `;
        document.body.appendChild(backdrop);
        backdrop.querySelector('#okw-tp-close').onclick = () => backdrop.remove();
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });

        const token = localStorage.getItem('authToken') || localStorage.getItem('token') || sessionStorage.getItem('token');
        const fmtC = (n) => '¢ ' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const row = (label, val) => `<tr><td style="padding:6px 8px;border-bottom:1px solid var(--color-border,#e2e8f0);">${label}</td><td style="padding:6px 8px;border-bottom:1px solid var(--color-border,#e2e8f0);text-align:right;font-weight:600;white-space:nowrap;">${fmtC(val)}</td></tr>`;

        fetch('/api/reports/today-profit', { headers: { Authorization: `Bearer ${token}` }, credentials: 'include' })
            .then(r => r.ok ? r.json() : Promise.reject(new Error('Failed to load')))
            .then(d => {
                backdrop.querySelector('#okw-tp-body').innerHTML = `
                    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px;color:var(--color-text,#0f172a);">
                        <div>
                            <div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#b91c1c;margin-bottom:6px;letter-spacing:0.04em;">COSTS &amp; DEDUCTIONS</div>
                            <table style="width:100%;border-collapse:collapse;font-size:13px;">
                                ${row('Opening Stock <small style="color:var(--color-text-muted);">(By purchase price)</small>', d.opening_stock_purchase)}
                                ${row('Opening Stock <small style="color:var(--color-text-muted);">(By sale price)</small>', d.opening_stock_sale)}
                                ${row('Total purchase <small style="color:var(--color-text-muted);">(Exc. tax, Discount)</small>', d.total_purchase)}
                                ${row('Total Stock Adjustment', d.total_stock_adjustment)}
                                ${row('Total Expense', d.total_expense)}
                                ${row('Total purchase shipping charge', d.purchase_shipping_charge)}
                                ${row('Purchase additional expenses', d.purchase_additional_expenses)}
                                ${row('Total transfer shipping charge', d.transfer_shipping_charge)}
                                ${row('Total Sell discount', d.total_sell_discount)}
                                ${row('Total customer reward', d.total_customer_reward)}
                                ${row('Total Sell Return', d.total_sell_return)}
                                ${row('Total Payroll', d.total_payroll)}
                                ${row('Total Production Cost', d.total_production_cost)}
                            </table>
                        </div>
                        <div>
                            <div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#15803d;margin-bottom:6px;letter-spacing:0.04em;">REVENUE &amp; INCOME</div>
                            <table style="width:100%;border-collapse:collapse;font-size:13px;">
                                ${row('Closing stock <small style="color:var(--color-text-muted);">(By purchase price)</small>', d.closing_stock_purchase)}
                                ${row('Closing stock <small style="color:var(--color-text-muted);">(By sale price)</small>', d.closing_stock_sale)}
                                ${row('Total Sales <small style="color:var(--color-text-muted);">(Exc. tax, Discount)</small>', d.total_sales)}
                                ${row('Total sell shipping charge', d.sell_shipping_charge)}
                                ${row('Sell additional expenses', d.sell_additional_expenses)}
                                ${row('Total Stock Recovered', d.total_stock_recovered)}
                                ${row('Total Purchase Return', d.total_purchase_return)}
                                ${row('Total Purchase discount', d.total_purchase_discount)}
                                ${row('Total sell round off', d.total_sell_round_off)}
                                ${row('Total Sell Return Discount', d.total_sell_return_discount)}
                            </table>
                        </div>
                    </div>
                    <div style="margin-top:16px;padding:14px;border-radius:10px;background:var(--color-surface-subtle,#f8fafc);border:1px solid var(--color-border,#e2e8f0);color:var(--color-text,#0f172a);">
                        <div style="font-weight:700;font-size:14px;">COGS: ${fmtC(d.cogs)}</div>
                        <div style="font-size:12px;color:var(--color-text-muted,#64748b);margin-bottom:8px;">Cost of Goods Sold = Starting inventory(opening stock) + purchases − ending inventory(closing stock)</div>
                        <div style="font-weight:700;font-size:14px;">Gross Profit: ${fmtC(d.gross_profit)}</div>
                        <div style="font-size:12px;color:var(--color-text-muted,#64748b);margin-bottom:8px;">(Total sell price - Total purchase price)</div>
                        <div style="font-weight:800;font-size:16px;color:#273990;">Net Profit: ${fmtC(d.net_profit)}</div>
                        <div style="font-size:11px;color:var(--color-text-muted,#64748b);">Gross Profit + (Total sell shipping charge + Sell additional expenses + Total Stock Recovered + Total Purchase discount + Total sell round off + Total Sell Return Discount) − (Total Stock Adjustment + Total Expense + Total purchase shipping charge + Total transfer shipping charge + Purchase additional expenses + Total Sell discount + Total customer reward + Total Payroll + Total Production Cost)</div>
                    </div>
                `;
            })
            .catch(() => {
                backdrop.querySelector('#okw-tp-body').innerHTML = '<div style="color:#c62828;">Could not load today\'s profit data.</div>';
            });
    }

    function matchesModuleUrl(modUrl, currentPath, currentParams) {
        const [mPath, mQuery] = modUrl.split('?');
        if (mPath !== currentPath) return false;
        if (!mQuery) return !currentParams.toString();
        const mParams = new URLSearchParams(mQuery);
        for (const [k, v] of mParams.entries()) {
            if (currentParams.get(k) !== v) return false;
        }
        return true;
    }

    function getActivePageTitle() {
        const currentPath = window.location.pathname.replace(/\.html$/, '') || '/';
        const currentParams = new URLSearchParams(window.location.search || '');
        const match = MODULES.find(m => matchesModuleUrl(m.url, currentPath, currentParams))
            || MODULES.find(m => m.url.split('?')[0] === currentPath);
        if (match) return match.label;
        const raw = (document.title || 'Manager Portal').replace(/OKWESIWA CO LTD\s*\|\s*/i, '').replace(/\s*-\s*OKWESIWA CO LTD/i, '').trim();
        return raw || 'Portal';
    }

    const PAGE_DESCRIPTIONS = {
        '/dashboard': 'Sales, transactions, and inventory performance at a glance.',
        '/ceo-portal': 'Executive oversight across branches, approvals, and operations.',
        '/ceo-live': 'Real-time store activity and branch revenue monitoring.',
        '/company-portal': 'Manage corporate invoices, transactions, and quick orders.',
        '/sell': 'Manage sales, POS transactions, drafts, quotations, returns, and shipments.',
        '/pos': 'Fast point-of-sale checkout, barcode scanning, and receipt printing.',
        '/open-shift': 'Start your cash register shift and record opening float.',
        '/close-shift': 'Count drawer cash and reconcile your shift.',
        '/daily-close': 'End-of-day sales summary and cash reconciliation.',
        '/transactions': 'Review completed sales, receipts, and payment methods.',
        '/promotions': 'Configure active discounts and promotional campaigns.',
        '/inventory': 'Manage stock items, purchase orders, receiving, batches, and transfers.',
        '/negative-stock': 'Analyze products sold without stock and reconcile inventory debt.',
        '/categories': 'Organize products into categories.',
        '/suppliers': 'Manage supplier database and contact information.',
        '/catalog-ops': 'Manage product brands, units of measure, and price groups.',
        '/operations': 'Track deliveries and perform physical stock counts.',
        '/extras': 'Manage reserved orders (part-pay) and staff attendance.',
        '/bulk-upload': 'Import or update products in bulk from Excel/CSV.',
        '/customers': 'Manage retail customers and purchase history.',
        '/credit-customers': 'Manage credit clients, balances, and manager authorization codes.',
        '/core-reports': 'Standard financial, tax, and operational reports.',
        '/sales-dashboard': 'Visual breakdown of revenue trends and top-selling items.',
        '/profitability': 'Analyze gross margin, cost of goods, and net profit.',
        '/reports': 'Comprehensive business analytics and exportable reports.',
        '/expenses': 'Track store expenses, categories, and operational spending.',
        '/stock-adjustments': 'Record stock write-offs, damages, and bulk adjustments.',
        '/stock-transfers': 'Transfer inventory between warehouse and branches.',
        '/business-settings': 'Configure business profile, tax, product, invoice, and printer settings.',
        '/locations': 'Manage business branches and warehouse locations.',
        '/tax-management': 'Configure VAT and statutory tax rates.',
        '/pos-register?tab=register': 'Fill in all required details to create a new staff account.',
        '/pos-register?tab=users': 'View and manage all registered staff accounts.',
        '/roles': 'Define staff roles and granular module permissions.',
        '/notification-templates': 'Customize email and SMS notification templates.',
        '/activity-log': 'Audit trail of user actions and system events.',
        '/backups': 'Automatic nightly backups, DOCX/JSON snapshots, and full data exports.',
        '/settings': 'Configure store identity, logo, currency, and receipt settings.',
        '/profile': 'Manage your account identity, workspace scope, and password.'
    };

    function getActivePageSubtitle() {
        const pEl = document.querySelector('.page-wrap h1 + p, .page-header p, .header-title p, .main-content h1 + p');
        if (pEl && pEl.textContent.trim()) return pEl.textContent.trim();
        const currentPath = window.location.pathname.replace(/\.html$/, '') || '/';
        const currentFull = currentPath + (window.location.search || '');
        return PAGE_DESCRIPTIONS[currentFull] || PAGE_DESCRIPTIONS[currentPath] || '';
    }

    function setupNotificationsDropdown(topbar) {
        const btn = topbar.querySelector('#okw-notif-btn');
        const dd = topbar.querySelector('#okw-notif-dropdown');
        const body = topbar.querySelector('#okw-notif-body');
        const badge = topbar.querySelector('#okw-notif-badge');
        if (!btn || !dd || !body) return;

        const NON_MANAGER_ROLES = ['cashier', 'teller', 'storekeeper', 'driver', 'company', 'business_client'];
        const SEEN_KEY = 'okw_notif_seen_ts';
        let latestTs = 0;

        function updateBadge(list) {
            if (!badge) return;
            const seenTs = Number(localStorage.getItem(SEEN_KEY) || 0);
            const unread = seenTs > 0
                ? list.filter(it => Number(it.ts || 0) > seenTs).length
                : list.length;
            badge.textContent = unread > 99 ? '99+' : String(unread);
            badge.style.display = unread > 0 ? 'inline-block' : 'none';
        }

        async function loadFeed() {
            const user = getCurrentUser();
            const role = (user && user.role ? user.role : '').toLowerCase().replace(/[\s-]+/g, '_');
            if (role && NON_MANAGER_ROLES.includes(role)) {
                if (badge) badge.style.display = 'none';
                body.innerHTML = '<div style="padding:16px;text-align:center;font-size:12px;color:var(--muted);">No recent alerts.</div>';
                return;
            }
            const token = localStorage.getItem('authToken') || localStorage.getItem('token') || sessionStorage.getItem('token');
            const headers = token ? { Authorization: `Bearer ${token}` } : {};
            try {
                const res = await fetch('/api/notifications/feed', { headers, credentials: 'include' });
                if (!res.ok) {
                    if (badge) badge.style.display = 'none';
                    body.innerHTML = '<div style="padding:14px;font-size:12px;color:var(--muted);">No notifications available.</div>';
                    return;
                }
                const data = await res.json();
                const list = data.items || [];
                latestTs = list.reduce((m, it) => Math.max(m, Number(it.ts || 0)), 0);
                updateBadge(list);
                if (!list.length) {
                    body.innerHTML = '<div style="padding:16px;text-align:center;font-size:12px;color:var(--muted);">No recent alerts.</div>';
                    return;
                }
                const toneColor = (t) => t === 'danger' ? '#dc2626' : (t === 'warning' ? '#d97706' : (t === 'success' ? '#16a34a' : '#2563eb'));
                body.innerHTML = list.map(it => `
                    <a href="${it.link || '/settings?tab=activity'}" style="display:block;padding:10px 14px;border-bottom:1px solid var(--edge,#e2e8f0);text-decoration:none;color:inherit;">
                        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:2px;">
                            <span style="font-size:10px;font-weight:700;text-transform:uppercase;color:${toneColor(it.tone)};">${it.category || 'Alert'}</span>
                            <span style="font-size:10px;color:var(--muted,#64748b);">${it.time || ''}</span>
                        </div>
                        <div style="font-size:12.5px;font-weight:600;line-height:1.35;">${String(it.title || '').replace(/</g, '&lt;')}</div>
                        ${it.detail ? `<div style="font-size:11.5px;color:var(--muted,#64748b);margin-top:2px;">${String(it.detail).replace(/</g, '&lt;')}</div>` : ''}
                    </a>
                `).join('');
            } catch (_) {
                body.innerHTML = '<div style="padding:14px;font-size:12px;color:#dc2626;">Could not load alerts.</div>';
            }
        }

        setTimeout(loadFeed, 400);
        setInterval(() => { if (!document.hidden) loadFeed(); }, 60000);
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const userDd = topbar.querySelector('#okw-user-dropdown');
            if (userDd) userDd.classList.remove('open');
            const open = dd.style.display === 'flex';
            dd.style.display = open ? 'none' : 'flex';
            if (!open) {
                loadFeed();
                if (latestTs > 0) {
                    try { localStorage.setItem(SEEN_KEY, String(latestTs)); } catch (_) { }
                    if (badge) badge.style.display = 'none';
                }
            }
        });
        dd.addEventListener('click', (e) => e.stopPropagation());
        document.addEventListener('click', () => { dd.style.display = 'none'; });
    }

    function injectTopbarIfNeeded() {
        if (document.querySelector('.okw-topbar')) return;
        const main = document.querySelector('.main-content') || document.querySelector('main') || document.body;
        if (!main) return;

        const user = getCurrentUser();
        const role = (user && user.role ? user.role : '').toLowerCase().replace(/[\s-]+/g, '_');
        const isMgr = ['super_admin', 'ceo', 'admin', 'manager', 'store_manager'].includes(role);
        const pageTitle = getActivePageTitle();
        const pageSub = getActivePageSubtitle();
        const displayName = (user && (user.name || user.username)) || 'Staff';
        const initials = String(displayName).split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || 'OK';

        const hasSidebar = !!document.querySelector('.sidebar');
        const topbar = document.createElement('header');
        topbar.className = 'okw-topbar';
        topbar.innerHTML = `
            <div class="okw-topbar-left">
                ${hasSidebar ? `<button type="button" class="okw-icon-btn" id="okw-sidebar-toggle" title="Toggle sidebar" aria-label="Toggle sidebar">${ICONS.menu}</button>` : ''}
                <div class="okw-topbar-heading">
                    <span class="okw-topbar-title">${String(pageTitle).replace(/</g, '&lt;')}</span>
                    ${pageSub ? `<span class="okw-topbar-sub" title="${String(pageSub).replace(/"/g, '&quot;')}">${String(pageSub).replace(/</g, '&lt;')}</span>` : ''}
                </div>
            </div>
            <div class="okw-topbar-center">
                <button type="button" class="okw-icon-btn okw-search-trigger" id="okw-cmd-trigger" title="Quick Search (Ctrl+K)">
                    ${ICONS.search}
                    <span class="label">Search...</span>
                    <span class="okw-kbd">Ctrl+K</span>
                </button>
            </div>
            <div class="okw-topbar-right">
                <div class="okw-plus-wrap" style="position:relative;">
                    <button type="button" class="okw-icon-btn" id="okw-plus-btn" title="Quick Tools (Calendar, To Do, Tour)" aria-label="Quick Tools" aria-haspopup="true" aria-expanded="false" style="font-size:18px;font-weight:700;padding:0 11px;">+</button>
                    <div id="okw-plus-dropdown" class="okw-menu-list" style="display:none;min-width:190px;top:40px;right:0;z-index:10050;">
                        <button type="button" class="okw-menu-item" id="okw-act-calendar">📅 Calendar</button>
                        <button type="button" class="okw-menu-item" id="okw-act-todo">✅ Add To Do</button>
                        <button type="button" class="okw-menu-item" id="okw-act-tour">🧭 Application Tour</button>
                    </div>
                </div>
                ${isMgr ? `<button type="button" class="okw-icon-btn" id="okw-today-profit-btn" title="Today's Profit">${ICONS.profitChart}<span>Today's Profit</span></button>` : ''}
                <div class="okw-notif-wrap">
                    <button type="button" class="okw-icon-btn" id="okw-notif-btn" title="Notifications &amp; Alerts" aria-label="Notifications &amp; Alerts">${ICONS.bell}<span id="okw-notif-badge" class="okw-notif-badge" style="display:none;">0</span></button>
                    <div id="okw-notif-dropdown" class="okw-notif-dropdown">
                        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid var(--edge,#e2e8f0);font-size:13px;font-weight:700;">
                            <span>Notifications &amp; Activity</span>
                            <a href="/activity-log" style="font-size:11px;font-weight:600;color:#273990;text-decoration:none;">Full Log →</a>
                        </div>
                        <div id="okw-notif-body" style="overflow-y:auto;flex:1;">Loading alerts...</div>
                    </div>
                </div>
                <button type="button" class="okw-icon-btn" id="okw-theme-toggle"></button>
                <div class="okw-user-wrap">
                    <button type="button" class="okw-topbar-avatar" id="okw-topbar-user" title="${String(displayName).replace(/"/g, '&quot;')}" aria-label="Account menu" aria-haspopup="true" aria-expanded="false">${initials}</button>
                    <div id="okw-user-dropdown" class="okw-user-dropdown" role="menu"></div>
                </div>
            </div>
        `;
        main.insertBefore(topbar, main.firstChild);

        applyTheme(getTheme());
        const sbToggle = topbar.querySelector('#okw-sidebar-toggle');
        if (sbToggle) sbToggle.addEventListener('click', toggleSidebar);
        topbar.querySelector('#okw-cmd-trigger').addEventListener('click', openCommandPalette);
        topbar.querySelector('#okw-theme-toggle').addEventListener('click', toggleTheme);
        const tpBtn = topbar.querySelector('#okw-today-profit-btn');
        if (tpBtn) tpBtn.addEventListener('click', openTodayProfitModal);
        setupQuickToolsDropdown(topbar);
        setupNotificationsDropdown(topbar);
        setupUserAvatarDropdown(topbar, user, role, displayName);
    }

    function todoStorageKey() {
        const u = getCurrentUser();
        return u && u.id ? `okw_todos_${u.id}` : 'okw_todos_default';
    }
    function loadTodos() {
        try { return JSON.parse(localStorage.getItem(todoStorageKey()) || '[]') || []; } catch (_) { return []; }
    }
    function saveTodos(list) {
        try { localStorage.setItem(todoStorageKey(), JSON.stringify(list)); } catch (_) { }
    }

    function openTodoModal(prefillDate = '') {
        const prev = document.getElementById('okw-todo-modal');
        if (prev) prev.remove();
        const today = prefillDate || new Date().toISOString().slice(0, 10);
        const backdrop = document.createElement('div');
        backdrop.id = 'okw-todo-modal';
        backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(11,16,23,0.62);z-index:10060;display:flex;align-items:center;justify-content:center;padding:16px;';
        backdrop.innerHTML = `
            <div class="okw-card" style="width:100%;max-width:560px;max-height:88vh;overflow-y:auto;padding:22px 24px;">
                <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--edge,#e2e8f0);padding-bottom:10px;margin-bottom:14px;">
                    <h2 style="margin:0;font-size:17px;">To-Do List</h2>
                    <button type="button" id="td-close" class="okw-btn okw-btn-outline">Close</button>
                </div>
                <form id="td-form" style="display:grid;grid-template-columns:1.6fr 1fr 110px auto;gap:8px;margin-bottom:14px;">
                    <input type="text" id="td-title" class="okw-input" placeholder="Task title..." required>
                    <input type="date" id="td-date" class="okw-input" value="${today}">
                    <select id="td-prio" class="okw-select">
                        <option value="Medium">Medium</option>
                        <option value="High">High</option>
                        <option value="Low">Low</option>
                    </select>
                    <button type="submit" class="okw-btn okw-btn-primary">Add</button>
                </form>
                <div id="td-list" style="display:flex;flex-direction:column;gap:8px;"></div>
            </div>`;
        document.body.appendChild(backdrop);
        backdrop.querySelector('#td-close').onclick = () => backdrop.remove();
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });

        const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        function renderList() {
            const items = loadTodos();
            const host = backdrop.querySelector('#td-list');
            if (!items.length) {
                host.innerHTML = '<div style="padding:18px;text-align:center;color:var(--muted,#64748b);font-size:13px;">No tasks yet. Add your first To-Do above.</div>';
                return;
            }
            host.innerHTML = items.map((t, i) => `
                <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border:1px solid var(--edge,#e2e8f0);border-radius:8px;${t.done ? 'opacity:0.55;' : ''}">
                    <label style="display:flex;align-items:center;gap:10px;cursor:pointer;flex:1;">
                        <input type="checkbox" data-td-chk="${i}" ${t.done ? 'checked' : ''}>
                        <div>
                            <div style="font-weight:600;font-size:13.5px;${t.done ? 'text-decoration:line-through;' : ''}">${esc(t.title)}</div>
                            <div style="font-size:11.5px;color:var(--muted,#64748b);">Due: ${esc(t.date || 'No date')} · Priority: <strong>${esc(t.priority || 'Medium')}</strong></div>
                        </div>
                    </label>
                    <button type="button" class="okw-btn okw-btn-danger" data-td-del="${i}" style="height:28px;padding:0 10px;font-size:12px;">Delete</button>
                </div>`).join('');
            host.querySelectorAll('[data-td-chk]').forEach(cb => {
                cb.onchange = () => {
                    const list = loadTodos();
                    list[Number(cb.dataset.tdChk)].done = cb.checked;
                    saveTodos(list);
                    renderList();
                };
            });
            host.querySelectorAll('[data-td-del]').forEach(btn => {
                btn.onclick = () => {
                    const list = loadTodos();
                    list.splice(Number(btn.dataset.tdDel), 1);
                    saveTodos(list);
                    renderList();
                };
            });
        }
        backdrop.querySelector('#td-form').onsubmit = (e) => {
            e.preventDefault();
            const title = backdrop.querySelector('#td-title').value.trim();
            if (!title) return;
            const list = loadTodos();
            list.unshift({
                id: Date.now(),
                title,
                date: backdrop.querySelector('#td-date').value,
                priority: backdrop.querySelector('#td-prio').value,
                done: false
            });
            saveTodos(list);
            backdrop.querySelector('#td-title').value = '';
            renderList();
        };
        renderList();
    }

    function openCalendarModal() {
        const prev = document.getElementById('okw-cal-modal');
        if (prev) prev.remove();
        const now = new Date();
        let curYear = now.getFullYear();
        let curMonth = now.getMonth();
        const backdrop = document.createElement('div');
        backdrop.id = 'okw-cal-modal';
        backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(11,16,23,0.62);z-index:10060;display:flex;align-items:center;justify-content:center;padding:16px;';
        backdrop.innerHTML = `
            <div class="okw-card" style="width:100%;max-width:680px;max-height:90vh;overflow-y:auto;padding:22px 24px;">
                <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--edge,#e2e8f0);padding-bottom:10px;margin-bottom:14px;">
                    <div style="display:flex;align-items:center;gap:10px;">
                        <button type="button" id="cal-prev" class="okw-btn okw-btn-outline" style="height:30px;padding:0 10px;">‹</button>
                        <h2 id="cal-title" style="margin:0;font-size:17px;min-width:170px;text-align:center;"></h2>
                        <button type="button" id="cal-next" class="okw-btn okw-btn-outline" style="height:30px;padding:0 10px;">›</button>
                    </div>
                    <div style="display:flex;gap:8px;">
                        <button type="button" id="cal-add-todo" class="okw-btn okw-btn-primary">+ Add To Do</button>
                        <button type="button" id="cal-close" class="okw-btn okw-btn-outline">Close</button>
                    </div>
                </div>
                <div id="cal-grid"></div>
                <div style="margin-top:10px;font-size:12px;color:var(--muted,#64748b);">Click any day to add a To-Do for that date.</div>
            </div>`;
        document.body.appendChild(backdrop);
        backdrop.querySelector('#cal-close').onclick = () => backdrop.remove();
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
        backdrop.querySelector('#cal-add-todo').onclick = () => { backdrop.remove(); openTodoModal(); };

        const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        function renderCal() {
            backdrop.querySelector('#cal-title').textContent = `${months[curMonth]} ${curYear}`;
            const firstDay = new Date(curYear, curMonth, 1).getDay();
            const daysInMonth = new Date(curYear, curMonth + 1, 0).getDate();
            const todayIso = new Date().toISOString().slice(0, 10);
            const todos = loadTodos();
            const byDate = {};
            todos.forEach(t => { if (t.date) { byDate[t.date] = (byDate[t.date] || 0) + 1; } });

            let html = '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px;text-align:center;font-size:11.5px;font-weight:700;color:var(--muted,#64748b);margin-bottom:6px;">' +
                ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div>${d}</div>`).join('') + '</div>';
            html += '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px;">';
            for (let i = 0; i < firstDay; i++) html += '<div></div>';
            for (let d = 1; d <= daysInMonth; d++) {
                const iso = `${curYear}-${String(curMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                const isToday = iso === todayIso;
                const cnt = byDate[iso] || 0;
                html += `<button type="button" data-cal-day="${iso}" style="min-height:58px;padding:6px;border-radius:8px;border:1px solid ${isToday ? '#273990' : 'var(--edge,#e2e8f0)'};background:${isToday ? 'rgba(39,57,144,0.08)' : 'var(--sheet,#fff)'};cursor:pointer;display:flex;flex-direction:column;align-items:flex-start;justify-content:space-between;color:var(--ink,#0f172a);">
                    <span style="font-weight:${isToday ? '800' : '600'};font-size:13px;color:${isToday ? '#273990' : 'inherit'};">${d}</span>
                    ${cnt ? `<span style="font-size:10.5px;font-weight:700;padding:1px 6px;border-radius:999px;background:#F9A51A;color:#111827;">${cnt} task${cnt > 1 ? 's' : ''}</span>` : ''}
                </button>`;
            }
            html += '</div>';
            const grid = backdrop.querySelector('#cal-grid');
            grid.innerHTML = html;
            grid.querySelectorAll('[data-cal-day]').forEach(btn => {
                btn.onclick = () => { backdrop.remove(); openTodoModal(btn.dataset.calDay); };
            });
        }
        backdrop.querySelector('#cal-prev').onclick = () => { curMonth--; if (curMonth < 0) { curMonth = 11; curYear--; } renderCal(); };
        backdrop.querySelector('#cal-next').onclick = () => { curMonth++; if (curMonth > 11) { curMonth = 0; curYear++; } renderCal(); };
        renderCal();
    }

    function startApplicationTour() {
        const prev = document.getElementById('okw-app-tour');
        if (prev) prev.remove();
        const steps = [
            { title: 'Welcome to Your Store Portal', body: 'This quick tour shows you where everything lives so you can run sales, stock, expenses, and reports effortlessly.', selector: '.sidebar' },
            { title: 'Instant Sidebar Search', body: 'Use "Find page..." at the top of the sidebar to jump straight to any screen — type "z report", "suppliers", "drafts", or "payroll" and press Enter.', selector: '#okw-sidebar-search' },
            { title: 'Global Quick Search (Ctrl+K)', body: 'Press Ctrl+K (or click Search in the top bar) from any page to jump across modules instantly.', selector: '#okw-cmd-trigger' },
            { title: 'Quick Tools (+ Menu)', body: 'Click the "+" button anytime to open your Business Calendar, manage To-Do tasks, or replay this Application Tour.', selector: '#okw-plus-btn' },
            { title: 'Sales, POS & Drafts', body: 'Open Sales in the sidebar for POS checkout, All Sales, Quotations, and Drafts (where you can Edit, Print, Delete, or send a Draft straight to POS).', selector: '.nav-group[data-group="Sales"]' },
            { title: 'Inventory, Suppliers & Contacts', body: 'Manage Current Stock, Purchase Orders, Adjustments, Transfers, Suppliers, Customers, and Customer Groups — click any row for a printable form or click any column header to sort.', selector: '.nav-group[data-group="Inventory"]' },
            { title: 'Reports, Filters & Export', body: 'Every report puts KPIs at the top, Search on the left, and Filters ▾ + Export ▾ (CSV, Excel, Print, PDF) cleanly on the right.', selector: '.nav-group[data-group="Reports"]' }
        ];
        let idx = 0;
        const overlay = document.createElement('div');
        overlay.id = 'okw-app-tour';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(11,16,23,0.58);z-index:10080;display:flex;align-items:center;justify-content:center;padding:16px;';
        document.body.appendChild(overlay);

        let highlighted = null;
        function clearHighlight() {
            if (highlighted) {
                highlighted.style.outline = '';
                highlighted.style.outlineOffset = '';
                highlighted = null;
            }
        }
        function renderStep() {
            clearHighlight();
            const s = steps[idx];
            const el = s.selector ? document.querySelector(s.selector) : null;
            if (el) {
                highlighted = el;
                el.style.outline = '3px solid #F9A51A';
                el.style.outlineOffset = '3px';
                try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) { }
            }
            overlay.innerHTML = `
                <div class="okw-card" style="width:100%;max-width:460px;padding:22px 24px;box-shadow:0 24px 60px rgba(0,0,0,0.35);">
                    <div style="font-size:11.5px;font-weight:700;text-transform:uppercase;color:#F9A51A;letter-spacing:0.05em;">Step ${idx + 1} of ${steps.length}</div>
                    <h3 style="margin:6px 0 8px;font-size:18px;">${s.title}</h3>
                    <p style="margin:0 0 18px;font-size:13.5px;line-height:1.55;color:var(--ink-2,#334155);">${s.body}</p>
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <button type="button" id="tour-skip" class="okw-btn okw-btn-outline">Close</button>
                        <div style="display:flex;gap:8px;">
                            ${idx > 0 ? '<button type="button" id="tour-prev" class="okw-btn okw-btn-outline">Back</button>' : ''}
                            <button type="button" id="tour-next" class="okw-btn okw-btn-primary">${idx === steps.length - 1 ? 'Finish' : 'Next →'}</button>
                        </div>
                    </div>
                </div>`;
            overlay.querySelector('#tour-skip').onclick = () => { clearHighlight(); overlay.remove(); };
            const prevBtn = overlay.querySelector('#tour-prev');
            if (prevBtn) prevBtn.onclick = () => { idx--; renderStep(); };
            overlay.querySelector('#tour-next').onclick = () => {
                if (idx >= steps.length - 1) { clearHighlight(); overlay.remove(); }
                else { idx++; renderStep(); }
            };
        }
        renderStep();
    }

    function setupQuickToolsDropdown(topbar) {
        const btn = topbar.querySelector('#okw-plus-btn');
        const dd = topbar.querySelector('#okw-plus-dropdown');
        if (!btn || !dd) return;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = dd.style.display === 'block';
            dd.style.display = open ? 'none' : 'block';
            btn.setAttribute('aria-expanded', open ? 'false' : 'true');
        });
        dd.addEventListener('click', (e) => e.stopPropagation());
        document.addEventListener('click', () => {
            dd.style.display = 'none';
            btn.setAttribute('aria-expanded', 'false');
        });
        topbar.querySelector('#okw-act-calendar').onclick = () => { dd.style.display = 'none'; openCalendarModal(); };
        topbar.querySelector('#okw-act-todo').onclick = () => { dd.style.display = 'none'; openTodoModal(); };
        topbar.querySelector('#okw-act-tour').onclick = () => { dd.style.display = 'none'; startApplicationTour(); };
    }

    function setupUserAvatarDropdown(topbar, user, role, displayName) {
        const btn = topbar.querySelector('#okw-topbar-user');
        const dd = topbar.querySelector('#okw-user-dropdown');
        if (!btn || !dd) return;

        const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const isCompany = role === 'company' || role === 'business_client' || (user && user.type === 'company');
        const isCeo = role === 'ceo';
        const isAdmin = role === 'super_admin' || role === 'admin';
        const isManager = role === 'manager' || role === 'store_manager';
        const isCashier = role === 'cashier' || role === 'teller';

        const items = [];
        if (isCompany) {
            items.push({ label: 'Home', href: '/dashboard' });
            items.push({ label: 'Proforma', href: '/company-portal?tab=proforma' });
            items.push({ label: 'Profile', href: '/company-portal?tab=company-profile' });
            items.push({ label: 'Settings', href: '/company-portal?tab=settings' });
        } else if (isAdmin || isCeo) {
            items.push({ label: 'Settings', href: '/settings?tab=store' });
            items.push({ label: 'Profile', href: '/profile' });
        } else if (isManager) {
            items.push({ label: 'POS', href: '/pos' });
            items.push({ label: 'Settings', href: '/settings?tab=store' });
            items.push({ label: 'Profile', href: '/profile' });
        } else if (isCashier) {
            items.push({ label: 'POS', href: '/pos' });
            items.push({ label: 'Shift', href: '/till?tab=close' });
            items.push({ label: 'Orders', href: '/extras' });
            items.push({ label: 'Profile', href: '/profile' });
        } else {
            items.push({ label: 'Deliveries', href: '/operations' });
            items.push({ label: 'Profile', href: '/profile' });
        }

        const roleLabel = (role || 'staff').replace(/_/g, ' ').toUpperCase();
        const branchLabel = user && user.store_location ? ` · ${user.store_location}` : '';
        dd.innerHTML = `
            <div class="okw-user-dd-head">
                <div class="okw-user-dd-name">${esc(displayName)}</div>
                <div class="okw-user-dd-meta">${esc(roleLabel + branchLabel)}</div>
            </div>
            <div class="okw-user-dd-list">
                ${items.map(it => `<a class="okw-user-dd-item" role="menuitem" href="${it.href}">${esc(it.label)}</a>`).join('')}
                <div class="okw-user-dd-sep"></div>
                <button type="button" class="okw-user-dd-item okw-user-dd-danger" id="okw-user-logout" role="menuitem">Sign out</button>
            </div>
        `;

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const notifDd = topbar.querySelector('#okw-notif-dropdown');
            if (notifDd) notifDd.style.display = 'none';
            const open = dd.classList.toggle('open');
            btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        dd.addEventListener('click', (e) => e.stopPropagation());
        document.addEventListener('click', () => {
            dd.classList.remove('open');
            btn.setAttribute('aria-expanded', 'false');
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                dd.classList.remove('open');
                btn.setAttribute('aria-expanded', 'false');
            }
        });

        const logoutBtn = dd.querySelector('#okw-user-logout');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', async () => {
                try {
                    const token = localStorage.getItem('authToken') || localStorage.getItem('companyToken') || localStorage.getItem('token');
                    await fetch(isCompany ? '/api/company/logout' : '/api/logout', {
                        method: 'POST',
                        headers: token ? { Authorization: 'Bearer ' + token } : {},
                        credentials: 'include'
                    }).catch(() => { });
                } catch (_) { }
                try { localStorage.clear(); sessionStorage.clear(); } catch (_) { }
                window.location.replace('/login?logout=true');
            });
        }
    }

    function defaultLogout() {
        localStorage.removeItem('authToken');
        localStorage.removeItem('companyToken');
        localStorage.removeItem('token');
        localStorage.removeItem('currentUser');
        localStorage.removeItem('companyUser');
        localStorage.removeItem('user');
        sessionStorage.clear();
        window.location.href = '/login';
    }

    function enhanceSidebar() {
        const sidebar = document.querySelector('.sidebar');
        if (!sidebar) return;

        if (localStorage.getItem('okwesiwa_sidebar_collapsed') === '1') {
            setSidebarCollapsed(true);
        }
        initMainContentSidebarAutoClose();

        const user = getCurrentUser();
        const role = (user && user.role ? user.role : 'cashier').toLowerCase().replace(/[\s-]+/g, '_');
        const userName = (user && (user.name || user.username)) || 'Staff';
        const userRoleLabel = (user && user.role) ? user.role.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Staff';
        const currentPath = window.location.pathname.replace(/\.html$/, '') || '/';
        const currentFull = currentPath + (window.location.search || '');

        // Single source of truth: the same role-filtered menu is rendered on every page,
        // including the CEO and company portals (their tabs are regular menu entries).
        const nav = sidebar.querySelector('.nav-links');
        if (nav) {
            const allowed = role === 'super_admin'
                ? MODULES
                : MODULES.filter(m => m.roles.includes('all') || m.roles.includes(role));
            const currentParams = new URLSearchParams(window.location.search || '');
            // Normalize default sub-views for /reports so the right item highlights even without explicit params
            const normParams = new URLSearchParams(currentParams.toString());
            if (currentPath === '/reports') {
                const tab = normParams.get('tab');
                if (tab === 'detailed' && !normParams.get('report')) normParams.set('report', 'transactions');
                if (tab === 'drilldown' && !normParams.get('view')) normParams.set('view', 'items_today');
                if (!tab && normParams.get('report')) normParams.set('tab', 'detailed');
            }
            const hasExactMatch = allowed.some(m => matchesModuleUrl(m.url, currentPath, normParams));
            const currentQuery = normParams.toString();
            const defaultForPath = allowed.find(m => m.url.split('?')[0] === currentPath);
            const isItemActive = (m) => {
                if (hasExactMatch) return matchesModuleUrl(m.url, currentPath, normParams);
                const [path, query] = m.url.split('?');
                if (path !== currentPath) return false;
                if (currentQuery) return false;
                return query ? m === defaultForPath : true;
            };
            const groups = [];
            const groupMap = new Map();
            for (const m of allowed) {
                if (!groupMap.has(m.group)) {
                    const arr = [];
                    groupMap.set(m.group, arr);
                    groups.push([m.group, arr]);
                }
                groupMap.get(m.group).push(m);
            }
            const GROUP_ICONS = {
                'User Management': 'users',
                'CEO': 'shield',
                'Company': 'layers',
                'Sales': 'shoppingBag',
                'Till': 'clock',
                'Inventory': 'package',
                'Contacts': 'users',
                'Accounts': 'dollarSign',
                'Reports': 'barChart',
                'Insights': 'trendingUp',
                'Staff': 'users',
                'Settings': 'settings',
                'Profile': 'user'
            };
            nav.innerHTML = groups.map(([groupName, items]) => {
                const distinctSubgroups = new Set(items.map(i => i.subgroup).filter(Boolean));
                const showSubgroups = distinctSubgroups.size > 1;
                let lastSub = null;
                const links = items.map(m => {
                    const active = isItemActive(m) ? ' active' : '';
                    let subHtml = '';
                    if (showSubgroups && m.subgroup && m.subgroup !== lastSub) {
                        lastSub = m.subgroup;
                        subHtml = `<div class="nav-subgroup-label">${m.subgroup}</div>`;
                    }
                    return `${subHtml}<a href="${m.url}" class="nav-item${active}">${ICONS[m.icon] || ''}<span>${m.label}</span></a>`;
                }).join('');
                if (groupName === 'Core' || groupName === 'Account') return links;
                const hasActive = items.some(isItemActive);
                const groupIconSvg = ICONS[GROUP_ICONS[groupName] || (items[0] && items[0].icon) || 'folder'] || '';
                const chevSvg = '<svg class="nav-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
                return `
                    <div class="nav-group" data-group="${groupName}">
                        <button type="button" class="nav-section nav-section-toggle${hasActive ? ' has-active' : ''}" title="${groupName}" aria-label="${groupName}" aria-expanded="${hasActive ? 'true' : 'false'}">
                            ${groupIconSvg}
                            <span class="nav-group-text">${groupName}</span>
                            ${chevSvg}
                        </button>
                        <div class="nav-group-items" style="display:${hasActive ? 'flex' : 'none'};flex-direction:column;">
                            ${links}
                        </div>
                    </div>
                `;
            }).join('');

            const collapseAllGroups = () => {
                nav.querySelectorAll('.nav-group').forEach(g => {
                    const b = g.querySelector('.nav-section-toggle');
                    const el = g.querySelector('.nav-group-items');
                    if (b) b.setAttribute('aria-expanded', 'false');
                    if (el) el.style.display = 'none';
                });
            };

            nav.querySelectorAll('.nav-section-toggle').forEach(btn => {
                btn.addEventListener('click', () => {
                    const groupEl = btn.closest('.nav-group');
                    const itemsEl = groupEl ? groupEl.querySelector('.nav-group-items') : null;
                    if (!itemsEl) return;
                    const wasCollapsed = document.body.classList.contains('sidebar-collapsed');
                    if (wasCollapsed) {
                        setSidebarCollapsed(false);
                        collapseAllGroups();
                        btn.setAttribute('aria-expanded', 'true');
                        itemsEl.style.display = 'flex';
                        return;
                    }
                    const isOpen = btn.getAttribute('aria-expanded') === 'true';
                    collapseAllGroups();
                    if (!isOpen) {
                        btn.setAttribute('aria-expanded', 'true');
                        itemsEl.style.display = 'flex';
                    }
                });
            });

            nav.querySelectorAll('.nav-group-items a').forEach(link => {
                link.addEventListener('click', () => {
                    collapseAllGroups();
                });
            });

            // Instant inline sidebar quick-find search
            let searchWrap = sidebar.querySelector('.sidebar-search-wrap');
            if (!searchWrap) {
                searchWrap = document.createElement('div');
                searchWrap.className = 'sidebar-search-wrap';
                searchWrap.innerHTML = `
                    <span class="sidebar-search-icon" aria-hidden="true">${ICONS.search}</span>
                    <input type="search" id="okw-sidebar-search" class="sidebar-search-input" placeholder="Find page..." aria-label="Find page in menu" autocomplete="off">
                `;
                nav.parentNode.insertBefore(searchWrap, nav);
            }
            const searchInput = searchWrap.querySelector('#okw-sidebar-search');
            if (searchInput && !searchInput.dataset.okwBound) {
                searchInput.dataset.okwBound = '1';
                const applySidebarFilter = () => {
                    const q = searchInput.value.trim().toLowerCase();
                    // Standalone top-level links (e.g. Dashboard, My Profile)
                    Array.from(nav.children).forEach(child => {
                        if (child.matches('a.nav-item')) {
                            const txt = (child.textContent || '').toLowerCase();
                            child.style.display = (!q || txt.includes(q)) ? '' : 'none';
                        }
                    });
                    nav.querySelectorAll('.nav-group').forEach(group => {
                        const groupName = (group.dataset.group || '').toLowerCase();
                        const toggleBtn = group.querySelector('.nav-section-toggle');
                        const itemsBox = group.querySelector('.nav-group-items');
                        if (!itemsBox) return;
                        if (!q) {
                            group.style.display = '';
                            itemsBox.querySelectorAll('a.nav-item, .nav-subgroup-label').forEach(el => { el.style.display = ''; });
                            const isActiveGroup = !!(toggleBtn && toggleBtn.classList.contains('has-active'));
                            if (toggleBtn) toggleBtn.setAttribute('aria-expanded', isActiveGroup ? 'true' : 'false');
                            itemsBox.style.display = isActiveGroup ? 'flex' : 'none';
                            return;
                        }
                        let currentSub = '';
                        let visibleCount = 0;
                        const subLabels = [];
                        let activeSubEntry = null;
                        Array.from(itemsBox.children).forEach(el => {
                            if (el.classList.contains('nav-subgroup-label')) {
                                currentSub = (el.textContent || '').toLowerCase();
                                activeSubEntry = { el, count: 0 };
                                subLabels.push(activeSubEntry);
                            } else if (el.matches('a.nav-item')) {
                                const text = (el.textContent || '').toLowerCase();
                                const match = text.includes(q) || groupName.includes(q) || currentSub.includes(q);
                                el.style.display = match ? '' : 'none';
                                if (match) {
                                    visibleCount++;
                                    if (activeSubEntry) activeSubEntry.count++;
                                }
                            }
                        });
                        subLabels.forEach(s => { s.el.style.display = s.count > 0 ? '' : 'none'; });
                        group.style.display = visibleCount > 0 ? '' : 'none';
                        if (visibleCount > 0) {
                            if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
                            itemsBox.style.display = 'flex';
                        }
                    });
                };
                searchInput.addEventListener('input', applySidebarFilter);
                searchInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape') {
                        searchInput.value = '';
                        applySidebarFilter();
                        searchInput.blur();
                    } else if (e.key === 'Enter') {
                        const firstVisible = Array.from(nav.querySelectorAll('a.nav-item')).find(a => a.offsetParent !== null);
                        if (firstVisible) window.location.href = firstVisible.getAttribute('href');
                    }
                });
            }

            initSidebarPrefetch(nav);
        }

        const applyCompanyLogo = (logoUrl) => {
            if (!logoUrl) return;
            document.querySelectorAll('.sidebar .brand img, img[src*="okwesiwa-logo"], img[alt="Store Logo"]').forEach(img => {
                if (img.getAttribute('src') !== logoUrl) img.src = logoUrl;
            });
        };
        try {
            const cachedSettings = JSON.parse(localStorage.getItem('posSettings') || '{}');
            if (cachedSettings && cachedSettings.logo_url) applyCompanyLogo(cachedSettings.logo_url);
        } catch (_) { }
        if (window.OkwUI && typeof OkwUI.getCompanyProfile === 'function') {
            Promise.resolve(OkwUI.getCompanyProfile()).then(p => {
                const logo = p && (p.logoUrl || p.logo_url);
                if (logo) applyCompanyLogo(logo);
            }).catch(() => { });
        }

        // Ensure a single uniform role badge under the logo on every page
        const ROLE_BADGES = {
            super_admin: 'Super Profile',
            ceo: 'CEO',
            admin: 'Administrator',
            manager: 'Store Manager',
            store_manager: 'Store Manager',
            cashier: 'Cashier',
            teller: 'Cashier',
            storekeeper: 'Store Keeper',
            driver: 'Driver',
            company: 'Business Client',
            business_client: 'Business Client'
        };
        const brand = sidebar.querySelector('.brand');
        if (brand) {
            let badge = brand.querySelector('.sidebar-role-badge');
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'sidebar-role-badge';
                brand.appendChild(badge);
            }
            badge.textContent = ROLE_BADGES[role] || userRoleLabel;
        }

        // Ensure a single uniform user-profile card exists in the sidebar footer
        let profile = sidebar.querySelector('.user-profile');
        if (!profile) {
            profile = document.createElement('div');
            profile.className = 'user-profile';
            profile.innerHTML = `
                <div class="user-profile-row">
                    <div class="user-avatar">${ICONS.user}</div>
                    <div class="user-info">
                        <div id="userName"></div>
                        <div id="userRole"></div>
                    </div>
                </div>
                <button type="button" class="sidebar-logout-btn" title="Logout" aria-label="Logout">${ICONS.logOut}</button>
            `;
            sidebar.appendChild(profile);
            profile.querySelector('.sidebar-logout-btn').addEventListener('click', () => {
                if (typeof global.logout === 'function') global.logout();
                else defaultLogout();
            });
        }
        const nameEl = profile.querySelector('#userName');
        const roleEl = profile.querySelector('#userRole');
        if (nameEl) nameEl.textContent = userName;
        if (roleEl) roleEl.textContent = userRoleLabel;
    }

    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            openCommandPalette();
        }
    });

    // pages that title themselves with an h2 still need one level-1 heading for screen readers
    function ensurePageHeading() {
        if (document.querySelector('h1, [role="heading"][aria-level="1"]')) return;
        const t = document.querySelector('.header-title h2, .header h2, .page-header h2, .main-content h2, .container h2, h2');
        if (t) { t.setAttribute('role', 'heading'); t.setAttribute('aria-level', '1'); }
    }

    // Landmarks and structure a screen reader can navigate by. Idempotent: safe to run repeatedly.
    function ensureStructure() {
        const main = document.querySelector('.main-content') || document.querySelector('body > .container');
        if (main && !document.querySelector('main, [role="main"]')) { main.setAttribute('role', 'main'); if (!main.id) main.id = 'main-content'; }
        const nav = document.querySelector('.sidebar .nav-links');
        if (nav && !nav.getAttribute('role')) { nav.setAttribute('role', 'navigation'); nav.setAttribute('aria-label', 'Main menu'); }
        const bar = document.querySelector('.okw-topbar');
        if (bar && !bar.getAttribute('role')) bar.setAttribute('role', 'banner');
        document.querySelectorAll('.skip-link').forEach((el) => el.remove());
        // card and section titles are headings; big figures are not
        document.querySelectorAll('.card-title, .section-title, .section-title-v3, .chart-title').forEach((el) => {
            if (!/^H[1-6]$/.test(el.tagName) && !el.getAttribute('role')) { el.setAttribute('role', 'heading'); el.setAttribute('aria-level', '2'); }
        });
        document.querySelectorAll('.stat-info h3, .kpi-value').forEach((el) => { if (/^H[1-6]$/.test(el.tagName)) el.setAttribute('role', 'presentation'); });
        // modals announce themselves as dialogs
        document.querySelectorAll('.modal-container, .modal-content, .modal-box').forEach((m) => {
            if (m.getAttribute('role')) return;
            m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true');
            const title = m.querySelector('.modal-title, h2, h3');
            if (title) { if (!title.id) title.id = 'dlg-' + Math.random().toString(36).slice(2, 8); m.setAttribute('aria-labelledby', title.id); }
        });
        // page notifications are announced
        document.querySelectorAll('.notification, #notification').forEach((n) => { if (!n.getAttribute('role')) { n.setAttribute('role', 'status'); n.setAttribute('aria-live', 'polite'); } });
    }

    // Keyboard focus for modals: move focus in, keep Tab inside, close on Escape, give focus back.
    function initModalFocus() {
        const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
        let current = null, opener = null, queued = false;
        const isOpen = (m) => {
            const cs = getComputedStyle(m);
            return cs.display !== 'none' && cs.visibility !== 'hidden' && m.getBoundingClientRect().width > 0 &&
                (m.classList.contains('active') || m.classList.contains('show'));
        };
        const findOpen = () => [...document.querySelectorAll('.modal-overlay, .modal')].filter((m) => !m.parentElement.closest('.modal-overlay, .modal')).find(isOpen) || null;
        const focusables = (m) => [...m.querySelectorAll(FOCUSABLE)].filter((e) => e.offsetParent !== null);
        function sync() {
            queued = false;
            const m = findOpen();
            if (m && m !== current) {
                opener = document.activeElement;
                current = m;
                setTimeout(() => {
                    const f = focusables(m);
                    const target = m.querySelector('input:not([type="hidden"]), select, textarea') || f[0];
                    if (target) target.focus(); else { m.setAttribute('tabindex', '-1'); m.focus(); }
                }, 60);
            } else if (!m && current) {
                current = null;
                if (opener && document.contains(opener) && typeof opener.focus === 'function') opener.focus();
                opener = null;
            }
        }
        new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(sync); } })
            .observe(document.body, { attributes: true, attributeFilter: ['class', 'style'], subtree: true });
        document.addEventListener('keydown', (e) => {
            if (!current) return;
            if (e.key === 'Escape') {
                const btn = current.querySelector('.close-modal, .modal-close, [aria-label="Close"], [data-close]');
                if (btn) { e.preventDefault(); btn.click(); } else { current.classList.remove('active', 'show'); }
            } else if (e.key === 'Tab') {
                const f = focusables(current);
                if (!f.length) { e.preventDefault(); return; }
                const first = f[0], last = f[f.length - 1];
                if (e.shiftKey && (document.activeElement === first || !current.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && (document.activeElement === last || !current.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
            }
        });
    }

    // form controls with no label get an accessible name from their placeholder, title or id
    function labelOrphans() {
        document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea').forEach((el) => {
            if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.closest('label') || (el.id && document.querySelector('label[for="' + el.id + '"]'))) return;
            const text = el.getAttribute('title') || el.getAttribute('placeholder') || (el.id || el.name || '').replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
            el.setAttribute('aria-label', (text && text.trim()) || (el.tagName === 'SELECT' ? 'Choose an option' : 'Filter'));
        });
    }

    function initPlainEnglishChat() {
        const user = getCurrentUser();
        const role = (user && user.role ? user.role : '').toLowerCase().replace(/[\s-]+/g, '_');
        if (!['super_admin', 'ceo', 'admin', 'manager', 'store_manager'].includes(role)) return;
        if (document.getElementById('okw-ai-chat-fab')) return;

        const fab = document.createElement('button');
        fab.id = 'okw-ai-chat-fab';
        fab.type = 'button';
        fab.title = 'Ask in Plain English';
        fab.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:10040;height:44px;padding:0 16px;border-radius:999px;border:1.5px solid #F9A51A;background:#273990;color:#ffffff;font-size:13px;font-weight:600;display:inline-flex;align-items:center;gap:8px;box-shadow:0 8px 24px rgba(15,23,42,0.24);cursor:pointer;';
        fab.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span>Business AI</span>`;

        const box = document.createElement('div');
        box.id = 'okw-ai-chat-box';
        box.style.cssText = 'display:none;position:fixed;right:20px;bottom:74px;z-index:10041;width:370px;max-width:calc(100vw - 32px);max-height:480px;flex-direction:column;background:var(--sheet,#ffffff);color:var(--ink,#0f172a);border:1px solid var(--edge,#cbd5e1);border-radius:14px;box-shadow:0 18px 42px rgba(15,23,42,0.22);overflow:hidden;';
        box.innerHTML = `
            <div style="background:#273990;color:#fff;padding:12px 14px;border-bottom:2px solid #F9A51A;display:flex;justify-content:space-between;align-items:center;">
                <div>
                    <div style="font-size:13.5px;font-weight:700;">Business AI Assistant</div>
                    <div style="font-size:11px;opacity:0.8;">Live sales, stock, credit, cash &amp; strategy</div>
                </div>
                <button type="button" id="okw-ai-close" style="background:transparent;border:0;color:#fff;font-size:18px;cursor:pointer;line-height:1;">&times;</button>
            </div>
            <div id="okw-ai-messages" style="flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;font-size:12.5px;min-height:180px;max-height:290px;">
                <div style="padding:8px 10px;border-radius:8px;background:var(--frame,#f8fafc);border:1px solid var(--edge,#e2e8f0);color:var(--ink-2,#334155);">
                    Hello! Ask me about live sales, low stock, credit balances, cash/MoMo totals, expenses, or revenue recommendations.
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:5px;">
                    <button type="button" class="okw-ai-chip" data-q="What sold most in the last 30 days?" style="font-size:11px;padding:4px 8px;border-radius:999px;border:1px solid var(--edge,#cbd5e1);background:var(--sheet,#fff);color:var(--ink,#0f172a);cursor:pointer;">Top selling</button>
                    <button type="button" class="okw-ai-chip" data-q="What is low in stock?" style="font-size:11px;padding:4px 8px;border-radius:999px;border:1px solid var(--edge,#cbd5e1);background:var(--sheet,#fff);color:var(--ink,#0f172a);cursor:pointer;">Low stock</button>
                    <button type="button" class="okw-ai-chip" data-q="Which customers owe money?" style="font-size:11px;padding:4px 8px;border-radius:999px;border:1px solid var(--edge,#cbd5e1);background:var(--sheet,#fff);color:var(--ink,#0f172a);cursor:pointer;">Credit owing</button>
                    <button type="button" class="okw-ai-chip" data-q="Show cash and MoMo balances" style="font-size:11px;padding:4px 8px;border-radius:999px;border:1px solid var(--edge,#cbd5e1);background:var(--sheet,#fff);color:var(--ink,#0f172a);cursor:pointer;">Cash &amp; MoMo</button>
                    <button type="button" class="okw-ai-chip" data-q="How can we increase revenue?" style="font-size:11px;padding:4px 8px;border-radius:999px;border:1px solid var(--edge,#cbd5e1);background:var(--sheet,#fff);color:var(--ink,#0f172a);cursor:pointer;">Strategy tips</button>
                </div>
            </div>
            <form id="okw-ai-form" style="display:flex;gap:6px;padding:10px;border-top:1px solid var(--edge,#e2e8f0);background:var(--frame,#f8fafc);">
                <input type="text" id="okw-ai-input" placeholder="Ask a question..." style="flex:1;height:34px;padding:0 10px;border:1px solid var(--edge,#cbd5e1);border-radius:8px;background:var(--sheet,#fff);color:var(--ink,#0f172a);font-size:12.5px;">
                <button type="submit" style="height:34px;padding:0 12px;border:0;border-radius:8px;background:#273990;color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;">Send</button>
            </form>
        `;

        document.body.appendChild(fab);
        document.body.appendChild(box);

        fab.addEventListener('click', () => {
            const open = box.style.display === 'flex';
            box.style.display = open ? 'none' : 'flex';
            if (!open) setTimeout(() => box.querySelector('#okw-ai-input')?.focus(), 40);
        });
        box.querySelector('#okw-ai-close').addEventListener('click', () => { box.style.display = 'none'; });
        box.querySelectorAll('.okw-ai-chip').forEach(ch => {
            ch.addEventListener('click', () => {
                const inp = box.querySelector('#okw-ai-input');
                if (inp) { inp.value = ch.getAttribute('data-q') || ''; box.querySelector('#okw-ai-form').requestSubmit(); }
            });
        });

        box.querySelector('#okw-ai-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const inp = box.querySelector('#okw-ai-input');
            const msgs = box.querySelector('#okw-ai-messages');
            const q = inp.value.trim();
            if (!q) return;
            inp.value = '';
            const uBubble = document.createElement('div');
            uBubble.style.cssText = 'align-self:flex-end;background:#273990;color:#fff;padding:7px 10px;border-radius:10px;max-width:85%;';
            uBubble.textContent = q;
            msgs.appendChild(uBubble);
            msgs.scrollTop = msgs.scrollHeight;

            try {
                const token = localStorage.getItem('authToken') || localStorage.getItem('token') || sessionStorage.getItem('token');
                const r = await fetch('/api/ceo-live/ask', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                    credentials: 'include',
                    body: JSON.stringify({ question: q })
                });
                const d = await r.json().catch(() => ({}));
                const aBubble = document.createElement('div');
                aBubble.style.cssText = 'align-self:flex-start;background:var(--frame,#f8fafc);border:1px solid var(--edge,#e2e8f0);padding:8px 10px;border-radius:10px;max-width:92%;';
                const escTxt = (s) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
                const rowsHtml = Array.isArray(d.table) && d.table.length
                    ? '<div style="margin-top:6px;font-size:11.5px;color:var(--muted,#64748b);">' +
                    d.table.slice(0, 5).map(row => escTxt(Object.values(row).slice(0, 3).join(' · '))).join('<br>') +
                    '</div>'
                    : '';
                const safeLink = (typeof d.link === 'string' && d.link.startsWith('/') && !d.link.startsWith('//')) ? escTxt(d.link) : '';
                aBubble.innerHTML = `<div>${escTxt(d.answer || d.message || 'No answer')}</div>${rowsHtml}${safeLink ? `<div style="margin-top:6px;"><a href="${safeLink}" style="color:#273990;font-weight:600;text-decoration:none;">Open Full Report &rarr;</a></div>` : ''}`;
                msgs.appendChild(aBubble);
                msgs.scrollTop = msgs.scrollHeight;
            } catch (_) { }
        });
    }

    // A page shown inside a hub section (?embed=1 in a frame) gets no sidebar, top bar or chat.
    const IS_EMBEDDED = /[?&]embed=1(&|$)/.test(window.location.search) && window.self !== window.top;
    if (IS_EMBEDDED) document.documentElement.classList.add('okw-embed');

    // Idle sign-out for roles that work in back-office pages. Tills (cashier, teller, storekeeper, driver) stay open.
    function initIdleSignOut() {
        let role = '';
        try { role = String((JSON.parse(localStorage.getItem('currentUser') || localStorage.getItem('companyUser') || '{}') || {}).role || '').toLowerCase(); } catch (_) { }
        if (!['ceo', 'admin', 'super_admin', 'manager', 'store_manager', 'company', 'business_client'].includes(role)) return;
        if (/\/(login|pos|customer-display|forgot-password|reset-password)$/.test(window.location.pathname)) return;
        const IDLE_MS = 30 * 60 * 1000, WARN_MS = 29 * 60 * 1000;
        let last = Date.now(), warned = null;
        const touch = () => { last = Date.now(); if (warned) { warned.remove(); warned = null; } };
        ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'].forEach(ev => window.addEventListener(ev, touch, { passive: true }));
        setInterval(async () => {
            const idle = Date.now() - last;
            if (idle >= IDLE_MS) {
                try {
                    const token = localStorage.getItem('authToken') || localStorage.getItem('companyToken');
                    if (token) await fetch(role.includes('company') || role === 'business_client' ? '/api/company/logout' : '/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, credentials: 'include' }).catch(() => { });
                } catch (_) { }
                try { localStorage.clear(); sessionStorage.clear(); } catch (_) { }
                window.location.replace('/login?logout=true&idle=1');
            } else if (idle >= WARN_MS && !warned) {
                warned = document.createElement('div');
                warned.setAttribute('role', 'alert');
                warned.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:100000;background:#273990;color:#fff;padding:12px 18px;border-radius:10px;font:500 14px system-ui;box-shadow:0 8px 24px rgba(15,23,42,.25)';
                warned.textContent = 'You will be signed out in a minute because of inactivity. Move the mouse or press a key to stay signed in.';
                document.body.appendChild(warned);
            }
        }, 20 * 1000);
    }

    function enforceCashierShiftGate() {
        let role = '';
        try {
            const u = JSON.parse(localStorage.getItem('currentUser') || localStorage.getItem('user') || '{}') || {};
            role = String(u.role || '').toLowerCase();
        } catch (_) { }
        if (!['cashier', 'teller'].includes(role)) return;

        const token = localStorage.getItem('authToken') || localStorage.getItem('token') || sessionStorage.getItem('token');
        if (!token) return;

        const path = window.location.pathname;
        const isOpenShiftGatePage = path === '/open-shift';

        fetch('/api/shifts/active', {
            headers: { Authorization: 'Bearer ' + token },
            credentials: 'include'
        }).then(r => (r.ok ? r.json() : null)).then(data => {
            if (!data || data.active) return;
            if (!isOpenShiftGatePage) {
                window.location.replace('/open-shift');
                return;
            }
            document.body.classList.add('okw-shift-gate');
            if (!document.getElementById('okw-shift-gate-logout')) {
                const btn = document.createElement('button');
                btn.id = 'okw-shift-gate-logout';
                btn.type = 'button';
                btn.textContent = 'Log out';
                btn.style.cssText = 'position:fixed;top:16px;right:20px;z-index:100001;padding:8px 16px;border-radius:8px;border:1px solid #cbd5e1;background:#ffffff;color:#1e293b;font:600 13px Inter,system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(15,23,42,0.08);';
                btn.addEventListener('click', async () => {
                    try {
                        await fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, credentials: 'include' }).catch(() => { });
                    } catch (_) { }
                    try { localStorage.clear(); sessionStorage.clear(); } catch (_) { }
                    window.location.replace('/login?logout=true');
                });
                document.body.appendChild(btn);
            }
        }).catch(() => { });
    }

    // Public pages (before sign-in) have no menu, top bar or assistant.
    const IS_PUBLIC_PAGE = /\/(login|forgot-password|reset-password|help|privacy|terms)\/?$/.test(window.location.pathname);

    function bootLayout() {
        const safeRun = (fn) => { try { fn(); } catch (e) { console.error('OkwLayout error:', e); } };
        if (IS_PUBLIC_PAGE) { safeRun(labelOrphans); return; }
        if (IS_EMBEDDED) {
            safeRun(labelOrphans);
            safeRun(initModalFocus);
            // a link to another page (POS, a hub...) must open in the whole window, never nest inside the frame
            document.addEventListener('click', (e) => {
                const a = e.target.closest && e.target.closest('a[href]');
                if (!a || a.target || a.hasAttribute('download')) return;
                const href = a.getAttribute('href') || '';
                if (!href || href.charAt(0) === '#' || /^javascript:/i.test(href)) return;
                a.target = '_top';
            }, true);
            return;
        }
        safeRun(enforceCashierShiftGate);
        safeRun(enhanceSidebar);
        safeRun(initIdleSignOut);
        safeRun(injectTopbarIfNeeded);
        safeRun(initPlainEnglishChat);
        safeRun(labelOrphans);
        safeRun(initModalFocus);
        safeRun(ensurePageHeading);
        safeRun(ensureStructure);
        setTimeout(() => safeRun(labelOrphans), 1500);
        setTimeout(() => safeRun(ensureStructure), 1500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootLayout);
    } else {
        bootLayout();
    }

    global.OkwLayout = {
        getTheme,
        applyTheme,
        toggleTheme,
        openCommandPalette,
        toggleSidebar
    };
    // Pages without their own mobile menu handler use the shared one.
    if (typeof global.toggleSidebar !== 'function') global.toggleSidebar = toggleSidebar;
})(window);
