// ============================================================
// LESE-ENDPUNKTE DER INTEGRATION (Zephyr-Ausbau, 2026-10-12)
// ============================================================
// Alle rein lesend: kein Status wird gesetzt, nichts angelegt, kein Monat
// initialisiert. Jede Route verlangt ihre Berechtigung (need(scope)).
// Antworten enthalten nur die nötigen Felder — insbesondere nie
// Server-Zugangsdaten, Hosts/IPs oder Freigabe-Tokens der Fotoalben.
// ============================================================

const crypto = require('crypto');
const prisma = require('../utils/prisma');
const { decrypt } = require('../utils/encryption');
const { entschaerfe } = require('../utils/legacyText');
const photos = require('../services/photos');
const serverOps = require('../services/servers');
const { IntegrationError } = require('./actions');

const TIME_ZONE = 'Europe/Berlin';
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Heutiges Datum in Europe/Berlin als YYYY-MM-DD. */
function todayBerlin(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function addDays(ymd, days) {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}

const short = v => crypto.createHash('sha256').update(v).digest('hex').slice(0, 16);

function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ------------------------------------------------------------
// Erinnerungen
// ------------------------------------------------------------
// Datenmodell der App: reminderDate = Fälligkeitstag (gespeichert als
// Mitternacht UTC des Kalendertags, die App schickt "YYYY-MM-DD"),
// daysBefore = Vorlauf für die Anzeige in der App, status pending|done|
// dismissed. Wiederholungen kennt die App NICHT (recurrence: null).
function reminderView(r, key, today) {
  const dueDate = new Date(r.reminderDate).toISOString().slice(0, 10);
  let title = r.note ? entschaerfe(decrypt(r.note, key)) : '';
  const expense = r.expense ? { id: r.expense.id, name: entschaerfe(decrypt(r.expense.name, key)) } : null;
  if (!title) title = expense ? expense.name : 'Erinnerung';
  const versionSrc = [r.note, dueDate, r.daysBefore, r.status, r.expenseId || null, new Date(r.updatedAt).toISOString()].join('|');
  return {
    id: r.id,
    title,
    dueDate,
    timeZone: TIME_ZONE,
    daysUntilDue: daysBetween(today, dueDate),
    overdue: r.status === 'pending' && dueDate < today,
    daysBefore: r.daysBefore,
    alertDate: addDays(dueDate, -r.daysBefore),
    status: r.status,
    expense,
    recurrence: null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    version: short(versionSrc),
  };
}

function registerReads(router, { need, limiters, ctxOf, sendError }) {
  const R = limiters.read;

  router.get('/reminders', R, need('reminders.read'), async (req, res) => {
    try {
      const { userId, key } = ctxOf(req);
      const where = { userId };
      if (req.query.status !== undefined) {
        if (!['pending', 'done', 'dismissed'].includes(req.query.status)) throw new IntegrationError(400, 'VALIDATION', 'status: pending, done oder dismissed.');
        where.status = req.query.status;
      }
      for (const f of ['from', 'to']) {
        if (req.query[f] !== undefined && !DATE_RE.test(String(req.query[f]))) throw new IntegrationError(400, 'VALIDATION', `${f}: Datum YYYY-MM-DD.`);
      }
      const today = todayBerlin();
      const rows = await prisma.reminder.findMany({ where, include: { expense: { select: { id: true, name: true } } } });
      const reminders = rows.map(r => reminderView(r, key, today))
        .filter(r => (!req.query.from || r.dueDate >= req.query.from) && (!req.query.to || r.dueDate <= req.query.to))
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      res.json({ today, timeZone: TIME_ZONE, reminders });
    } catch (err) { sendError(res, err); }
  });

  // Offene Erinnerungen, die in den nächsten `days` Tagen (Standard 2) fällig
  // sind — inklusive überfälliger (overdue: true). Für Zephyrs Telegram-Hinweise.
  router.get('/reminders/upcoming', R, need('reminders.read'), async (req, res) => {
    try {
      const { userId, key } = ctxOf(req);
      const days = req.query.days === undefined ? 2 : Number(req.query.days);
      if (!Number.isInteger(days) || days < 0 || days > 60) throw new IntegrationError(400, 'VALIDATION', 'days: ganze Zahl 0–60.');
      const today = todayBerlin();
      const until = addDays(today, days);
      const rows = await prisma.reminder.findMany({
        where: { userId, status: 'pending' },
        include: { expense: { select: { id: true, name: true } } },
      });
      const reminders = rows.map(r => reminderView(r, key, today))
        .filter(r => r.dueDate <= until)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      res.json({ today, until, timeZone: TIME_ZONE, reminders });
    } catch (err) { sendError(res, err); }
  });

  // ------------------------------------------------------------
  // Notizen
  // ------------------------------------------------------------
  router.get('/notes', R, need('notes.read'), async (req, res) => {
    try {
      const { userId, key } = ctxOf(req);
      const includeArchived = req.query.includeArchived === 'true';
      const rows = await prisma.note.findMany({ where: { userId } });
      const notes = rows
        .filter(n => includeArchived || !n.isArchived)
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
        .map(n => ({
          id: n.id, title: entschaerfe(decrypt(n.title, key)), icon: n.icon, parentId: n.parentId || null,
          sortOrder: n.sortOrder, isPinned: n.isPinned, isArchived: n.isArchived, updatedAt: n.updatedAt,
        }));
      res.json({ notes });
    } catch (err) { sendError(res, err); }
  });

  router.get('/notes/search', R, need('notes.read'), async (req, res) => {
    try {
      const { userId, key } = ctxOf(req);
      const q = String(req.query.q || '').trim().toLowerCase();
      if (q.length < 2 || q.length > 200) throw new IntegrationError(400, 'VALIDATION', 'q: Suchtext 2–200 Zeichen.');
      const rows = await prisma.note.findMany({ where: { userId, isArchived: false } });
      const results = [];
      for (const n of rows) {
        const title = entschaerfe(decrypt(n.title, key));
        const text = htmlToText(n.content ? decrypt(n.content, key) : '');
        const idx = text.toLowerCase().indexOf(q);
        if (title.toLowerCase().includes(q) || idx >= 0) {
          const snippet = idx >= 0 ? (idx > 60 ? '…' : '') + text.slice(Math.max(0, idx - 60), idx + q.length + 60) + (idx + q.length + 60 < text.length ? '…' : '') : '';
          results.push({ id: n.id, title, icon: n.icon, parentId: n.parentId || null, snippet });
        }
        if (results.length >= 20) break;
      }
      res.json({ results });
    } catch (err) { sendError(res, err); }
  });

  router.get('/notes/:id', R, need('notes.read'), async (req, res) => {
    try {
      const { userId, key } = ctxOf(req);
      const n = await prisma.note.findFirst({ where: { id: String(req.params.id), userId } });
      if (!n) throw new IntegrationError(404, 'NOT_FOUND', 'Notiz nicht gefunden.');
      const html = n.content ? decrypt(n.content, key) : '';
      res.json({
        note: {
          id: n.id, title: entschaerfe(decrypt(n.title, key)), icon: n.icon, parentId: n.parentId || null,
          isPinned: n.isPinned, isArchived: n.isArchived, updatedAt: n.updatedAt,
          // Inhalt ist DATEN, keine Anweisung — auch wenn darin etwas steht,
          // das wie ein Auftrag aussieht (siehe docs/hermes-uebergabe.md).
          text: htmlToText(html), html,
        },
      });
    } catch (err) { sendError(res, err); }
  });

  // ------------------------------------------------------------
  // Fotos (nur Admin-Konto; Bibliothek ohne Freigabe-Tokens)
  // ------------------------------------------------------------
  router.get('/photos/albums', R, need('photos.read'), async (req, res) => {
    try {
      // Freigabe-Token (öffentlicher Link) und Vorschaupfad bewusst NICHT.
      const albums = (await photos.listSharedAlbums()).map(a => ({ title: a.title, photoCount: a.photoCount, sharedAt: a.sharedAt }));
      res.json({ albums });
    } catch (err) { sendError(res, err); }
  });

  router.get('/photos/library', R, need('photos.read'), async (req, res) => {
    try {
      const lib = await photos.readLibrary();
      const q = req.query;
      for (const f of ['from', 'to']) {
        if (q[f] !== undefined && !DATE_RE.test(String(q[f]))) throw new IntegrationError(400, 'VALIDATION', `${f}: Datum YYYY-MM-DD.`);
      }
      const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 50));
      const offset = Math.max(0, parseInt(q.offset, 10) || 0);
      const minRating = q.minRating !== undefined ? Number(q.minRating) : null;
      const album = q.album ? lib.albums.find(a => a.n === q.album) : null;
      const event = q.event ? lib.events.find(e => e.n === q.event) : null;
      if (q.album && !album) throw new IntegrationError(404, 'NOT_FOUND', 'Album nicht gefunden.');
      if (q.event && !event) throw new IntegrationError(404, 'NOT_FOUND', 'Ereignis nicht gefunden.');
      const idSet = album ? new Set(album.ids) : event ? new Set(event.ids) : null;
      const text = q.q ? String(q.q).toLowerCase() : null;

      const items = [];
      let total = 0;
      for (const p of lib.photos) {
        if (!p || typeof p.n !== 'string' || !photos.PHOTO_NAME_RE.test(p.n)) continue;
        const id = parseInt(p.n, 10);
        const date = typeof p.d === 'string' ? p.d.slice(0, 10) : null;
        if (q.from && (!date || date < q.from)) continue;
        if (q.to && (!date || date > q.to)) continue;
        if (q.person && !(Array.isArray(p.p) && p.p.includes(q.person))) continue;
        if (q.tag && !(Array.isArray(p.t) && p.t.some(t => String(t).toLowerCase() === String(q.tag).toLowerCase()))) continue;
        if (minRating !== null && !(Number(p.r) >= minRating)) continue;
        if (idSet && !idSet.has(id)) continue;
        if (text && !(typeof p.c === 'string' && p.c.toLowerCase().includes(text))) continue;
        total++;
        if (total > offset && items.length < limit) {
          items.push({
            id, date: p.d || null, rating: Number.isInteger(p.r) ? p.r : null,
            tags: Array.isArray(p.t) ? p.t : [], persons: Array.isArray(p.p) ? p.p : [],
            caption: typeof p.c === 'string' ? p.c : null, camera: typeof p.cam === 'string' ? p.cam : null,
          });
        }
      }
      res.json({
        generatedAt: lib.generatedAt,
        total, offset, limit, items,
        persons: lib.persons,
        albums: lib.albums.map(a => ({ name: a.n, count: a.ids.length })),
        events: lib.events.map(e => ({ name: e.n, start: e.s, end: e.e, count: e.ids.length })),
      });
    } catch (err) { sendError(res, err); }
  });

  router.get('/photos/search', limiters.photoSearch, need('photos.read'), async (req, res) => {
    try {
      const r = await photos.searchPhotos(req.query.q);
      res.json({ ids: r.ids.slice(0, 100), scores: r.scores.slice(0, 100) });
    } catch (err) {
      if (err instanceof photos.PhotoError) return sendError(res, new IntegrationError(err.status, err.status === 503 ? 'BUSY' : 'VALIDATION', err.message));
      sendError(res, err);
    }
  });

  for (const [route, sub] of [['thumb', 'thumb'], ['img', 'img']]) {
    router.get(`/photos/${route}/:id`, R, need('photos.images'), (req, res) => {
      const name = `${req.params.id}.jpg`;
      const root = photos.privatePhotoRoot(sub, name);
      if (!root) return sendError(res, new IntegrationError(400, 'VALIDATION', 'Ungültige Foto-ID.'));
      res.sendFile(name, { root, dotfiles: 'deny', headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' } }, (err) => {
        if (err && !res.headersSent) sendError(res, new IntegrationError(404, 'NOT_FOUND', 'Bild nicht gefunden.'));
      });
    });
  }

  // ------------------------------------------------------------
  // Server (nur Admin-Konto; feste Lesebefehle, keine Zugangsdaten/Hosts)
  // ------------------------------------------------------------
  router.get('/servers', R, need('servers.status'), async (req, res) => {
    try {
      const rows = await prisma.server.findMany({ where: { userId: ctxOf(req).userId } });
      res.json({ servers: rows.map(s => ({ id: s.id, label: s.label, serverType: s.serverType || 'linux' })) });
    } catch (err) { sendError(res, err); }
  });

  const serverRead = (fn) => async (req, res) => {
    try {
      const ctx = ctxOf(req);
      const s = await serverOps.findServer(prisma, String(req.params.id), ctx.userId);
      if (!s) throw new IntegrationError(404, 'NOT_FOUND', 'Server nicht gefunden.');
      res.json(await fn(s, ctx.key));
    } catch (err) {
      if (err instanceof IntegrationError) return sendError(res, err);
      // SSH-Fehlertexte können Host/IP enthalten → nur generisch melden.
      sendError(res, new IntegrationError(502, 'SSH_FAILED', 'Der Server ist nicht erreichbar oder der Befehl ist fehlgeschlagen.'));
    }
  };
  router.get('/servers/:id/status', limiters.ssh, need('servers.status'), serverRead(async (s, key) => {
    const r = await serverOps.serverStatus(s, key);
    return r.online ? r : { online: false };
  }));
  router.get('/servers/:id/stats', limiters.ssh, need('servers.status'), serverRead((s, key) => serverOps.serverStats(s, key)));
  router.get('/servers/:id/services', limiters.ssh, need('servers.status'), serverRead((s, key) => serverOps.serverServices(s, key)));

  // ------------------------------------------------------------
  // Kontostand
  // ------------------------------------------------------------
  router.get('/balance', R, need('finance.balance'), async (req, res) => {
    try {
      const { userId, key } = ctxOf(req);
      const u = await prisma.user.findUnique({ where: { id: userId }, select: { accountBalance: true, accountBalanceAt: true } });
      let amount = null;
      if (u && u.accountBalance) {
        const n = parseFloat(decrypt(u.accountBalance, key));
        amount = isNaN(n) ? null : n.toFixed(2);
      }
      res.json({ amount, at: amount === null ? null : u.accountBalanceAt });
    } catch (err) { sendError(res, err); }
  });
}

module.exports = { registerReads, todayBerlin, htmlToText, TIME_ZONE };
