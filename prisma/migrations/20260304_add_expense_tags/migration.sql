-- AlterTable: Add tags field to expenses
ALTER TABLE "expenses" ADD COLUMN "tags" TEXT NOT NULL DEFAULT '';
