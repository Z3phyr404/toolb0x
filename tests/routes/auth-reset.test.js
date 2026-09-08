// ============================================================
// PASSWORT-RESET TESTS
// ============================================================
// Testet beide Reset-Wege:
// - Recovery-Code (ohne Datenverlust): Code aus der Registrierung
//   entschlüsselt den Key → neues Passwort, Daten bleiben
// - Admin-Reset-Token (mit Datenverlust): alle verschlüsselten
//   Daten werden gelöscht, Konto bekommt frischen Key + Kategorien
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
const { cleanupAuth } = require('../helpers/authHelper');

// --- 3. Route + Test-App laden ---
const authRouter = require('../../src/routes/auth');
const { createTestApp } = require('../helpers/testApp');
const app = createTestApp({ path: '/api/auth', router: authRouter });

const REGISTER_BODY = { email: 'reset@test.de', password: 'AltesPw1234', name: 'Reset Nutzer' };

function resetStore() {
  for (const table of Object.keys(mockPrisma._store)) {
    mockPrisma._store[table].length = 0;
  }
}

async function registerUser() {
  const res = await request(app).post('/api/auth/register').send(REGISTER_BODY);
  assert.equal(res.status, 201);
  return res.body.recoveryCode;
}

describe('POST /api/auth/reset-password (Recovery-Code, ohne Datenverlust)', () => {
  beforeEach(resetStore);
  after(() => cleanupAuth());

  it('setzt das Passwort mit gültigem Recovery-Code zurück — Daten bleiben', async () => {
    const recoveryCode = await registerUser();
    assert.match(recoveryCode, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){5}$/);
    const categoriesBefore = mockPrisma._store.categories.map(c => c.name);

    const res = await request(app).post('/api/auth/reset-password').send({
      email: REGISTER_BODY.email,
      recoveryCode,
      newPassword: 'NeuesPw1234',
    });
    assert.equal(res.status, 200);

    // Kategorien unangetastet (kein Datenverlust) — gleiche Ciphertexte
    assert.deepEqual(mockPrisma._store.categories.map(c => c.name), categoriesBefore);

    // Login mit neuem Passwort klappt (Key-Wrap intakt), altes Passwort nicht
    const loginNew = await request(app).post('/api/auth/login')
      .send({ email: REGISTER_BODY.email, password: 'NeuesPw1234' });
    assert.equal(loginNew.status, 200);

    const loginOld = await request(app).post('/api/auth/login')
      .send({ email: REGISTER_BODY.email, password: REGISTER_BODY.password });
    assert.equal(loginOld.status, 401);
  });

  it('akzeptiert den Code auch klein geschrieben und ohne Bindestriche', async () => {
    const recoveryCode = await registerUser();

    const res = await request(app).post('/api/auth/reset-password').send({
      email: REGISTER_BODY.email,
      recoveryCode: recoveryCode.toLowerCase().replaceAll('-', ' '),
      newPassword: 'NeuesPw1234',
    });
    assert.equal(res.status, 200);
  });

  it('lehnt einen falschen Recovery-Code ab', async () => {
    await registerUser();

    const res = await request(app).post('/api/auth/reset-password').send({
      email: REGISTER_BODY.email,
      recoveryCode: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA',
      newPassword: 'NeuesPw1234',
    });
    assert.equal(res.status, 401);

    // Passwort unverändert
    const login = await request(app).post('/api/auth/login')
      .send({ email: REGISTER_BODY.email, password: REGISTER_BODY.password });
    assert.equal(login.status, 200);
  });

  it('liefert dieselbe Fehlermeldung für unbekannte E-Mail und falschen Code', async () => {
    await registerUser();

    const wrongCode = await request(app).post('/api/auth/reset-password').send({
      email: REGISTER_BODY.email, recoveryCode: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA', newPassword: 'NeuesPw1234',
    });
    const wrongMail = await request(app).post('/api/auth/reset-password').send({
      email: 'gibtsnicht@test.de', recoveryCode: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA', newPassword: 'NeuesPw1234',
    });
    assert.equal(wrongCode.status, 401);
    assert.equal(wrongMail.status, 401);
    assert.deepEqual(wrongCode.body, wrongMail.body);
  });
});

describe('POST /api/auth/recovery-code (Code rotieren)', () => {
  beforeEach(resetStore);
  after(() => cleanupAuth());

  it('erzeugt einen neuen Code — der alte wird ungültig', async () => {
    // Registrierung setzt das Auth-Cookie und liefert den ersten Code
    const registerRes = await request(app).post('/api/auth/register').send(REGISTER_BODY);
    const cookie = registerRes.headers['set-cookie'];
    const oldCode = registerRes.body.recoveryCode;

    const rotate = await request(app).post('/api/auth/recovery-code')
      .set('Cookie', cookie)
      .send({ currentPassword: REGISTER_BODY.password });
    assert.equal(rotate.status, 200);
    const newCode = rotate.body.recoveryCode;
    assert.match(newCode, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){5}$/);
    assert.notEqual(newCode, oldCode);

    // Alter Code ist ungültig, neuer funktioniert
    const oldTry = await request(app).post('/api/auth/reset-password').send({
      email: REGISTER_BODY.email, recoveryCode: oldCode, newPassword: 'NeuesPw1234',
    });
    assert.equal(oldTry.status, 401);

    const newTry = await request(app).post('/api/auth/reset-password').send({
      email: REGISTER_BODY.email, recoveryCode: newCode, newPassword: 'NeuesPw1234',
    });
    assert.equal(newTry.status, 200);
  });

  it('verlangt das korrekte aktuelle Passwort', async () => {
    const registerRes = await request(app).post('/api/auth/register').send(REGISTER_BODY);
    const cookie = registerRes.headers['set-cookie'];

    const rotate = await request(app).post('/api/auth/recovery-code')
      .set('Cookie', cookie)
      .send({ currentPassword: 'FalschesPw1' });
    assert.equal(rotate.status, 401);
  });
});

describe('POST /api/auth/reset-with-token (Admin-Fallback, mit Datenverlust)', () => {
  beforeEach(resetStore);
  after(() => cleanupAuth());

  function armResetToken(userId, expiresInMs = 60 * 60 * 1000) {
    const token = crypto.randomBytes(32).toString('hex');
    const user = mockPrisma._store.users.find(u => u.id === userId);
    user.resetToken = crypto.createHash('sha256').update(token).digest('hex');
    user.resetTokenExpires = new Date(Date.now() + expiresInMs);
    return token;
  }

  it('setzt neues Passwort, löscht Daten und liefert neuen Recovery-Code', async () => {
    await registerUser();
    const user = mockPrisma._store.users[0];
    const oldCategories = mockPrisma._store.categories.map(c => c.name);

    // Alt-Daten simulieren
    mockPrisma._store.expenses.push({ id: 'e1', userId: user.id, name: 'x', amount: 'y', month: '2026-07' });
    mockPrisma._store.notes.push({ id: 'n1', userId: user.id, title: 'x' });
    mockPrisma._store.storedPasswords.push({ id: 's1', userId: user.id, vaultId: null, name: 'x' });

    const token = armResetToken(user.id);
    const res = await request(app).post('/api/auth/reset-with-token')
      .send({ token, newPassword: 'GanzNeu1234' });

    assert.equal(res.status, 200);
    assert.match(res.body.recoveryCode, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){5}$/);

    // Verschlüsselte Daten weg, Kategorien neu (andere Ciphertexte)
    assert.equal(mockPrisma._store.expenses.length, 0);
    assert.equal(mockPrisma._store.notes.length, 0);
    assert.equal(mockPrisma._store.storedPasswords.length, 0);
    assert.equal(mockPrisma._store.categories.length, oldCategories.length);
    assert.notDeepEqual(mockPrisma._store.categories.map(c => c.name), oldCategories);

    // Token verbraucht
    assert.equal(user.resetToken, null);

    // Login mit neuem Passwort
    const login = await request(app).post('/api/auth/login')
      .send({ email: REGISTER_BODY.email, password: 'GanzNeu1234' });
    assert.equal(login.status, 200);
  });

  it('lehnt abgelaufene Tokens ab', async () => {
    await registerUser();
    const token = armResetToken(mockPrisma._store.users[0].id, -1000);

    const res = await request(app).post('/api/auth/reset-with-token')
      .send({ token, newPassword: 'GanzNeu1234' });
    assert.equal(res.status, 401);
  });

  it('lehnt unbekannte Tokens ab', async () => {
    await registerUser();

    const res = await request(app).post('/api/auth/reset-with-token')
      .send({ token: 'deadbeef'.repeat(8), newPassword: 'GanzNeu1234' });
    assert.equal(res.status, 401);
  });
});


describe('Auth credential atomicity regressions', () => {
  beforeEach(resetStore);
  after(() => cleanupAuth());

  function arm() {
    const token = crypto.randomBytes(32).toString('hex');
    Object.assign(mockPrisma._store.users[0], {
      resetToken: crypto.createHash('sha256').update(token).digest('hex'),
      resetTokenExpires: new Date(Date.now() + 60000),
    });
    return token;
  }
  const reset = token => request(app).post('/api/auth/reset-with-token')
    .send({ token, newPassword: 'GanzNeu1234' });

  for (const method of ['password', 'recovery']) {
    it(method + ' invalidates an outstanding reset link without deleting data', async () => {
      const reg = await request(app).post('/api/auth/register').send(REGISTER_BODY);
      const token = arm();
      const categories = structuredClone(mockPrisma._store.categories);
      const result = method === 'password'
        ? await request(app).put('/api/auth/password').set('Cookie', reg.headers['set-cookie'])
          .send({ currentPassword: REGISTER_BODY.password, newPassword: 'Updated1234' })
        : await request(app).post('/api/auth/reset-password')
          .send({ email: REGISTER_BODY.email, recoveryCode: reg.body.recoveryCode, newPassword: 'Updated1234' });
      assert.equal(result.status, 200);
      assert.equal(mockPrisma._store.users[0].resetToken, null);
      assert.equal(mockPrisma._store.users[0].resetTokenExpires, null);
      assert.equal((await reset(token)).status, 401);
      assert.deepEqual(mockPrisma._store.categories, categories);
    });
  }

  it('allows only one concurrent token use after both requests read the valid token', async () => {
    await registerUser();
    const token = arm();
    const original = mockPrisma.user.findUnique;
    let arrivals = 0, release;
    const bothRead = new Promise(resolve => { release = resolve; });
    mockPrisma.user.findUnique = async args => {
      const snapshot = await original(args);
      if (args.where.resetToken) {
        if (++arrivals === 2) release();
        await bothRead;
      }
      return snapshot;
    };
    let results;
    try { results = await Promise.all([reset(token), reset(token)]); }
    finally { mockPrisma.user.findUnique = original; }
    assert.deepEqual(results.map(r => r.status).sort(), [200, 401]);
    assert.equal(mockPrisma._store.categories.length, 9);
    const before = structuredClone(mockPrisma._store);
    assert.equal((await reset(token)).status, 401);
    assert.deepEqual(mockPrisma._store, before);
  });

  for (const stage of ['delete', 'recreate']) {
    it('rolls back credentials, token and all data on ' + stage + ' failure; retry succeeds', async () => {
      const reg = await request(app).post('/api/auth/register').send(REGISTER_BODY);
      const token = arm();
      const userId = mockPrisma._store.users[0].id;
      mockPrisma._store.expenses.push({ id: 'expense', userId });
      mockPrisma._store.notes.push({ id: 'note', userId });
      const before = structuredClone(mockPrisma._store);
      const collection = stage === 'delete' ? mockPrisma.note : mockPrisma.category;
      const operation = stage === 'delete' ? 'deleteMany' : 'createMany';
      const original = collection[operation];
      collection[operation] = async () => { throw new Error('Injected transaction failure'); };
      try { assert.equal((await reset(token)).status, 500); }
      finally { collection[operation] = original; }
      assert.deepEqual(mockPrisma._store, before);
      assert.equal((await request(app).get('/api/auth/me').set('Cookie', reg.headers['set-cookie'])).status, 200);
      assert.equal((await reset(token)).status, 200);
      assert.equal((await request(app).get('/api/auth/me').set('Cookie', reg.headers['set-cookie'])).status, 401);
    });
  }

  for (const route of ['password', 'reset-password', 'recovery-code']) {
    it('rejects a stale ' + route + ' write after a competing credential update', async () => {
      const reg = await request(app).post('/api/auth/register').send(REGISTER_BODY);
      const original = mockPrisma.user.updateMany;
      let winner;
      mockPrisma.user.updateMany = async args => {
        Object.assign(mockPrisma._store.users[0], {
          password: 'competing-password-hash', encryptedKey: 'competing-key', recoveryKey: 'competing-recovery-key',
        });
        winner = structuredClone(mockPrisma._store.users[0]);
        return original(args);
      };
      let result;
      try {
        result = route === 'password'
          ? await request(app).put('/api/auth/password').set('Cookie', reg.headers['set-cookie'])
            .send({ currentPassword: REGISTER_BODY.password, newPassword: 'Updated1234' })
          : await request(app).post('/api/auth/' + route).set('Cookie', reg.headers['set-cookie'])
            .send({ email: REGISTER_BODY.email, recoveryCode: reg.body.recoveryCode,
              currentPassword: REGISTER_BODY.password, newPassword: 'Updated1234' });
      } finally { mockPrisma.user.updateMany = original; }
      assert.equal(result.status, 401);
      assert.deepEqual(mockPrisma._store.users[0], winner);
    });
  }

  it('rechecks expiry after crypto preparation before touching data', async () => {
    await registerUser();
    const token = arm();
    const original = mockPrisma.$transaction;
    mockPrisma.$transaction = callback => {
      mockPrisma._store.users[0].resetTokenExpires = new Date(0);
      return original(callback);
    };
    const categories = structuredClone(mockPrisma._store.categories);
    try { assert.equal((await reset(token)).status, 401); }
    finally { mockPrisma.$transaction = original; }
    assert.deepEqual(mockPrisma._store.categories, categories);
    assert.notEqual(mockPrisma._store.users[0].resetToken, null);
  });
});
