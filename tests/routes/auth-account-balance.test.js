// ============================================================
// KONTOSTAND-TESTS (PUT /api/auth/account-balance + GET /me)
// ============================================================
// Der Kontostand ist ein Schnappschuss, den der Nutzer selbst pflegt.
// Geprüft wird vor allem, dass er verschlüsselt in der DB landet und dass
// ein defekter Ciphertext NICHT als NaN ins Dashboard durchschlägt.
// ============================================================

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

// --- Mock-Prisma injizieren ---
const { createMockPrisma } = require('../helpers/mockPrisma');
const mockPrisma = createMockPrisma();
const prismaPath = require.resolve('../../src/utils/prisma');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: mockPrisma };

// --- Auth-Helper ---
const { createTestAuth, cleanupAuth } = require('../helpers/authHelper');
const { decrypt } = require('../../src/utils/encryption');

// --- Route + Test-App ---
const authRouter = require('../../src/routes/auth');
const { createTestApp } = require('../helpers/testApp');
const app = createTestApp({ path: '/api/auth', router: authRouter });

let auth;

function nutzer() {
  return mockPrisma._store.users.find(u => u.id === auth.userId);
}

function reset() {
  mockPrisma._store.users.length = 0;
  auth = createTestAuth(mockPrisma);
}

// =================================================================
describe('PUT /api/auth/account-balance', () => {
  beforeEach(reset);

  it('speichert den Kontostand VERSCHLÜSSELT', async () => {
    const res = await request(app)
      .put('/api/auth/account-balance')
      .set('Cookie', auth.cookie)
      .send({ accountBalance: 1842.37 });

    assert.equal(res.status, 200);
    assert.equal(res.body.accountBalance, 1842.37);
    assert.ok(res.body.accountBalanceAt, 'Zeitpunkt fehlt');

    const roh = nutzer().accountBalance;
    assert.notEqual(roh, '1842.37', 'Der Betrag steht im Klartext in der DB!');
    assert.equal(decrypt(roh, auth.encryptionKey), '1842.37');
  });

  it('erlaubt negative Stände (Dispo)', async () => {
    const res = await request(app)
      .put('/api/auth/account-balance')
      .set('Cookie', auth.cookie)
      .send({ accountBalance: -238.05 });

    assert.equal(res.status, 200);
    assert.equal(res.body.accountBalance, -238.05);
    assert.equal(decrypt(nutzer().accountBalance, auth.encryptionKey), '-238.05');
  });

  it('rundet auf zwei Nachkommastellen', async () => {
    const res = await request(app)
      .put('/api/auth/account-balance')
      .set('Cookie', auth.cookie)
      .send({ accountBalance: 10.005 });

    assert.equal(res.status, 200);
    assert.equal(res.body.accountBalance, 10.01);
  });

  it('nimmt auch einen numerischen String an', async () => {
    const res = await request(app)
      .put('/api/auth/account-balance')
      .set('Cookie', auth.cookie)
      .send({ accountBalance: '1234.50' });

    assert.equal(res.status, 200);
    assert.equal(res.body.accountBalance, 1234.5);
  });

  it('lehnt Text ab, den parseFloat still zurechtbiegen würde', async () => {
    // NaN/Infinity stehen NICHT in der Liste: JSON.stringify macht daraus
    // null, das käme als "Stand entfernen" an. Als String erreichen sie
    // die Route aber sehr wohl.
    for (const wert of ['12abc', 'abc', '12,50', 'NaN', 'Infinity', {}, true]) {
      const res = await request(app)
        .put('/api/auth/account-balance')
        .set('Cookie', auth.cookie)
        .send({ accountBalance: wert });
      assert.equal(res.status, 400, `"${String(wert)}" wurde akzeptiert`);
    }
    assert.equal(nutzer().accountBalance, undefined);
  });

  it('lehnt unrealistisch grosse Beträge ab — in beide Richtungen', async () => {
    for (const wert of [10000000, -10000000]) {
      const res = await request(app)
        .put('/api/auth/account-balance')
        .set('Cookie', auth.cookie)
        .send({ accountBalance: wert });
      assert.equal(res.status, 400);
    }
  });

  it('speichert eine echte Null (nicht dasselbe wie "kein Stand")', async () => {
    const res = await request(app)
      .put('/api/auth/account-balance')
      .set('Cookie', auth.cookie)
      .send({ accountBalance: 0 });

    assert.equal(res.status, 200);
    assert.equal(res.body.accountBalance, 0);
    assert.ok(nutzer().accountBalance, 'Die 0 wurde als "leer" behandelt');
    assert.equal(decrypt(nutzer().accountBalance, auth.encryptionKey), '0');
  });

  it('löscht den Stand bei null', async () => {
    await request(app).put('/api/auth/account-balance')
      .set('Cookie', auth.cookie).send({ accountBalance: 500 });
    assert.ok(nutzer().accountBalance);

    const res = await request(app).put('/api/auth/account-balance')
      .set('Cookie', auth.cookie).send({ accountBalance: null });

    assert.equal(res.status, 200);
    assert.equal(res.body.accountBalance, null);
    assert.equal(res.body.accountBalanceAt, null);
    assert.equal(nutzer().accountBalance, null);
    assert.equal(nutzer().accountBalanceAt, null);
  });

  it('braucht eine Anmeldung', async () => {
    const res = await request(app)
      .put('/api/auth/account-balance')
      .send({ accountBalance: 100 });
    assert.equal(res.status, 401);
  });
});

// =================================================================
describe('GET /api/auth/me — Kontostand', () => {
  beforeEach(reset);

  it('liefert den entschlüsselten Stand zurück', async () => {
    await request(app).put('/api/auth/account-balance')
      .set('Cookie', auth.cookie).send({ accountBalance: 77.5 });

    const res = await request(app).get('/api/auth/me').set('Cookie', auth.cookie);

    assert.equal(res.status, 200);
    assert.equal(res.body.user.accountBalance, 77.5);
    assert.ok(res.body.user.accountBalanceAt);
  });

  it('liefert null, wenn nie etwas eingetragen wurde', async () => {
    const res = await request(app).get('/api/auth/me').set('Cookie', auth.cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.accountBalance, null);
  });

  it('liefert null statt NaN, wenn der Ciphertext defekt ist', async () => {
    // decrypt() wirft nicht, sondern gibt "[Entschlüsselung fehlgeschlagen]"
    // zurück. Ohne Guard stünde im Dashboard "NaN €".
    nutzer().accountBalance = 'kaputt:kaputt:kaputt';
    nutzer().accountBalanceAt = new Date();

    const res = await request(app).get('/api/auth/me').set('Cookie', auth.cookie);

    assert.equal(res.status, 200);
    assert.equal(res.body.user.accountBalance, null);
  });
});

after(() => cleanupAuth());
