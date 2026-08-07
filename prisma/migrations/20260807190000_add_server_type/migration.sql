-- Server-Typ: "linux" (voller Funktionsumfang) oder "storage"
-- (Hetzner Storage Box: nur Erreichbarkeit + Speicherbelegung via df)
ALTER TABLE "servers" ADD COLUMN "serverType" TEXT NOT NULL DEFAULT 'linux';
