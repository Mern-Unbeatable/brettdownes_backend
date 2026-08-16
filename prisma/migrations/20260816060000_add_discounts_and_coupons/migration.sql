ALTER TABLE "Order" ADD COLUMN "couponCode" TEXT;

CREATE TABLE "DiscountTier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "scope" TEXT NOT NULL DEFAULT 'ORDER',
    "percent" INTEGER NOT NULL,
    "minSubtotalCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DiscountTier_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Coupon" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "discountType" TEXT NOT NULL DEFAULT 'PERCENT',
    "discountValue" INTEGER NOT NULL,
    "appliesTo" TEXT NOT NULL DEFAULT 'ALL',
    "minSubtotalCents" INTEGER NOT NULL DEFAULT 0,
    "usageLimit" INTEGER,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CouponProduct" (
    "couponId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    CONSTRAINT "CouponProduct_pkey" PRIMARY KEY ("couponId","productId")
);

CREATE UNIQUE INDEX "Coupon_code_key" ON "Coupon"("code");
CREATE INDEX "DiscountTier_enabled_idx" ON "DiscountTier"("enabled");
CREATE INDEX "Coupon_enabled_idx" ON "Coupon"("enabled");
CREATE INDEX "CouponProduct_productId_idx" ON "CouponProduct"("productId");

ALTER TABLE "CouponProduct" ADD CONSTRAINT "CouponProduct_couponId_fkey"
FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CouponProduct" ADD CONSTRAINT "CouponProduct_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "DiscountTier" ("id", "name", "enabled", "scope", "percent", "minSubtotalCents", "updatedAt")
VALUES
  ('orders-200', 'On all orders over $200', true, 'ORDER', 10, 20000, CURRENT_TIMESTAMP),
  ('orders-300', 'On all orders over $300', true, 'ORDER', 20, 30000, CURRENT_TIMESTAMP),
  ('full-kits', 'On full kits', true, 'KIT', 25, 0, CURRENT_TIMESTAMP);
