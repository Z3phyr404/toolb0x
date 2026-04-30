-- CreateTable
CREATE TABLE "servers" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" TEXT NOT NULL DEFAULT '22',
    "username" TEXT NOT NULL,
    "authType" TEXT NOT NULL DEFAULT 'password',
    "password" TEXT NOT NULL DEFAULT '',
    "privateKey" TEXT NOT NULL DEFAULT '',
    "passphrase" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "servers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "servers_userId_idx" ON "servers"("userId");

-- AddForeignKey
ALTER TABLE "servers" ADD CONSTRAINT "servers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
