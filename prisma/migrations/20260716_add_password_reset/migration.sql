-- AlterTable: Passwort-Reset (Recovery-Code + Admin-Reset-Token)
ALTER TABLE "users" ADD COLUMN "recoveryKey" TEXT;
ALTER TABLE "users" ADD COLUMN "resetToken" TEXT;
ALTER TABLE "users" ADD COLUMN "resetTokenExpires" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "users_resetToken_key" ON "users"("resetToken");
