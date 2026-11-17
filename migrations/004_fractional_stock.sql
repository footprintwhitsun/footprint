-- 004: Allow fractional stock quantities (e.g. 2.5 m chain-link, 3.75 kg nails)
-- Changes products.stock and stock-related quantity columns to NUMERIC(12,3).
-- Idempotent: each column is only altered if it is still an integer type.

DO $$
DECLARE
    col RECORD;
BEGIN
    FOR col IN
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type IN ('integer', 'smallint', 'bigint')
          AND (table_name, column_name) IN (
              ('products', 'stock'),
              ('products', 'reorder_level'),
              ('product_batches', 'quantity'),
              ('inventory_audit_log', 'quantity_before'),
              ('inventory_audit_log', 'quantity_after'),
              ('stock_adjustments', 'quantity_adjusted'),
              ('purchase_order_items', 'quantity')
          )
    LOOP
        EXECUTE format(
            'ALTER TABLE %I ALTER COLUMN %I TYPE NUMERIC(12,3) USING %I::numeric(12,3)',
            col.table_name, col.column_name, col.column_name
        );
        RAISE NOTICE 'Converted %.% to NUMERIC(12,3)', col.table_name, col.column_name;
    END LOOP;
END $$;

