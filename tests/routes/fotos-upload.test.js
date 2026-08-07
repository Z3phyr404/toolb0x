// ============================================================
// FOTOS-UPLOAD ROUTE TESTS (Posteingang für fotob0x, 2026-08-07)
// ============================================================
// Testet den rohen Stream-Upload nach /api/fotos/upload/:name:
// - Datei ankommen lassen (Inhalt byte-identisch)
// - Namenskollision → -2-Suffix statt Überschreiben
// - Fremde Endungen und Pfad-Tricks werden abgelehnt
// - Status listet den Posteingang, DELETE räumt auf
// - Nicht-Admins haben keinen Zugriff
// ============================================================

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

// --- 1. Posteingang in ein Temp-Verzeichnis legen, BEVOR die Route lädt ---
const INBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'fotos-inbox-test-'));
process.env.FOTOS_INBOX_DIR = INBOX;

// --- 2. Mock-Prisma injizieren (requireAuth lädt den User für den Suspended-Check) ---
const { createMockPrisma } = require('../helpers/mockPrisma');
const mockPrisma = createMockPrisma();
const prismaPath = require.resolve('../../src/utils/prisma');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: mockPrisma };

// --- 3. Auth-Helper laden (setzt JWT_SECRET) ---
const { createTestAuth, cleanupAuth } = require('../helpers/authHelper');

// --- 4. Route + Test-App laden ---
const fotosRouter = require('../../src/routes/fotos');
const { createTestApp } = require('../helpers/testApp');
const app = createTestApp({ path: '/api/fotos', router: fotosRouter });

let admin;
let user;

before(() => {
  admin = createTestAuth(mockPrisma);
  mockPrisma._store.users.find((u) => u.id === admin.userId).role = 'admin';
  user = createTestAuth(mockPrisma);
});

after(() => {
  cleanupAuth();
  fs.rmSync(INBOX, { recursive: true, force: true });
});

describe('PUT /api/fotos/upload/:name', () => {
  it('speichert die Datei byte-identisch im Posteingang', async () => {
    const payload = Buffer.from('fake-raw-datei-inhalt-0123456789');
    const res = await request(app)
      .put('/api/fotos/upload/DSC00042.ARW')
      .set('Cookie', admin.cookie)
      .set('Content-Type', 'application/octet-stream')
      .send(payload);
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'DSC00042.ARW');
    assert.equal(res.body.size, payload.length);
    assert.deepEqual(fs.readFileSync(path.join(INBOX, 'DSC00042.ARW')), payload);
  });

  it('überschreibt nie: gleicher Name bekommt ein -2-Suffix', async () => {
    const res = await request(app)
      .put('/api/fotos/upload/DSC00042.ARW')
      .set('Cookie', admin.cookie)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('zweite datei'));
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'DSC00042-2.ARW');
    assert.equal(fs.readFileSync(path.join(INBOX, 'DSC00042.ARW'), 'utf8'), 'fake-raw-datei-inhalt-0123456789');
  });

  it('lehnt nicht unterstützte Endungen ab', async () => {
    const res = await request(app)
      .put('/api/fotos/upload/schadprogramm.exe')
      .set('Cookie', admin.cookie)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('x'));
    assert.equal(res.status, 400);
  });

  it('entschärft Pfad-Bestandteile im Namen (kein Ausbruch aus dem Posteingang)', async () => {
    const res = await request(app)
      .put('/api/fotos/upload/' + encodeURIComponent('..\\..\\evil.jpg'))
      .set('Cookie', admin.cookie)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('x'));
    // Entweder sauber abgelehnt oder auf einen harmlosen Namen IM Posteingang reduziert
    if (res.status === 200) {
      const stored = path.join(INBOX, res.body.name);
      assert.equal(path.dirname(stored), INBOX);
      assert.ok(fs.existsSync(stored));
    } else {
      assert.equal(res.status, 400);
    }
    assert.ok(!fs.existsSync(path.join(INBOX, '..', 'evil.jpg')));
  });

  it('lehnt leere Dateien ab', async () => {
    const res = await request(app)
      .put('/api/fotos/upload/leer.jpg')
      .set('Cookie', admin.cookie)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(0));
    assert.equal(res.status, 400);
    assert.ok(!fs.existsSync(path.join(INBOX, 'leer.jpg')));
  });

  it('blockt Nicht-Admins', async () => {
    const res = await request(app)
      .put('/api/fotos/upload/foto.jpg')
      .set('Cookie', user.cookie)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('x'));
    assert.equal(res.status, 403);
  });
});

describe('GET /api/fotos/upload/status', () => {
  it('listet die Dateien im Posteingang', async () => {
    const res = await request(app).get('/api/fotos/upload/status').set('Cookie', admin.cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.ready, true);
    const names = res.body.files.map((f) => f.name);
    assert.ok(names.includes('DSC00042.ARW'));
    assert.ok(names.includes('DSC00042-2.ARW'));
  });

  it('verschweigt Dateien, die DELETE nie annehmen würde (Umlaute, fremde Endungen)', async () => {
    fs.writeFileSync(path.join(INBOX, 'Föhn.jpg'), 'x');
    fs.writeFileSync(path.join(INBOX, 'rest.tmp'), 'x');
    const res = await request(app).get('/api/fotos/upload/status').set('Cookie', admin.cookie);
    assert.equal(res.status, 200);
    const names = res.body.files.map((f) => f.name);
    assert.ok(!names.includes('Föhn.jpg'));
    assert.ok(!names.includes('rest.tmp'));
  });
});

describe('DELETE /api/fotos/upload/:name', () => {
  it('entfernt genau eine Datei aus dem Posteingang', async () => {
    const res = await request(app)
      .delete('/api/fotos/upload/DSC00042-2.ARW')
      .set('Cookie', admin.cookie);
    assert.equal(res.status, 200);
    assert.ok(!fs.existsSync(path.join(INBOX, 'DSC00042-2.ARW')));
    assert.ok(fs.existsSync(path.join(INBOX, 'DSC00042.ARW')));
  });

  it('meldet 404 für unbekannte Dateien', async () => {
    const res = await request(app)
      .delete('/api/fotos/upload/DSC00042-2.ARW')
      .set('Cookie', admin.cookie);
    assert.equal(res.status, 404);
  });
});
