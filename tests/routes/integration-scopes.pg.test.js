// ============================================================
// ZEPHYR-AUSBAU GEGEN ECHTES POSTGRESQL
// ============================================================
// Belegt, was der Mock nicht kann: Array-Spalte `scopes`, parallele
// App-Freigaben/Bestätigungen auf denselben Entwurf (bedingtes updateMany +
// Unique-Index), FK-Kaskade beim Löschen von Notizen, atomare Rotation.
// Läuft nur mit TEST_DATABASE_URL — Einrichtung siehe integration.pg.test.js.
// NIEMALS auf eine Produktivdatenbank zeigen lassen.
// ============================================================

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const request = require('supertest');

const DB_URL = process.env.TEST_DATABASE_URL;
process.env.INTEGRATION_RATE_AUTH_FAIL = '100000';
process.env.INTEGRATION_RATE_READ = '100000';
process.env.INTEGRATION_RATE_WRITE = '100000';

const ALL = ['finance.read', 'finance.write', 'finance.categories', 'finance.balance', 'reminders.read', 'reminders.write', 'notes.read', 'notes.write'];
let prisma, local, appApi, enc, auth, H, credId, sessionStore;

describe('Zephyr-Ausbau gegen echtes PostgreSQL', { skip: DB_URL ? false : 'TEST_DATABASE_URL nicht gesetzt' }, () => {
  before(async () => {
    if (/toolb0x\.eu|46\.225\./.test(DB_URL)) throw new Error('TEST_DATABASE_URL zeigt nicht auf eine Testdatenbank');
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    const prismaPath = require.resolve('../../src/utils/prisma');
    require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: prisma };
    enc = require('../../src/utils/encryption');
    sessionStore = require('../../src/utils/sessionStore');
    require('../helpers/authHelper'); // setzt JWT_SECRET
    local = require('../../src/integration/app').createIntegrationApp();
    const { createTestApp } = require('../helpers/testApp');
    appApi = createTestApp({ path: '/api/integrations', router: require('../../src/routes/integrations') });
  });

  after(async () => {
    if (prisma) await prisma.$disconnect();
    if (sessionStore) sessionStore.destroy();
  });

  beforeEach(async () => {
    for (const t of ['integrationWrite', 'integrationDraft', 'integrationCredential', 'expenseBooking', 'reminder', 'expense', 'income', 'monthInit', 'category', 'note']) {
      await prisma[t].deleteMany({});
    }
    await prisma.user.deleteMany({});
    const key = enc.generateEncryptionKey();
    const user = await prisma.user.create({
      data: { email: `pg-${crypto.randomBytes(4).toString('hex')}@example.test`, password: await bcrypt.hash('Synthetisch1!', 4), name: 'Synthetik', encryptedKey: 'x', role: 'admin' },
    });
    const jwt = require('jsonwebtoken');
    const sid = sessionStore.create(user.id, key);
    auth = { userId: user.id, key, cookie: `auth_token=${jwt.sign({ userId: user.id, sid }, process.env.JWT_SECRET, { expiresIn: '20m' })}` };
    const { createCredential } = require('../../src/integration/credentials');
    const c = await createCredential(prisma, { userId: user.id, encryptionKey: key, scopes: ALL });
    H = { Authorization: `Bearer ${c.token}` };
    credId = c.credential.id;
  });

  const draft = (action, params) => request(local).post('/v1/drafts').set(H).send({ action, params });
  const approve = d => request(appApi).post(`/api/integrations/approvals/${d.draftId}/approve`).set('Cookie', auth.cookie).send({ contentHash: d.contentHash });

  it('scopes werden als Array gespeichert und wirken', async () => {
    const row = await prisma.integrationCredential.findUnique({ where: { id: credId } });
    assert.deepEqual(row.scopes, ALL);
    await prisma.integrationCredential.update({ where: { id: credId }, data: { scopes: ['finance.read'] } });
    assert.equal((await request(local).get('/v1/notes').set(H)).status, 403);
  });

  it('parallele App-Freigaben + Zephyr-Bestätigung: genau eine Ausführung', async () => {
    const note = await prisma.note.create({ data: { userId: auth.userId, title: enc.encrypt('Weg', auth.key), content: enc.encrypt('', auth.key) } });
    const d = (await draft('note.delete', { id: note.id })).body;
    const confirm = request(local).post(`/v1/drafts/${d.draftId}/confirm`).set(H).set('Idempotency-Key', crypto.randomUUID()).send({ contentHash: d.contentHash });
    const res = await Promise.all([approve(d), approve(d), approve(d), confirm]);
    const codes = res.map(r => r.status);
    assert.equal(codes.filter(c => c === 200 && !res[codes.indexOf(c)].body.replayed).length >= 1, true);
    assert.equal(codes[3], 403, 'Zephyr darf App-Entwürfe nie selbst ausführen');
    assert.equal(await prisma.integrationWrite.count({ where: { draftId: d.draftId } }), 1);
    assert.equal(await prisma.note.count({ where: { id: note.id } }), 0);
  });

  it('Notiz löschen: Unterseiten per FK-Kaskade weg', async () => {
    const a = await prisma.note.create({ data: { userId: auth.userId, title: enc.encrypt('Projekt', auth.key), content: enc.encrypt('', auth.key) } });
    await prisma.note.create({ data: { userId: auth.userId, title: enc.encrypt('Unter', auth.key), content: enc.encrypt('', auth.key), parentId: a.id } });
    const d = (await draft('note.delete', { id: a.id })).body;
    assert.equal(d.summary.deletesSubpages, 1);
    assert.equal((await approve(d)).status, 200);
    assert.equal(await prisma.note.count({ where: { userId: auth.userId } }), 0);
  });

  it('Erinnerung anlegen: Fälligkeitstag bleibt als Kalenderdatum erhalten', async () => {
    const d = (await draft('reminder.create', { title: 'Kündigen', dueDate: '2026-12-31', daysBefore: 2 })).body;
    const c = await request(local).post(`/v1/drafts/${d.draftId}/confirm`).set(H).set('Idempotency-Key', crypto.randomUUID()).send({ contentHash: d.contentHash });
    assert.equal(c.status, 201);
    const list = await request(local).get('/v1/reminders').set(H);
    assert.equal(list.body.reminders[0].dueDate, '2026-12-31');
    assert.equal(list.body.reminders[0].alertDate, '2026-12-29');
  });

  it('Rotation ist atomar: genau ein aktiver Zugang danach', async () => {
    const r = await request(appApi).post(`/api/integrations/${credId}/rotate`).set('Cookie', auth.cookie).send({ password: 'Synthetisch1!' });
    assert.equal(r.status, 201);
    const active = await prisma.integrationCredential.findMany({ where: { userId: auth.userId, revokedAt: null } });
    assert.equal(active.length, 1);
    assert.deepEqual(active[0].scopes, ALL);
    assert.equal((await request(local).get('/v1/status').set(H)).status, 401);
  });
});
