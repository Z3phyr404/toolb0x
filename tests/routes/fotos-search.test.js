// ============================================================
// KI-FOTOSUCHE ROUTE TESTS (2026-08-09)
// ============================================================
// Testet /api/fotos/search/status und POST /api/fotos/search mit einem
// GESTUBBTEN Encoder (kein Modell-Download!) und synthetischen
// Int8-Vektoren im Format des fotob0x-Websync-Exports:
// - Status ohne/mit Vektoren
// - 404 mit deutscher Meldung, solange kein Index hochgeladen wurde
// - Ranking-Reihenfolge, bester Wert über mehrere Anfrage-Varianten,
//   relative Schwelle 0.55 (trimToRelevant)
// - Cache-Invalidierung, 503 während des Modell-Ladens, Dims-Mismatch
// - Nicht-Admins haben keinen Zugriff
// ============================================================

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

// --- 1. Privaten Mirror in ein Temp-Verzeichnis legen, BEVOR die Route lädt ---
const PRIVAT = fs.mkdtempSync(path.join(os.tmpdir(), 'fotos-search-test-'));
process.env.FOTOS_PRIVAT_DIR = PRIVAT;

// --- 2. Mock-Prisma injizieren (requireAuth lädt den User für den Suspended-Check) ---
const { createMockPrisma } = require('../helpers/mockPrisma');
const mockPrisma = createMockPrisma();
const prismaPath = require.resolve('../../src/utils/prisma');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: mockPrisma };

// --- 3. Encoder stubben (Dependency über require.cache, wie beim Prisma-Mock):
//        die Tests steuern über _variants/_mode, was "das Modell" liefert ---
const embedderStub = {
  _variants: [[1, 0, 0, 0]], // Anfrage-Vektoren, die embedQueryVariants liefert
  _mode: 'ok',               // 'ok' | 'loading' (wirft MODEL_LOADING)
  lastModelId: null,
  isReady() { return true; },
  async embedQueryVariants(query, modelId) {
    this.lastModelId = modelId;
    if (this._mode === 'loading') {
      const err = new Error('Das KI-Modell wird noch geladen.');
      err.code = 'MODEL_LOADING';
      throw err;
    }
    return this._variants.map((v) => Float32Array.from(v));
  },
};
const embedderPath = require.resolve('../../src/utils/fotoEmbedder');
require.cache[embedderPath] = { id: embedderPath, filename: embedderPath, loaded: true, exports: embedderStub };

// --- 4. Auth-Helper, Route + Test-App laden ---
const { createTestAuth, cleanupAuth } = require('../helpers/authHelper');
const { invalidateSearchCache } = require('../../src/utils/fotoSearch');
const fotosRouter = require('../../src/routes/fotos');
const { createTestApp } = require('../helpers/testApp');
const app = createTestApp({ path: '/api/fotos', router: fotosRouter });

const MODEL_ID = 'onnx-community/siglip2-base-patch16-224-ONNX';

/**
 * Schreibt einen Such-Index im Websync-Format: Vektoren werden L2-normalisiert
 * und wie in fotob0x (websync.ts) Int8-quantisiert (S = 127 / max|v|).
 */
function writeIndex(vectors, ids, model) {
  const dims = vectors[0].length;
  const scales = [];
  const buf = Buffer.alloc(vectors.length * dims);
  vectors.forEach((v, n) => {
    const len = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    const norm = v.map((x) => x / len);
    const maxAbs = Math.max(...norm.map(Math.abs));
    const scale = 127 / maxAbs;
    scales.push(scale);
    norm.forEach((x, i) => buf.writeInt8(Math.round(x * scale), n * dims + i));
  });
  fs.mkdirSync(path.join(PRIVAT, 'search'), { recursive: true });
  fs.writeFileSync(
    path.join(PRIVAT, 'search', 'index.json'),
    JSON.stringify({ model, dims, count: ids.length, ids, scales })
  );
  fs.writeFileSync(path.join(PRIVAT, 'search', 'vectors.bin'), buf);
  // mtime-Cache sicher entwerten (zwei Schreibvorgänge können in derselben
  // Millisekunde landen)
  invalidateSearchCache();
}

let admin;
let user;

before(() => {
  admin = createTestAuth(mockPrisma);
  mockPrisma._store.users.find((u) => u.id === admin.userId).role = 'admin';
  user = createTestAuth(mockPrisma);
});

after(() => {
  cleanupAuth();
  fs.rmSync(PRIVAT, { recursive: true, force: true });
});

describe('ohne hochgeladene Suchvektoren', () => {
  it('Status meldet available: false', async () => {
    const res = await request(app).get('/api/fotos/search/status').set('Cookie', admin.cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.available, false);
  });

  it('POST /search liefert 404 mit deutschem Hinweis auf den Websync', async () => {
    const res = await request(app)
      .post('/api/fotos/search')
      .set('Cookie', admin.cookie)
      .send({ q: 'sonnenuntergang' });
    assert.equal(res.status, 404);
    assert.match(res.body.error, /Websync/);
  });
});

describe('Eingabe-Validierung', () => {
  it('lehnt fehlenden/leeren Suchtext ab', async () => {
    for (const body of [{}, { q: '' }, { q: '   ' }, { q: 42 }]) {
      const res = await request(app)
        .post('/api/fotos/search')
        .set('Cookie', admin.cookie)
        .send(body);
      assert.equal(res.status, 400);
    }
  });

  it('lehnt überlange Suchtexte ab (max. 300 Zeichen)', async () => {
    const res = await request(app)
      .post('/api/fotos/search')
      .set('Cookie', admin.cookie)
      .send({ q: 'x'.repeat(301) });
    assert.equal(res.status, 400);
  });
});

describe('mit Suchvektoren', () => {
  it('Status meldet available: true samt Modell und Anzahl', async () => {
    // 20 Vektoren: 15 nahe an [1,0,0,0] (absteigende Ähnlichkeit),
    // 5 orthogonal dazu — ids 200..219.
    const vectors = [];
    const ids = [];
    for (let k = 0; k < 15; k++) {
      const theta = (k * 2 * Math.PI) / 180; // 0°, 2°, …, 28°
      vectors.push([Math.cos(theta), Math.sin(theta), 0, 0]);
      ids.push(200 + k);
    }
    for (let k = 15; k < 20; k++) {
      vectors.push([0, 0, 1, 0]);
      ids.push(200 + k);
    }
    writeIndex(vectors, ids, MODEL_ID);

    const res = await request(app).get('/api/fotos/search/status').set('Cookie', admin.cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.available, true);
    assert.equal(res.body.count, 20);
    assert.equal(res.body.model, MODEL_ID);
  });

  it('rankt nach Skalarprodukt und schneidet den Schwanz per 0.55-Schwelle ab', async () => {
    embedderStub._variants = [[1, 0, 0, 0]];
    const res = await request(app)
      .post('/api/fotos/search')
      .set('Cookie', admin.cookie)
      .send({ q: 'Sonnenuntergang am See' });
    assert.equal(res.status, 200);
    // Die 15 ähnlichen Fotos (cos 0°..28° ≥ 0.88) bleiben, die 5 orthogonalen
    // (cos 0) liegen unter der relativen Schwelle 0 + (0.88…1)*0.55 → weg.
    assert.deepEqual(res.body.ids, Array.from({ length: 15 }, (_, k) => 200 + k));
    // Scores absteigend und nahe an den echten Kosinus-Werten
    // (Int8-Quantisierung kostet < 1 %).
    for (let k = 0; k < 15; k++) {
      const expected = Math.cos((k * 2 * Math.PI) / 180);
      assert.ok(Math.abs(res.body.scores[k] - expected) < 0.02,
        `Score ${res.body.scores[k]} weicht zu weit von ${expected} ab`);
      if (k > 0) assert.ok(res.body.scores[k] <= res.body.scores[k - 1]);
    }
    // Der Encoder wurde mit der Modell-ID aus index.json aufgerufen.
    assert.equal(embedderStub.lastModelId, MODEL_ID);
  });

  it('nimmt je Foto den besten Wert über mehrere Anfrage-Varianten', async () => {
    // Neuer, kleiner Index: je ein Vektor auf drei Achsen (ids 300-302).
    writeIndex([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]], [300, 301, 302], MODEL_ID);
    // Zwei Varianten (Original + "Übersetzung"): Achse 0 und Achse 1.
    embedderStub._variants = [[1, 0, 0, 0], [0, 1, 0, 0]];
    const res = await request(app)
      .post('/api/fotos/search')
      .set('Cookie', admin.cookie)
      .send({ q: 'Hund' });
    assert.equal(res.status, 200);
    // 300 und 301 punkten je über EINE Variante mit ~1, 302 mit ~0 —
    // unter 12 Ergebnissen wird nie beschnitten, also sind alle drei da.
    assert.equal(res.body.ids.length, 3);
    assert.deepEqual(res.body.ids.slice(0, 2).sort(), [300, 301]);
    assert.ok(res.body.scores[0] > 0.98 && res.body.scores[1] > 0.98);
    assert.equal(res.body.ids[2], 302);
    assert.ok(res.body.scores[2] < 0.05);
  });

  it('antwortet 503 mit deutschem Hinweis, solange das Modell lädt', async () => {
    embedderStub._mode = 'loading';
    const res = await request(app)
      .post('/api/fotos/search')
      .set('Cookie', admin.cookie)
      .send({ q: 'hund' });
    embedderStub._mode = 'ok';
    assert.equal(res.status, 503);
    assert.match(res.body.error, /geladen/);
  });

  it('meldet 500, wenn die Vektorlänge nicht zum Index passt', async () => {
    embedderStub._variants = [[1, 0, 0]]; // 3 statt 4 Dimensionen
    const res = await request(app)
      .post('/api/fotos/search')
      .set('Cookie', admin.cookie)
      .send({ q: 'hund' });
    embedderStub._variants = [[1, 0, 0, 0]];
    assert.equal(res.status, 500);
    assert.match(res.body.error, /Websync/);
  });

  it('lädt den Index nach einer Änderung auf der Platte neu (mtime-Cache)', async () => {
    embedderStub._variants = [[1, 0, 0, 0]];
    writeIndex([[1, 0, 0, 0]], [777], MODEL_ID);
    const res = await request(app)
      .post('/api/fotos/search')
      .set('Cookie', admin.cookie)
      .send({ q: 'hund' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.ids, [777]);
  });

  it('blockt Nicht-Admins (Status und Suche)', async () => {
    const s = await request(app).get('/api/fotos/search/status').set('Cookie', user.cookie);
    assert.equal(s.status, 403);
    const p = await request(app)
      .post('/api/fotos/search')
      .set('Cookie', user.cookie)
      .send({ q: 'hund' });
    assert.equal(p.status, 403);
  });
});
