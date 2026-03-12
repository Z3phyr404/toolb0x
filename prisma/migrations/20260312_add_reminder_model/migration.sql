-- CreateTable
CREATE TABLE "reminders" (
    "id" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "reminderDate" TIMESTAMP(3) NOT NULL,
    "daysBefore" INTEGER NOT NULL DEFAULT 3,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expenseId" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reminders_userId_status_idx" ON "reminders"("userId", "status");

-- CreateIndex
CREATE INDEX "reminders_userId_reminderDate_idx" ON "reminders"("userId", "reminderDate");

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "expenses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
