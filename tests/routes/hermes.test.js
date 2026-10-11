// ============================================================
// HERMES-CHAT ROUTE TESTS (2026-10-11)
// ============================================================
// Testet /api/hermes/* gegen einen GESTUBBTEN Hermes-API-Server
// (globalThis.fetch wird ersetzt — es geht nie eine echte Anfrage raus):
// - nur Admins, Key bleibt auf dem Server (Bearer-Header upstream)
// - Status ohne Key / bei nicht erreichbarem Hermes
// - Chatliste nur aus api_server, ungültige IDs fliegen raus
// - Verlauf ohne Werkzeug-AUSGABEN
// - Chat-Stream: nur die gefilterten Ereignisse kommen beim Browser an
// - Freigabe: "always" ist bewusst nicht erlaubt
// ============================================================

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

// --- Mock-Prisma injizieren (requireAuth lädt den User für den Suspended-Check) ---
const { createMockPrisma } = require('../helpers/mockPrisma');
const mockPrisma = createMockPrisma();
const prismaPath = require.resolve('../../src/utils/prisma');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: mockPrisma };

const { createTestAuth, cleanupAuth } = require('../helpers/authHelper');
const hermesRouter = require('../../src/routes/hermes');
const { createTestApp } = require('../helpers/testApp');
const app = createTestApp({ path: '/api/hermes', router: hermesRouter });

const KEY = 'test-hermes-key-0123456789abcdef';
const realFetch = globalThis.fetch;

// Aufgezeichnete Upstream-Aufrufe + austauschbarer Antwort-Handler
let calls = [];
let upstream = () => json({});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function sse(events) {
  const text = events.map(([ev, data]) =>
    ev === ':' ? ': keepalive\n\n' : `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  // In kleinen Stücken liefern, damit auch über Chunk-Grenzen geparst wird
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 17) controller.enqueue(bytes.slice(i, i + 17));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

let admin;
let user;

before(() => {
  admin = createTestAuth(mockPrisma);
  mockPrisma._store.users.find((u) => u.id === admin.userId).role = 'admin';
  user = createTestAuth(mockPrisma);
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
    return upstream(String(url), opts);
  };
});

beforeEach(() => {
  calls = [];
  upstream = () => json({});
  process.env.HERMES_API_KEY = KEY;
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.HERMES_API_KEY;
  cleanupAuth();
});

describe('Zugriff', () => {
  it('Nicht-Admins bekommen 403', async () => {
    const res = await request(app).get('/api/hermes/status').set('Cookie', user.cookie);
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
  });

  it('ohne Anmeldung 401', async () => {
    const res = await request(app).get('/api/hermes/sessions');
    assert.equal(res.status, 401);
  });
});

describe('Status', () => {
  it('ohne HERMES_API_KEY: nicht eingerichtet, keine Upstream-Anfrage', async () => {
    delete process.env.HERMES_API_KEY;
    const res = await request(app).get('/api/hermes/status').set('Cookie', admin.cookie);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { configured: false, online: false });
    assert.equal(calls.length, 0);
  });

  it('erreichbar: online mit Version, Key nur im Upstream-Header', async () => {
    upstream = () => json({ status: 'ok', version: '0.21.6' });
    const res = await request(app).get('/api/hermes/status').set('Cookie', admin.cookie);
    assert.deepEqual(res.body, { configured: true, online: true, version: '0.21.6' });
    assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
    assert.ok(!JSON.stringify(res.body).includes(KEY));
  });

  it('nicht erreichbar: online false statt Fehler', async () => {
    upstream = () => { throw new TypeError('fetch failed'); };
    const res = await request(app).get('/api/hermes/status').set('Cookie', admin.cookie);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { configured: true, online: false });
  });
});

describe('Chats', () => {
  it('Liste nur aus api_server, ungültige IDs werden verworfen', async () => {
    upstream = () => json({ data: [
      { id: 'api_1791706319_7d10ba0b', title: 'Test', preview: 'Hallo', last_active: 1791706325, message_count: 4 },
      { id: '../etc/passwd', title: 'böse' },
    ] });
    const res = await request(app).get('/api/hermes/sessions').set('Cookie', admin.cookie);
    assert.equal(res.status, 200);
    assert.match(calls[0].url, /\/api\/sessions\?limit=100&source=api_server$/);
    assert.deepEqual(res.body.sessions, [
      { id: 'api_1791706319_7d10ba0b', title: 'Test', preview: 'Hallo', lastActive: 1791706325, messageCount: 4 },
    ]);
  });

  it('neuer Chat: Titel wird von Steuerzeichen befreit und gekürzt', async () => {
    upstream = (url, opts) => json({ session: { id: 'api_1_abc', title: JSON.parse(opts.body).title } });
    const res = await request(app).post('/api/hermes/sessions').set('Cookie', admin.cookie)
      .send({ title: 'Zeile1\nZeile2' + 'x'.repeat(300) });
    assert.equal(res.status, 201);
    const sent = JSON.parse(calls[0].body).title;
    assert.ok(!sent.includes('\n'));
    assert.equal(sent.length, 120);
  });

  it('ungültige Chat-ID: 400 ohne Upstream-Anfrage', async () => {
    const res = await request(app).get('/api/hermes/sessions/bad$id/messages').set('Cookie', admin.cookie);
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });

  it('Verlauf enthält Werkzeug-Aufrufe, aber nie deren Ausgabe', async () => {
    upstream = () => json({ data: [
      { role: 'user', content: 'Zeig die .env' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'terminal', arguments: '{"command":"cat .env"}' } }] },
      { role: 'tool', content: '{"output":"JWT_SECRET=streng-geheim"}', tool_name: 'terminal' },
      { role: 'assistant', content: 'Erledigt.' },
    ] });
    const res = await request(app).get('/api/hermes/sessions/api_1_abc/messages').set('Cookie', admin.cookie);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.messages, [
      { role: 'user', text: 'Zeig die .env' },
      { role: 'tool', name: 'terminal', detail: 'cat .env' },
      { role: 'assistant', text: 'Erledigt.' },
    ]);
    assert.ok(!JSON.stringify(res.body).includes('streng-geheim'));
  });

  it('Löschen wird an Hermes durchgereicht', async () => {
    const res = await request(app).delete('/api/hermes/sessions/api_1_abc').set('Cookie', admin.cookie);
    assert.equal(res.status, 200);
    assert.equal(calls[0].method, 'DELETE');
    assert.match(calls[0].url, /\/api\/sessions\/api_1_abc$/);
  });

  it('Upstream lehnt den Key ab: 502 mit Hinweis', async () => {
    upstream = () => json({ error: 'unauthorized' }, 401);
    const res = await request(app).get('/api/hermes/sessions').set('Cookie', admin.cookie);
    assert.equal(res.status, 502);
    assert.match(res.body.error, /HERMES_API_KEY/);
  });
});

describe('Chat-Stream', () => {
  it('leere oder zu lange Nachricht: 400', async () => {
    let res = await request(app).post('/api/hermes/sessions/api_1_abc/chat').set('Cookie', admin.cookie).send({ input: '  ' });
    assert.equal(res.status, 400);
    res = await request(app).post('/api/hermes/sessions/api_1_abc/chat').set('Cookie', admin.cookie).send({ input: 'x'.repeat(20001) });
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });

  it('reicht nur gefilterte Ereignisse weiter, keine Werkzeug-Ausgaben', async () => {
    upstream = () => sse([
      ['run.started', { run_id: 'run_abcdef1234', user_message: { content: 'Hallo' } }],
      [':'],
      ['tool.started', { tool_name: 'terminal', preview: 'uptime', args: { command: 'uptime' } }],
      ['tool.completed', { tool_name: 'terminal' }],
      ['tool.progress', { tool_name: '_thinking', delta: 'intern' }],
      ['assistant.delta', { delta: 'Läuft ' }],
      ['assistant.delta', { delta: 'seit 16 h.' }],
      ['assistant.completed', { content: 'Läuft seit 16 h.' }],
      ['run.completed', { messages: [{ role: 'tool', content: 'GEHEIME-AUSGABE' }] }],
      ['done', {}],
    ]);
    const res = await request(app).post('/api/hermes/sessions/api_1_abc/chat').set('Cookie', admin.cookie)
      .send({ input: 'Wie lange läuft der Server?' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);
    assert.equal(res.headers['x-accel-buffering'], 'no');
    assert.deepEqual(JSON.parse(calls[0].body), { input: 'Wie lange läuft der Server?' });
    const text = res.text;
    assert.match(text, /event: start\ndata: \{"runId":"run_abcdef1234"\}/);
    assert.match(text, /event: tool\ndata: \{"name":"terminal","detail":"uptime"\}/);
    assert.match(text, /event: delta\ndata: \{"text":"Läuft "\}/);
    assert.match(text, /event: done\ndata: \{"status":"completed"\}/);
    assert.ok(!text.includes('GEHEIME-AUSGABE'));
    assert.ok(!text.includes('_thinking'));
  });

  it('Freigabe-Anfrage kommt ohne "always" an', async () => {
    upstream = () => sse([
      ['approval.request', { run_id: 'run_abcdef1234', command: 'rm -rf /tmp/x', description: 'Löschen', choices: ['once', 'session', 'always', 'deny'] }],
      ['run.cancelled', {}],
    ]);
    const res = await request(app).post('/api/hermes/sessions/api_1_abc/chat').set('Cookie', admin.cookie).send({ input: 'x' });
    assert.match(res.text, /event: approval\ndata: \{"runId":"run_abcdef1234","command":"rm -rf \/tmp\/x","description":"Löschen","choices":\["once","session","deny"\]\}/);
    assert.match(res.text, /event: done\ndata: \{"status":"cancelled"\}/);
  });

  it('Stream endet ohne Abschluss: done mit Fehler', async () => {
    upstream = () => sse([['assistant.delta', { delta: 'Hal' }]]);
    const res = await request(app).post('/api/hermes/sessions/api_1_abc/chat').set('Cookie', admin.cookie).send({ input: 'x' });
    assert.match(res.text, /event: done\ndata: \{"status":"failed"/);
  });

  it('Hermes nicht erreichbar: JSON-Fehler statt Stream', async () => {
    upstream = () => { throw new TypeError('fetch failed'); };
    const res = await request(app).post('/api/hermes/sessions/api_1_abc/chat').set('Cookie', admin.cookie).send({ input: 'x' });
    assert.equal(res.status, 502);
    assert.match(res.body.error, /nicht erreichbar/);
  });
});

describe('Freigabe und Stoppen', () => {
  it('"always" und unbekannte Entscheidungen werden abgelehnt', async () => {
    for (const choice of ['always', 'yes', undefined]) {
      const res = await request(app).post('/api/hermes/runs/run_abcdef1234/approval').set('Cookie', admin.cookie).send({ choice });
      assert.equal(res.status, 400);
    }
    assert.equal(calls.length, 0);
  });

  it('gültige Entscheidung geht an /v1/runs/:id/approval', async () => {
    const res = await request(app).post('/api/hermes/runs/run_abcdef1234/approval').set('Cookie', admin.cookie).send({ choice: 'once' });
    assert.equal(res.status, 200);
    assert.match(calls[0].url, /\/v1\/runs\/run_abcdef1234\/approval$/);
    assert.deepEqual(JSON.parse(calls[0].body), { choice: 'once' });
  });

  it('ungültige Lauf-ID: 400', async () => {
    const res = await request(app).post('/api/hermes/runs/abc/stop').set('Cookie', admin.cookie).send({});
    assert.equal(res.status, 400);
  });

  it('Stoppen geht an /v1/runs/:id/stop', async () => {
    const res = await request(app).post('/api/hermes/runs/run_abcdef1234/stop').set('Cookie', admin.cookie).send({});
    assert.equal(res.status, 200);
    assert.match(calls[0].url, /\/v1\/runs\/run_abcdef1234\/stop$/);
  });
});
