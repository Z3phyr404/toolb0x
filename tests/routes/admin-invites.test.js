// ============================================================
// ADMIN-INVITES ROUTE TESTS
// ============================================================
// Registrierung nur per Einladungslink (seit 2026-10-10):
// - Admin erzeugt Links, in der DB liegt nur der Hash
// - offene Einladungen auflisten, zurückziehen
// - Nicht-Admins haben keinen Zugriff
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

// --- 3. Route + Test-App laden ---
const adminRouter = require('../../src/routes/admin');
const { createTestApp } = require('../helpers/testApp');
const app = createTestApp({ path: '/api/admin', router: adminRouter });

let admin;

function makeAdmin(auth) {
  const record = mockPrisma._store.users.find(u => u.id === auth.userId);
  record.role = 'admin';
  return auth;
}

describe('/api/admin/invites', () => {
  beforeEach(() => {
    mockPrisma._store.users.length = 0;
    mockPrisma._store.invites.length = 0;
    admin = makeAdmin(createTestAuth(mockPrisma));
  });

  after(() => cleanupAuth());

  it('erzeugt einen Link und speichert nur den Hash', async () => {
    const res = await request(app)
      .post('/api/admin/invites')
      .set('Cookie', admin.cookie)
      .send({ note: 'für Anna' });

    assert.equal(res.status, 201);
    assert.match(res.body.token, /^[a-f0-9]{64}$/);

    const stored = mockPrisma._store.invites[0];
    const hash = crypto.createHash('sha256').update(res.body.token).digest('hex');
    assert.equal(stored.tokenHash, hash);
    assert.ok(!JSON.stringify(stored).includes(res.body.token), 'Klartext-Token darf NICHT in der DB stehen');
    assert.equal(stored.note, 'für Anna');
    assert.equal(stored.createdById, admin.userId);

    const tage = (stored.expiresAt - Date.now()) / 86400000;
    assert.ok(tage > 6.9 && tage <= 7, 'Standard-Gültigkeit 7 Tage');
  });

  it('lehnt eine unsinnige Gültigkeit ab', async () => {
    for (const days of [0, 31, 'x', 1.5]) {
      const res = await request(app)
        .post('/api/admin/invites')
        .set('Cookie', admin.cookie)
        .send({ days });
      assert.equal(res.status, 400, `days=${days}`);
    }
    assert.equal(mockPrisma._store.invites.length, 0);
  });

  it('listet nur offene Einladungen — ohne Hash', async () => {
    await request(app).post('/api/admin/invites').set('Cookie', admin.cookie).send({ note: 'offen' });
    await request(app).post('/api/admin/invites').set('Cookie', admin.cookie).send({ note: 'benutzt' });
    await request(app).post('/api/admin/invites').set('Cookie', admin.cookie).send({ note: 'abgelaufen' });
    mockPrisma._store.invites[1].usedAt = new Date();
    mockPrisma._store.invites[2].expiresAt = new Date(Date.now() - 1000);

    const res = await request(app).get('/api/admin/invites').set('Cookie', admin.cookie);

    assert.equal(res.status, 200);
    assert.equal(res.body.invites.length, 1);
    assert.equal(res.body.invites[0].note, 'offen');
  });

  it('zieht eine offene Einladung zurück', async () => {
    const created = await request(app).post('/api/admin/invites').set('Cookie', admin.cookie).send({});

    const res = await request(app)
      .delete(`/api/admin/invites/${created.body.id}`)
      .set('Cookie', admin.cookie);

    assert.equal(res.status, 200);
    assert.equal(mockPrisma._store.invites.length, 0);
  });

  it('verweigert Nicht-Admins den Zugriff', async () => {
    const user = createTestAuth(mockPrisma);
    const res = await request(app).post('/api/admin/invites').set('Cookie', user.cookie).send({});

    assert.equal(res.status, 403);
    assert.equal(mockPrisma._store.invites.length, 0);
  });
});
