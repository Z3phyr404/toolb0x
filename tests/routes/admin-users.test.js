// ============================================================
// ADMIN-USERS ROUTE TESTS
// ============================================================
// Testet die Nutzer-Löschung durch Admins:
// - Admin kann Nutzer endgültig löschen
// - Selbst-Löschung und Admin-Löschung sind blockiert
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

function seedUser({ role = 'user', suspended = false } = {}) {
  const id = crypto.randomUUID();
  mockPrisma._store.users.push({
    id,
    email: `seed-${id.slice(0, 8)}@test.de`,
    name: 'Ziel-Nutzer',
    role,
    suspended,
    createdAt: new Date(),
  });
  return id;
}

describe('DELETE /api/admin/users/:id', () => {
  beforeEach(() => {
    mockPrisma._store.users.length = 0;
    admin = makeAdmin(createTestAuth(mockPrisma));
  });

  after(() => cleanupAuth());

  it('löscht einen Nutzer endgültig', async () => {
    const targetId = seedUser();

    const res = await request(app)
      .delete(`/api/admin/users/${targetId}`)
      .set('Cookie', admin.cookie);

    assert.equal(res.status, 200);
    assert.match(res.body.message, /endgültig gelöscht/);
    assert.ok(!mockPrisma._store.users.some(u => u.id === targetId), 'Nutzer muss aus der DB entfernt sein');
  });

  it('blockiert Selbst-Löschung', async () => {
    const res = await request(app)
      .delete(`/api/admin/users/${admin.userId}`)
      .set('Cookie', admin.cookie);

    assert.equal(res.status, 400);
    assert.equal(mockPrisma._store.users.length, 1);
  });

  it('blockiert das Löschen anderer Admins', async () => {
    const otherAdminId = seedUser({ role: 'admin' });

    const res = await request(app)
      .delete(`/api/admin/users/${otherAdminId}`)
      .set('Cookie', admin.cookie);

    assert.equal(res.status, 400);
    assert.ok(mockPrisma._store.users.some(u => u.id === otherAdminId));
  });

  it('liefert 404 für unbekannte Nutzer', async () => {
    const res = await request(app)
      .delete(`/api/admin/users/${crypto.randomUUID()}`)
      .set('Cookie', admin.cookie);

    assert.equal(res.status, 404);
  });

  it('verweigert Nicht-Admins den Zugriff', async () => {
    const normalUser = createTestAuth(mockPrisma);
    const targetId = seedUser();

    const res = await request(app)
      .delete(`/api/admin/users/${targetId}`)
      .set('Cookie', normalUser.cookie);

    assert.equal(res.status, 403);
    assert.ok(mockPrisma._store.users.some(u => u.id === targetId), 'Nutzer darf nicht gelöscht sein');
  });
});

describe('POST /api/admin/users/:id/reset-link', () => {
  beforeEach(() => {
    mockPrisma._store.users.length = 0;
    admin = makeAdmin(createTestAuth(mockPrisma));
  });

  after(() => cleanupAuth());

  it('erzeugt einen Reset-Token und speichert nur dessen Hash', async () => {
    const targetId = seedUser();

    const res = await request(app)
      .post(`/api/admin/users/${targetId}/reset-link`)
      .set('Cookie', admin.cookie);

    assert.equal(res.status, 200);
    assert.match(res.body.token, /^[0-9a-f]{64}$/);

    const target = mockPrisma._store.users.find(u => u.id === targetId);
    assert.ok(target.resetToken, 'Hash muss gespeichert sein');
    assert.notEqual(target.resetToken, res.body.token, 'Klartext-Token darf NICHT in der DB stehen');
    assert.ok(target.resetTokenExpires > new Date(), 'Ablaufzeit in der Zukunft');
  });

  it('blockiert Reset-Links für Admins und für sich selbst', async () => {
    const otherAdminId = seedUser({ role: 'admin' });

    const forAdmin = await request(app)
      .post(`/api/admin/users/${otherAdminId}/reset-link`)
      .set('Cookie', admin.cookie);
    assert.equal(forAdmin.status, 400);

    const forSelf = await request(app)
      .post(`/api/admin/users/${admin.userId}/reset-link`)
      .set('Cookie', admin.cookie);
    assert.equal(forSelf.status, 400);
  });
});
