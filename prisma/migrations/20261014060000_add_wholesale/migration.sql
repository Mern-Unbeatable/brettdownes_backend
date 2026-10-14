-- CreateTable
CREATE TABLE "WholesaleCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WholesaleCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WholesaleProduct" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "catNo" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL DEFAULT '',
    "strength" TEXT NOT NULL DEFAULT '',
    "vialSize" TEXT NOT NULL DEFAULT '',
    "priceCents" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WholesaleProduct_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WholesaleCategory_slug_key" ON "WholesaleCategory"("slug");

-- CreateIndex
CREATE INDEX "WholesaleCategory_sortOrder_idx" ON "WholesaleCategory"("sortOrder");

-- CreateIndex
CREATE INDEX "WholesaleProduct_categoryId_idx" ON "WholesaleProduct"("categoryId");

-- CreateIndex
CREATE INDEX "WholesaleProduct_sortOrder_idx" ON "WholesaleProduct"("sortOrder");

-- AddForeignKey
ALTER TABLE "WholesaleProduct" ADD CONSTRAINT "WholesaleProduct_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "WholesaleCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
