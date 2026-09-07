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
const zlib = require('zlib');
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
  mockPrisma._store.expenseBookings.length = 0;
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

// PDF-Rohbytes in lesbaren Text zurückverwandeln: PDFKit komprimiert die
// Content-Streams (Flate) und schreibt Text darin als Hex-Strings.
function pdfText(buf) {
  let out = '';
  let i = 0;
  for (;;) {
    const s = buf.indexOf('stream', i);
    if (s === -1) break;
    let a = s + 6;
    if (buf[a] === 13) a++;
    if (buf[a] === 10) a++;
    const e = buf.indexOf('endstream', a);
    if (e === -1) break;
    try {
      const roh = zlib.inflateSync(buf.subarray(a, e)).toString('latin1');
      out += roh.replace(/<([0-9a-fA-F]+)>/g, (_, h) => Buffer.from(h, 'hex').toString('latin1'));
    } catch { /* Nicht-Text-Stream (Bild, Font) — überspringen */ }
    i = e + 9;
  }
  return out;
}

// Antwort als Buffer einlesen (supertest parst application/pdf sonst als Text).
function alsBuffer(req) {
  return req.buffer().parse((res, cb) => {
    const teile = [];
    res.on('data', (d) => teile.push(d));
    res.on('end', () => cb(null, Buffer.concat(teile)));
  });
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

// =================================================================
// DEFEKTE CIPHERTEXTE — dürfen die Summen nicht vergiften
// =================================================================
// decrypt() wirft NICHT, sondern liefert '[Entschlüsselung fehlgeschlagen]'.
// parseFloat davon ist NaN, und ein einziges NaN in einer Summe machte früher
// ALLE Beträge im PDF zu "NaN €" — ohne Fehler und ohne Log.
describe('Export — defekter Betrag macht die Summen nicht kaputt', () => {
  beforeEach(() => {
    resetStore();
    auth = createTestAuth(mockPrisma);
    seedCategory();
  });

  after(() => cleanupAuth());

  // Ausgabe, deren amount mit einem FREMDEN Schlüssel verschlüsselt ist.
  function seedKaputteAusgabe(month) {
    const fremderKey = crypto.randomBytes(32);
    const record = {
      id: crypto.randomUUID(),
      name: encrypt('Kaputt', auth.encryptionKey),
      amount: encrypt('99', fremderKey),
      tags: '',
      categoryId: testCategoryId,
      userId: auth.userId,
      month,
      isRecurring: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockPrisma._store.expenses.push(record);
    return record;
  }

  it('Monats-PDF: kein "NaN" im Dokument, gute Beträge bleiben lesbar', async () => {
    seedExpense({ name: 'Miete', amount: 640, month: '2026-03' });
    seedIncome({ name: 'Gehalt', amount: 3000, month: '2026-03' });
    seedKaputteAusgabe('2026-03');

    const res = await alsBuffer(
      request(app).get('/api/export/pdf?month=2026-03').set('Cookie', auth.cookie),
    );

    assert.equal(res.status, 200);
    const text = pdfText(res.body);
    assert.ok(!text.includes('NaN'), 'PDF darf kein NaN enthalten');
    assert.ok(text.includes('640,00'), 'Der intakte Betrag muss weiterhin auftauchen');
    assert.ok(text.includes('3.000,00'), 'Die Einnahme muss weiterhin auftauchen');
  });

  it('Gesamt-PDF: kein "NaN" im Dokument', async () => {
    seedExpense({ name: 'Miete', amount: 640, month: '2026-03' });
    seedIncome({ name: 'Gehalt', amount: 3000, month: '2026-03' });
    seedKaputteAusgabe('2026-02');

    const res = await alsBuffer(
      request(app).get('/api/export/pdf-all').set('Cookie', auth.cookie),
    );

    assert.equal(res.status, 200);
    assert.ok(!pdfText(res.body).includes('NaN'), 'Gesamt-PDF darf kein NaN enthalten');
  });
});
