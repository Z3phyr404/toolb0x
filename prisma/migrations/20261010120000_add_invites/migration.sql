-- Registrierung nur noch auf Einladung: Admin erzeugt einen Link,
-- in der DB liegt nur der SHA-256-Hash des Tokens (wie beim Reset-Link).
-- CreateTable
CREATE TABLE "invites" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invites_tokenHash_key" ON "invites"("tokenHash");

-- CreateIndex
CREATE INDEX "invites_createdById_idx" ON "invites"("createdById");

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
