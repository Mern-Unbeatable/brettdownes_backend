CREATE TYPE "ReviewClaimStatus" AS ENUM ('AWAITING_OTP', 'PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "ReviewCreditClaim" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "reviewEmail" TEXT NOT NULL,
    "otpHash" TEXT,
    "otpExpiresAt" TIMESTAMP(3),
    "otpAttempts" INTEGER NOT NULL DEFAULT 0,
    "emailVerifiedAt" TIMESTAMP(3),
    "status" "ReviewClaimStatus" NOT NULL DEFAULT 'AWAITING_OTP',
    "creditCents" INTEGER NOT NULL DEFAULT 500,
    "rejectReason" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewCreditClaim_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReviewCreditClaim_orderId_key" ON "ReviewCreditClaim"("orderId");
CREATE INDEX "ReviewCreditClaim_userId_idx" ON "ReviewCreditClaim"("userId");
CREATE INDEX "ReviewCreditClaim_status_idx" ON "ReviewCreditClaim"("status");
CREATE INDEX "ReviewCreditClaim_createdAt_idx" ON "ReviewCreditClaim"("createdAt");

ALTER TABLE "ReviewCreditClaim" ADD CONSTRAINT "ReviewCreditClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReviewCreditClaim" ADD CONSTRAINT "ReviewCreditClaim_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
