-- 005: POS approval/PIN tables (previously created at request time) and supplier payments

CREATE TABLE IF NOT EXISTS pos_approval_tokens (
    token VARCHAR(80) PRIMARY KEY,
    approver_id INTEGER NULL,
    approver_name VARCHAR(120) DEFAULT '',
    approver_role VARCHAR(40) DEFAULT '',
    reason TEXT DEFAULT '',
    max_discount NUMERIC(12,2) NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pos_approval_tokens_expires ON pos_approval_tokens (expires_at);

CREATE TABLE IF NOT EXISTS pos_pin_attempts (
    attempt_key VARCHAR(120) PRIMARY KEY,
    fail_count INTEGER NOT NULL DEFAULT 0,
    reset_at TIMESTAMPTZ NOT NULL
);

-- Payments made to suppliers against purchase orders (used to compute payables)
CREATE TABLE IF NOT EXISTS supplier_payments (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER DEFAULT 1,
    supplier_id INTEGER REFERENCES suppliers(id),
    purchase_order_id INTEGER REFERENCES purchase_orders(id),
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    payment_method VARCHAR(40) DEFAULT 'bank',
    reference VARCHAR(120) DEFAULT '',
    notes TEXT DEFAULT '',
    paid_by INTEGER NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_po ON supplier_payments (purchase_order_id);

-- Lay-away deposits and instalments (counted in daily-close cash)
CREATE TABLE IF NOT EXISTS layaway_payments (
    id SERIAL PRIMARY KEY,
    layaway_id INTEGER NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    payment_method VARCHAR(40) DEFAULT 'cash',
    store_location VARCHAR(120) DEFAULT 'Main Shop',
    received_by INTEGER NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_layaway_payments_created ON layaway_payments (created_at);
