-- Sign-in moves to NazmulCodes Auth (central SSO).
-- Users are identified by centralUserId. Email is just synced profile data and is no longer unique.
-- passwordHash is dropped: Veltrix no longer has its own password login (fresh start, approved 2026-11-27).

-- DropIndex
DROP INDEX "User_email_key";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "passwordHash",
ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "centralUserId" TEXT,
ADD COLUMN     "centralVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "disabledAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "User_centralUserId_key" ON "User"("centralUserId");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

