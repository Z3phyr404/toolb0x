// ============================================================
// AUTH-REGISTER ROUTE TESTS
// ============================================================
// Testet die Registrierung:
// - Happy Path (User + Keypair + Default-Kategorien)
// - Doppelte E-Mail → 400 mit code EMAIL_EXISTS (Frontend
//   wechselt damit automatisch in den Anmelde-Modus)
// - Passwort-Validierung
// ============================================================

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

// --- 1. Mock-Prisma erstellen und injizieren BEVOR die Route geladen wird ---
const { createMockPrisma } = require('../helpers/mockPrisma');
const mockPrisma = createMockPrisma();
const prismaPath = require.resolve('../../src/utils/prisma');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: mockPrisma };

// --- 2. Auth-Helper laden (setzt JWT_SECRET) ---
const { cleanupAuth } = require('../helpers/authHelper');

// --- 3. Route + Test-App laden ---
const authRouter = require('../../src/routes/auth');
const { createTestApp } = require('../helpers/testApp');
const app = createTestApp({ path: '/api/auth', router: authRouter });

const VALID_BODY = { email: 'neu@test.de', password: 'Test1234!', name: 'Neuer Nutzer' };

describe('POST /api/auth/register', () => {
  beforeEach(() => {
    mockPrisma._store.users.length = 0;
    mockPrisma._store.categories.length = 0;
  });

  after(() => cleanupAuth());

  it('registriert einen neuen Nutzer mit Keypair', async () => {
    const res = await request(app).post('/api/auth/register').send(VALID_BODY);

    assert.equal(res.status, 201);
    assert.equal(res.body.user.email, 'neu@test.de');

    const user = mockPrisma._store.users[0];
    assert.ok(user.encryptedKey, 'encryptedKey muss gesetzt sein');
    assert.match(user.publicKey, /BEGIN PUBLIC KEY/, 'RSA-Public-Key muss provisioniert sein');
    assert.ok(user.encryptedPrivateKey.includes(':'), 'Private Key muss verschlüsselt sein');
  });

  it('setzt das Auth-Cookie nach der Registrierung', async () => {
    const res = await request(app).post('/api/auth/register').send(VALID_BODY);

    const cookies = res.headers['set-cookie'] || [];
    assert.ok(cookies.some(c => c.startsWith('auth_token=')), 'auth_token-Cookie fehlt');
  });

  it('liefert 400 + code EMAIL_EXISTS bei doppelter E-Mail', async () => {
    await request(app).post('/api/auth/register').send(VALID_BODY);

    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...VALID_BODY, name: 'Zweiter Versuch' });

    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'EMAIL_EXISTS');
    assert.match(res.body.errors[0], /bereits registriert/);
    assert.equal(mockPrisma._store.users.length, 1, 'es darf kein zweiter User entstehen');
  });

  it('erkennt Duplikate unabhängig von Groß-/Kleinschreibung', async () => {
    await request(app).post('/api/auth/register').send(VALID_BODY);

    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...VALID_BODY, email: 'NEU@test.de' });

    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'EMAIL_EXISTS');
  });

  it('lehnt zu schwache Passwörter ab', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...VALID_BODY, password: 'nurbuchstaben' });

    assert.equal(res.status, 400);
    assert.ok(res.body.errors.length >= 1);
    assert.equal(res.body.code, undefined, 'Validierungsfehler haben keinen EMAIL_EXISTS-Code');
  });
});
