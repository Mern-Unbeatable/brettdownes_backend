-- Rename SKU to barcode (client inventory identifier)
ALTER TABLE "Variant" RENAME COLUMN "sku" TO "barcode";
ALTER TABLE "OrderItem" RENAME COLUMN "sku" TO "barcode";
