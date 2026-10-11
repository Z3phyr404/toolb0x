-- Zephyr-Ausbau: einzeln schaltbare Berechtigungen und Freigabe in der App.
-- Bestehende Zugänge behalten genau ihre bisherigen Rechte (Finanzen lesen/schreiben).
-- Rollback:
--   ALTER TABLE "integration_credentials" DROP COLUMN "scopes";
--   ALTER TABLE "integration_drafts" DROP COLUMN "scope", DROP COLUMN "level",
--     DROP COLUMN "summary", DROP COLUMN "decision", DROP COLUMN "decidedAt";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261012120000_integration_scopes';

-- AlterTable
ALTER TABLE "integration_credentials" ADD COLUMN "scopes" TEXT[] DEFAULT ARRAY['finance.read', 'finance.write']::TEXT[];

-- AlterTable
ALTER TABLE "integration_drafts" ADD COLUMN "decidedAt" TIMESTAMP(3),
ADD COLUMN "decision" TEXT,
ADD COLUMN "level" TEXT NOT NULL DEFAULT 'auto',
ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'finance.write',
ADD COLUMN "summary" TEXT NOT NULL DEFAULT '';
