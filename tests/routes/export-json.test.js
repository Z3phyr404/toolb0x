// ============================================================
// JSON-DATENEXPORT TESTS (DSGVO Art. 20)
// ============================================================
// Testet GET /api/export/json:
// - liefert maschinenlesbares JSON mit allen Bereichen
// - entschlüsselt korrekt (User-Key UND Tresor-Schlüssel)
// - Share-Blobs bleiben außen vor (clientseitig verschlüsselt)
// - Row-Level-Security: fremde Daten tauchen nicht auf
// ============================================================

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');

// --- Mock-Prisma injizieren BEVOR die Route geladen wird ---
const { createMockPrisma } = require('../helpers/mockPrisma');
const mockPrisma = createMockPrisma();
const prismaPath = require.resolve('../../src/utils/prisma');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: mockPrisma };

// --- Auth-Helper ---
const { createTestAuth, cleanupAuth } = require('../helpers/authHelper');
const {
  encrypt,
  generateEncryptionKey,
  generateUserKeypair,
  wrapKeyWithPublicKey,
} = require('../../src/utils/encryption');

// --- Route + Test-App ---
const exportRouter = require('../../src/routes/export');
const { createTestApp } = require('../helpers/testApp');
const app = createTestApp({ path: '/api/export', router: exportRouter });

let auth;

function resetStore() {
  for (const t of Object.keys(mockPrisma._store)) mockPrisma._store[t].length = 0;
}

describe('GET /api/export/json', () => {
  beforeEach(() => {
    resetStore();
    auth = createTestAuth(mockPrisma);
  });

  after(() => cleanupAuth());

  it('exportiert alle Bereiche als maschinenlesbares JSON', async () => {
    const key = auth.encryptionKey;
    const catId = crypto.randomUUID();

    mockPrisma._store.categories.push({
      id: catId, userId: auth.userId, name: encrypt('Wohnen', key), color: encrypt('#FF9500', key), createdAt: new Date(),
    });
    mockPrisma._store.expenses.push({
      id: crypto.randomUUID(), userId: auth.userId, categoryId: catId,
      name: encrypt('Miete', key), amount: encrypt('640.50', key),
      tags: encrypt(JSON.stringify(['Fix']), key), month: '2026-07', isRecurring: true, createdAt: new Date(),
    });
    mockPrisma._store.incomes.push({
      id: crypto.randomUUID(), userId: auth.userId,
      name: encrypt('Gehalt', key), amount: encrypt('3000', key), month: '2026-07', isRecurring: true, createdAt: new Date(),
    });
    mockPrisma._store.notes.push({
      id: crypto.randomUUID(), userId: auth.userId,
      title: encrypt('Meine Notiz', key), content: encrypt('<p>Inhalt</p>', key),
      icon: '📝', isPinned: false, isArchived: false, createdAt: new Date(), updatedAt: new Date(),
    });
    mockPrisma._store.storedPasswords.push({
      id: crypto.randomUUID(), userId: auth.userId, vaultId: null,
      name: encrypt('Netflix', key), username: encrypt('a@b.de', key), password: encrypt('Geheim1!', key),
      website: encrypt('https://netflix.com', key), notes: encrypt('', key), createdAt: new Date(),
    });

    const res = await request(app).get('/api/export/json').set('Cookie', auth.cookie);

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.match(res.headers['content-disposition'], /attachment; filename="toolb0x-export-\d{4}-\d{2}-\d{2}\.json"/);

    const d = JSON.parse(res.text);
    assert.equal(d.kategorien[0].name, 'Wohnen');
    assert.equal(d.ausgaben[0].name, 'Miete');
    assert.equal(d.ausgaben[0].betrag, '640.50');
    assert.deepEqual(d.ausgaben[0].tags, ['Fix']);
    assert.equal(d.ausgaben[0].kategorie, 'Wohnen');
    assert.equal(d.einnahmen[0].name, 'Gehalt');
    assert.equal(d.notizen[0].titel, 'Meine Notiz');
    assert.equal(d.notizen[0].inhaltHtml, '<p>Inhalt</p>');
    assert.equal(d.passwoerter[0].passwort, 'Geheim1!');
    assert.ok(d.exportiertAm, 'Export-Zeitstempel fehlt');
  });

  it('entschlüsselt auch Tresor-Einträge (Tresor-Schlüssel statt User-Key)', async () => {
    const key = auth.encryptionKey;

    // Nutzer braucht ein Keypair, damit der Tresor-Schlüssel entpackt werden kann
    const keypair = generateUserKeypair();
    const nutzer = mockPrisma._store.users.find(u => u.id === auth.userId);
    nutzer.publicKey = keypair.publicKey;
    nutzer.encryptedPrivateKey = encrypt(keypair.privateKey, key);

    const vaultKey = generateEncryptionKey();
    const vaultId = crypto.randomUUID();
    mockPrisma._store.vaults.push({
      id: vaultId, ownerId: auth.userId, name: encrypt('Team-Tresor', vaultKey), createdAt: new Date(),
    });
    mockPrisma._store.vaultMembers.push({
      id: crypto.randomUUID(), vaultId, userId: auth.userId, role: 'owner',
      wrappedKey: wrapKeyWithPublicKey(keypair.publicKey, vaultKey),
    });
    mockPrisma._store.storedPasswords.push({
      id: crypto.randomUUID(), userId: auth.userId, vaultId,
      name: encrypt('Team-Zugang', vaultKey), username: encrypt('team', vaultKey),
      password: encrypt('TeamGeheim9!', vaultKey), website: encrypt('', vaultKey),
      notes: encrypt('', vaultKey), createdAt: new Date(),
    });

    const res = await request(app).get('/api/export/json').set('Cookie', auth.cookie);
    assert.equal(res.status, 200);

    const d = JSON.parse(res.text);
    assert.equal(d.tresore.length, 1);
    assert.equal(d.tresore[0].name, 'Team-Tresor');
    assert.equal(d.tresore[0].binIchEigentuemer, true);
    const eintrag = d.passwoerter.find(p => p.tresorId === vaultId);
    assert.ok(eintrag, 'Tresor-Eintrag fehlt im Export');
    assert.equal(eintrag.passwort, 'TeamGeheim9!', 'Tresor-Eintrag wurde nicht entschlüsselt');
  });

  it('liefert bei geteilten Links nur Metadaten, keinen Blob', async () => {
    mockPrisma._store.shares.push({
      id: crypto.randomUUID(), userId: auth.userId, token: 'abc123',
      blob: 'clientseitig:verschluesselt:xyz', hasPin: true, maxViews: 1, viewCount: 0,
      expiresAt: new Date(Date.now() + 3600000), createdAt: new Date(),
    });

    const res = await request(app).get('/api/export/json').set('Cookie', auth.cookie);
    const d = JSON.parse(res.text);

    assert.equal(d.geteilteLinks.length, 1);
    assert.equal(d.geteilteLinks[0].token, 'abc123');
    assert.equal(d.geteilteLinks[0].pinGeschuetzt, true);
    assert.equal(d.geteilteLinks[0].blob, undefined, 'Blob darf nicht im Export stehen');
    assert.equal(res.text.includes('clientseitig:verschluesselt'), false, 'Blob-Inhalt ist durchgesickert');
  });

  it('exportiert keine fremden Daten (Row-Level-Security)', async () => {
    const fremdId = crypto.randomUUID();
    const fremdKey = generateEncryptionKey();
    mockPrisma._store.notes.push({
      id: crypto.randomUUID(), userId: fremdId,
      title: encrypt('Fremde Notiz', fremdKey), content: encrypt('<p>geheim</p>', fremdKey),
      isPinned: false, isArchived: false, createdAt: new Date(), updatedAt: new Date(),
    });

    const res = await request(app).get('/api/export/json').set('Cookie', auth.cookie);
    const d = JSON.parse(res.text);

    assert.equal(d.notizen.length, 0, 'Fremde Notiz im Export!');
  });

  it('verlangt Authentifizierung', async () => {
    const res = await request(app).get('/api/export/json');
    assert.equal(res.status, 401);
  });
});
