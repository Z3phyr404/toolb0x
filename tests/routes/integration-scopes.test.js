// ============================================================
// ZEPHYR-AUSBAU — Berechtigungen, Freigabestufen, neue Bereiche
// ============================================================
// Synthetische Daten, Mock-Prisma, temporäre Foto-Ordner, SSH gestubbt
// (nie eine echte Verbindung). Prüft erlaubte und verweigerte Funktionen,
// fremde Objekte, App-Freigabe, Widerruf/Abwahl, Rotation, Wiederholungen,
// konkurrierende Freigaben und das Ausbleiben von Geheimnis-Leaks.
// ============================================================

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcrypt');
const request = require('supertest');

const logs = [];
for (const level of ['log', 'error', 'warn', 'info']) {
  const orig = console[level];
  console[level] = (...args) => { logs.push(args.map(String).join(' ')); if (process.env.TEST_VERBOSE) orig(...args); };
}

process.env.INTEGRATION_RATE_AUTH_FAIL = '100000';
process.env.INTEGRATION_RATE_READ = '100000';
process.env.INTEGRATION_RATE_WRITE = '100000';
process.env.INTEGRATION_RATE_SSH = '100000';

// Foto-Verzeichnisse: temporär, synthetisch
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-fotos-'));
process.env.FOTOS_DIR = path.join(TMP, 'fotos');
process.env.FOTOS_PRIVAT_DIR = path.join(TMP, 'privat');

// SSH-Stub: zeichnet Befehle auf, verbindet nie
const sshCalls = [];
let sshFail = null;
const sshPath = require.resolve('../../src/utils/ssh');
require.cache[sshPath] = {
  id: sshPath, filename: sshPath, loaded: true,
  exports: {
    HOST_KEY_MISMATCH: 'HOST_KEY_MISMATCH',
    execSSH: async (config, command) => {
      sshCalls.push({ host: config.host, command });
      if (sshFail) throw new Error(sshFail);
      if (command.startsWith('hostname')) return { code: 0, stdout: 'synth-host\nup 3 days\nUbuntu 24.04', stderr: '' };
      if (command.startsWith('systemctl list-units')) return { code: 0, stdout: 'nginx\nssh\n', stderr: '' };
      return { code: 0, stdout: 'OK', stderr: '' };
    },
  },
};

const { createMockPrisma } = require('../helpers/mockPrisma');
const mockPrisma = createMockPrisma();
const prismaPath = require.resolve('../../src/utils/prisma');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: mockPrisma };

const { createTestAuth, cleanupAuth } = require('../helpers/authHelper');
const { encrypt, decrypt } = require('../../src/utils/encryption');
const { createCredential } = require('../../src/integration/credentials');
const { createIntegrationApp } = require('../../src/integration/app');
const { runningExternal } = require('../../src/integration/execute');
const { todayBerlin } = require('../../src/integration/reads');
const integrationsRouter = require('../../src/routes/integrations');
const { createTestApp } = require('../helpers/testApp');

const local = createIntegrationApp();
const appApi = createTestApp({ path: '/api/integrations', router: integrationsRouter });
const S = mockPrisma._store;
const PASSWORT = 'Synthetisch1!';
const ALL = ['finance.read', 'finance.write', 'finance.categories', 'finance.balance', 'reminders.read', 'reminders.write',
  'notes.read', 'notes.write', 'photos.read', 'photos.images', 'photos.edit', 'servers.status', 'servers.actions'];

let me, other, otherKey, token, H, credId, cat, server, issued;

function addDays(ymd, d) {
  const x = new Date(`${ymd}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10);
}

async function setup({ scopes = ALL, role = 'admin' } = {}) {
  for (const t of Object.keys(S)) S[t].length = 0;
  issued = [];
  me = createTestAuth(mockPrisma);
  const u = S.users.find(x => x.id === me.userId);
  u.role = role;
  u.password = await bcrypt.hash(PASSWORT, 4);
  other = createTestAuth(mockPrisma);
  otherKey = other.encryptionKey;
  cat = { id: crypto.randomUUID(), userId: me.userId, name: encrypt('Lebensmittel', me.encryptionKey), color: encrypt('#00aa00', me.encryptionKey), createdAt: new Date() };
  S.categories.push(cat);
  server = {
    id: crypto.randomUUID(), userId: me.userId, label: 'Synth-VPS', serverType: 'linux', authType: 'password',
    host: encrypt('203.0.113.99', me.encryptionKey), port: encrypt('22', me.encryptionKey), username: encrypt('root', me.encryptionKey),
    password: encrypt('GEHEIM-SSH-PASSWORT', me.encryptionKey), privateKey: '', passphrase: '', notes: '', hostKeyFingerprint: 'fp',
  };
  S.servers.push(server);
  // scopes 'default' = wie ein neu in der App erzeugter Zugang (ohne Angabe)
  const c = await createCredential(mockPrisma, { userId: me.userId, encryptionKey: me.encryptionKey, ...(scopes === 'default' ? {} : { scopes }) });
  token = c.token; credId = c.credential.id; issued.push(token);
  H = { Authorization: `Bearer ${token}` };
  sshCalls.length = 0; sshFail = null;
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(process.env.FOTOS_PRIVAT_DIR, 'thumb'), { recursive: true });
  fs.mkdirSync(path.join(process.env.FOTOS_PRIVAT_DIR, 'img'), { recursive: true });
  fs.mkdirSync(path.join(process.env.FOTOS_DIR, 'AbCdEf123456'), { recursive: true });
  fs.writeFileSync(path.join(process.env.FOTOS_DIR, 'AbCdEf123456', 'index.html'), '<title>Synth-Album</title>');
  fs.writeFileSync(path.join(process.env.FOTOS_PRIVAT_DIR, 'thumb', '5000.jpg'), 'JPEGDATA');
  fs.writeFileSync(path.join(process.env.FOTOS_PRIVAT_DIR, 'library.json'), JSON.stringify({
    generatedAt: '2026-10-01T00:00:00Z', photoCount: 3, persons: ['Person A'],
    events: [{ n: 'Ausflug', s: '2026-09-01', e: '2026-09-02', ids: [5000, 4999] }],
    albums: [{ n: 'Beste', ids: [5000] }],
    photos: [
      { n: '5000.jpg', d: '2026-09-01T10:00:00', r: 5, t: ['See'], p: ['Person A'], c: 'Ein See im Nebel' },
      { n: '4999.jpg', d: '2026-09-02T10:00:00', r: 2, t: ['Wald'] },
      { n: '4998.jpg', d: '2025-01-01T10:00:00' },
    ],
  }));
}

const get = (p, h = H) => request(local).get(p).set(h);
const draft = (action, params, h = H) => request(local).post('/v1/drafts').set(h).send({ action, params });
const confirm = (d, idem = crypto.randomUUID(), h = H) =>
  request(local).post(`/v1/drafts/${d.draftId}/confirm`).set(h).set('Idempotency-Key', idem).send({ contentHash: d.contentHash });
const approve = (d, cookie = me.cookie) =>
  request(appApi).post(`/api/integrations/approvals/${d.draftId}/approve`).set('Cookie', cookie).send({ contentHash: d.contentHash });
async function ok(action, params) {
  const r = await draft(action, params);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
const snapshot = () => JSON.stringify(Object.fromEntries(Object.entries(S).filter(([t]) => t !== 'integrationCredentials')));

after(() => { cleanupAuth(); fs.rmSync(TMP, { recursive: true, force: true }); });

// ------------------------------------------------------------
describe('Berechtigungen', () => {
  it('neuer Zugang hat nur Finanzen; andere Bereiche 403 SCOPE_MISSING', async () => {
    await setup({ scopes: 'default' });
    assert.equal((await get('/v1/categories')).status, 200);
    for (const p of ['/v1/reminders', '/v1/notes', '/v1/photos/library', '/v1/servers', '/v1/balance']) {
      const r = await get(p);
      assert.equal(r.status, 403, p);
      assert.equal(r.body.error, 'SCOPE_MISSING');
    }
    const d = await draft('reminder.create', { dueDate: '2026-12-01' });
    assert.equal(d.status, 403);
  });

  it('Admin-Berechtigungen wirken nur für Admin-Konten — Rolle wird je Anfrage geprüft', async () => {
    await setup();
    assert.equal((await get('/v1/servers')).status, 200);
    S.users.find(x => x.id === me.userId).role = 'user';
    assert.equal((await get('/v1/servers')).status, 403);
    assert.equal((await get('/v1/photos/library')).status, 403);
    assert.equal((await get('/v1/notes')).status, 200, 'Nicht-Admin-Rechte bleiben');
  });

  it('Zephyr kann Rechte abgeben, aber nicht erweitern', async () => {
    await setup({ scopes: ['finance.read', 'reminders.read'] });
    const r = await request(local).post('/v1/scopes/drop').set(H).send({ scope: 'reminders.read' });
    assert.equal(r.status, 200);
    assert.equal((await get('/v1/reminders')).status, 403);
    assert.equal((await request(local).post('/v1/scopes/add').set(H).send({ scope: 'notes.read' })).status, 404);
  });

  it('/status zeigt Stufen je Aktion, ohne Geheimnisse', async () => {
    await setup();
    const r = await get('/v1/status');
    const byName = Object.fromEntries(r.body.actions.map(a => [a.name, a]));
    assert.equal(byName['expense.create'].level, 'auto');
    assert.equal(byName['note.create'].level, 'chat');
    assert.equal(byName['note.delete'].level, 'app');
    assert.equal(byName['server.restart'].level, 'app');
    assert.ok(!Object.keys(byName).some(n => /password|vault|share|admin|export/.test(n)));
    assert.ok(!JSON.stringify(r.body).includes(token.split('.')[1]));
  });

  it('ausgeschlossene Bereiche existieren nicht', async () => {
    await setup();
    for (const p of ['/v1/passwords', '/v1/vaults', '/v1/shares', '/v1/admin/users', '/v1/export/json', '/v1/servers/x/exec', '/v1/sql', '/v1/shell']) {
      assert.equal((await get(p)).status, 404, p);
    }
    for (const a of ['password.create', 'vault.member.add', 'share.create', 'server.exec', 'user.delete']) {
      assert.equal((await draft(a, {})).body.error, 'UNKNOWN_ACTION', a);
    }
  });
});

// ------------------------------------------------------------
describe('Erinnerungen', () => {
  const today = todayBerlin();
  function addRem(owner, key, { title = '', due, status = 'pending', daysBefore = 3, expenseId = null }) {
    const r = {
      id: crypto.randomUUID(), userId: owner, note: title ? encrypt(title, key) : '', reminderDate: new Date(`${due}T00:00:00.000Z`),
      daysBefore, status, expenseId, createdAt: new Date(), updatedAt: new Date(),
    };
    S.reminders.push(r);
    return r;
  }

  beforeEach(() => setup());

  it('Liste: dokumentierte Felder, kein Betrag, keine fremden', async () => {
    const exp = { id: crypto.randomUUID(), userId: me.userId, name: encrypt('Fitness-Abo', me.encryptionKey), amount: encrypt('39.90', me.encryptionKey), categoryId: cat.id, month: '2026-10' };
    S.expenses.push(exp);
    addRem(me.userId, me.encryptionKey, { due: '2026-12-31', expenseId: exp.id });
    addRem(other.userId, otherKey, { title: 'Fremd', due: '2026-12-01' });
    const r = await get('/v1/reminders');
    assert.equal(r.status, 200);
    assert.equal(r.body.reminders.length, 1);
    const x = r.body.reminders[0];
    assert.equal(x.title, 'Fitness-Abo');
    assert.equal(x.dueDate, '2026-12-31');
    assert.equal(x.timeZone, 'Europe/Berlin');
    assert.equal(x.recurrence, null);
    assert.equal(x.alertDate, '2026-12-28');
    assert.deepEqual(x.expense, { id: exp.id, name: 'Fitness-Abo' });
    assert.ok(x.version && x.updatedAt && x.createdAt);
    assert.ok(!JSON.stringify(r.body).includes('39.90'));
  });

  it('upcoming(2): heute, in 2 Tagen und überfällig — nicht in 3 Tagen, nicht erledigt; ändert nichts', async () => {
    addRem(me.userId, me.encryptionKey, { title: 'Heute', due: today });
    addRem(me.userId, me.encryptionKey, { title: 'In2', due: addDays(today, 2) });
    addRem(me.userId, me.encryptionKey, { title: 'In3', due: addDays(today, 3) });
    addRem(me.userId, me.encryptionKey, { title: 'Alt', due: addDays(today, -1) });
    addRem(me.userId, me.encryptionKey, { title: 'Erledigt', due: today, status: 'done' });
    const vorher = snapshot();
    const r = await get('/v1/reminders/upcoming?days=2');
    assert.deepEqual(r.body.reminders.map(x => x.title), ['Alt', 'Heute', 'In2']);
    assert.equal(r.body.reminders[0].overdue, true);
    assert.equal(r.body.reminders[2].daysUntilDue, 2);
    assert.equal(snapshot(), vorher, 'Lesen darf nichts ändern');
  });

  it('anlegen und Status ändern (Chat-Stufe), fremde Ausgabe abgelehnt', async () => {
    const bad = await draft('reminder.create', { dueDate: '2026-12-01', expenseId: crypto.randomUUID() });
    assert.equal(bad.status, 400);
    const d = await ok('reminder.create', { title: 'Kündigen', dueDate: '2026-12-01', daysBefore: 7 });
    assert.equal(d.level, 'chat');
    const c = await confirm(d);
    assert.equal(c.status, 201);
    const row = S.reminders.find(x => x.id === c.body.targetId);
    assert.equal(new Date(row.reminderDate).toISOString(), '2026-12-01T00:00:00.000Z');
    assert.equal(decrypt(row.note, me.encryptionKey), 'Kündigen');
    const u = await ok('reminder.update', { id: row.id, status: 'done' });
    assert.equal((await confirm(u)).status, 200);
    assert.equal(S.reminders.find(x => x.id === row.id).status, 'done');
  });

  it('löschen nur per App-Freigabe; Zephyr kann nicht selbst bestätigen', async () => {
    const r = addRem(me.userId, me.encryptionKey, { title: 'Weg', due: '2026-12-01' });
    const d = await ok('reminder.delete', { id: r.id });
    assert.equal(d.level, 'app');
    const c = await confirm(d);
    assert.equal(c.status, 403);
    assert.equal(c.body.error, 'APP_APPROVAL_REQUIRED');
    assert.equal((await get(`/v1/drafts/${d.draftId}`)).body.status, 'pending_approval');
    assert.equal(S.reminders.length, 1);
    const list = await request(appApi).get('/api/integrations/approvals').set('Cookie', me.cookie);
    assert.equal(list.body.approvals.length, 1);
    assert.equal(list.body.approvals[0].summary.before.title, 'Weg');
    const a = await approve(d);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(S.reminders.length, 0);
    assert.equal((await get(`/v1/drafts/${d.draftId}`)).body.status, 'executed');
  });

  it('abgelehnte Freigabe wird nie ausgeführt', async () => {
    const r = addRem(me.userId, me.encryptionKey, { title: 'Bleibt', due: '2026-12-01' });
    const d = await ok('reminder.delete', { id: r.id });
    const rej = await request(appApi).post(`/api/integrations/approvals/${d.draftId}/reject`).set('Cookie', me.cookie);
    assert.equal(rej.status, 200);
    assert.equal((await get(`/v1/drafts/${d.draftId}`)).body.status, 'rejected');
    assert.notEqual((await approve(d)).status, 200);
    assert.equal(S.reminders.length, 1);
  });
});

// ------------------------------------------------------------
describe('Notizen', () => {
  beforeEach(() => setup());
  const addNote = (owner, key, title, extra = {}) => {
    const n = { id: crypto.randomUUID(), userId: owner, title: encrypt(title, key), content: encrypt(extra.html || '', key), icon: '', parentId: extra.parentId || null, sortOrder: 0, isPinned: false, isArchived: !!extra.isArchived, createdAt: new Date(), updatedAt: new Date() };
    S.notes.push(n);
    return n;
  };

  it('Text wird sicher in HTML gewandelt (kein Skript-HTML über die Integration)', async () => {
    const d = await ok('note.create', { title: 'Einkauf', text: 'Milch <script>alert(1)</script>\n\nBrot & "Butter"' });
    const c = await confirm(d);
    assert.equal(c.status, 201);
    const row = S.notes.find(n => n.id === c.body.targetId);
    const html = decrypt(row.content, me.encryptionKey);
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
    const r = await get(`/v1/notes/${row.id}`);
    assert.equal(r.body.note.text, 'Milch <script>alert(1)</script>\n\nBrot & "Butter"');
  });

  it('anhängen, Konflikt text+appendText, Zirkel und fremde Elternseite abgelehnt', async () => {
    const a = addNote(me.userId, me.encryptionKey, 'A', { html: '<p>alt</p>' });
    const b = addNote(me.userId, me.encryptionKey, 'B', { parentId: a.id });
    const fremd = addNote(other.userId, otherKey, 'Fremd');
    const u = await ok('note.update', { id: a.id, appendText: 'neu' });
    assert.equal((await confirm(u)).status, 200);
    assert.equal(decrypt(S.notes.find(n => n.id === a.id).content, me.encryptionKey), '<p>alt</p><p>neu</p>');
    assert.equal((await draft('note.update', { id: a.id, text: 'x', appendText: 'y' })).status, 400);
    assert.equal((await draft('note.move', { id: a.id, parentId: b.id })).status, 400);
    assert.equal((await draft('note.create', { title: 'X', parentId: fremd.id })).status, 400);
    assert.equal((await get(`/v1/notes/${fremd.id}`)).status, 404);
    assert.equal((await draft('note.update', { id: fremd.id, title: 'gekapert' })).status, 404);
  });

  it('Suche und Liste ohne Archiv; Lesen ändert nichts', async () => {
    addNote(me.userId, me.encryptionKey, 'Urlaub planen', { html: '<p>Flug nach Lissabon</p>' });
    addNote(me.userId, me.encryptionKey, 'Altes', { html: '<p>Lissabon 2019</p>', isArchived: true });
    const vorher = snapshot();
    const s = await get('/v1/notes/search?q=lissabon');
    assert.deepEqual(s.body.results.map(r => r.title), ['Urlaub planen']);
    assert.equal((await get('/v1/notes')).body.notes.length, 1);
    assert.equal((await get('/v1/notes?includeArchived=true')).body.notes.length, 2);
    assert.equal(snapshot(), vorher);
  });

  it('löschen nur per App-Freigabe, Zusammenfassung nennt Unterseiten', async () => {
    const a = addNote(me.userId, me.encryptionKey, 'Projekt');
    addNote(me.userId, me.encryptionKey, 'Unterseite', { parentId: a.id });
    const d = await ok('note.delete', { id: a.id });
    assert.equal(d.summary.deletesSubpages, 1);
    assert.equal((await confirm(d)).status, 403);
    assert.equal((await approve(d)).status, 200);
    assert.ok(!S.notes.some(n => n.id === a.id));
  });

  it('in der App geändert nach Entwurf → TARGET_CHANGED auch bei App-Freigabe', async () => {
    const a = addNote(me.userId, me.encryptionKey, 'Projekt');
    const d = await ok('note.delete', { id: a.id });
    S.notes.find(n => n.id === a.id).title = encrypt('Umbenannt', me.encryptionKey);
    const r = await approve(d);
    assert.equal(r.status, 409);
    assert.ok(S.notes.some(n => n.id === a.id));
  });
});

// ------------------------------------------------------------
describe('Fotos', () => {
  beforeEach(() => setup());

  it('Alben ohne Freigabe-Token; Bibliothek filterbar und paginiert', async () => {
    const al = await get('/v1/photos/albums');
    assert.deepEqual(al.body.albums.map(a => a.title), ['Synth-Album']);
    assert.ok(!JSON.stringify(al.body).includes('AbCdEf123456'), 'kein öffentlicher Link-Token');
    const lib = await get('/v1/photos/library?from=2026-01-01&minRating=3');
    assert.equal(lib.body.total, 1);
    assert.equal(lib.body.items[0].id, 5000);
    assert.equal((await get('/v1/photos/library?event=Ausflug')).body.total, 2);
    assert.equal((await get('/v1/photos/library?q=nebel')).body.total, 1);
    const page = await get('/v1/photos/library?limit=1&offset=1');
    assert.equal(page.body.items.length, 1);
    assert.equal(page.body.total, 3);
  });

  it('Bilddateien nur mit photos.images; Pfad-Tricks abgewiesen', async () => {
    await setup({ scopes: ALL.filter(s => s !== 'photos.images') });
    assert.equal((await get('/v1/photos/thumb/5000')).status, 403);
    await setup();
    const r = await get('/v1/photos/thumb/5000');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/jpeg');
    for (const bad of ['..%2Flibrary', 'abc', '5000.jpg']) {
      assert.ok([400, 404].includes((await get(`/v1/photos/thumb/${bad}`)).status), bad);
    }
  });

  it('Bewerten/Taggen (Chat) schreibt Marker; Löschwunsch nur per App-Freigabe', async () => {
    const e = await ok('photo.edit', { ids: [5000], rating: 4, addTags: ['Herbst'] });
    assert.equal((await confirm(e)).status, 200);
    const marker = JSON.parse(fs.readFileSync(path.join(process.env.FOTOS_PRIVAT_DIR, 'edit-queue', '5000.json'), 'utf8'));
    assert.deepEqual(marker, { r: 4, add: ['Herbst'] });
    assert.equal((await draft('photo.edit', { ids: [5000, 5000], rating: 1 })).status, 400);
    const d = await ok('photo.delete', { ids: [4999] });
    assert.equal((await confirm(d)).status, 403);
    assert.ok(!fs.existsSync(path.join(process.env.FOTOS_PRIVAT_DIR, 'delete-queue', '4999')));
    assert.equal((await approve(d)).status, 200);
    assert.ok(fs.existsSync(path.join(process.env.FOTOS_PRIVAT_DIR, 'delete-queue', '4999')));
  });
});

// ------------------------------------------------------------
describe('Server', () => {
  beforeEach(() => setup());

  it('Liste ohne Host/Zugangsdaten; Status per festem Befehl', async () => {
    const l = await get('/v1/servers');
    assert.deepEqual(l.body.servers, [{ id: server.id, label: 'Synth-VPS', serverType: 'linux' }]);
    const s = await get(`/v1/servers/${server.id}/status`);
    assert.equal(s.body.online, true);
    assert.ok(sshCalls[0].command.startsWith('hostname'));
    const all = JSON.stringify([l.body, s.body]);
    assert.ok(!all.includes('203.0.113.99') && !all.includes('GEHEIM-SSH-PASSWORT'));
  });

  it('SSH-Fehler werden generisch gemeldet (keine IP im Text)', async () => {
    sshFail = 'connect ECONNREFUSED 203.0.113.99:22';
    const r = await get(`/v1/servers/${server.id}/stats`);
    assert.equal(r.status, 502);
    assert.ok(!JSON.stringify(r.body).includes('203.0.113.99'));
    const st = await get(`/v1/servers/${server.id}/status`);
    assert.deepEqual(st.body, { online: false });
  });

  it('Neustart: nur per App-Freigabe, läuft nach dem Commit, genau einmal', async () => {
    const d = await ok('server.restart', { id: server.id });
    assert.equal(d.level, 'app');
    assert.equal((await confirm(d)).status, 403);
    assert.equal(sshCalls.length, 0);
    const [a1, a2] = await Promise.all([approve(d), approve(d)]);
    assert.deepEqual([a1.status, a2.status].sort(), [200, 202]);
    await Promise.all([...runningExternal.values()]);
    const st = await get(`/v1/drafts/${d.draftId}`);
    assert.equal(st.body.status, 'executed');
    assert.equal(st.body.result.state, 'done');
    assert.deepEqual(sshCalls.map(c => c.command), ['sudo reboot']);
  });

  it('ungültiger Dienstname, fremder Server, fehlende Berechtigung', async () => {
    assert.equal((await draft('server.service-restart', { id: server.id, service: 'nginx; rm -rf /' })).status, 400);
    const fremd = { ...server, id: crypto.randomUUID(), userId: other.userId };
    S.servers.push(fremd);
    assert.equal((await draft('server.restart', { id: fremd.id })).status, 404);
    assert.equal((await get(`/v1/servers/${fremd.id}/status`)).status, 404);
    await setup({ scopes: ALL.filter(s => s !== 'servers.actions') });
    assert.equal((await draft('server.restart', { id: server.id })).status, 403);
  });
});

// ------------------------------------------------------------
describe('Verwaltung in der App', () => {
  beforeEach(() => setup({ scopes: ['finance.read', 'finance.write'] }));
  const put = (scopes, password, cookie = me.cookie) =>
    request(appApi).put(`/api/integrations/${credId}/scopes`).set('Cookie', cookie).send({ scopes, ...(password ? { password } : {}) });

  it('Einschalten braucht Passwort, Abschalten nicht; unbekannte Rechte abgelehnt', async () => {
    assert.equal((await put(['finance.read', 'finance.write', 'notes.read'])).status, 401);
    assert.equal((await put(['finance.read', 'finance.write', 'notes.read'], 'falsch')).status, 401);
    assert.equal((await put(['finance.read', 'finance.write', 'notes.read'], PASSWORT)).status, 200);
    assert.equal((await get('/v1/notes')).status, 200);
    assert.equal((await put(['finance.read'])).status, 200);
    assert.equal((await get('/v1/notes')).status, 403);
    assert.equal((await put(['passwords.read'], PASSWORT)).status, 400);
  });

  it('Admin-Rechte für Nicht-Admin nicht vergebbar; fremde Zugänge nicht änderbar', async () => {
    S.users.find(x => x.id === me.userId).role = 'user';
    assert.equal((await put(['servers.actions'], PASSWORT)).status, 403);
    assert.equal((await put(['finance.read'], null, other.cookie)).status, 404);
  });

  it('Abwahl wirkt auch auf schon erstellte Entwürfe', async () => {
    await put(ALL, PASSWORT);
    const r = { id: crypto.randomUUID(), userId: me.userId, note: '', reminderDate: new Date('2026-12-01T00:00:00Z'), daysBefore: 3, status: 'pending', expenseId: null, createdAt: new Date(), updatedAt: new Date() };
    S.reminders.push(r);
    const d = await ok('reminder.delete', { id: r.id });
    await put(ALL.filter(s => s !== 'reminders.write'));
    const a = await approve(d);
    assert.equal(a.status, 403);
    assert.equal(S.reminders.length, 1);
  });

  it('Rotation: alter Schlüssel sofort ungültig, neuer mit gleichen Rechten', async () => {
    assert.equal((await request(appApi).post(`/api/integrations/${credId}/rotate`).set('Cookie', me.cookie).send({ password: 'falsch' })).status, 401);
    const r = await request(appApi).post(`/api/integrations/${credId}/rotate`).set('Cookie', me.cookie).send({ password: PASSWORT });
    assert.equal(r.status, 201);
    issued.push(r.body.token);
    assert.equal((await get('/v1/categories')).status, 401);
    const neu = { Authorization: `Bearer ${r.body.token}` };
    assert.equal((await get('/v1/categories', neu)).status, 200);
    assert.deepEqual(r.body.credential.scopes, ['finance.read', 'finance.write']);
  });

  it('fremde Freigaben weder sichtbar noch ausführbar; widerrufener Zugang nicht ausführbar', async () => {
    await put(ALL, PASSWORT);
    const r = { id: crypto.randomUUID(), userId: me.userId, note: '', reminderDate: new Date('2026-12-01T00:00:00Z'), daysBefore: 3, status: 'pending', expenseId: null, createdAt: new Date(), updatedAt: new Date() };
    S.reminders.push(r);
    const d = await ok('reminder.delete', { id: r.id });
    assert.deepEqual((await request(appApi).get('/api/integrations/approvals').set('Cookie', other.cookie)).body.approvals, []);
    assert.equal((await approve(d, other.cookie)).status, 404);
    await request(appApi).delete(`/api/integrations/${credId}`).set('Cookie', me.cookie);
    assert.deepEqual((await request(appApi).get('/api/integrations/approvals').set('Cookie', me.cookie)).body.approvals, []);
    assert.notEqual((await approve(d)).status, 200);
    assert.equal(S.reminders.length, 1);
  });
});

// ------------------------------------------------------------
describe('Finanzen unverändert + neue Finanzaktionen', () => {
  beforeEach(() => setup());

  it('Kategorie löschen nur per App-Freigabe; Ausgaben wandern nach Sonstiges', async () => {
    S.expenses.push({ id: crypto.randomUUID(), userId: me.userId, name: encrypt('Brot', me.encryptionKey), amount: encrypt('2', me.encryptionKey), categoryId: cat.id, month: '2026-10' });
    const d = await ok('category.delete', { id: cat.id });
    assert.equal(d.summary.movesExpensesToSonstiges, 1);
    assert.equal((await confirm(d)).status, 403);
    assert.equal((await approve(d)).status, 200);
    const sonst = S.categories.find(c => decrypt(c.name, me.encryptionKey) === 'Sonstiges');
    assert.ok(sonst);
    assert.equal(S.expenses[0].categoryId, sonst.id);
  });

  it('Kontostand setzen (auto) und lesen; negative Werte erlaubt', async () => {
    const d = await ok('balance.set', { amount: '-12,5' });
    assert.equal(d.level, 'auto');
    assert.equal((await confirm(d)).status, 200);
    assert.deepEqual((await get('/v1/balance')).body.amount, '-12.50');
    assert.equal((await draft('balance.set', { amount: '12abc' })).status, 400);
  });
});

// ------------------------------------------------------------
describe('Keine Geheimnisse in Logs', () => {
  it('Logs ohne Token-Secrets, SSH-Passwort, Hosts und Inhalte', () => {
    const all = logs.join('\n');
    for (const t of issued || []) assert.ok(!all.includes(t.split('.')[1]), 'Token-Secret im Log');
    for (const s of ['GEHEIM-SSH-PASSWORT', '203.0.113.99', 'Lissabon', 'Kündigen', 'Milch']) {
      assert.ok(!all.includes(s), `${s} im Log`);
    }
  });
});
