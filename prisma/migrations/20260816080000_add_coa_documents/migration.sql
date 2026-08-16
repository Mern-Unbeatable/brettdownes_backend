CREATE TABLE "CoaDocument" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "documentUrl" TEXT NOT NULL DEFAULT '',
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CoaDocument_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CoaDocument_productId_idx" ON "CoaDocument"("productId");
CREATE INDEX "CoaDocument_isPublished_idx" ON "CoaDocument"("isPublished");

ALTER TABLE "CoaDocument" ADD CONSTRAINT "CoaDocument_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
