-- Add availability flag to wholesale products
ALTER TABLE "WholesaleProduct" ADD COLUMN "inStock" BOOLEAN NOT NULL DEFAULT true;

-- Guest orders placed from the private /other store
CREATE TABLE "WholesaleOrder" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "subtotalCents" INTEGER NOT NULL,
    "shippingCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "shippingLabel" TEXT,
    "contactName" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "addressLine1" TEXT NOT NULL,
    "addressLine2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "zip" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'US',
    "notes" TEXT,
    "stripeSessionId" TEXT,
    "trackingCode" TEXT,
    "trackingUrl" TEXT,
    "carrier" TEXT,
    "shippedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WholesaleOrder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WholesaleOrder_orderNumber_key" ON "WholesaleOrder"("orderNumber");
CREATE INDEX "WholesaleOrder_status_idx" ON "WholesaleOrder"("status");
CREATE INDEX "WholesaleOrder_paymentStatus_idx" ON "WholesaleOrder"("paymentStatus");
CREATE INDEX "WholesaleOrder_createdAt_idx" ON "WholesaleOrder"("createdAt");

CREATE TABLE "WholesaleOrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "catNo" TEXT NOT NULL DEFAULT '',
    "productName" TEXT NOT NULL,
    "strength" TEXT NOT NULL DEFAULT '',
    "vialSize" TEXT NOT NULL DEFAULT '',
    "unitPriceCents" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,

    CONSTRAINT "WholesaleOrderItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WholesaleOrderItem_orderId_idx" ON "WholesaleOrderItem"("orderId");

ALTER TABLE "WholesaleOrderItem" ADD CONSTRAINT "WholesaleOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "WholesaleOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
