ALTER TABLE "Product"
ADD COLUMN "badge" TEXT NOT NULL DEFAULT '',
ADD COLUMN "showOnHome" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "homeOrder" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "Product_showOnHome_homeOrder_idx" ON "Product"("showOnHome", "homeOrder");
