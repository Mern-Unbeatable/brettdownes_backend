ALTER TABLE "WholesaleProduct" ADD COLUMN "stock" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WholesaleProduct" ADD COLUMN "barcode" TEXT NOT NULL DEFAULT '';

-- Items currently marked available get 1 unit so they don't all go out of stock overnight.
UPDATE "WholesaleProduct" SET "stock" = 1 WHERE "inStock" = true AND "stock" = 0;
UPDATE "WholesaleProduct" SET "inStock" = false WHERE "stock" = 0;
UPDATE "WholesaleProduct" SET "inStock" = true WHERE "stock" > 0;

ALTER TABLE "WholesaleOrderItem" ADD COLUMN "productId" TEXT;
