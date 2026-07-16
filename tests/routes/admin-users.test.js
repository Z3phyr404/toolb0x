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
