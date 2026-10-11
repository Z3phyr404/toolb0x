-- Dauer-Zugang für den lokalen Hermes-Agenten (siehe docs/hermes-integration.md).
-- Rollback: DROP TABLE "integration_writes", "integration_drafts",
--           "integration_credentials"; danach die Zeile dieser Migration aus
--           "_prisma_migrations" löschen.

-- CreateTable
CREATE TABLE "integration_credentials" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Hermes',
    "scope" TEXT NOT NULL DEFAULT 'finance',
    "secretHash" TEXT NOT NULL,
    "wrappedKey" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_drafts" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_writes" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "month" TEXT,
    "result" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_writes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "integration_credentials_secretHash_key" ON "integration_credentials"("secretHash");

-- CreateIndex
CREATE INDEX "integration_credentials_userId_idx" ON "integration_credentials"("userId");

-- CreateIndex
CREATE INDEX "integration_drafts_credentialId_idx" ON "integration_drafts"("credentialId");

-- CreateIndex
CREATE UNIQUE INDEX "integration_writes_draftId_key" ON "integration_writes"("draftId");

-- CreateIndex
CREATE INDEX "integration_writes_userId_idx" ON "integration_writes"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "integration_writes_credentialId_idempotencyKey_key" ON "integration_writes"("credentialId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_drafts" ADD CONSTRAINT "integration_drafts_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "integration_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_writes" ADD CONSTRAINT "integration_writes_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "integration_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;
