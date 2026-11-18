-- 007: finish what 004 started. products.stock became NUMERIC(12,3), but these columns, which receive that value
-- directly, stayed INTEGER. Recording a stock count and the reorder check failed with
-- 'invalid input syntax for type integer: "20.000"'.
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
              ('stock_take_items', 'physical_count'),
              ('stock_take_items', 'system_count'),
              ('stock_take_items', 'variance'),
              ('reorder_alerts', 'current_stock'),
              ('reorder_alerts', 'reorder_level'),
              ('reorder_alerts', 'suggested_quantity')
          )
    LOOP
        EXECUTE format(
            'ALTER TABLE %I ALTER COLUMN %I TYPE NUMERIC(12,3) USING %I::numeric(12,3)',
            col.table_name, col.column_name, col.column_name
        );
        RAISE NOTICE 'Converted %.% to NUMERIC(12,3)', col.table_name, col.column_name;
    END LOOP;
END $$;
