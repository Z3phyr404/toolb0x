-- Server-Typ: "linux" (voller Funktionsumfang) oder "storage"
-- (Hetzner Storage Box: nur Erreichbarkeit + Speicherbelegung via df)
ALTER TABLE "Server" ADD COLUMN "serverType" TEXT NOT NULL DEFAULT 'linux';
