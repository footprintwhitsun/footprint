-- 008: a reorder alert is per tenant and product. The table was unique on product_barcode alone, so two tenants
-- stocking the same barcode overwrote each other's alert (and the second tenant's insert replaced the first's).
-- Idempotent.

DO $$
DECLARE c TEXT;
BEGIN
    FOR c IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'public.reorder_alerts'::regclass AND contype = 'u'
          AND pg_get_constraintdef(oid) = 'UNIQUE (product_barcode)'
    LOOP
        EXECUTE format('ALTER TABLE reorder_alerts DROP CONSTRAINT %I', c);
    END LOOP;
END $$;

ALTER TABLE reorder_alerts ADD COLUMN IF NOT EXISTS tenant_id INT DEFAULT 1;
UPDATE reorder_alerts SET tenant_id = 1 WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reorder_alerts_tenant_barcode ON reorder_alerts (tenant_id, product_barcode);
