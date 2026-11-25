-- DropIndex
DROP INDEX "Resource_ownerId_type_name_key";

-- AlterTable
ALTER TABLE "Resource" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lockedUntil" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Resource_ownerId_type_name_idx" ON "Resource"("ownerId", "type", "name");

-- CreateIndex
CREATE INDEX "Resource_status_lockedUntil_idx" ON "Resource"("status", "lockedUntil");

-- A tenant can't have two live resources of the same type with the same name,
-- but a deleted resource's name can be reused. Prisma can't express partial indexes.
CREATE UNIQUE INDEX "Resource_owner_type_name_live_key"
  ON "Resource"("ownerId", "type", "name") WHERE "status" <> 'DELETED';
