// ============================================================
// HERMES-ROUTEN — Chat mit dem Hermes Agent auf diesem Server
// ============================================================
// Hermes (Nous Research) läuft als systemd-Benutzerdienst neben toolb0x
// und bringt einen eigenen API-Server mit, der NUR auf 127.0.0.1:8642
// lauscht und einen Bearer-Key verlangt. Diese Route ist der einzige Weg
// aus dem Browser dorthin:
//   - nur für Admins (Hermes hat eine Shell mit den Rechten von michael)
//   - der Key bleibt auf dem Server (Env HERMES_API_KEY), der Browser
//     sieht ihn nie
//   - der Chat-Stream wird nicht 1:1 durchgereicht, sondern auf die
//     Ereignisse reduziert, die die Oberfläche braucht. Werkzeug-Ausgaben
//     (Dateiinhalte, Befehlsausgaben) verlassen den Server so nicht.
//
// Die Chats liegen in Hermes selbst (~/.hermes/state.db), NICHT in der
// toolb0x-Datenbank — sie sind also nicht Zero-Knowledge-verschlüsselt.
// Die Oberfläche weist darauf hin.
// ============================================================

const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireAdmin);

// Eigener Body-Parser: Der globale ist auf 10 KB begrenzt (security.js
// nimmt /api/hermes deshalb aus) — für eingefügte Logs zu knapp.
router.use(express.json({ limit: '64kb' }));

const HERMES_URL = (process.env.HERMES_API_URL || 'http://127.0.0.1:8642').replace(/\/+$/, '');

// Hermes-Session-IDs: api_<zeit>_<hex> (API) bzw. <datum>_<zeit>_<hex>
// (Telegram, CLI). Alles andere landet nie in einer Upstream-URL.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const RUN_ID_RE = /^run_[A-Za-z0-9]{8,64}$/;

const MAX_INPUT = 20000;
const MAX_TITLE = 120;
// Bewusst ohne "always": eine dauerhafte Freigabe ändert die
// Hermes-Konfiguration und gehört ins Terminal, nicht in den Browser.
const APPROVAL_CHOICES = ['once', 'session', 'deny'];

const UPSTREAM_TIMEOUT_MS = 15000;
// Ein Agent-Lauf kann lange dauern (Recherche, mehrere Befehle). Danach
// bricht toolb0x nur die Verbindung ab — Hermes arbeitet weiter, das
// Ergebnis steht dann im Verlauf.
const STREAM_TIMEOUT_MS = 30 * 60 * 1000;

function apiKey() {
  return process.env.HERMES_API_KEY || '';
}

class HermesError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Fragt den Hermes-API-Server an. Wirft HermesError mit einer deutschen
 * Meldung, die direkt an den Browser gehen darf.
 */
async function hermesFetch(pfad, { method = 'GET', body, timeoutMs = UPSTREAM_TIMEOUT_MS } = {}) {
  if (!apiKey()) {
    throw new HermesError(503, 'Hermes ist nicht eingerichtet (HERMES_API_KEY fehlt auf dem Server).');
  }
  let res;
  try {
    res = await fetch(HERMES_URL + pfad, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new HermesError(502, 'Hermes ist nicht erreichbar. Läuft der Dienst hermes-gateway?');
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new HermesError(502, 'Hermes hat den Schlüssel abgelehnt (HERMES_API_KEY prüfen).');
    }
    if (res.status === 404) throw new HermesError(404, 'Chat oder Lauf nicht gefunden.');
    if (res.status === 409) throw new HermesError(409, 'Dieser Lauf nimmt gerade keine Eingabe an.');
    if (res.status === 429) throw new HermesError(429, 'Hermes ist gerade ausgelastet. Bitte gleich noch einmal versuchen.');
    throw new HermesError(502, `Hermes meldet einen Fehler (${res.status}).`);
  }
  return res;
}

function sendError(res, err) {
  if (err instanceof HermesError) return res.status(err.status).json({ error: err.message });
  console.error('Hermes-Route:', err);
  return res.status(500).json({ error: 'Interner Fehler bei der Verbindung zu Hermes.' });
}

function checkSessionId(req, res) {
  if (!SESSION_ID_RE.test(req.params.id)) {
    res.status(400).json({ error: 'Ungültige Chat-ID.' });
    return false;
  }
  return true;
}

function cleanTitle(raw) {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TITLE);
}

function toSession(s) {
  return {
    id: s.id,
    title: s.title || '',
    preview: typeof s.preview === 'string' ? s.preview.slice(0, 200) : '',
    lastActive: s.last_active || s.started_at || null,
    messageCount: s.message_count || 0,
  };
}

// Kurzbeschreibung eines Werkzeug-Aufrufs für die Oberfläche: der Befehl
// bzw. das wichtigste Argument, gekürzt. Die AUSGABE des Werkzeugs wird
// bewusst nie mitgeschickt.
function toolDetail(args) {
  let a = args;
  if (typeof a === 'string') {
    try { a = JSON.parse(a); } catch { return a.slice(0, 200); }
  }
  if (!a || typeof a !== 'object') return '';
  const wert = a.command ?? a.query ?? a.url ?? a.path ?? a.file_path ?? a.pattern ?? '';
  return String(wert).slice(0, 200);
}

// ============================================================
// GET /api/hermes/status — ist Hermes eingerichtet und erreichbar?
// ============================================================
router.get('/status', async (req, res) => {
  if (!apiKey()) return res.json({ configured: false, online: false });
  try {
    const r = await hermesFetch('/health', { timeoutMs: 5000 });
    const data = await r.json().catch(() => ({}));
    res.json({ configured: true, online: true, version: data.version || null });
  } catch {
    res.json({ configured: true, online: false });
  }
});

// ============================================================
// GET /api/hermes/sessions — Chats aus toolb0x (Quelle api_server)
// ============================================================
router.get('/sessions', async (req, res) => {
  try {
    const r = await hermesFetch('/api/sessions?limit=100&source=api_server');
    const data = await r.json();
    const list = Array.isArray(data.data) ? data.data : [];
    res.json({ sessions: list.filter((s) => s && SESSION_ID_RE.test(s.id || '')).map(toSession) });
  } catch (err) {
    sendError(res, err);
  }
});

// ============================================================
// POST /api/hermes/sessions — neuen Chat anlegen
// ============================================================
router.post('/sessions', async (req, res) => {
  try {
    const title = cleanTitle(req.body?.title) || 'Neuer Chat';
    const r = await hermesFetch('/api/sessions', { method: 'POST', body: { title } });
    const data = await r.json();
    if (!data.session || !SESSION_ID_RE.test(data.session.id || '')) {
      throw new HermesError(502, 'Hermes hat keinen gültigen Chat angelegt.');
    }
    res.status(201).json({ session: toSession(data.session) });
  } catch (err) {
    sendError(res, err);
  }
});

// ============================================================
// PATCH /api/hermes/sessions/:id — Chat umbenennen
// ============================================================
router.patch('/sessions/:id', async (req, res) => {
  if (!checkSessionId(req, res)) return;
  const title = cleanTitle(req.body?.title);
  if (!title) return res.status(400).json({ error: 'Bitte einen Namen angeben.' });
  try {
    await hermesFetch(`/api/sessions/${req.params.id}`, { method: 'PATCH', body: { title } });
    res.json({ ok: true, title });
  } catch (err) {
    sendError(res, err);
  }
});

// ============================================================
// DELETE /api/hermes/sessions/:id — Chat löschen
// ============================================================
router.delete('/sessions/:id', async (req, res) => {
  if (!checkSessionId(req, res)) return;
  try {
    await hermesFetch(`/api/sessions/${req.params.id}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ============================================================
// GET /api/hermes/sessions/:id/messages — Verlauf eines Chats
// ============================================================
// Liefert nur Text von Nutzer und Hermes plus je Werkzeug-Aufruf Name und
// Kurzbeschreibung. Werkzeug-Ausgaben (role "tool") fallen weg.
router.get('/sessions/:id/messages', async (req, res) => {
  if (!checkSessionId(req, res)) return;
  try {
    const r = await hermesFetch(`/api/sessions/${req.params.id}/messages?inline_images=false`);
    const data = await r.json();
    const out = [];
    for (const m of Array.isArray(data.data) ? data.data : []) {
      if (m.role === 'user' && typeof m.content === 'string' && m.content) {
        out.push({ role: 'user', text: m.content });
      } else if (m.role === 'assistant') {
        for (const call of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
          const fn = call && call.function;
          if (fn && fn.name) out.push({ role: 'tool', name: String(fn.name), detail: toolDetail(fn.arguments) });
        }
        if (typeof m.content === 'string' && m.content.trim()) {
          out.push({ role: 'assistant', text: m.content });
        }
      }
    }
    res.json({ messages: out });
  } catch (err) {
    sendError(res, err);
  }
});

// ============================================================
// POST /api/hermes/sessions/:id/chat — eine Nachricht, Antwort als SSE
// ============================================================
// Hermes streamt Ereignisse (run.started, tool.*, assistant.*,
// approval.request, run.completed …). Wir lesen den Strom serverseitig,
// reichen nur die nötigen Felder weiter und halten die Verbindung mit
// Keepalive-Kommentaren offen (nginx bricht sonst nach 60 s ab).
router.post('/sessions/:id/chat', async (req, res) => {
  if (!checkSessionId(req, res)) return;
  const input = typeof req.body?.input === 'string' ? req.body.input.trim() : '';
  if (!input) return res.status(400).json({ error: 'Bitte eine Nachricht eingeben.' });
  if (input.length > MAX_INPUT) {
    return res.status(400).json({ error: `Die Nachricht ist zu lang (max. ${MAX_INPUT} Zeichen).` });
  }

  let upstream;
  try {
    upstream = await hermesFetch(`/api/sessions/${req.params.id}/chat/stream`, {
      method: 'POST',
      body: { input },
      timeoutMs: STREAM_TIMEOUT_MS,
    });
  } catch (err) {
    return sendError(res, err);
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // nginx puffert Antworten sonst und liefert den Stream erst am Ende aus
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Verlässt der Browser die Seite, läuft der Lauf in Hermes trotzdem zu
  // Ende (er steht danach im Verlauf). Wir lesen weiter, schreiben nur nicht.
  let clientGone = false;
  res.on('close', () => { clientGone = true; });

  const send = (event, data) => {
    if (clientGone) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let ended = false;
  const handle = (event, data) => {
    switch (event) {
      case 'run.started':
        send('start', { runId: data.run_id || null });
        break;
      case 'tool.started':
        if (data.tool_name && !String(data.tool_name).startsWith('_')) {
          send('tool', { name: String(data.tool_name), detail: String(data.preview || '').slice(0, 200) });
        }
        break;
      case 'tool.failed':
        if (data.tool_name && !String(data.tool_name).startsWith('_')) {
          send('tool-failed', { name: String(data.tool_name) });
        }
        break;
      case 'assistant.delta':
        if (typeof data.delta === 'string') send('delta', { text: data.delta });
        break;
      case 'assistant.commentary':
        if (typeof data.text === 'string' && data.text.trim()) send('commentary', { text: data.text });
        break;
      case 'assistant.completed':
        send('message', { text: typeof data.content === 'string' ? data.content : '' });
        break;
      case 'approval.request':
        send('approval', {
          runId: data.run_id || null,
          command: String(data.command || '').slice(0, 2000),
          description: String(data.description || '').slice(0, 500),
          choices: (Array.isArray(data.choices) ? data.choices : []).filter((c) => APPROVAL_CHOICES.includes(c)),
        });
        break;
      case 'run.completed':
        ended = true;
        send('done', { status: 'completed' });
        break;
      case 'run.failed':
        ended = true;
        send('done', { status: 'failed', error: String(data.error || data.turn_exit_reason || '').slice(0, 300) });
        break;
      case 'run.cancelled':
        ended = true;
        send('done', { status: 'cancelled' });
        break;
      default:
        break;
    }
  };

  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let event = 'message';
        const dataLines = [];
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) continue; // Keepalive-Kommentar
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (!dataLines.length) {
          if (!clientGone) res.write(': keepalive\n\n');
          continue;
        }
        let data;
        try { data = JSON.parse(dataLines.join('\n')); } catch { continue; }
        handle(event, data || {});
      }
    }
  } catch (err) {
    if (!ended) send('done', { status: 'failed', error: 'Die Verbindung zu Hermes ist abgebrochen.' });
    ended = true;
  }
  if (!ended) send('done', { status: 'failed', error: 'Hermes hat den Lauf ohne Ergebnis beendet.' });
  if (!clientGone) res.end();
});

// ============================================================
// POST /api/hermes/runs/:runId/approval — Befehl freigeben/ablehnen
// ============================================================
router.post('/runs/:runId/approval', async (req, res) => {
  if (!RUN_ID_RE.test(req.params.runId)) return res.status(400).json({ error: 'Ungültige Lauf-ID.' });
  const choice = req.body?.choice;
  if (!APPROVAL_CHOICES.includes(choice)) {
    return res.status(400).json({ error: 'Ungültige Entscheidung.' });
  }
  try {
    await hermesFetch(`/v1/runs/${req.params.runId}/approval`, { method: 'POST', body: { choice } });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ============================================================
// POST /api/hermes/runs/:runId/stop — laufende Antwort abbrechen
// ============================================================
router.post('/runs/:runId/stop', async (req, res) => {
  if (!RUN_ID_RE.test(req.params.runId)) return res.status(400).json({ error: 'Ungültige Lauf-ID.' });
  try {
    await hermesFetch(`/v1/runs/${req.params.runId}/stop`, { method: 'POST', body: {} });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
