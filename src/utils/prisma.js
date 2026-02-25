// ============================================================
// ZENTRALE PRISMA-INSTANZ
// ============================================================
// Warum zentral? Jedes `new PrismaClient()` erstellt einen
// eigenen Verbindungspool zur Datenbank. Bei 5 Dateien die
// jeweils einen eigenen Client erstellen, sind das 5 Pools
// mit je ~10 Verbindungen = 50 Verbindungen.
// PostgreSQL erlaubt standardmäßig nur 100.
//
// Mit einer zentralen Instanz teilen sich alle Routen
// einen einzigen Pool — effizient und sicher.
// ============================================================

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  // In Production: Nur Warnungen und Fehler loggen
  log: process.env.NODE_ENV === 'production'
    ? ['warn', 'error']
    : ['query', 'warn', 'error'],
});

module.exports = prisma;
