-- Sammelposten: Ausgaben mit schwankendem Betrag (Lebensmittel, Tanken, ...)
-- sammeln Einzelbuchungen ein. `amount` ist bei diesen Posten die vom Server
-- gepflegte Summe der Buchungen, `plannedAmount` der Budgetwert daneben.
ALTER TABLE "expenses" ADD COLUMN "isCollector" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "expenses" ADD COLUMN "plannedAmount" TEXT;

-- Einzelbuchungen. Werden NIE in Folgemonate kopiert, nur der Posten selbst.
CREATE TABLE "expense_bookings" (
    "id" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "bookedOn" TEXT,
    "expenseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "expense_bookings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "expense_bookings_expenseId_idx" ON "expense_bookings"("expenseId");
CREATE INDEX "expense_bookings_userId_idx" ON "expense_bookings"("userId");

ALTER TABLE "expense_bookings" ADD CONSTRAINT "expense_bookings_expenseId_fkey"
    FOREIGN KEY ("expenseId") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "expense_bookings" ADD CONSTRAINT "expense_bookings_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
