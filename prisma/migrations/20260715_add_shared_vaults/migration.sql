-- AlterTable: Keypair-Felder für geteilte Tresore
ALTER TABLE "users" ADD COLUMN "publicKey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "users" ADD COLUMN "encryptedPrivateKey" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "vaults" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vaults_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vault_members" (
    "id" TEXT NOT NULL,
    "vaultId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "wrappedKey" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vault_members_pkey" PRIMARY KEY ("id")
);

-- AlterTable: StoredPassword kann in einem Tresor liegen
ALTER TABLE "stored_passwords" ADD COLUMN "vaultId" TEXT;

-- CreateIndex
CREATE INDEX "vaults_ownerId_idx" ON "vaults"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "vault_members_vaultId_userId_key" ON "vault_members"("vaultId", "userId");

-- CreateIndex
CREATE INDEX "vault_members_userId_idx" ON "vault_members"("userId");

-- CreateIndex
CREATE INDEX "stored_passwords_vaultId_idx" ON "stored_passwords"("vaultId");

-- AddForeignKey
ALTER TABLE "vaults" ADD CONSTRAINT "vaults_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_members" ADD CONSTRAINT "vault_members_vaultId_fkey" FOREIGN KEY ("vaultId") REFERENCES "vaults"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_members" ADD CONSTRAINT "vault_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stored_passwords" ADD CONSTRAINT "stored_passwords_vaultId_fkey" FOREIGN KEY ("vaultId") REFERENCES "vaults"("id") ON DELETE CASCADE ON UPDATE CASCADE;
