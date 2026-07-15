// ============================================================
// INCOME ROUTE TESTS
// ============================================================
// Gleiche Struktur wie expenses.test.js, ohne categoryId.
// ============================================================

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');

// --- Mock-Prisma injizieren ---
const { createMockPrisma } = require('../helpers/mockPrisma');
const mockPrisma = createMockPrisma();
const prismaPath = require.resolve('../../src/utils/prisma');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: mockPrisma };

// --- Auth-Helper ---
const { createTestAuth, cleanupAuth } = require('../helpers/authHelper');
const { encrypt, decrypt } = require('../../src/utils/encryption');

// --- Route + Test-App ---
const incomeRouter = require('../../src/routes/income');
const { createTestApp } = require('../helpers/testApp');
const app = createTestApp({ path: '/api/income', router: incomeRouter });

let auth;

function resetStore() {
  mockPrisma._store.expenses.length = 0;
  mockPrisma._store.incomes.length = 0;
  mockPrisma._store.monthInits.length = 0;
  mockPrisma._store.categories.length = 0;
  mockPrisma._store.users.length = 0;
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

function seedMonthInit(month) {
  mockPrisma._store.monthInits.push({
    id: crypto.randomUUID(),
    userId: auth.userId,
    month,
    type: 'income',
  });
}

// =================================================================
// GET /api/income — Auto-Copy
// =================================================================
describe('GET /api/income — Auto-Copy', () => {
  beforeEach(() => {
    resetStore();
    auth = createTestAuth(mockPrisma);
  });

  after(() => cleanupAuth());

  it('kopiert wiederkehrende Einnahmen aus Vormonat', async () => {
    seedIncome({ name: 'Gehalt', amount: 3000, month: '2026-02' });

    const res = await request(app)
      .get('/api/income?month=2026-03')
      .set('Cookie', auth.cookie);

    assert.equal(res.status, 200);
    assert.equal(res.body.incomes.length, 1);
    assert.equal(res.body.incomes[0].name, 'Gehalt');
  });

  it('kopiert NICHT wenn Monat bereits initialisiert', async () => {
    seedIncome({ name: 'Gehalt', amount: 3000, month: '2026-02' });
    seedMonthInit('2026-03');

    const res = await request(app)
      .get('/api/income?month=2026-03')
      .set('Cookie', auth.cookie);

    assert.equal(res.status, 200);
    assert.equal(res.body.incomes.length, 0);
  });

  it('kopiert NICHT nicht-wiederkehrende Einnahmen', async () => {
    seedIncome({ name: 'Bonus', amount: 500, month: '2026-02', isRecurring: false });

    const res = await request(app)
      .get('/api/income?month=2026-03')
      .set('Cookie', auth.cookie);

    assert.equal(res.status, 200);
    assert.equal(res.body.incomes.length, 0);
  });

  it('stoppt an monthInit-Grenze', async () => {
    seedIncome({ name: 'Altes Gehalt', amount: 2500, month: '2025-12', isRecurring: true });
    seedMonthInit('2026-01');

    const res = await request(app)
      .get('/api/income?month=2026-02')
      .set('Cookie', auth.cookie);

    assert.equal(res.status, 200);
    assert.equal(res.body.incomes.length, 0);
  });

  it('kopiert verschlüsselte Werte 1:1', async () => {
    const original = seedIncome({ name: 'Gehalt', amount: 3000, month: '2026-02' });

    await request(app)
      .get('/api/income?month=2026-03')
      .set('Cookie', auth.cookie);

    const copy = mockPrisma._store.incomes.find(i => i.month === '2026-03');
    assert.ok(copy);
    assert.equal(copy.name, original.name);
    assert.equal(copy.amount, original.amount);
  });
});

// =================================================================
// POST /api/income — Vorwärts-Propagation
// =================================================================
describe('POST /api/income — Vorwärts-Propagation', () => {
  beforeEach(() => {
    resetStore();
    auth = createTestAuth(mockPrisma);
  });

  after(() => cleanupAuth());

  it('wiederkehrende Einnahme wird in initialisierte Zukunftsmonate kopiert', async () => {
    seedMonthInit('2026-04');
    seedMonthInit('2026-05');

    const res = await request(app)
      .post('/api/income')
      .set('Cookie', auth.cookie)
      .send({ name: 'Nebenjob', amount: 500, month: '2026-03', isRecurring: true });

    assert.equal(res.status, 201);

    const all = mockPrisma._store.incomes.filter(i => i.userId === auth.userId);
    const months = all.map(i => i.month).sort();
    assert.deepEqual(months, ['2026-03', '2026-04', '2026-05']);
  });

  it('nicht-wiederkehrende Einnahme wird NICHT kopiert', async () => {
    seedMonthInit('2026-04');

    await request(app)
      .post('/api/income')
      .set('Cookie', auth.cookie)
      .send({ name: 'Einmalig', amount: 200, month: '2026-03', isRecurring: false });

    const all = mockPrisma._store.incomes.filter(i => i.userId === auth.userId);
    assert.equal(all.length, 1);
    assert.equal(all[0].month, '2026-03');
  });
});

// =================================================================
// PUT /api/income — Edit-Propagation
// =================================================================
describe('PUT /api/income — Edit-Propagation', () => {
  beforeEach(() => {
    resetStore();
    auth = createTestAuth(mockPrisma);
  });

  after(() => cleanupAuth());

  it('Namens-/Betrags-Änderung wird in Zukunftsmonate propagiert', async () => {
    const march = seedIncome({ name: 'Gehalt', amount: 3000, month: '2026-03' });
    const encName = march.name;
    const encAmount = march.amount;
    mockPrisma._store.incomes.push({
      id: crypto.randomUUID(), name: encName, amount: encAmount,
      userId: auth.userId, month: '2026-04',
      isRecurring: true, createdAt: new Date(), updatedAt: new Date(),
    });
    mockPrisma._store.incomes.push({
      id: crypto.randomUUID(), name: encName, amount: encAmount,
      userId: auth.userId, month: '2026-05',
      isRecurring: true, createdAt: new Date(), updatedAt: new Date(),
    });

    const res = await request(app)
      .put(`/api/income/${march.id}`)
      .set('Cookie', auth.cookie)
      .send({ name: 'Neues Gehalt', amount: 3500, isRecurring: true });

    assert.equal(res.status, 200);
    assert.equal(res.body.income.name, 'Neues Gehalt');

    const key = auth.encryptionKey;
    const april = mockPrisma._store.incomes.find(i => i.month === '2026-04');
    const may = mockPrisma._store.incomes.find(i => i.month === '2026-05');
    assert.equal(decrypt(april.name, key), 'Neues Gehalt');
    assert.equal(decrypt(may.name, key), 'Neues Gehalt');
    assert.equal(decrypt(april.amount, key), '3500');
  });

  it('KEINE Propagation in vergangene Monate', async () => {
    const jan = seedIncome({ name: 'Gehalt', amount: 3000, month: '2026-01' });
    const march = seedIncome({ name: 'Gehalt', amount: 3000, month: '2026-03' });
    jan.name = march.name;
    jan.amount = march.amount;

    await request(app)
      .put(`/api/income/${march.id}`)
      .set('Cookie', auth.cookie)
      .send({ name: 'Neues Gehalt', amount: 3500, isRecurring: true });

    const key = auth.encryptionKey;
    const janAfter = mockPrisma._store.incomes.find(i => i.month === '2026-01');
    assert.equal(decrypt(janAfter.name, key), 'Gehalt');
  });

  it('KEINE Propagation wenn isRecurring auf false gesetzt wird', async () => {
    const march = seedIncome({ name: 'Gehalt', amount: 3000, month: '2026-03' });
    mockPrisma._store.incomes.push({
      id: crypto.randomUUID(), name: march.name, amount: march.amount,
      userId: auth.userId, month: '2026-04',
      isRecurring: true, createdAt: new Date(), updatedAt: new Date(),
    });

    await request(app)
      .put(`/api/income/${march.id}`)
      .set('Cookie', auth.cookie)
      .send({ name: 'Neues Gehalt', amount: 3500, isRecurring: false });

    const key = auth.encryptionKey;
    const april = mockPrisma._store.incomes.find(i => i.month === '2026-04');
    assert.equal(decrypt(april.name, key), 'Gehalt');
  });
});

// =================================================================
// DELETE /api/income — Löschschutz
// =================================================================
describe('DELETE /api/income — Löschschutz', () => {
  beforeEach(() => {
    resetStore();
    auth = createTestAuth(mockPrisma);
  });

  after(() => cleanupAuth());

  it('löscht die Einnahme und markiert den Monat als initialisiert', async () => {
    const income = seedIncome({ name: 'Gehalt', amount: 3000, month: '2026-03' });

    const res = await request(app)
      .delete(`/api/income/${income.id}`)
      .set('Cookie', auth.cookie);

    assert.equal(res.status, 200);

    const remaining = mockPrisma._store.incomes.filter(i => i.userId === auth.userId);
    assert.equal(remaining.length, 0);

    const mi = mockPrisma._store.monthInits.find(
      m => m.month === '2026-03' && m.type === 'income' && m.userId === auth.userId,
    );
    assert.ok(mi);
  });

  it('gelöschte Einnahmen kommen bei erneutem GET NICHT zurück', async () => {
    seedIncome({ name: 'Gehalt', amount: 3000, month: '2026-02' });

    let res = await request(app)
      .get('/api/income?month=2026-03')
      .set('Cookie', auth.cookie);
    assert.equal(res.body.incomes.length, 1);

    const copyId = mockPrisma._store.incomes.find(i => i.month === '2026-03').id;
    await request(app)
      .delete(`/api/income/${copyId}`)
      .set('Cookie', auth.cookie);

    res = await request(app)
      .get('/api/income?month=2026-03')
      .set('Cookie', auth.cookie);
    assert.equal(res.body.incomes.length, 0, 'Gelöschte Einnahme darf nicht zurückkommen');
  });
});
