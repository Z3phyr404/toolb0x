// ============================================================
// ADMIN-RESET GEGEN ECHTES POSTGRESQL
// ============================================================
// Die übrigen Reset-Tests laufen gegen den In-Memory-Mock. Der kann
// Transaktionen nur nachstellen. Hier läuft derselbe Code gegen eine echte
// Datenbank, damit die Aussagen zu Nebenläufigkeit, Rollback und
// FK-Kaskaden wirklich belegt sind.
//
// Läuft nur mit gesetzter TEST_DATABASE_URL, sonst wird übersprungen:
//
//   docker run -d --name toolb0x-pgtest -e POSTGRES_PASSWORD=testpw \
//     -e POSTGRES_USER=testuser -e POSTGRES_DB=toolb0xtest \
//     -p 55433:5432 postgres:16-alpine
//   export TEST_DATABASE_URL="postgresql://testuser:testpw@localhost:55433/toolb0xtest?schema=public"
//   DATABASE_URL="$TEST_DATABASE_URL" npx prisma db push
//   npm run test:pg
//
// Die Datenbank wird vor jedem Test geleert. Niemals auf eine
// Produktivdatenbank zeigen lassen.
// ============================================================

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');

const DB_URL = process.env.TEST_DATABASE_URL;
const DEFAULT_CATEGORY_COUNT = 9;

let prisma, app, realTransaction, cleanupAuth;

describe('Admin-Reset gegen echtes PostgreSQL', { skip: DB_URL ? false : 'TEST_DATABASE_URL nicht gesetzt' }, () => {
  async function wipe() {
    await prisma.expenseBooking.deleteMany({});
    await prisma.expense.deleteMany({});
    await prisma.income.deleteMany({});
    await prisma.monthInit.deleteMany({});
    await prisma.reminder.deleteMany({});
    await prisma.category.deleteMany({});
    await prisma.note.deleteMany({});
    await prisma.storedPassword.deleteMany({});
    await prisma.vaultMember.deleteMany({});
    await prisma.vault.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  }

  before(async () => {
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    realTransaction = prisma.$transaction.bind(prisma);

    // Echten Client an der Stelle des Moduls einhängen, BEVOR die Route lädt.
    const prismaPath = require.resolve('../../src/utils/prisma');
    require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: prisma };

    ({ cleanupAuth } = require('../helpers/authHelper')); // setzt JWT_SECRET
    const authRouter = require('../../src/routes/auth');
    const { createTestApp } = require('../helpers/testApp');
    app = createTestApp({ path: '/api/auth', router: authRouter });
    await prisma.$connect();
  });

  after(async () => {
    if (prisma) {
      prisma.$transaction = realTransaction;
      await wipe();
      await prisma.$disconnect();
    }
    // Session-Timer beenden, sonst endet der Testprozess nicht.
    if (cleanupAuth) cleanupAuth();
  });

  beforeEach(async () => {
    prisma.$transaction = realTransaction;
    await wipe();
  });

  async function registerUser(email = 'pg-reset@test.de', password = 'AltesPw1234') {
    const res = await request(app).post('/api/auth/register')
      .send({ email, password, name: 'PG Reset' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const user = await prisma.user.findUnique({ where: { email } });
    return { user, password, recoveryCode: res.body.recoveryCode };
  }

  /** Legt einen Admin-Reset-Token an, wie es die Admin-Route tut. */
  async function giveResetToken(userId, minutes = 60) {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await prisma.user.update({
      where: { id: userId },
      data: { resetToken: tokenHash, resetTokenExpires: new Date(Date.now() + minutes * 60000) },
    });
    return token;
  }

  /** Nutzdaten inklusive einer Zeile, die nur per FK-Kaskade verschwinden kann. */
  async function seedData(userId) {
    const category = await prisma.category.create({ data: { name: 'enc', color: 'enc', userId } });
    const expense = await prisma.expense.create({
      data: { name: 'enc', amount: 'enc', categoryId: category.id, userId, month: '2026-09' },
    });
    await prisma.expenseBooking.create({ data: { amount: 'enc', expenseId: expense.id, userId } });
    return { category, expense };
  }

  it('löst den Token genau einmal ein und legt die Standardkategorien einmal an', async () => {
    const { user } = await registerUser();
    await seedData(user.id);
    const token = await giveResetToken(user.id);

    const first = await request(app).post('/api/auth/reset-with-token')
      .send({ token, newPassword: 'NeuesPw12345' });
    assert.equal(first.status, 200, JSON.stringify(first.body));

    const second = await request(app).post('/api/auth/reset-with-token')
      .send({ token, newPassword: 'NochEins12345' });
    assert.equal(second.status, 401);

    const nachher = await prisma.user.findUnique({ where: { id: user.id } });
    assert.equal(nachher.resetToken, null);
    assert.equal(nachher.resetTokenExpires, null);
    assert.notEqual(nachher.encryptedKey, user.encryptedKey);
    assert.equal(await prisma.expense.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.category.count({ where: { userId: user.id } }), DEFAULT_CATEGORY_COUNT);
  });

  it('löscht abhängige Buchungen über die FK-Kaskade der Datenbank mit', async () => {
    const { user } = await registerUser();
    await seedData(user.id);
    assert.equal(await prisma.expenseBooking.count({ where: { userId: user.id } }), 1);

    const token = await giveResetToken(user.id);
    const res = await request(app).post('/api/auth/reset-with-token')
      .send({ token, newPassword: 'NeuesPw12345' });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    // ExpenseBooking löscht die Route nicht selbst. Nur die echte Datenbank
    // räumt sie über ON DELETE CASCADE ab.
    assert.equal(await prisma.expenseBooking.count({ where: { userId: user.id } }), 0);
  });

  it('lässt bei zwei gleichzeitigen Einlösungen genau eine gewinnen', async () => {
    const { user } = await registerUser();
    await seedData(user.id);
    const token = await giveResetToken(user.id);

    const results = await Promise.all([
      request(app).post('/api/auth/reset-with-token').send({ token, newPassword: 'ParallelEins1' }),
      request(app).post('/api/auth/reset-with-token').send({ token, newPassword: 'ParallelZwei1' }),
    ]);
    const codes = results.map(r => r.status).sort();
    assert.deepEqual(codes, [200, 401], 'genau eine Einlösung darf gewinnen: ' +
      JSON.stringify(results.map(r => [r.status, r.body])));

    // Nicht doppelt angelegt, nicht doppelt gelöscht.
    assert.equal(await prisma.category.count({ where: { userId: user.id } }), DEFAULT_CATEGORY_COUNT);
    const nachher = await prisma.user.findUnique({ where: { id: user.id } });
    assert.equal(nachher.resetToken, null);
  });

  it('entwertet einen offenen Reset-Token beim Passwortwechsel', async () => {
    const { user, password } = await registerUser();
    const token = await giveResetToken(user.id);

    const agent = request.agent(app);
    const login = await agent.post('/api/auth/login').send({ email: user.email, password });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const change = await agent.put('/api/auth/password')
      .send({ currentPassword: password, newPassword: 'GanzNeuesPw12' });
    assert.equal(change.status, 200, JSON.stringify(change.body));

    const res = await request(app).post('/api/auth/reset-with-token')
      .send({ token, newPassword: 'ZuSpaet123456' });
    assert.equal(res.status, 401);
  });

  it('entwertet einen offenen Reset-Token beim neuen Recovery-Code', async () => {
    const { user, password } = await registerUser();
    const token = await giveResetToken(user.id);

    const agent = request.agent(app);
    const login = await agent.post('/api/auth/login').send({ email: user.email, password });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const rotate = await agent.post('/api/auth/recovery-code').send({ currentPassword: password });
    assert.equal(rotate.status, 200, JSON.stringify(rotate.body));

    const res = await request(app).post('/api/auth/reset-with-token')
      .send({ token, newPassword: 'ZuSpaet123456' });
    assert.equal(res.status, 401);
  });

  it('rollt die Löschungen zurück, wenn die Transaktion scheitert', async () => {
    const { user } = await registerUser();
    const { expense } = await seedData(user.id);
    const token = await giveResetToken(user.id);

    // Fehler ganz am Ende der Transaktion, nach allen Löschungen.
    prisma.$transaction = (arg, opts) => {
      if (typeof arg !== 'function') return realTransaction(arg, opts);
      return realTransaction(async (tx) => {
        const guarded = new Proxy(tx, {
          get(target, prop) {
            if (prop === 'category') {
              return new Proxy(target.category, {
                get(catTarget, catProp) {
                  if (catProp === 'createMany') {
                    return async () => { throw new Error('absichtlicher Testfehler'); };
                  }
                  const value = Reflect.get(catTarget, catProp);
                  return typeof value === 'function' ? value.bind(catTarget) : value;
                },
              });
            }
            const value = Reflect.get(target, prop);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return arg(guarded);
      }, opts);
    };

    const res = await request(app).post('/api/auth/reset-with-token')
      .send({ token, newPassword: 'NeuesPw12345' });
    assert.equal(res.status, 500);

    // Nichts darf verloren sein, der Token bleibt gültig.
    assert.equal(await prisma.expense.count({ where: { id: expense.id } }), 1);
    assert.equal(await prisma.expenseBooking.count({ where: { userId: user.id } }), 1);
    const nachher = await prisma.user.findUnique({ where: { id: user.id } });
    assert.notEqual(nachher.resetToken, null);
    assert.equal(nachher.encryptedKey, user.encryptedKey);
  });

  it('bleibt mit vielen Datensätzen im Prisma-Zeitlimit der Transaktion', async () => {
    const { user } = await registerUser();
    const { category } = await seedData(user.id);
    const rows = Array.from({ length: 5000 }, () => ({
      name: 'enc', amount: 'enc', categoryId: category.id, userId: user.id, month: '2026-09',
    }));
    await prisma.expense.createMany({ data: rows });
    const token = await giveResetToken(user.id);

    const started = Date.now();
    const res = await request(app).post('/api/auth/reset-with-token')
      .send({ token, newPassword: 'NeuesPw12345' });
    const ms = Date.now() - started;
    // Prisma bricht interaktive Transaktionen standardmäßig nach 5 s ab.
    assert.equal(res.status, 200, `Reset nach ${ms} ms fehlgeschlagen: ${JSON.stringify(res.body)}`);
    console.log(`    Reset mit ${rows.length + 1} Ausgaben: ${ms} ms`);
    assert.equal(await prisma.expense.count({ where: { userId: user.id } }), 0);
  });
});
