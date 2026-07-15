// ============================================================
// EXPENSES ROUTE TESTS
// ============================================================
// Testet die kritische wiederkehrende-Logik:
// - GET: Auto-Copy aus Vormonaten
// - POST: Vorwärts-Propagation in Zukunftsmonate
// - PUT: Edit-Propagation (Name/Betrag/Kategorie)
// - DELETE: Löschschutz via monthInit
// ============================================================

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');

// --- 1. Mock-Prisma erstellen und injizieren BEVOR die Route geladen wird ---
const { createMockPrisma } = require('../helpers/mockPrisma');
const mockPrisma = createMockPrisma();
const prismaPath = require.resolve('../../src/utils/prisma');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: mockPrisma };

// --- 2. Auth-Helper laden (setzt JWT_SECRET) ---
const { createTestAuth, cleanupAuth } = require('../helpers/authHelper');
const { encrypt, decrypt } = require('../../src/utils/encryption');

// --- 3. Route + Test-App laden ---
const expenseRouter = require('../../src/routes/expenses');
const { createTestApp } = require('../helpers/testApp');
const app = createTestApp({ path: '/api/expenses', router: expenseRouter });

// --- Test-Daten ---
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

function seedMonthInit(month) {
  mockPrisma._store.monthInits.push({
    id: crypto.randomUUID(),
    userId: auth.userId,
    month,
    type: 'expense',
  });
}

// =================================================================
// GET /api/expenses — Auto-Copy wiederkehrender Ausgaben
// =================================================================
describe('GET /api/expenses — Auto-Copy', () => {
  beforeEach(() => {
    resetStore();
    auth = createTestAuth(mockPrisma);
    seedCategory();
  });

  after(() => cleanupAuth());

  it('kopiert wiederkehrende Ausgaben aus Vormonat in leeren, nicht-initialisierten Monat', async () => {
    seedExpense({ name: 'Miete', amount: 640, month: '2026-02' });
    seedExpense({ name: 'Strom', amount: 85, month: '2026-02' });

    const res = await request(app)
      .get('/api/expenses?month=2026-03')
      .set('Cookie', auth.cookie);

    assert.equal(res.status, 200);
    assert.equal(res.body.expenses.length, 2);

    const names = res.body.expenses.map(e => e.name).sort();
    assert.deepEqual(names, ['Miete', 'Strom']);

    // monthInit muss erstellt worden sein
    const mi = mockPrisma._store.monthInits.find(
      m => m.month === '2026-03' && m.type === 'expense' && m.userId === auth.userId,
    );
    assert.ok(mi, 'monthInit für 2026-03 sollte existieren');
  });

  it('kopiert NICHT wenn Monat bereits initialisiert ist (auch wenn leer)', async () => {
    seedExpense({ name: 'Miete', amount: 640, month: '2026-02' });
    seedMonthInit('2026-03'); // Schon initialisiert

    const res = await request(app)
      .get('/api/expenses?month=2026-03')
      .set('Cookie', auth.cookie);

    assert.equal(res.status, 200);
    assert.equal(res.body.expenses.length, 0);
  });

  it('kopiert NICHT nicht-wiederkehrende Ausgaben', async () => {
    seedExpense({ name: 'Einmalig', amount: 100, month: '2026-02', isRecurring: false });

    const res = await request(app)
      .get('/api/expenses?month=2026-03')
      .set('Cookie', auth.cookie);

    assert.equal(res.status, 200);
    assert.equal(res.body.expenses.length, 0);
  });

  it('kopiert verschlüsselte Werte 1:1 (nicht neu verschlüsselt)', async () => {
    const original = seedExpense({ name: 'Miete', amount: 640, month: '2026-02' });
    const originalEncName = original.name;
    const originalEncAmount = original.amount;

    await request(app)
      .get('/api/expenses?month=2026-03')
      .set('Cookie', auth.cookie);

    // Die Kopie in 2026-03 muss den exakt gleichen Ciphertext haben
    const copy = mockPrisma._store.expenses.find(
      e => e.month === '2026-03' && e.userId === auth.userId,
    );
    assert.ok(copy, 'Kopie sollte existieren');
    assert.equal(copy.name, originalEncName);
    assert.equal(copy.amount, originalEncAmount);
  });

  it('stoppt an monthInit-Grenze (gelöschte Items kommen nicht zurück)', async () => {
    seedExpense({ name: 'Alte Miete', amount: 500, month: '2025-12', isRecurring: true });
    seedMonthInit('2026-01'); // Grenze — User hat 2026-01 manuell bearbeitet (alles gelöscht)
    // 2026-02 ist leer, kein monthInit → Suche geht zu 2026-01, findet monthInit, stoppt

    const res = await request(app)
      .get('/api/expenses?month=2026-02')
      .set('Cookie', auth.cookie);

    assert.equal(res.status, 200);
    assert.equal(res.body.expenses.length, 0);
  });

  it('erstellt monthInit auch wenn keine wiederkehrenden Ausgaben gefunden werden', async () => {
    // Keine Ausgaben irgendwo
    const res = await request(app)
      .get('/api/expenses?month=2026-03')
      .set('Cookie', auth.cookie);

    assert.equal(res.status, 200);
    assert.equal(res.body.expenses.length, 0);

    const mi = mockPrisma._store.monthInits.find(
      m => m.month === '2026-03' && m.type === 'expense',
    );
    assert.ok(mi, 'monthInit sollte auch bei leerem Ergebnis erstellt werden');
  });

  it('gibt bestehende Ausgaben direkt zurück (kein Auto-Copy)', async () => {
    seedExpense({ name: 'Miete', amount: 640, month: '2026-03' });

    const res = await request(app)
      .get('/api/expenses?month=2026-03')
      .set('Cookie', auth.cookie);

    assert.equal(res.status, 200);
    assert.equal(res.body.expenses.length, 1);
    assert.equal(res.body.expenses[0].name, 'Miete');
  });
});

// =================================================================
// POST /api/expenses — Vorwärts-Propagation
// =================================================================
describe('POST /api/expenses — Vorwärts-Propagation', () => {
  beforeEach(() => {
    resetStore();
    auth = createTestAuth(mockPrisma);
    seedCategory();
  });

  after(() => cleanupAuth());

  it('wiederkehrende Ausgabe wird in bereits initialisierte Zukunftsmonate kopiert', async () => {
    seedMonthInit('2026-04');
    seedMonthInit('2026-05');

    const res = await request(app)
      .post('/api/expenses')
      .set('Cookie', auth.cookie)
      .send({ name: 'Netflix', amount: 12.99, categoryId: testCategoryId, month: '2026-03', isRecurring: true });

    assert.equal(res.status, 201);

    // Sollte in 2026-03, 2026-04, 2026-05 existieren
    const all = mockPrisma._store.expenses.filter(e => e.userId === auth.userId);
    const months = all.map(e => e.month).sort();
    assert.deepEqual(months, ['2026-03', '2026-04', '2026-05']);
  });

  it('nicht-wiederkehrende Ausgabe wird NICHT in Zukunftsmonate kopiert', async () => {
    seedMonthInit('2026-04');

    const res = await request(app)
      .post('/api/expenses')
      .set('Cookie', auth.cookie)
      .send({ name: 'Einmalig', amount: 50, categoryId: testCategoryId, month: '2026-03', isRecurring: false });

    assert.equal(res.status, 201);

    const all = mockPrisma._store.expenses.filter(e => e.userId === auth.userId);
    assert.equal(all.length, 1);
    assert.equal(all[0].month, '2026-03');
  });

  it('keine Kopie in nicht-initialisierte Zukunftsmonate', async () => {
    // Kein monthInit für Zukunft

    const res = await request(app)
      .post('/api/expenses')
      .set('Cookie', auth.cookie)
      .send({ name: 'Spotify', amount: 9.99, categoryId: testCategoryId, month: '2026-03', isRecurring: true });

    assert.equal(res.status, 201);

    const all = mockPrisma._store.expenses.filter(e => e.userId === auth.userId);
    assert.equal(all.length, 1);
  });
});

// =================================================================
// PUT /api/expenses — Edit-Propagation
// =================================================================
describe('PUT /api/expenses — Edit-Propagation', () => {
  beforeEach(() => {
    resetStore();
    auth = createTestAuth(mockPrisma);
    seedCategory();
  });

  after(() => cleanupAuth());

  it('Namens-/Betrags-Änderung wird in Zukunftsmonate propagiert', async () => {
    // 3 Monate mit der gleichen wiederkehrenden Ausgabe
    const march = seedExpense({ name: 'Miete', amount: 640, month: '2026-03' });
    // Kopien haben den gleichen verschlüsselten Namen (wie beim Auto-Copy)
    const encName = march.name;
    const encAmount = march.amount;
    mockPrisma._store.expenses.push({
      id: crypto.randomUUID(), name: encName, amount: encAmount,
      categoryId: testCategoryId, userId: auth.userId, month: '2026-04',
      isRecurring: true, createdAt: new Date(), updatedAt: new Date(),
    });
    mockPrisma._store.expenses.push({
      id: crypto.randomUUID(), name: encName, amount: encAmount,
      categoryId: testCategoryId, userId: auth.userId, month: '2026-05',
      isRecurring: true, createdAt: new Date(), updatedAt: new Date(),
    });

    // März-Eintrag umbenennen
    const res = await request(app)
      .put(`/api/expenses/${march.id}`)
      .set('Cookie', auth.cookie)
      .send({ name: 'Kaltmiete', amount: 580, categoryId: testCategoryId, isRecurring: true });

    assert.equal(res.status, 200);
    assert.equal(res.body.expense.name, 'Kaltmiete');

    // April und Mai sollten auch aktualisiert sein
    const key = auth.encryptionKey;
    const april = mockPrisma._store.expenses.find(e => e.month === '2026-04');
    const may = mockPrisma._store.expenses.find(e => e.month === '2026-05');
    assert.equal(decrypt(april.name, key), 'Kaltmiete');
    assert.equal(decrypt(may.name, key), 'Kaltmiete');
    assert.equal(decrypt(april.amount, key), '580');
    assert.equal(decrypt(may.amount, key), '580');
  });

  it('KEINE Propagation in vergangene Monate', async () => {
    const jan = seedExpense({ name: 'Miete', amount: 640, month: '2026-01' });
    const march = seedExpense({ name: 'Miete', amount: 640, month: '2026-03' });
    // Jan hat seinen eigenen Ciphertext, March auch
    // Damit der Test funktioniert, müssen die gleichen verschlüsselten Werte haben
    // (wie beim Auto-Copy). Also setze ich Jan's Name auf March's Name.
    jan.name = march.name;
    jan.amount = march.amount;

    // März-Eintrag bearbeiten
    await request(app)
      .put(`/api/expenses/${march.id}`)
      .set('Cookie', auth.cookie)
      .send({ name: 'Kaltmiete', amount: 580, categoryId: testCategoryId, isRecurring: true });

    // Januar darf NICHT geändert sein (month: { gt: '2026-03' } trifft 2026-01 nicht)
    const key = auth.encryptionKey;
    const janAfter = mockPrisma._store.expenses.find(e => e.month === '2026-01');
    assert.equal(decrypt(janAfter.name, key), 'Miete');
  });

  it('KEINE Propagation wenn isRecurring auf false gesetzt wird', async () => {
    const march = seedExpense({ name: 'Miete', amount: 640, month: '2026-03' });
    mockPrisma._store.expenses.push({
      id: crypto.randomUUID(), name: march.name, amount: march.amount,
      categoryId: testCategoryId, userId: auth.userId, month: '2026-04',
      isRecurring: true, createdAt: new Date(), updatedAt: new Date(),
    });

    await request(app)
      .put(`/api/expenses/${march.id}`)
      .set('Cookie', auth.cookie)
      .send({ name: 'Kaltmiete', amount: 580, categoryId: testCategoryId, isRecurring: false });

    // April darf NICHT geändert sein
    const key = auth.encryptionKey;
    const april = mockPrisma._store.expenses.find(e => e.month === '2026-04');
    assert.equal(decrypt(april.name, key), 'Miete');
  });

  it('unabhängig geänderte Kopien werden NICHT überschrieben', async () => {
    const march = seedExpense({ name: 'Miete', amount: 640, month: '2026-03' });
    // April-Kopie wurde unabhängig geändert (anderer verschlüsselter Name)
    seedExpense({ name: 'Eigene Änderung', amount: 700, month: '2026-04' });

    await request(app)
      .put(`/api/expenses/${march.id}`)
      .set('Cookie', auth.cookie)
      .send({ name: 'Kaltmiete', amount: 580, categoryId: testCategoryId, isRecurring: true });

    const key = auth.encryptionKey;
    const april = mockPrisma._store.expenses.find(e => e.month === '2026-04');
    // April wurde NICHT überschrieben weil der verschlüsselte Name nicht matched
    assert.equal(decrypt(april.name, key), 'Eigene Änderung');
  });
});

// =================================================================
// DELETE /api/expenses — Löschschutz
// =================================================================
describe('DELETE /api/expenses — Löschschutz', () => {
  beforeEach(() => {
    resetStore();
    auth = createTestAuth(mockPrisma);
    seedCategory();
  });

  after(() => cleanupAuth());

  it('löscht die Ausgabe und markiert den Monat als initialisiert', async () => {
    const expense = seedExpense({ name: 'Miete', amount: 640, month: '2026-03' });

    const res = await request(app)
      .delete(`/api/expenses/${expense.id}`)
      .set('Cookie', auth.cookie);

    assert.equal(res.status, 200);

    // Ausgabe muss weg sein
    const remaining = mockPrisma._store.expenses.filter(e => e.userId === auth.userId);
    assert.equal(remaining.length, 0);

    // monthInit muss existieren
    const mi = mockPrisma._store.monthInits.find(
      m => m.month === '2026-03' && m.type === 'expense' && m.userId === auth.userId,
    );
    assert.ok(mi, 'monthInit für 2026-03 sollte existieren');
  });

  it('gelöschte Ausgaben kommen bei erneutem GET NICHT zurück', async () => {
    // 1. Vormonat mit wiederkehrender Ausgabe
    seedExpense({ name: 'Miete', amount: 640, month: '2026-02' });

    // 2. GET 2026-03 → kopiert Ausgabe
    let res = await request(app)
      .get('/api/expenses?month=2026-03')
      .set('Cookie', auth.cookie);
    assert.equal(res.body.expenses.length, 1);

    // 3. Kopie in 2026-03 löschen
    const copyId = mockPrisma._store.expenses.find(e => e.month === '2026-03').id;
    await request(app)
      .delete(`/api/expenses/${copyId}`)
      .set('Cookie', auth.cookie);

    // 4. Erneut GET 2026-03 → darf NICHT neu kopieren
    res = await request(app)
      .get('/api/expenses?month=2026-03')
      .set('Cookie', auth.cookie);
    assert.equal(res.body.expenses.length, 0, 'Gelöschte Ausgabe darf nicht zurückkommen');
  });
});
