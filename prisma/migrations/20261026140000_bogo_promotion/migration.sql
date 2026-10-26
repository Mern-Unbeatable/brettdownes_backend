-- CreateTable
CREATE TABLE "BogoPromotion" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BogoPromotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BogoPromotionProduct" (
    "promotionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,

    CONSTRAINT "BogoPromotionProduct_pkey" PRIMARY KEY ("promotionId","productId")
);

-- CreateIndex
CREATE INDEX "BogoPromotion_enabled_idx" ON "BogoPromotion"("enabled");

-- CreateIndex
CREATE INDEX "BogoPromotionProduct_productId_idx" ON "BogoPromotionProduct"("productId");

-- AddForeignKey
ALTER TABLE "BogoPromotionProduct" ADD CONSTRAINT "BogoPromotionProduct_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "BogoPromotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BogoPromotionProduct" ADD CONSTRAINT "BogoPromotionProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
