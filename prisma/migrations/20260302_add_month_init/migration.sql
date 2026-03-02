-- CreateTable
CREATE TABLE "month_inits" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "month_inits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "month_inits_userId_month_idx" ON "month_inits"("userId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "month_inits_userId_month_type_key" ON "month_inits"("userId", "month", "type");

-- AddForeignKey
ALTER TABLE "month_inits" ADD CONSTRAINT "month_inits_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
