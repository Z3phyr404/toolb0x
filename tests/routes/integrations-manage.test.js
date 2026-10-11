// ============================================================
// HERMES-ZUGANG VERWALTEN — /api/integrations (Sitzung in der App)
// ============================================================

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const request = require('supertest');

process.env.INTEGRATION_RATE_AUTH_FAIL = '100000';

const { createMockPrisma } = require('../helpers/mockPrisma');
const mockPrisma = createMockPrisma();
const prismaPath = require.resolve('../../src/utils/prisma');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: mockPrisma };

const { createTestAuth, cleanupAuth } = require('../helpers/authHelper');
const integrationsRouter = require('../../src/routes/integrations');
const { createTestApp } = require('../helpers/testApp');
const { createIntegrationApp } = require('../../src/integration/app');

const app = createTestApp({ path: '/api/integrations', router: integrationsRouter });
const local = createIntegrationApp();
const S = mockPrisma._store;
const PASSWORT = 'Synthetisch1!';
let auth;

async function setup() {
  for (const t of Object.keys(S)) S[t].length = 0;
  auth = createTestAuth(mockPrisma);
  S.users.find(u => u.id === auth.userId).password = await bcrypt.hash(PASSWORT, 4);
}

after(() => cleanupAuth());

describe('/api/integrations', () => {
  beforeEach(setup);

  it('ohne Anmeldung: 401', async () => {
    assert.equal((await request(app).get('/api/integrations')).status, 401);
    assert.equal((await request(app).post('/api/integrations').send({ password: PASSWORT })).status, 401);
  });

  it('Anlegen braucht das richtige Passwort', async () => {
    const r1 = await request(app).post('/api/integrations').set('Cookie', auth.cookie).send({});
    assert.equal(r1.status, 400);
    const r2 = await request(app).post('/api/integrations').set('Cookie', auth.cookie).send({ password: 'falsch' });
    assert.equal(r2.status, 401);
    assert.equal(S.integrationCredentials.length, 0);
  });

  it('Token nur einmal in der Antwort, danach nie wieder abrufbar; funktioniert lokal', async () => {
    const res = await request(app).post('/api/integrations').set('Cookie', auth.cookie).send({ password: PASSWORT, name: 'Hermes' });
    assert.equal(res.status, 201);
    assert.match(res.body.token, /^tbxi_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    assert.equal(res.body.credential.active, true);

    const list = await request(app).get('/api/integrations').set('Cookie', auth.cookie);
    const raw = JSON.stringify(list.body);
    assert.ok(!raw.includes(res.body.token.split('.')[1]));
    assert.ok(!raw.includes('secretHash') && !raw.includes('wrappedKey'));
    assert.equal(list.body.credentials.length, 1);

    const status = await request(local).get('/v1/status').set('Authorization', `Bearer ${res.body.token}`);
    assert.equal(status.status, 200);
  });

  it('Widerruf wirkt sofort', async () => {
    const res = await request(app).post('/api/integrations').set('Cookie', auth.cookie).send({ password: PASSWORT });
    const del = await request(app).delete(`/api/integrations/${res.body.credential.id}`).set('Cookie', auth.cookie);
    assert.equal(del.status, 200);
    const status = await request(local).get('/v1/status').set('Authorization', `Bearer ${res.body.token}`);
    assert.equal(status.status, 401);
    const again = await request(app).delete(`/api/integrations/${res.body.credential.id}`).set('Cookie', auth.cookie);
    assert.equal(again.status, 404);
  });

  it('fremde Zugänge sind weder sichtbar noch widerrufbar', async () => {
    const res = await request(app).post('/api/integrations').set('Cookie', auth.cookie).send({ password: PASSWORT });
    const fremd = createTestAuth(mockPrisma);
    const list = await request(app).get('/api/integrations').set('Cookie', fremd.cookie);
    assert.deepEqual(list.body.credentials, []);
    const del = await request(app).delete(`/api/integrations/${res.body.credential.id}`).set('Cookie', fremd.cookie);
    assert.equal(del.status, 404);
    assert.equal(S.integrationCredentials[0].revokedAt, null);
  });

  it('höchstens 3 aktive Zugänge', async () => {
    for (let i = 0; i < 3; i++) {
      assert.equal((await request(app).post('/api/integrations').set('Cookie', auth.cookie).send({ password: PASSWORT })).status, 201);
    }
    assert.equal((await request(app).post('/api/integrations').set('Cookie', auth.cookie).send({ password: PASSWORT })).status, 400);
  });

  it('Zugang funktioniert ohne angemeldete Sitzung weiter (nach Logout/Neustart)', async () => {
    const res = await request(app).post('/api/integrations').set('Cookie', auth.cookie).send({ password: PASSWORT });
    require('../../src/utils/sessionStore').deleteAllForUser(auth.userId); // Logout / Neustart
    assert.equal((await request(app).get('/api/integrations').set('Cookie', auth.cookie)).status, 401);
    const cats = await request(local).get('/v1/categories').set('Authorization', `Bearer ${res.body.token}`);
    assert.equal(cats.status, 200);
  });
});
