-- Add coupon/discount support to private-store ("Other") orders.
ALTER TABLE "WholesaleOrder"
  ADD COLUMN "discountCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "couponCode" TEXT;
