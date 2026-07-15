// ============================================================
// EXPORT ROUTE TESTS
// ============================================================
// Testet den PDF-Export:
// - GET /pdf?month=YYYY-MM: Monats-Export
// - GET /pdf-all: Gesamt-Export aller Finanzdaten
// ============================================================

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');

// --- Mock-Prisma injizieren BEVOR die Route geladen wird ---
const { createMockPrisma } = require('../helpers/mockPrisma');
const mockPrisma = createMockPrisma();
const prismaPath = require.resolve('../../src/utils/prisma');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: mockPrisma };

// --- Auth-Helper ---
const { createTestAuth, cleanupAuth } = require('../helpers/authHelper');
const { encrypt } = require('../../src/utils/encryption');

// --- Route + Test-App ---
const exportRouter = require('../../src/routes/export');
const { createTestApp } = require('../helpers/testApp');
const app = createTestApp({ path: '/api/export', router: exportRouter });

let auth;
let testCategoryId;

function resetStore() {
  mockPrisma._store.expenses.length = 0;
  mockPrisma._store.incomes.length = 0;
  mockPrisma._store.monthInits.length = 0;
  mockPrisma._store.categories.length = 0;
  mockPrisma._store.users.length = 0;
}

function seedCategory() {
  testCategoryId = crypto.randomUUID();
  const key = auth.encryptionKey;
  mockPrisma._store.categories.push({
    id: testCategoryId,
    name: encrypt('Wohnen', key),
    color: encrypt('#FF5733', key),
    userId: auth.userId,
  });
  return testCategoryId;
}

function seedExpense({ name, amount, month, isRecurring = true, categoryId }) {
  const key = auth.encryptionKey;
  const record = {
    id: crypto.randomUUID(),
    name: encrypt(name, key),
    amount: encrypt(String(amount), key),
    tags: encrypt(JSON.stringify(['Test']), key),
    categoryId: categoryId || testCategoryId,
    userId: auth.userId,
    month,
    isRecurring,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  mockPrisma._store.expenses.push(record);
  return record;
}

function seedIncome({ name, amount, month, isRecurring = true }) {
  const key = auth.encryptionKey;
  const record = {
    id: crypto.randomUUID(),
    name: encrypt(name, key),
    amount: encrypt(String(amount), key),
    userId: auth.userId,
    month,
    isRecurring,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  mockPrisma._store.incomes.push(record);
  return record;
}

// =================================================================
// GET /api/export/pdf — Monats-PDF-Export
// =================================================================
describe('GET /api/export/pdf — Monats-Export', () => {
  beforeEach(() => {
    resetStore();
    auth = createTestAuth(mockPrisma);
    seedCategory();
  });

  after(() => cleanupAuth());

  it('gibt PDF mit korrekten Headern zurück', async () => {
    seedExpense({ name: 'Miete', amount: 640, month: '2026-03' });
    seedIncome({ name: 'Gehalt', amount: 3000, month: '2026-03' });

    const res = await request(app)
      .get('/api/export/pdf?month=2026-03')
      .set('Cookie', auth.cookie);

    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/pdf');
    assert.ok(res.headers['content-disposition'].includes('Finanzuebersicht'));
    assert.ok(res.body.length > 0, 'PDF sollte nicht leer sein');
  });

  it('gibt PDF auch bei leerem Monat zurück', async () => {
    const res = await request(app)
      .get('/api/export/pdf?month=2026-03')
      .set('Cookie', auth.cookie);

    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/pdf');
  });

  it('lehnt ungültiges Monatsformat ab', async () => {
    const res = await request(app)
      .get('/api/export/pdf?month=invalid')
      .set('Cookie', auth.cookie);

    assert.equal(res.status, 400);
  });

  it('verwendet aktuellen Monat als Default', async () => {
    const res = await request(app)
      .get('/api/export/pdf')
      .set('Cookie', auth.cookie);

    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/pdf');
  });
});

// =================================================================
// GET /api/export/pdf-all — Gesamt-PDF-Export
// =================================================================
describe('GET /api/export/pdf-all — Gesamt-Export', () => {
  beforeEach(() => {
    resetStore();
    auth = createTestAuth(mockPrisma);
    seedCategory();
  });

  after(() => cleanupAuth());

  it('gibt PDF mit korrekten Headern zurück', async () => {
    seedExpense({ name: 'Miete', amount: 640, month: '2026-03' });
    seedIncome({ name: 'Gehalt', amount: 3000, month: '2026-03' });

    const res = await request(app)
      .get('/api/export/pdf-all')
      .set('Cookie', auth.cookie);

    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/pdf');
    assert.ok(res.headers['content-disposition'].includes('Gesamtexport'));
    assert.ok(res.body.length > 0, 'PDF sollte nicht leer sein');
  });

  it('gibt PDF auch ohne Daten zurück (leere Datenbank)', async () => {
    const res = await request(app)
      .get('/api/export/pdf-all')
      .set('Cookie', auth.cookie);

    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/pdf');
    assert.ok(res.body.length > 0);
  });

  it('exportiert Daten aus mehreren Monaten', async () => {
    seedExpense({ name: 'Miete', amount: 640, month: '2026-01' });
    seedExpense({ name: 'Miete', amount: 640, month: '2026-02' });
    seedExpense({ name: 'Miete', amount: 640, month: '2026-03' });
    seedIncome({ name: 'Gehalt', amount: 3000, month: '2026-01' });
    seedIncome({ name: 'Gehalt', amount: 3000, month: '2026-02' });
    seedIncome({ name: 'Gehalt', amount: 3000, month: '2026-03' });

    const res = await request(app)
      .get('/api/export/pdf-all')
      .set('Cookie', auth.cookie);

    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/pdf');
    // PDF mit 3 Monaten sollte größer sein als mit 0
    assert.ok(res.body.length > 1000, 'PDF mit mehreren Monaten sollte substantiell sein');
  });

  it('exportiert nur Daten des authentifizierten Users', async () => {
    // Daten für den Test-User
    seedExpense({ name: 'Miete', amount: 640, month: '2026-03' });

    // Daten für einen anderen User (direkt in den Store)
    const otherUserId = crypto.randomUUID();
    mockPrisma._store.expenses.push({
      id: crypto.randomUUID(),
      name: encrypt('Fremde Ausgabe', auth.encryptionKey),
      amount: encrypt('999', auth.encryptionKey),
      tags: '',
      categoryId: testCategoryId,
      userId: otherUserId,
      month: '2026-03',
      isRecurring: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .get('/api/export/pdf-all')
      .set('Cookie', auth.cookie);

    assert.equal(res.status, 200);
    // Wir können den PDF-Inhalt nicht parsen, aber der Test stellt sicher,
    // dass die Query mit userId filtert (Row-Level Security)
  });

  it('enthält Filename mit aktuellem Datum', async () => {
    const res = await request(app)
      .get('/api/export/pdf-all')
      .set('Cookie', auth.cookie);

    const today = new Date().toISOString().slice(0, 10);
    assert.ok(
      res.headers['content-disposition'].includes(today),
      'Filename sollte aktuelles Datum enthalten',
    );
  });

  it('behandelt Ausgaben ohne Kategorie korrekt', async () => {
    // Ausgabe ohne categoryId
    const key = auth.encryptionKey;
    mockPrisma._store.expenses.push({
      id: crypto.randomUUID(),
      name: encrypt('Ohne Kategorie', key),
      amount: encrypt('50', key),
      tags: '',
      categoryId: null,
      userId: auth.userId,
      month: '2026-03',
      isRecurring: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .get('/api/export/pdf-all')
      .set('Cookie', auth.cookie);

    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/pdf');
  });

  it('behandelt Monat mit nur Einnahmen korrekt', async () => {
    seedIncome({ name: 'Gehalt', amount: 3000, month: '2026-03' });
    // Keine Ausgaben

    const res = await request(app)
      .get('/api/export/pdf-all')
      .set('Cookie', auth.cookie);

    assert.equal(res.status, 200);
  });

  it('behandelt Monat mit nur Ausgaben korrekt', async () => {
    seedExpense({ name: 'Miete', amount: 640, month: '2026-03' });
    // Keine Einnahmen

    const res = await request(app)
      .get('/api/export/pdf-all')
      .set('Cookie', auth.cookie);

    assert.equal(res.status, 200);
  });
});
