-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'PRO', 'TEAM');

-- CreateEnum
CREATE TYPE "AdminRoleType" AS ENUM ('SUPPORT', 'ADMIN', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('FLY', 'NEON', 'UPSTASH', 'PADDLE');

-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('ACTIVE', 'ROTATED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ResourceType" AS ENUM ('APP', 'WORKER', 'POSTGRES', 'REDIS');

-- CreateEnum
CREATE TYPE "ResourceStatus" AS ENUM ('PENDING', 'PROVISIONING', 'ACTIVE', 'FAILED', 'DELETING', 'DELETED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT,
    "plan" "Plan" NOT NULL DEFAULT 'FREE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminRole" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "AdminRoleType" NOT NULL,
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderCredential" (
    "id" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "field" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "CredentialStatus" NOT NULL DEFAULT 'ACTIVE',
    "ciphertext" TEXT,
    "iv" TEXT,
    "authTag" TEXT,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "fingerprint" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "ProviderCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Resource" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "type" "ResourceType" NOT NULL,
    "provider" "Provider" NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "status" "ResourceStatus" NOT NULL DEFAULT 'PENDING',
    "externalId" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secretCiphertext" TEXT,
    "secretIv" TEXT,
    "secretAuthTag" TEXT,
    "monthlyCostCents" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AdminRole_userId_key" ON "AdminRole"("userId");

-- CreateIndex
CREATE INDEX "ProviderCredential_provider_status_idx" ON "ProviderCredential"("provider", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCredential_provider_field_version_key" ON "ProviderCredential"("provider", "field", "version");

-- CreateIndex
CREATE INDEX "Resource_ownerId_status_idx" ON "Resource"("ownerId", "status");

-- CreateIndex
CREATE INDEX "Resource_provider_externalId_idx" ON "Resource"("provider", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Resource_ownerId_type_name_key" ON "Resource"("ownerId", "type", "name");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "AdminRole" ADD CONSTRAINT "AdminRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminRole" ADD CONSTRAINT "AdminRole_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderCredential" ADD CONSTRAINT "ProviderCredential_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- At most one ACTIVE version per (provider, field). Prisma can't express partial indexes.
CREATE UNIQUE INDEX "ProviderCredential_one_active_per_field"
  ON "ProviderCredential"("provider", "field") WHERE "status" = 'ACTIVE';
