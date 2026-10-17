CREATE TABLE "WholesaleOrderEvent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WholesaleOrderEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WholesaleOrderEvent_orderId_idx" ON "WholesaleOrderEvent"("orderId");

ALTER TABLE "WholesaleOrderEvent" ADD CONSTRAINT "WholesaleOrderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "WholesaleOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
