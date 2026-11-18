-- Indexes for the hottest list/filter queries (products list, batch stats, transactions by date).
CREATE INDEX IF NOT EXISTS idx_products_tenant_name_active
    ON products (tenant_id, name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_product_batches_barcode_active
    ON product_batches (product_barcode) WHERE status = 'Active';
CREATE INDEX IF NOT EXISTS idx_transactions_created_at
    ON transactions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_store_created
    ON transactions (store_location, created_at DESC);
