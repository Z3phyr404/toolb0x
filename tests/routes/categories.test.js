// ============================================================
// CATEGORIES ROUTE TESTS — Löschen mit Fallback "Sonstiges"
// ============================================================
// Beim Löschen einer Kategorie mit Ausgaben wandern die Ausgaben nach
// "Sonstiges". Hier wird geprüft, dass dabei nie ein zweites "Sonstiges"
// entsteht und ein bereits vorhandenes Duplikat zusammengeführt werden
// kann — egal, welches der beiden man löscht.
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

const { createTestAuth, cleanupAuth } = require('../helpers/authHelper');
const { encrypt, decrypt } = require('../../src/utils/encryption');

const categoryRouter = require('../../src/routes/categories');
const { createTestApp } = require('../helpers/testApp');
const app = createTestApp({ path: '/api/categories', router: categoryRouter });

let auth;
let uhr = 0;

function resetStore() {
  for (const tabelle of Object.keys(mockPrisma._store)) mockPrisma._store[tabelle].length = 0;
}

function neuerNutzer() {
  resetStore();
  auth = createTestAuth(mockPrisma);
}

function seedCategory(name) {
  const record = {
    id: crypto.randomUUID(),
    name: encrypt(name, auth.encryptionKey),
    color: encrypt('#8E8E93', auth.encryptionKey),
    userId: auth.userId,
    createdAt: new Date(Date.UTC(2026, 0, 1) + (uhr++) * 1000),
  };
  mockPrisma._store.categories.push(record);
  return record;
}

function seedExpense(categoryId) {
  const record = {
    id: crypto.randomUUID(),
    name: encrypt('Posten', auth.encryptionKey),
    amount: encrypt('10', auth.encryptionKey),
    categoryId,
    userId: auth.userId,
    month: '2026-09',
    isRecurring: false,
  };
  mockPrisma._store.expenses.push(record);
  return record;
}

function sonstigesKategorien() {
  return mockPrisma._store.categories.filter(
    c => decrypt(c.name, auth.encryptionKey).toLowerCase() === 'sonstiges',
  );
}

function loesche(id) {
  return request(app).delete('/api/categories/' + id).set('Cookie', auth.cookie);
}

describe('DELETE /api/categories/:id — Fallback "Sonstiges"', () => {
  beforeEach(() => neuerNutzer());
  after(() => cleanupAuth());

  it('verschiebt Ausgaben in das vorhandene "Sonstiges" statt ein zweites anzulegen', async () => {
    const sonstiges = seedCategory('Sonstiges');
    const freizeit = seedCategory('Freizeit');
    const ausgabe = seedExpense(freizeit.id);

    const res = await loesche(freizeit.id);

    assert.equal(res.status, 200);
    assert.equal(res.body.movedExpenses, 1);
    assert.equal(ausgabe.categoryId, sonstiges.id);
    assert.equal(sonstigesKategorien().length, 1);
  });

  it('legt "Sonstiges" genau einmal an, wenn es keins gibt', async () => {
    const freizeit = seedCategory('Freizeit');
    const ausgabe = seedExpense(freizeit.id);

    const res = await loesche(freizeit.id);

    assert.equal(res.status, 200);
    const sonstige = sonstigesKategorien();
    assert.equal(sonstige.length, 1);
    assert.equal(ausgabe.categoryId, sonstige[0].id);
  });

  it('erkennt "sonstiges" auch in anderer Schreibweise', async () => {
    const klein = seedCategory('sonstiges');
    const freizeit = seedCategory('Freizeit');
    const ausgabe = seedExpense(freizeit.id);

    const res = await loesche(freizeit.id);

    assert.equal(res.status, 200);
    assert.equal(sonstigesKategorien().length, 1);
    assert.equal(ausgabe.categoryId, klein.id);
  });

  it('führt ein doppeltes "Sonstiges" zusammen — egal, welches gelöscht wird', async () => {
    for (const welches of [0, 1]) {
      neuerNutzer();
      const beide = [seedCategory('Sonstiges'), seedCategory('Sonstiges')];
      const ausgaben = [seedExpense(beide[0].id), seedExpense(beide[1].id)];
      const weg = beide[welches];
      const bleibt = beide[1 - welches];

      const res = await loesche(weg.id);

      assert.equal(res.status, 200, 'Löschen von Duplikat ' + welches + ' muss klappen');
      assert.equal(sonstigesKategorien().length, 1);
      assert.equal(sonstigesKategorien()[0].id, bleibt.id);
      assert.ok(ausgaben.every(a => a.categoryId === bleibt.id));
    }
  });

  it('verweigert das Löschen des einzigen "Sonstiges", solange Ausgaben daran hängen', async () => {
    const sonstiges = seedCategory('Sonstiges');
    seedExpense(sonstiges.id);

    const res = await loesche(sonstiges.id);

    assert.equal(res.status, 400);
    assert.equal(sonstigesKategorien().length, 1);
  });

  it('legt beim Löschen einer leeren Kategorie kein "Sonstiges" an', async () => {
    const freizeit = seedCategory('Freizeit');

    const res = await loesche(freizeit.id);

    assert.equal(res.status, 200);
    assert.equal(sonstigesKategorien().length, 0);
    assert.equal(mockPrisma._store.categories.length, 0);
  });
});
