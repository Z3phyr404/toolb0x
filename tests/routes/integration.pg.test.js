// ============================================================
// HERMES-INTEGRATION GEGEN ECHTES POSTGRESQL
// ============================================================
// Der Mock serialisiert Transaktionen nur. Hier laufen parallele Anfragen
// gegen eine echte Datenbank: Zeilensperren, bedingtes updateMany,
// Unique-Index für den Idempotency-Key und Advisory-Locks bei der
// Monats-Initialisierung werden so wirklich belegt.
//
// Läuft nur mit TEST_DATABASE_URL (synthetische Daten, wird geleert):
//   docker run -d --rm --name toolb0x-testdb -e POSTGRES_USER=testuser \
//     -e POSTGRES_PASSWORD=testpw -e POSTGRES_DB=toolb0xtest \
//     -p 127.0.0.1:55433:5432 postgres:16-alpine
//   export TEST_DATABASE_URL="postgresql://testuser:testpw@localhost:55433/toolb0xtest?schema=public"
//   DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy
//   npm run test:pg   (nacheinander — beide PG-Dateien leeren dieselbe DB)
// NIEMALS auf eine Produktivdatenbank zeigen lassen.
// ============================================================

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');

const DB_URL = process.env.TEST_DATABASE_URL;

process.env.INTEGRATION_RATE_AUTH_FAIL = '100000';
process.env.INTEGRATION_RATE_READ = '100000';
process.env.INTEGRATION_RATE_WRITE = '100000';

let prisma, app, enc, user, key, cat, collector, auth;

describe('Integration gegen echtes PostgreSQL', { skip: DB_URL ? false : 'TEST_DATABASE_URL nicht gesetzt' }, () => {
  before(async () => {
    if (/toolb0x\.eu|46\.225\./.test(DB_URL)) throw new Error('TEST_DATABASE_URL zeigt nicht auf eine Testdatenbank');
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    const prismaPath = require.resolve('../../src/utils/prisma');
    require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: prisma };
    enc = require('../../src/utils/encryption');
    app = require('../../src/integration/app').createIntegrationApp();
  });

  after(async () => {
    if (prisma) await prisma.$disconnect();
    require('../../src/utils/sessionStore').destroy();
  });

  beforeEach(async () => {
    await prisma.integrationWrite.deleteMany({});
    await prisma.integrationDraft.deleteMany({});
    await prisma.integrationCredential.deleteMany({});
    await prisma.expenseBooking.deleteMany({});
    await prisma.reminder.deleteMany({});
    await prisma.expense.deleteMany({});
    await prisma.income.deleteMany({});
    await prisma.monthInit.deleteMany({});
    await prisma.category.deleteMany({});
    await prisma.user.deleteMany({});

    key = enc.generateEncryptionKey();
    user = await prisma.user.create({
      data: {
        email: `pg-${crypto.randomBytes(4).toString('hex')}@example.test`,
        password: 'x', name: 'Synthetik', encryptedKey: 'x', budgetStartDay: 1,
      },
    });
    cat = await prisma.category.create({ data: { userId: user.id, name: enc.encrypt('Lebensmittel', key), color: enc.encrypt('#112233', key) } });
    collector = await prisma.expense.create({
      data: {
        userId: user.id, categoryId: cat.id, month: '2026-10', isCollector: true, isRecurring: true,
        name: enc.encrypt('Rewe', key), amount: enc.encrypt('0', key), plannedAmount: enc.encrypt('400', key),
      },
    });
    await prisma.monthInit.create({ data: { userId: user.id, month: '2026-10', type: 'expense' } });
    const { createCredential } = require('../../src/integration/credentials');
    const { token } = await createCredential(prisma, { userId: user.id, encryptionKey: key });
    auth = { Authorization: `Bearer ${token}` };
  });

  const draft = (action, params) => request(app).post('/v1/drafts').set(auth).send({ action, params });
  const confirm = (d, idem = crypto.randomUUID()) =>
    request(app).post(`/v1/drafts/${d.draftId}/confirm`).set(auth).set('Idempotency-Key', idem).send({ contentHash: d.contentHash });

  it('parallele Bestätigungen desselben Entwurfs: genau ein Eintrag', async () => {
    const d = (await draft('expense.create', { name: 'Brot', amount: '2.40', categoryId: cat.id, date: '2026-10-11' })).body;
    const same = crypto.randomUUID();
    const res = await Promise.all([confirm(d, same), confirm(d, same), confirm(d), confirm(d), confirm(d), confirm(d, same)]);
    const codes = res.map(r => r.status);
    assert.equal(codes.filter(c => c === 201).length, 1, JSON.stringify(res.map(r => [r.status, r.body.error])));
    assert.ok(codes.every(c => [200, 201, 409].includes(c)), JSON.stringify(codes));
    const brot = (await prisma.expense.findMany({ where: { userId: user.id } })).filter(e => enc.decrypt(e.name, key) === 'Brot');
    assert.equal(brot.length, 1);
    assert.equal(await prisma.integrationWrite.count(), 1);
  });

  it('gleicher Idempotency-Key, anderer Inhalt: 409 (Unique-Index), nur ein Eintrag', async () => {
    const d1 = (await draft('expense.create', { name: 'A', amount: '1', categoryId: cat.id, date: '2026-10-01' })).body;
    const d2 = (await draft('expense.create', { name: 'B', amount: '2', categoryId: cat.id, date: '2026-10-01' })).body;
    const k = crypto.randomUUID();
    const [r1, r2] = await Promise.all([confirm(d1, k), confirm(d2, k)]);
    assert.deepEqual([r1.status, r2.status].sort(), [201, 409]);
    assert.equal(await prisma.expense.count({ where: { userId: user.id, isCollector: false } }), 1);
  });

  it('parallele Buchungen auf denselben Sammelposten: Summe exakt', async () => {
    const amounts = ['0.10', '0.20', '1.05', '19.99', '3.33', '7.01', '0.07', '12.00'];
    const drafts = [];
    for (const amount of amounts) {
      drafts.push((await draft('booking.create', { expenseId: collector.id, amount, date: '2026-10-05' })).body);
    }
    const res = await Promise.all(drafts.map(d => confirm(d)));
    assert.ok(res.every(r => r.status === 201), JSON.stringify(res.map(r => r.body)));
    const row = await prisma.expense.findUnique({ where: { id: collector.id } });
    const expected = amounts.reduce((s, a) => s + Math.round(parseFloat(a) * 100), 0) / 100;
    assert.equal(parseFloat(enc.decrypt(row.amount, key)), expected);
    assert.equal(await prisma.expenseBooking.count({ where: { expenseId: collector.id } }), amounts.length);
  });

  it('parallele Schreibvorgänge in einen nie geöffneten Monat: Auto-Kopie genau einmal', async () => {
    await prisma.expense.create({
      data: { userId: user.id, categoryId: cat.id, month: '2026-10', isRecurring: true, name: enc.encrypt('Miete', key), amount: enc.encrypt('800', key) },
    });
    const drafts = [];
    for (const name of ['X1', 'X2', 'X3', 'X4']) {
      drafts.push((await draft('expense.create', { name, amount: '1', categoryId: cat.id, date: '2026-11-02' })).body);
    }
    const res = await Promise.all(drafts.map(d => confirm(d)));
    assert.ok(res.every(r => r.status === 201), JSON.stringify(res.map(r => [r.status, r.body])));
    const nov = await prisma.expense.findMany({ where: { userId: user.id, month: '2026-11' } });
    const names = nov.map(e => enc.decrypt(e.name, key)).sort();
    assert.deepEqual(names, ['Miete', 'Rewe', 'X1', 'X2', 'X3', 'X4']);
    assert.equal(await prisma.monthInit.count({ where: { userId: user.id, month: '2026-11', type: 'expense' } }), 1);
  });

  it('Fehler in der Ausführung rollt alles zurück (Entwurf bleibt unverbraucht)', async () => {
    const d = (await draft('expense.create', { name: 'Kino', amount: '9', categoryId: cat.id, date: '2026-10-10' })).body;
    await prisma.expense.updateMany({ where: { id: collector.id }, data: {} });
    // Kategorie nach dem Entwurf löschen → Ausführung muss scheitern (TARGET_CHANGED)
    await prisma.expense.deleteMany({ where: { categoryId: cat.id } });
    await prisma.category.delete({ where: { id: cat.id } });
    const r = await confirm(d);
    assert.equal(r.status, 409);
    assert.equal(await prisma.integrationWrite.count(), 0);
    const row = await prisma.integrationDraft.findUnique({ where: { id: d.draftId } });
    assert.equal(row.usedAt, null, 'Beanspruchung muss mit zurückgerollt werden');
  });

  it('Löschen des Nutzers entfernt Zugänge per Kaskade', async () => {
    await prisma.expense.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    assert.equal(await prisma.integrationCredential.count(), 0);
  });
});
