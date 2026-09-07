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

  it('isRecurring auf false → Auto-Kopien in Zukunftsmonaten werden entfernt', async () => {
    const feb = seedExpense({ name: 'Miete', amount: 640, month: '2026-02' });
    const march = seedExpense({ name: 'Miete', amount: 640, month: '2026-03' });
    // Auto-Kopie in April (identischer Ciphertext wie März)
    mockPrisma._store.expenses.push({
      id: crypto.randomUUID(), name: march.name, amount: march.amount,
      categoryId: testCategoryId, userId: auth.userId, month: '2026-04',
      isRecurring: true, createdAt: new Date(), updatedAt: new Date(),
    });

    const res = await request(app)
      .put(`/api/expenses/${march.id}`)
      .set('Cookie', auth.cookie)
      .send({ name: 'Kaltmiete', amount: 580, categoryId: testCategoryId, isRecurring: false });
    assert.equal(res.status, 200);

    const months = mockPrisma._store.expenses.map(e => e.month).sort();
    assert.deepEqual(months, ['2026-02', '2026-03'], 'April-Kopie muss weg sein, Februar bleibt');
    assert.ok(mockPrisma._store.expenses.find(e => e.id === feb.id));
    const key = auth.encryptionKey;
    const edited = mockPrisma._store.expenses.find(e => e.id === march.id);
    assert.equal(decrypt(edited.name, key), 'Kaltmiete');
    assert.equal(edited.isRecurring, false);
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

  it('löscht Auto-Kopien in bereits initialisierten Zukunftsmonaten mit', async () => {
    // Der gemeldete Fehler: April wurde schon einmal geöffnet (Kopie existiert),
    // dann wird die Ausgabe im März gelöscht → sie darf im April nicht bleiben.
    seedExpense({ name: 'Netflix', amount: 12.99, month: '2026-03' });

    let res = await request(app).get('/api/expenses?month=2026-04').set('Cookie', auth.cookie);
    assert.equal(res.body.expenses.length, 1, 'April bekommt zunächst die Auto-Kopie');
    res = await request(app).get('/api/expenses?month=2026-05').set('Cookie', auth.cookie);
    assert.equal(res.body.expenses.length, 1, 'Mai ebenfalls');

    const marchId = mockPrisma._store.expenses.find(e => e.month === '2026-03').id;
    res = await request(app).delete(`/api/expenses/${marchId}`).set('Cookie', auth.cookie);
    assert.equal(res.status, 200);

    assert.equal(mockPrisma._store.expenses.length, 0, 'März, April und Mai müssen leer sein');

    res = await request(app).get('/api/expenses?month=2026-04').set('Cookie', auth.cookie);
    assert.equal(res.body.expenses.length, 0, 'April darf die Ausgabe nicht mehr zeigen');
    res = await request(app).get('/api/expenses?month=2026-05').set('Cookie', auth.cookie);
    assert.equal(res.body.expenses.length, 0, 'Mai darf die Ausgabe nicht mehr zeigen');
  });

  it('lässt Vormonate, unabhängig bearbeitete Kopien und fremde Nutzer unangetastet', async () => {
    const key = auth.encryptionKey;
    const feb = seedExpense({ name: 'Netflix', amount: 12.99, month: '2026-02' });
    const march = seedExpense({ name: 'Netflix', amount: 12.99, month: '2026-03' });
    // Auto-Kopie im April (gleicher Ciphertext) → soll weg
    const aprilCopy = {
      id: crypto.randomUUID(), name: march.name, amount: march.amount,
      categoryId: testCategoryId, userId: auth.userId, month: '2026-04',
      isRecurring: true, createdAt: new Date(), updatedAt: new Date(),
    };
    // Im Mai unabhängig neu angelegt (eigener Ciphertext) → bleibt
    const mayOwn = seedExpense({ name: 'Netflix', amount: 12.99, month: '2026-05' });
    // Einmalige Ausgabe gleichen Namens im April → bleibt
    const aprilOnce = seedExpense({ name: 'Netflix', amount: 12.99, month: '2026-04', isRecurring: false });
    // Fremder Nutzer mit identischem Ciphertext (theoretisch) → bleibt
    const foreign = { ...aprilCopy, id: crypto.randomUUID(), userId: crypto.randomUUID() };
    mockPrisma._store.expenses.push(aprilCopy, foreign);

    const res = await request(app).delete(`/api/expenses/${march.id}`).set('Cookie', auth.cookie);
    assert.equal(res.status, 200);

    const ids = mockPrisma._store.expenses.map(e => e.id).sort();
    assert.deepEqual(ids, [feb.id, mayOwn.id, aprilOnce.id, foreign.id].sort());
    assert.equal(decrypt(mockPrisma._store.expenses.find(e => e.id === feb.id).name, key), 'Netflix');
  });

  it('nicht-wiederkehrende Ausgabe löscht nichts in Zukunftsmonaten', async () => {
    const march = seedExpense({ name: 'Kino', amount: 15, month: '2026-03', isRecurring: false });
    const april = {
      id: crypto.randomUUID(), name: march.name, amount: march.amount,
      categoryId: testCategoryId, userId: auth.userId, month: '2026-04',
      isRecurring: true, createdAt: new Date(), updatedAt: new Date(),
    };
    mockPrisma._store.expenses.push(april);

    await request(app).delete(`/api/expenses/${march.id}`).set('Cookie', auth.cookie);

    assert.deepEqual(mockPrisma._store.expenses.map(e => e.id), [april.id]);
  });
});

// ============================================================
// TAGESDATUM (spentOn, 2026-08-22)
// ============================================================
describe('spentOn — Tagesdatum je Ausgabe', () => {
  beforeEach(() => {
    resetStore();
    auth = createTestAuth(mockPrisma);
    seedCategory();
  });

  it('speichert das Datum und liefert es wieder aus', async () => {
    const res = await request(app)
      .post('/api/expenses')
      .set('Cookie', auth.cookie)
      .send({ name: 'Tanken', amount: 72.4, categoryId: testCategoryId, month: '2026-08', spentOn: '2026-08-11', isRecurring: false });
    assert.equal(res.status, 201);
    assert.equal(res.body.expense.spentOn, '2026-08-11');
  });

  it('lehnt ein Datum außerhalb des Monats ab', async () => {
    const res = await request(app)
      .post('/api/expenses')
      .set('Cookie', auth.cookie)
      .send({ name: 'Tanken', amount: 72.4, categoryId: testCategoryId, month: '2026-08', spentOn: '2026-09-01', isRecurring: false });
    assert.equal(res.status, 400);
  });

  it('lehnt ungültige Datumsformate ab', async () => {
    for (const bad of ['11.08.2026', '2026-8-1', '2026-08-32']) {
      const res = await request(app)
        .post('/api/expenses')
        .set('Cookie', auth.cookie)
        .send({ name: 'X', amount: 1, categoryId: testCategoryId, month: '2026-08', spentOn: bad });
      assert.equal(res.status, 400, 'spentOn=' + bad);
    }
  });

  it('leeres/fehlendes Datum wird zu null', async () => {
    const res = await request(app)
      .post('/api/expenses')
      .set('Cookie', auth.cookie)
      .send({ name: 'Bar', amount: 12, categoryId: testCategoryId, month: '2026-08', spentOn: '', isRecurring: false });
    assert.equal(res.status, 201);
    assert.equal(res.body.expense.spentOn, null);
  });

  it('Auto-Copy überträgt den Tag in den neuen Monat (gekappt auf Monatslänge)', async () => {
    seedExpense({ name: 'Miete', amount: 640, month: '2026-01' });
    const rec = mockPrisma._store.expenses[0];
    rec.spentOn = '2026-01-31';

    const res = await request(app)
      .get('/api/expenses?month=2026-02')
      .set('Cookie', auth.cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.expenses.length, 1);
    // Februar 2026 hat 28 Tage -> aus dem 31. wird der 28.
    assert.equal(res.body.expenses[0].spentOn, '2026-02-28');
  });

  it('PUT kann das Datum entfernen (leerer Wert)', async () => {
    seedExpense({ name: 'Kino', amount: 20, month: '2026-08', isRecurring: false });
    const id = mockPrisma._store.expenses[0].id;
    mockPrisma._store.expenses[0].spentOn = '2026-08-16';

    const res = await request(app)
      .put('/api/expenses/' + id)
      .set('Cookie', auth.cookie)
      .send({ name: 'Kino', amount: 20, categoryId: testCategoryId, month: '2026-08', spentOn: '', isRecurring: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.expense.spentOn, null);
  });
});

// ============================================================
// VERLAUF (GET /api/expenses/history, 2026-08-22)
// ============================================================
describe('GET /api/expenses/history — Monatsverlauf', () => {
  beforeEach(() => {
    resetStore();
    auth = createTestAuth(mockPrisma);
    seedCategory();
  });

  it('aggregiert Ausgaben und Einnahmen je Monat (entschlüsselt)', async () => {
    seedExpense({ name: 'Miete', amount: 640, month: '2026-07' });
    seedExpense({ name: 'Miete', amount: 640, month: '2026-08' });
    seedExpense({ name: 'Kino', amount: 20, month: '2026-08', isRecurring: false });
    mockPrisma._store.incomes.push({
      id: crypto.randomUUID(),
      name: encrypt('Gehalt', auth.encryptionKey),
      amount: encrypt('3000', auth.encryptionKey),
      month: '2026-08',
      isRecurring: true,
      userId: auth.userId,
    });

    const res = await request(app)
      .get('/api/expenses/history?months=3&month=2026-08')
      .set('Cookie', auth.cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.months.length, 3);
    assert.deepEqual(res.body.months.map(m => m.month), ['2026-06', '2026-07', '2026-08']);
    const aug = res.body.months[2];
    assert.equal(aug.expenses, 660);
    assert.equal(aug.income, 3000);
    assert.equal(res.body.months[1].expenses, 640);
    assert.equal(res.body.months[0].expenses, 0);
    // Kategoriesumme über das Fenster, Name entschlüsselt
    assert.equal(res.body.byCategory.length, 1);
    assert.equal(res.body.byCategory[0].name, 'Wohnen');
    assert.equal(res.body.byCategory[0].total, 1300);
    assert.equal(res.body.byCategory[0].count, 3);
  });

  it('liefert KEINE Einzelposten und keine fremden Nutzerdaten', async () => {
    seedExpense({ name: 'Miete', amount: 640, month: '2026-08' });
    // Fremder Nutzer mit eigener Ausgabe im selben Monat
    const other = createTestAuth(mockPrisma);
    mockPrisma._store.expenses.push({
      id: crypto.randomUUID(),
      name: encrypt('Fremd', other.encryptionKey),
      amount: encrypt('999', other.encryptionKey),
      categoryId: null,
      tags: '',
      month: '2026-08',
      isRecurring: false,
      userId: other.userId,
    });

    const res = await request(app)
      .get('/api/expenses/history?months=3&month=2026-08')
      .set('Cookie', auth.cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.months[2].expenses, 640, 'nur eigene Ausgaben');
    assert.ok(!('expenses' in res.body) || Array.isArray(res.body.expenses) === false, 'keine Einzelposten-Liste');
  });

  it('kappt months auf 3–24 und prüft das Monatsformat', async () => {
    const res = await request(app)
      .get('/api/expenses/history?months=999&month=2026-08')
      .set('Cookie', auth.cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.months.length, 24);

    const bad = await request(app)
      .get('/api/expenses/history?month=august')
      .set('Cookie', auth.cookie);
    assert.equal(bad.status, 400);
  });
});

// ============================================================
// VERSCHOBENER MONATSANFANG (budgetStartDay, 2026-09-07)
// ============================================================
// Bei Starttag 15 läuft die Periode "2026-09" vom 15.09. bis zum 14.10.
// Der DB-Schlüssel `month` bleibt "YYYY-MM" — nur die erlaubte Datumsspanne
// und die Übertragung wiederkehrender Einträge richten sich danach.
describe('Ausgaben mit verschobenem Monatsanfang (Starttag 15)', () => {
  beforeEach(() => {
    resetStore();
    auth = createTestAuth(mockPrisma, { budgetStartDay: 15 });
    seedCategory();
  });

  after(() => cleanupAuth());

  const basis = () => ({
    name: 'Miete',
    amount: 640,
    categoryId: testCategoryId,
    month: '2026-09',
  });

  it('akzeptiert ein Datum aus dem FOLGEmonat, solange es in der Periode liegt', async () => {
    const res = await request(app)
      .post('/api/expenses')
      .set('Cookie', auth.cookie)
      .send({ ...basis(), spentOn: '2026-10-05' });

    assert.equal(res.status, 201);
    assert.equal(res.body.expense.spentOn, '2026-10-05');
    assert.equal(res.body.expense.month, '2026-09');
  });

  it('lehnt ein Datum VOR dem Periodenstart ab', async () => {
    const res = await request(app)
      .post('/api/expenses')
      .set('Cookie', auth.cookie)
      .send({ ...basis(), spentOn: '2026-09-14' });

    assert.equal(res.status, 400);
    assert.match(res.body.errors.join(' '), /15\.09\.2026 bis 14\.10\.2026/);
  });

  it('lehnt ein Datum NACH dem Periodenende ab', async () => {
    const res = await request(app)
      .post('/api/expenses')
      .set('Cookie', auth.cookie)
      .send({ ...basis(), spentOn: '2026-10-15' });

    assert.equal(res.status, 400);
  });

  it('Auto-Copy setzt den Tag in den richtigen Kalendermonat der Zielperiode', async () => {
    // Zwei wiederkehrende Ausgaben in Periode 2026-09 (15.09.-14.10.):
    // eine im ersten Monat der Periode, eine im zweiten.
    await request(app).post('/api/expenses').set('Cookie', auth.cookie)
      .send({ ...basis(), name: 'Miete', spentOn: '2026-09-20', isRecurring: true });
    await request(app).post('/api/expenses').set('Cookie', auth.cookie)
      .send({ ...basis(), name: 'Strom', spentOn: '2026-10-05', isRecurring: true });

    // Periode 2026-10 (15.10.-14.11.) erstmals öffnen
    const res = await request(app)
      .get('/api/expenses?month=2026-10')
      .set('Cookie', auth.cookie);

    assert.equal(res.status, 200);
    const nachName = Object.fromEntries(res.body.expenses.map(e => [e.name, e.spentOn]));
    assert.equal(nachName.Miete, '2026-10-20', 'Tag 20 bleibt im ersten Monat der Periode');
    assert.equal(nachName.Strom, '2026-11-05', 'Tag 5 wandert in den zweiten Monat der Periode');
  });

  it('das übertragene Datum liegt immer in der Zielperiode', async () => {
    const { isInPeriod } = require('../../src/utils/budgetPeriod');
    await request(app).post('/api/expenses').set('Cookie', auth.cookie)
      .send({ ...basis(), spentOn: '2026-10-14', isRecurring: true });

    for (const monat of ['2026-10', '2026-11', '2026-12']) {
      const res = await request(app).get(`/api/expenses?month=${monat}`).set('Cookie', auth.cookie);
      const kopie = res.body.expenses[0];
      assert.ok(kopie, `Periode ${monat} sollte eine Kopie haben`);
      assert.ok(
        isInPeriod(kopie.spentOn, monat, 15),
        `${kopie.spentOn} liegt nicht in Periode ${monat}`,
      );
    }
  });

  it('PUT prüft das Datum auch ohne mitgeschicktes month gegen die Periode', async () => {
    const erstellt = await request(app).post('/api/expenses').set('Cookie', auth.cookie)
      .send({ ...basis(), spentOn: '2026-09-20' });

    // Ohne `month` im Body: früher wurde spentOn gar nicht geprüft.
    const res = await request(app)
      .put(`/api/expenses/${erstellt.body.expense.id}`)
      .set('Cookie', auth.cookie)
      .send({ name: 'Miete', amount: 640, categoryId: testCategoryId, spentOn: '2026-01-05' });

    assert.equal(res.status, 400);
  });
});
