-- AlterTable
ALTER TABLE "User" ADD COLUMN "heardAboutUs" TEXT;
ALTER TABLE "User" ADD COLUMN "creditCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "creditCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PendingRegistration" ADD COLUMN "heardAboutUs" TEXT;
