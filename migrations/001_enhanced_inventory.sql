-- Enhanced Inventory System Migrations
-- Run this to set up complete inventory management system

-- 1. ENHANCED PRODUCTS TABLE with all required fields
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'products_v2') THEN
        CREATE TABLE products_v2 (
            barcode VARCHAR(50) PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            category VARCHAR(100),
            selling_unit VARCHAR(50) DEFAULT 'Unit',
            packaging_unit VARCHAR(50) DEFAULT 'Box',
            conversion_rate DECIMAL(10,2) DEFAULT 1,
            cost_price DECIMAL(10,2) DEFAULT 0,
            price DECIMAL(10,2) NOT NULL,
            stock INTEGER DEFAULT 0,
            reorder_level INTEGER DEFAULT 5,
            track_batch BOOLEAN DEFAULT false,
            track_expiry BOOLEAN DEFAULT false,
            branch_id INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    END IF;
END $$;

-- 2. PRICING TABLE (for multiple price lists)
CREATE TABLE IF NOT EXISTS price_lists (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    list_type VARCHAR(50), -- 'Standard', 'Wholesale', 'Promotional'
    branch_id INTEGER,
    effective_date DATE,
    status VARCHAR(20) DEFAULT 'Active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS price_list_items (
    id SERIAL PRIMARY KEY,
    price_list_id INTEGER REFERENCES price_lists(id) ON DELETE CASCADE,
    product_barcode VARCHAR(50) REFERENCES products(barcode) ON DELETE CASCADE,
    markup_percentage DECIMAL(5,2),
    selling_price DECIMAL(10,2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. SHELF MANAGEMENT TABLE
CREATE TABLE IF NOT EXISTS shelf_inventory (
    id SERIAL PRIMARY KEY,
    product_barcode VARCHAR(50) REFERENCES products(barcode) ON DELETE CASCADE,
    quantity_on_shelf INTEGER DEFAULT 0,
    store_quantity INTEGER DEFAULT 0,
    branch_id INTEGER,
    last_verified TIMESTAMP,
    staff_id INTEGER,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. STOCK ADJUSTMENTS TABLE (for damage, theft, errors)
CREATE TABLE IF NOT EXISTS stock_adjustments (
    id SERIAL PRIMARY KEY,
    product_barcode VARCHAR(50) REFERENCES products(barcode) ON DELETE CASCADE,
    adjustment_type VARCHAR(50), -- 'Damage', 'Theft', 'Counting Error', 'Expiry Write-off'
    quantity_adjusted INTEGER,
    reason TEXT,
    approver_id INTEGER,
    branch_id INTEGER,
    approved_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. STOCK TAKE (Physical Count) TABLE
CREATE TABLE IF NOT EXISTS stock_takes (
    id SERIAL PRIMARY KEY,
    stock_take_date DATE,
    branch_id INTEGER,
    created_by INTEGER,
    approved_by INTEGER,
    status VARCHAR(50) DEFAULT 'In Progress', -- 'In Progress', 'Completed', 'Approved'
    variance_total DECIMAL(10,2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_take_items (
    id SERIAL PRIMARY KEY,
    stock_take_id INTEGER REFERENCES stock_takes(id) ON DELETE CASCADE,
    product_barcode VARCHAR(50) REFERENCES products(barcode) ON DELETE CASCADE,
    physical_count INTEGER,
    system_count INTEGER,
    variance INTEGER,
    variance_reason VARCHAR(255),
    counted_by VARCHAR(100),
    counted_at TIMESTAMP
);

-- 6. STOCK TRANSFER/DISTRIBUTION TABLE (Enhanced)
CREATE TABLE IF NOT EXISTS stock_transfers_v2 (
    id SERIAL PRIMARY KEY,
    from_branch VARCHAR(100),
    to_branch VARCHAR(100),
    status VARCHAR(50) DEFAULT 'Pending', -- 'Pending', 'Confirmed', 'Rejected', 'Completed'
    created_by INTEGER,
    confirmed_by INTEGER,
    transfer_date DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    confirmed_at TIMESTAMP,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS stock_transfer_items (
    id SERIAL PRIMARY KEY,
    transfer_id INTEGER REFERENCES stock_transfers_v2(id) ON DELETE CASCADE,
    product_barcode VARCHAR(50) REFERENCES products(barcode) ON DELETE CASCADE,
    quantity_sent INTEGER,
    quantity_received INTEGER,
    unit_cost DECIMAL(10,2),
    batch_number VARCHAR(100),
    expiry_date DATE
);

-- 7. PRODUCT BATCHES TABLE (Enhanced with tracking)
CREATE TABLE IF NOT EXISTS product_batches_v2 (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER DEFAULT 1,
    product_barcode VARCHAR(50) REFERENCES products(barcode) ON DELETE CASCADE,
    batch_number VARCHAR(100) NOT NULL,
    expiry_date DATE,
    manufactured_date DATE,
    quantity_received INTEGER DEFAULT 0,
    quantity_available INTEGER DEFAULT 0,
    quantity_sold INTEGER DEFAULT 0,
    cost_price DECIMAL(10,2),
    unit_cost DECIMAL(10,2),
    branch_id INTEGER,
    status VARCHAR(50) DEFAULT 'Active', -- 'Active', 'Near Expiry', 'Expired', 'Sold Out'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, product_barcode, batch_number, branch_id)
);

-- 8. GOODS RECEIVED LOG TABLE
CREATE TABLE IF NOT EXISTS goods_received (
    id SERIAL PRIMARY KEY,
    po_id INTEGER REFERENCES purchase_orders(id),
    product_barcode VARCHAR(50) REFERENCES products(barcode) ON DELETE CASCADE,
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

-- 9. REORDER ALERTS TABLE
CREATE TABLE IF NOT EXISTS reorder_alerts (
    id SERIAL PRIMARY KEY,
    product_barcode VARCHAR(50) REFERENCES products(barcode) ON DELETE CASCADE,
    current_stock INTEGER,
    reorder_level INTEGER,
    suggested_quantity INTEGER,
    priority VARCHAR(20), -- 'Critical', 'High', 'Normal'
    status VARCHAR(50) DEFAULT 'Active',
    branch_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    acknowledged_at TIMESTAMP
);

-- 10. INVENTORY AUDIT LOG TABLE
CREATE TABLE IF NOT EXISTS inventory_audit_log (
    id SERIAL PRIMARY KEY,
    action_type VARCHAR(100), -- 'Stock In', 'Stock Out', 'Transfer', 'Adjustment', 'Stock Take'
    product_barcode VARCHAR(50) REFERENCES products(barcode) ON DELETE CASCADE,
    quantity_before INTEGER,
    quantity_after INTEGER,
    reference_id INTEGER, -- PO ID, Transfer ID, etc.
    reference_type VARCHAR(50),
    user_id INTEGER,
    branch_id INTEGER,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 11. FAST/SLOW MOVING ITEMS TABLE (for analytics)
CREATE TABLE IF NOT EXISTS product_performance (
    id SERIAL PRIMARY KEY,
    product_barcode VARCHAR(50) REFERENCES products(barcode) ON DELETE CASCADE,
    year INTEGER,
    month INTEGER,
    quantity_sold INTEGER DEFAULT 0,
    revenue DECIMAL(10,2) DEFAULT 0,
    average_daily_sales DECIMAL(10,2) DEFAULT 0,
    classification VARCHAR(50), -- 'Fast Moving', 'Slow Moving', 'Dead Stock'
    branch_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 12. UPDATE EXISTING PURCHASE_ORDERS TABLE
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(100);
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS invoice_date DATE;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS received_date DATE;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS branch_id INTEGER;

-- 13. UPDATE EXISTING STOCK_TRANSFERS TABLE
ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS branch_id INTEGER;
ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS confirmed_by INTEGER;
ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMP;

-- 14. CREATE PRICELIST ENTRIES TABLE
CREATE TABLE IF NOT EXISTS pricelist_entries (
    id SERIAL PRIMARY KEY,
    pricelist_id VARCHAR(50),
    product_barcode VARCHAR(50) REFERENCES products(barcode) ON DELETE CASCADE,
    cost_price DECIMAL(10,2),
    markup_percentage DECIMAL(5,2) DEFAULT 5,
    selling_price DECIMAL(10,2),
    branch_id INTEGER,
    effective_from DATE,
    effective_to DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 15. SHELVING MOVEMENT LOG
CREATE TABLE IF NOT EXISTS shelf_movements (
    id SERIAL PRIMARY KEY,
    product_barcode VARCHAR(50) REFERENCES products(barcode) ON DELETE CASCADE,
    movement_type VARCHAR(50), -- 'Store to Shelf', 'Shelf to Store'
    quantity INTEGER,
    staff_id INTEGER,
    from_location VARCHAR(100),
    to_location VARCHAR(100),
    branch_id INTEGER,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_batches_product ON product_batches(product_barcode);
CREATE INDEX IF NOT EXISTS idx_batches_expiry ON product_batches(expiry_date);
CREATE INDEX IF NOT EXISTS idx_stock_adjustments_product ON stock_adjustments(product_barcode);
CREATE INDEX IF NOT EXISTS idx_stock_takes_date ON stock_takes(stock_take_date);
CREATE INDEX IF NOT EXISTS idx_stock_takes_branch ON stock_takes(branch_id);
CREATE INDEX IF NOT EXISTS idx_transfers_status ON stock_transfers(status);
CREATE INDEX IF NOT EXISTS idx_reorder_alerts_priority ON reorder_alerts(priority);
CREATE INDEX IF NOT EXISTS idx_audit_log_product ON inventory_audit_log(product_barcode);
CREATE INDEX IF NOT EXISTS idx_performance_classification ON product_performance(classification);
