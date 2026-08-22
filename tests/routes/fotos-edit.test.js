// ============================================================
// FOTOS-EDIT-REQUEST TESTS (Änderungs-Warteschlange, 2026-08-22)
// ============================================================
// Bewerten/Taggen im Web legt Marker "<assetId>.json" unter
// fotos-privat/edit-queue ab; fotob0x holt sie ab. Getestet wird:
// - Bewertung und Tags landen als Marker-JSON
// - Mehrere Anfragen zum selben Foto werden in EINEN Marker gemischt
//   (letzte Bewertung gewinnt, add/del heben sich gegenseitig auf)
// - Ungültige IDs/Bewertungen/Tags werden abgelehnt bzw. bereinigt
// - Status zählt offene Marker, Nicht-Admins sind ausgesperrt
// ============================================================

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

// --- 1. Privat-Verzeichnis in ein Temp-Verzeichnis legen, BEVOR die Route lädt ---
const PRIVAT = fs.mkdtempSync(path.join(os.tmpdir(), 'fotos-privat-test-'));
process.env.FOTOS_PRIVAT_DIR = PRIVAT;
const QUEUE = path.join(PRIVAT, 'edit-queue');

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

function readMarker(id) {
  return JSON.parse(fs.readFileSync(path.join(QUEUE, id + '.json'), 'utf8'));
}

before(() => {
  admin = createTestAuth(mockPrisma);
  mockPrisma._store.users.find((u) => u.id === admin.userId).role = 'admin';
  user = createTestAuth(mockPrisma);
});

after(() => {
  cleanupAuth();
  fs.rmSync(PRIVAT, { recursive: true, force: true });
});

describe('POST /api/fotos/edit-request', () => {
  it('legt einen Marker mit Bewertung an', async () => {
    const res = await request(app)
      .post('/api/fotos/edit-request')
      .set('Cookie', admin.cookie)
      .send({ id: 42, rating: 4 });
    assert.equal(res.status, 200);
    assert.deepEqual(readMarker(42), { r: 4 });
  });

  it('mischt eine spätere Bewertung in den bestehenden Marker (letzte gewinnt)', async () => {
    const res = await request(app)
      .post('/api/fotos/edit-request')
      .set('Cookie', admin.cookie)
      .send({ id: 42, rating: 0 });
    assert.equal(res.status, 200);
    assert.deepEqual(readMarker(42), { r: 0 });
  });

  it('sammelt Tag-Änderungen; add und del heben sich gegenseitig auf', async () => {
    await request(app).post('/api/fotos/edit-request').set('Cookie', admin.cookie)
      .send({ id: 42, addTags: ['Urlaub', 'Meer'] });
    await request(app).post('/api/fotos/edit-request').set('Cookie', admin.cookie)
      .send({ id: 42, removeTags: ['Meer', 'Alt'] });
    const marker = readMarker(42);
    assert.equal(marker.r, 0); // Bewertung aus dem vorigen Test bleibt erhalten
    assert.deepEqual(marker.add, ['Urlaub']);
    assert.deepEqual(marker.del.sort(), ['Alt', 'Meer']);
  });

  it('bereinigt Tags: Duplikate, Leerraum, Steuerzeichen, Überlänge', async () => {
    const res = await request(app)
      .post('/api/fotos/edit-request')
      .set('Cookie', admin.cookie)
      .send({ id: 7, addTags: ['  Strand  ', 'strand', 'böse\u0000zeile', 'a/b', 'x'.repeat(61), '', 42] });
    assert.equal(res.status, 200);
    assert.deepEqual(readMarker(7), { add: ['Strand'] });
  });

  it('lehnt ungültige IDs ab', async () => {
    for (const id of [0, -1, 'abc', 1e12, null]) {
      const res = await request(app)
        .post('/api/fotos/edit-request')
        .set('Cookie', admin.cookie)
        .send({ id, rating: 3 });
      assert.equal(res.status, 400, 'id=' + String(id));
    }
    assert.ok(!fs.existsSync(path.join(QUEUE, '0.json')));
  });

  it('lehnt ungültige Bewertungen ab', async () => {
    for (const rating of [-1, 6, 2.5, 'toll']) {
      const res = await request(app)
        .post('/api/fotos/edit-request')
        .set('Cookie', admin.cookie)
        .send({ id: 9, rating });
      assert.equal(res.status, 400, 'rating=' + String(rating));
    }
  });

  it('lehnt Anfragen ohne jede Änderung ab', async () => {
    const res = await request(app)
      .post('/api/fotos/edit-request')
      .set('Cookie', admin.cookie)
      .send({ id: 9, addTags: ['\u0001'] }); // wird wegbereinigt → nichts übrig
    assert.equal(res.status, 400);
  });


  it('nimmt ids[] für Mehrfachauswahl an und legt je Foto einen Marker an', async () => {
    const res = await request(app)
      .post('/api/fotos/edit-request')
      .set('Cookie', admin.cookie)
      .send({ ids: [201, 202, 202, 'x', -5], rating: 5, addTags: ['Auswahl'] });
    assert.equal(res.status, 200);
    assert.equal(res.body.queued, 2); // 202 dedupliziert, ungültige verworfen
    assert.deepEqual(readMarker(201), { r: 5, add: ['Auswahl'] });
    assert.deepEqual(readMarker(202), { r: 5, add: ['Auswahl'] });
  });

  it('lehnt leere/ungültige ids-Listen ab', async () => {
    const res = await request(app)
      .post('/api/fotos/edit-request')
      .set('Cookie', admin.cookie)
      .send({ ids: ['abc', 0], rating: 3 });
    assert.equal(res.status, 400);
  });
  it('blockt Nicht-Admins', async () => {
    const res = await request(app)
      .post('/api/fotos/edit-request')
      .set('Cookie', user.cookie)
      .send({ id: 42, rating: 5 });
    assert.equal(res.status, 403);
  });
});

describe('GET /api/fotos/edit-request', () => {
  it('zählt die offenen Marker', async () => {
    const res = await request(app).get('/api/fotos/edit-request').set('Cookie', admin.cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.pending, 4); // 42, 7 sowie 201/202 aus dem ids[]-Test
  });
});
