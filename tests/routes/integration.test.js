// ============================================================
// HERMES-INTEGRATION — Route-Tests (Mock-Prisma, synthetische Daten)
// ============================================================
// Prüft den lokalen Integrations-Listener (src/integration/app.js):
// Authentifizierung per Dauer-Token, Lesen ohne Nebenwirkungen,
// Entwurf → Bestätigung → Speichern, Idempotenz, centgenaue Beträge,
// Perioden, Fremdzugriffe, Widerruf und dass keine Secrets in Antworten
// oder Logs landen.
// ============================================================

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');

// --- Log-Mitschnitt: alles, was die App loggt, wird am Ende auf Secrets geprüft
const logs = [];
for (const level of ['log', 'error', 'warn', 'info']) {
  const orig = console[level];
  console[level] = (...args) => { logs.push(args.map(String).join(' ')); if (process.env.TEST_VERBOSE) orig(...args); };
}

// Rate-Limits für die Testflut hochsetzen (eigene Tests prüfen die Limits nicht)
process.env.INTEGRATION_RATE_AUTH_FAIL = '100000';
process.env.INTEGRATION_RATE_READ = '100000';
process.env.INTEGRATION_RATE_WRITE = '100000';

const { createMockPrisma } = require('../helpers/mockPrisma');
const mockPrisma = createMockPrisma();
const prismaPath = require.resolve('../../src/utils/prisma');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: mockPrisma };

const { encrypt, decrypt, generateEncryptionKey } = require('../../src/utils/encryption');
const { createCredential } = require('../../src/integration/credentials');
const { createIntegrationApp } = require('../../src/integration/app');

const app = createIntegrationApp();
const S = mockPrisma._store;

let user, other, token, auth, catFood, catOther, collector, otherCollector, issuedTokens;

function reset() {
  for (const t of Object.keys(S)) S[t].length = 0;
}

function addUser(opts = {}) {
  const u = {
    id: crypto.randomUUID(),
    email: `u-${crypto.randomBytes(3).toString('hex')}@example.test`,
    name: 'Synthetik',
    role: 'user',
    suspended: false,
    budgetStartDay: opts.budgetStartDay || 1,
    createdAt: new Date(),
  };
  S.users.push(u);
  return { ...u, key: generateEncryptionKey() };
}

function addCategory(u, name) {
  const c = { id: crypto.randomUUID(), userId: u.id, name: encrypt(name, u.key), color: encrypt('#123456', u.key), createdAt: new Date() };
  S.categories.push(c);
  return c;
}

function addExpense(u, data) {
  const e = {
    id: crypto.randomUUID(), userId: u.id, createdAt: new Date(), updatedAt: new Date(),
    name: encrypt(data.name, u.key), amount: encrypt(data.amount, u.key), tags: '',
    categoryId: data.categoryId, month: data.month, spentOn: data.spentOn ?? null,
    isRecurring: data.isRecurring ?? false, isCollector: data.isCollector ?? false,
    plannedAmount: data.plannedAmount ? encrypt(data.plannedAmount, u.key) : null,
  };
  S.expenses.push(e);
  return e;
}

async function setup(opts = {}) {
  reset();
  issuedTokens = [];
  user = addUser(opts);
  other = addUser();
  catFood = addCategory(user, 'Lebensmittel');
  catOther = addCategory(other, 'Fremd');
  collector = addExpense(user, { name: 'Rewe', amount: '0', plannedAmount: '400', isCollector: true, isRecurring: true, categoryId: catFood.id, month: '2026-10' });
  otherCollector = addExpense(other, { name: 'Fremdposten', amount: '0', plannedAmount: '100', isCollector: true, categoryId: catOther.id, month: '2026-10' });
  S.monthInits.push({ id: crypto.randomUUID(), userId: user.id, month: '2026-10', type: 'expense' });
  const created = await createCredential(mockPrisma, { userId: user.id, encryptionKey: user.key, name: 'Hermes' });
  token = created.token;
  issuedTokens.push(token);
  auth = { Authorization: `Bearer ${token}` };
}

const draft = (action, params, headers = auth) =>
  request(app).post('/v1/drafts').set(headers).send({ action, params });

const confirm = (d, idem = crypto.randomUUID(), headers = auth, hash = d.contentHash) =>
  request(app).post(`/v1/drafts/${d.draftId}/confirm`).set(headers).set('Idempotency-Key', idem).send({ contentHash: hash });

async function draftOk(action, params) {
  const res = await draft(action, params);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const snapshot = () => JSON.stringify(Object.fromEntries(
  Object.entries(S).filter(([t]) => !['integrationCredentials'].includes(t)),
));

after(() => {
  require('../../src/utils/sessionStore').destroy();
});

// ------------------------------------------------------------
describe('Integration — Authentifizierung', () => {
  beforeEach(() => setup());

  it('ohne Token: 401', async () => {
    const res = await request(app).get('/v1/categories');
    assert.equal(res.status, 401);
  });

  it('kaputter Token: 401', async () => {
    for (const bad of ['Bearer x', 'Bearer tbxi_abc', `Bearer ${token}x`, `Basic ${token}`, `Bearer ${token.replace(/\.(.)/, '.A$1').slice(0, -1)}`]) {
      const res = await request(app).get('/v1/categories').set('Authorization', bad);
      assert.equal(res.status, 401, bad);
    }
  });

  it('Token in der URL wird nicht akzeptiert', async () => {
    const res = await request(app).get(`/v1/categories?token=${encodeURIComponent(token)}`);
    assert.equal(res.status, 401);
  });

  it('widerrufener Token: 401, auch nach Neuanlage desselben Nutzers', async () => {
    const res1 = await request(app).post('/v1/revoke').set(auth);
    assert.equal(res1.status, 200);
    const cred = S.integrationCredentials[0];
    assert.equal(cred.wrappedKey, null, 'Schlüsselkopie muss gelöscht sein');
    assert.ok(cred.revokedAt);
    const res2 = await request(app).get('/v1/categories').set(auth);
    assert.equal(res2.status, 401);
  });

  it('fehlende/manipulierte Schlüsselkopie: 401, kein Rückgriff', async () => {
    const cred = S.integrationCredentials[0];
    const [iv, tag, enc] = cred.wrappedKey.split(':');
    cred.wrappedKey = [iv, tag, Buffer.from('x'.repeat(32)).toString('base64')].join(':');
    const res = await request(app).get('/v1/categories').set(auth);
    assert.equal(res.status, 401);
    cred.wrappedKey = [iv, tag, enc].join(':');
    assert.equal((await request(app).get('/v1/categories').set(auth)).status, 200);
  });

  it('gesperrter Nutzer: 403', async () => {
    S.users.find(u => u.id === user.id).suspended = true;
    const res = await request(app).get('/v1/categories').set(auth);
    assert.equal(res.status, 403);
  });

  it('Anfragen über einen Proxy (X-Forwarded-For) werden abgewiesen', async () => {
    for (const h of ['X-Forwarded-For', 'X-Real-IP', 'Forwarded']) {
      const res = await request(app).get('/v1/categories').set(auth).set(h, '203.0.113.7');
      assert.equal(res.status, 403, h);
    }
  });

  it('nur Finanzbereich: andere App-Bereiche existieren hier nicht', async () => {
    for (const p of ['/api/passwords', '/api/notes', '/api/export/json', '/api/admin/users', '/api/auth/me', '/v1/passwords', '/v1/users']) {
      const res = await request(app).get(p).set(auth);
      assert.equal(res.status, 404, p);
    }
  });

  it('direkte Änderungs-/Lösch-Verben gibt es nicht (nur über Entwürfe)', async () => {
    assert.equal((await request(app).put(`/v1/expenses/${collector.id}`).set(auth).send({})).status, 404);
    assert.equal((await request(app).delete(`/v1/expenses/${collector.id}`).set(auth)).status, 404);
    assert.equal((await request(app).post('/v1/expenses').set(auth).send({})).status, 404);
  });
});

// ------------------------------------------------------------
describe('Integration — Lesen ohne Nebenwirkungen', () => {
  beforeEach(() => setup());

  it('Kategorien: nur eigene, nur id + name', async () => {
    const res = await request(app).get('/v1/categories').set(auth);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.categories, [{ id: catFood.id, name: 'Lebensmittel' }]);
  });

  it('Ausgaben eines nie geöffneten Monats: leer + initialized=false, KEINE Kopie, kein MonthInit', async () => {
    const vorher = snapshot();
    const res = await request(app).get('/v1/expenses?month=2026-11').set(auth);
    assert.equal(res.status, 200);
    assert.equal(res.body.initialized, false);
    assert.deepEqual(res.body.expenses, []);
    assert.equal(snapshot(), vorher, 'Lesen darf nichts schreiben');
  });

  it('Ausgaben, Einnahmen, Übersicht, Verlauf, Status lesen ändert nichts', async () => {
    const vorher = snapshot();
    for (const p of ['/v1/status', '/v1/expenses?month=2026-10', '/v1/income?month=2026-10', '/v1/summary?month=2026-10', '/v1/history?months=3&month=2026-10', '/v1/writes', '/v1/categories']) {
      const res = await request(app).get(p).set(auth);
      assert.equal(res.status, 200, p + ' ' + JSON.stringify(res.body));
    }
    assert.equal(snapshot(), vorher);
  });

  it('Ausgabenliste enthält nur eigene Einträge, entschlüsselt', async () => {
    const res = await request(app).get('/v1/expenses?month=2026-10').set(auth);
    assert.equal(res.body.expenses.length, 1);
    assert.equal(res.body.expenses[0].name, 'Rewe');
    assert.equal(res.body.expenses[0].isCollector, true);
    assert.equal(res.body.expenses[0].userId, undefined, 'keine internen Felder');
  });

  it('ungültiger Monat: 400', async () => {
    const res = await request(app).get('/v1/expenses?month=2026-13').set(auth);
    assert.equal(res.status, 400);
  });
});

// ------------------------------------------------------------
describe('Integration — Ausgabe anlegen (Entwurf → Bestätigung)', () => {
  beforeEach(() => setup());

  it('gültige Einzelausgabe: einmalig, centgenau, verschlüsselt, zurückgelesen', async () => {
    const d = await draftOk('expense.create', { name: 'Bäcker', amount: '3,40', categoryId: catFood.id, date: '2026-10-11' });
    assert.equal(d.summary.amount, '3.40');
    assert.equal(d.summary.month, '2026-10');
    assert.equal(d.summary.isRecurring, false);
    assert.equal(S.expenses.length, 2, 'Entwurf schreibt noch nichts');

    const res = await confirm(d);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.entry.name, 'Bäcker');
    assert.equal(res.body.entry.amount, '3.40');
    assert.equal(res.body.entry.isRecurring, false);

    const row = S.expenses.find(e => e.id === res.body.targetId);
    assert.notEqual(row.name, 'Bäcker', 'muss verschlüsselt sein');
    assert.equal(decrypt(row.amount, user.key), '3.40');
    assert.equal(row.isRecurring, false);
    assert.equal(row.spentOn, '2026-10-11');
  });

  it('Einzelkauf wird NICHT in bereits geöffnete Folgemonate kopiert', async () => {
    S.monthInits.push({ id: crypto.randomUUID(), userId: user.id, month: '2026-11', type: 'expense' });
    S.monthInits.push({ id: crypto.randomUUID(), userId: user.id, month: '2026-12', type: 'expense' });
    const d = await draftOk('expense.create', { name: 'Kino', amount: '12', categoryId: catFood.id, date: '2026-10-03' });
    assert.equal((await confirm(d)).status, 201);
    const kino = S.expenses.filter(e => decrypt(e.name, user.key) === 'Kino');
    assert.equal(kino.length, 1);
  });

  it('wiederkehrend nur auf ausdrücklichen Wunsch — dann wie in der App kopiert', async () => {
    S.monthInits.push({ id: crypto.randomUUID(), userId: user.id, month: '2026-11', type: 'expense' });
    const d = await draftOk('expense.create', { name: 'Abo', amount: '9.99', categoryId: catFood.id, date: '2026-10-05', isRecurring: true });
    assert.equal(d.summary.isRecurring, true);
    assert.equal((await confirm(d)).status, 201);
    const abo = S.expenses.filter(e => e.userId === user.id && decrypt(e.name, user.key) === 'Abo');
    assert.deepEqual(abo.map(e => e.month).sort(), ['2026-10', '2026-11']);
  });

  it('Schreiben in nie geöffneten Monat initialisiert ihn vorher (Miete fehlt nicht)', async () => {
    addExpense(user, { name: 'Miete', amount: '800', categoryId: catFood.id, month: '2026-10', isRecurring: true, spentOn: '2026-10-01' });
    const d = await draftOk('expense.create', { name: 'Brot', amount: '2.10', categoryId: catFood.id, date: '2026-11-01' });
    assert.equal((await confirm(d)).status, 201);
    const nov = S.expenses.filter(e => e.userId === user.id && e.month === '2026-11').map(e => decrypt(e.name, user.key)).sort();
    assert.deepEqual(nov, ['Brot', 'Miete', 'Rewe']);
    assert.ok(S.monthInits.some(m => m.month === '2026-11' && m.type === 'expense'));
  });

  it('fehlende Angaben werden nicht geraten', async () => {
    for (const [params, feld] of [
      [{ amount: '1', categoryId: catFood.id, date: '2026-10-01' }, 'name'],
      [{ name: 'X', categoryId: catFood.id, date: '2026-10-01' }, 'amount'],
      [{ name: 'X', amount: '1', date: '2026-10-01' }, 'categoryId'],
      [{ name: 'X', amount: '1', categoryId: catFood.id }, 'date'],
    ]) {
      const res = await draft('expense.create', params);
      assert.equal(res.status, 400, feld);
      assert.equal(res.body.error, 'VALIDATION');
    }
  });

  it('unbekannte Felder (z. B. userId) werden abgelehnt', async () => {
    const res = await draft('expense.create', { name: 'X', amount: '1', categoryId: catFood.id, date: '2026-10-01', userId: other.id });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.body), /userId/);
    const res2 = await request(app).post('/v1/drafts').set(auth).send({ action: 'expense.create', params: {}, userId: other.id });
    assert.equal(res2.status, 400);
  });

  it('unbekannte Aktion: 400', async () => {
    const res = await draft('password.read', { id: catFood.id });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'UNKNOWN_ACTION');
  });

  it('Beträge: nur eindeutige Cent-Werte', async () => {
    for (const bad of ['0', '0,00', '-1', '12.345', '12abc', '1e3', '1.000,00', '', ' ', '1000000', 12.5, null, '12.']) {
      const res = await draft('expense.create', { name: 'X', amount: bad, categoryId: catFood.id, date: '2026-10-01' });
      assert.equal(res.status, 400, `Betrag ${JSON.stringify(bad)}`);
    }
    for (const [ok, norm] of [['12', '12.00'], ['12,5', '12.50'], ['0.01', '0.01'], ['999999.99', '999999.99']]) {
      const res = await draft('expense.create', { name: 'X', amount: ok, categoryId: catFood.id, date: '2026-10-01' });
      assert.equal(res.status, 201, ok);
      assert.equal(res.body.summary.amount, norm);
    }
  });

  it('Datum und Finanzmonat werden geprüft', async () => {
    const base = { name: 'X', amount: '1', categoryId: catFood.id };
    assert.equal((await draft('expense.create', { ...base, date: '2026-02-30' })).status, 400);
    assert.equal((await draft('expense.create', { ...base, date: '11.10.2026' })).status, 400);
    assert.equal((await draft('expense.create', { ...base, date: '2026-10-11', month: '2026-09' })).status, 400);
    assert.equal((await draft('expense.create', { ...base, date: '2026-10-11', month: '2026-10' })).status, 201);
  });

  it('verschobener Monatsanfang: Datum bestimmt die Periode', async () => {
    await setup({ budgetStartDay: 15 });
    const d1 = await draftOk('expense.create', { name: 'A', amount: '1', categoryId: catFood.id, date: '2026-10-05' });
    assert.equal(d1.summary.month, '2026-09');
    const d2 = await draftOk('expense.create', { name: 'B', amount: '1', categoryId: catFood.id, date: '2026-10-20' });
    assert.equal(d2.summary.month, '2026-10');
  });

  it('fremde oder falsche Kategorie: abgelehnt', async () => {
    const r1 = await draft('expense.create', { name: 'X', amount: '1', categoryId: catOther.id, date: '2026-10-01' });
    assert.equal(r1.status, 400);
    const r2 = await draft('expense.create', { name: 'X', amount: '1', categoryId: crypto.randomUUID(), date: '2026-10-01' });
    assert.equal(r2.status, 400);
  });
});

// ------------------------------------------------------------
describe('Integration — Bestätigung ist an den Entwurf gebunden', () => {
  beforeEach(() => setup());

  const params = () => ({ name: 'Tanken', amount: '55.10', categoryId: catFood.id, date: '2026-10-09' });

  it('ohne Bestätigung wird nichts gespeichert', async () => {
    await draftOk('expense.create', params());
    assert.equal(S.expenses.length, 2);
  });

  it('fehlender oder falscher Hash: abgelehnt, nichts gespeichert', async () => {
    const d = await draftOk('expense.create', params());
    const r1 = await request(app).post(`/v1/drafts/${d.draftId}/confirm`).set(auth).set('Idempotency-Key', crypto.randomUUID()).send({});
    assert.equal(r1.status, 400);
    const r2 = await confirm(d, crypto.randomUUID(), auth, 'a'.repeat(64));
    assert.equal(r2.status, 409);
    assert.equal(r2.body.error, 'HASH_MISMATCH');
    assert.equal(S.expenses.length, 2);
  });

  it('confirmed=true o. ä. ersetzt keine Bestätigung', async () => {
    const res = await draft('expense.create', { ...params(), confirmed: true });
    assert.equal(res.status, 400);
  });

  it('fehlender Idempotency-Key: 400', async () => {
    const d = await draftOk('expense.create', params());
    const res = await request(app).post(`/v1/drafts/${d.draftId}/confirm`).set(auth).send({ contentHash: d.contentHash });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'IDEMPOTENCY_KEY_REQUIRED');
  });

  it('abgelaufener Entwurf: 410', async () => {
    const d = await draftOk('expense.create', params());
    S.integrationDrafts[0].expiresAt = new Date(Date.now() - 1000);
    const res = await confirm(d);
    assert.equal(res.status, 410);
    assert.equal(S.expenses.length, 2);
  });

  it('wiederverwendeter Entwurf (anderer Key): 409, kein zweiter Eintrag', async () => {
    const d = await draftOk('expense.create', params());
    assert.equal((await confirm(d)).status, 201);
    const res = await confirm(d);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'DRAFT_USED');
    assert.equal(S.expenses.length, 3);
  });

  it('veränderter Inhalt nach Entwurf (manipulierte Payload): abgelehnt', async () => {
    const d = await draftOk('expense.create', params());
    const row = S.integrationDrafts[0];
    const p = JSON.parse(decrypt(row.payload, user.key));
    p.params.amount = '5510.00';
    row.payload = encrypt(JSON.stringify(p), user.key);
    const res = await confirm(d);
    assert.equal(res.status, 409);
    assert.equal(S.expenses.length, 2);
  });

  it('Entwurf eines anderen Zugangs ist nicht bestätigbar', async () => {
    const d = await draftOk('expense.create', params());
    const fremd = await createCredential(mockPrisma, { userId: other.id, encryptionKey: other.key, name: 'Fremd' });
    issuedTokens.push(fremd.token);
    const res = await confirm(d, crypto.randomUUID(), { Authorization: `Bearer ${fremd.token}` });
    assert.equal(res.status, 404);
  });

  it('gleicher Idempotency-Key + gleicher Entwurf: genau ein Eintrag, gleiche Antwort', async () => {
    const d = await draftOk('expense.create', params());
    const key = crypto.randomUUID();
    const r1 = await confirm(d, key);
    const r2 = await confirm(d, key);
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 200);
    assert.equal(r2.body.replayed, true);
    assert.equal(r2.body.targetId, r1.body.targetId);
    assert.equal(S.expenses.length, 3);
  });

  it('parallele Bestätigungen: höchstens ein Eintrag', async () => {
    const d = await draftOk('expense.create', params());
    const key = crypto.randomUUID();
    const results = await Promise.all([
      confirm(d, key), confirm(d, key), confirm(d), confirm(d), confirm(d, key),
    ]);
    assert.equal(results.filter(r => r.status === 201).length, 1);
    assert.ok(results.every(r => [200, 201, 409].includes(r.status)));
    assert.equal(S.expenses.length, 3);
    assert.equal(S.integrationWrites.length, 1);
  });

  it('gleicher Idempotency-Key mit anderem Inhalt: 409', async () => {
    const d1 = await draftOk('expense.create', params());
    const d2 = await draftOk('expense.create', { ...params(), amount: '60' });
    const key = crypto.randomUUID();
    assert.equal((await confirm(d1, key)).status, 201);
    const res = await confirm(d2, key);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'IDEMPOTENCY_CONFLICT');
    assert.equal(S.expenses.length, 3);
  });

  it('ungültiger Idempotency-Key: 400', async () => {
    const d = await draftOk('expense.create', params());
    const res = await confirm(d, 'kurz');
    assert.equal(res.status, 400);
  });
});

// ------------------------------------------------------------
describe('Integration — Sammelposten-Buchungen', () => {
  beforeEach(() => setup());

  it('Buchung + Summe centgenau (0,10 + 0,20 = 0,30)', async () => {
    for (const amount of ['0.10', '0,20']) {
      const d = await draftOk('booking.create', { expenseId: collector.id, amount, date: '2026-10-02' });
      const res = await confirm(d);
      assert.equal(res.status, 201, JSON.stringify(res.body));
    }
    assert.equal(decrypt(S.expenses.find(e => e.id === collector.id).amount, user.key), '0.3');
    const last = S.integrationWrites.at(-1);
    assert.equal(last.targetType, 'booking');
  });

  it('Summe stimmt mit Bestandsbuchungen und gibt total zurück', async () => {
    S.expenseBookings.push({ id: crypto.randomUUID(), expenseId: collector.id, userId: user.id, amount: encrypt('19.99', user.key), note: '', bookedOn: '2026-10-01', createdAt: new Date() });
    const d = await draftOk('booking.create', { expenseId: collector.id, amount: '0.02', date: '2026-10-02', note: 'Kaugummi' });
    const res = await confirm(d);
    assert.equal(res.body.total, 20.01);
    assert.equal(res.body.entry.note, 'Kaugummi');
  });

  it('fremder Sammelposten: 404', async () => {
    const res = await draft('booking.create', { expenseId: otherCollector.id, amount: '1', date: '2026-10-02' });
    assert.equal(res.status, 404);
  });

  it('normale Ausgabe ist kein Sammelposten: 400', async () => {
    const normal = addExpense(user, { name: 'Miete', amount: '800', categoryId: catFood.id, month: '2026-10' });
    const res = await draft('booking.create', { expenseId: normal.id, amount: '1', date: '2026-10-02' });
    assert.equal(res.status, 400);
  });

  it('Datum außerhalb der Periode des Postens: 400', async () => {
    const res = await draft('booking.create', { expenseId: collector.id, amount: '1', date: '2026-11-02' });
    assert.equal(res.status, 400);
  });

  it('Buchung ändern und löschen, Summe folgt', async () => {
    const d = await draftOk('booking.create', { expenseId: collector.id, amount: '10', date: '2026-10-02' });
    const created = await confirm(d);
    const bookingId = created.body.targetId;
    const u = await draftOk('booking.update', { expenseId: collector.id, bookingId, amount: '12.50' });
    assert.equal(u.summary.before.amount, '10.00');
    assert.equal(u.summary.after.amount, '12.50');
    assert.equal((await confirm(u)).body.total, 12.5);
    const del = await draftOk('booking.delete', { expenseId: collector.id, bookingId });
    assert.equal((await confirm(del)).body.total, 0);
    assert.equal(S.expenseBookings.length, 0);
  });
});

// ------------------------------------------------------------
describe('Integration — Ändern und Löschen', () => {
  beforeEach(() => setup());

  it('Ausgabe ändern (Teilangaben), Rest bleibt', async () => {
    const e = addExpense(user, { name: 'Strom', amount: '80', categoryId: catFood.id, month: '2026-10', spentOn: '2026-10-03' });
    const d = await draftOk('expense.update', { id: e.id, amount: '85.20' });
    assert.equal(d.summary.before.amount, '80.00');
    assert.equal(d.summary.after.name, 'Strom');
    const res = await confirm(d);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = S.expenses.find(x => x.id === e.id);
    assert.equal(decrypt(row.amount, user.key), '85.20');
    assert.equal(decrypt(row.name, user.key), 'Strom');
    assert.equal(row.spentOn, '2026-10-03');
  });

  it('in der App geändert nach dem Entwurf: 409, nichts überschrieben', async () => {
    const e = addExpense(user, { name: 'Strom', amount: '80', categoryId: catFood.id, month: '2026-10' });
    const d = await draftOk('expense.update', { id: e.id, amount: '85' });
    S.expenses.find(x => x.id === e.id).amount = encrypt('90', user.key); // Nutzer ändert in der App
    const res = await confirm(d);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'TARGET_CHANGED');
    assert.equal(decrypt(S.expenses.find(x => x.id === e.id).amount, user.key), '90');
  });

  it('Ausgabe löschen; wiederkehrende Auto-Kopien verschwinden mit', async () => {
    const e = addExpense(user, { name: 'Abo', amount: '5', categoryId: catFood.id, month: '2026-10', isRecurring: true });
    const copy = { ...e, id: crypto.randomUUID(), month: '2026-11' };
    S.expenses.push(copy);
    const d = await draftOk('expense.delete', { id: e.id });
    assert.equal(d.summary.before.name, 'Abo');
    assert.equal((await confirm(d)).status, 200);
    assert.equal(S.expenses.filter(x => x.id === e.id || x.id === copy.id).length, 0);
  });

  it('fremde Einträge: nicht änderbar, nicht löschbar', async () => {
    const fremd = addExpense(other, { name: 'Geheim', amount: '1', categoryId: catOther.id, month: '2026-10' });
    assert.equal((await draft('expense.update', { id: fremd.id, amount: '2' })).status, 404);
    assert.equal((await draft('expense.delete', { id: fremd.id })).status, 404);
    assert.equal((await draft('booking.delete', { expenseId: otherCollector.id, bookingId: crypto.randomUUID() })).status, 404);
  });

  it('Sammelposten umschalten oder Monat verschieben geht nicht über Hermes', async () => {
    assert.equal((await draft('expense.update', { id: collector.id, isCollector: false })).status, 400);
    assert.equal((await draft('expense.update', { id: collector.id, month: '2026-11' })).status, 400);
  });

  it('Einnahme anlegen, ändern, löschen', async () => {
    const c = await draftOk('income.create', { name: 'Gehalt', amount: '2500', month: '2026-10' });
    assert.equal(c.summary.isRecurring, false);
    const r1 = await confirm(c);
    assert.equal(r1.status, 201);
    const id = r1.body.targetId;
    const u = await draftOk('income.update', { id, amount: '2600' });
    assert.equal((await confirm(u)).status, 200);
    assert.equal(decrypt(S.incomes.find(i => i.id === id).amount, user.key), '2600.00');
    const d = await draftOk('income.delete', { id });
    assert.equal((await confirm(d)).status, 200);
    assert.equal(S.incomes.length, 0);
  });

  it('Einnahme ohne Monat wird nicht geraten', async () => {
    const res = await draft('income.create', { name: 'Gehalt', amount: '2500' });
    assert.equal(res.status, 400);
  });
});

// ------------------------------------------------------------
describe('Integration — Audit und Secrets', () => {
  beforeEach(() => setup());

  it('writes-Liste: nur Metadaten des eigenen Zugangs', async () => {
    const d = await draftOk('expense.create', { name: 'Kaffee', amount: '3', categoryId: catFood.id, date: '2026-10-10' });
    await confirm(d);
    const res = await request(app).get('/v1/writes').set(auth);
    assert.equal(res.status, 200);
    assert.equal(res.body.writes.length, 1);
    const w = res.body.writes[0];
    assert.deepEqual(Object.keys(w).sort(), ['action', 'createdAt', 'month', 'targetId', 'targetType']);
    const row = S.integrationWrites[0];
    assert.ok(!JSON.stringify(row).includes('Kaffee'), 'Audit ohne Klartext-Namen');
  });

  it('keine Secrets in Antworten, Datenbank-Hashes oder Logs', async () => {
    const d = await draftOk('expense.create', { name: 'Kaffee', amount: '3', categoryId: catFood.id, date: '2026-10-10' });
    const r = await confirm(d);
    const bodies = JSON.stringify([d, r.body, (await request(app).get('/v1/status').set(auth)).body]);
    const secret = token.split('.')[1];
    const keyB64 = user.key.toString('base64');
    assert.ok(!bodies.includes(secret));
    assert.ok(!bodies.includes(keyB64));
    assert.ok(!bodies.includes('wrappedKey'));
    assert.ok(!bodies.includes('secretHash'));
    assert.ok(!JSON.stringify(S.integrationCredentials).includes(secret), 'Secret nie im Klartext in der DB');
  });
});

// Ganz am Ende: in keinem Log aller Tests darf ein Token-Secret oder Schlüssel stehen.
describe('Integration — Logs', () => {
  it('Logs enthalten keine Tokens und keine Schlüssel', () => {
    const all = logs.join('\n');
    for (const t of issuedTokens || []) {
      assert.ok(!all.includes(t.split('.')[1]), 'Token-Secret im Log');
    }
    assert.ok(!/tbxi_[0-9a-f-]+\.[A-Za-z0-9_-]{20,}/.test(all), 'Token-Muster im Log');
  });
});
