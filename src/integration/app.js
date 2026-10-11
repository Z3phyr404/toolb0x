// ============================================================
// INTEGRATIONS-LISTENER — lokaler Zugang für Zephyr/Hermes
// ============================================================
// 2026-10-11: Finanzzugang. 2026-10-12: einzeln schaltbare Berechtigungen
// (src/integration/scopes.js) und Freigabestufen (auto | chat | app).
//
// Eigene Express-App auf einem EIGENEN Port, gebunden an 127.0.0.1.
// nginx leitet nur an Port 3000 weiter — dieser Listener ist von außen
// also technisch nicht erreichbar, selbst wenn nginx /api komplett
// durchreicht. Zusätzlich lehnt er alles ab, was nicht von Loopback kommt
// oder Proxy-Header trägt.
//
// Kein Cookie, kein Login, kein Admin-Token: Authentifizierung NUR per
// Dauer-Token (Authorization: Bearer tbxi_…). Jede Route verlangt ihre
// Berechtigung; jede Änderung läuft über Entwurf → Bestätigung
// (contentHash + Idempotency-Key), Stufe "app" nur über die App.
// Es gibt bewusst KEINE Shell-, SQL- oder freien Proxy-Endpunkte.
// Doku: docs/hermes-integration.md
// ============================================================

const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const prisma = require('../utils/prisma');
const finance = require('../services/finance');
const { encrypt, decrypt } = require('../utils/encryption');
const { entschaerfe } = require('../utils/legacyText');
const { currentPeriod, periodRange } = require('../utils/budgetPeriod');
const { authenticate, revokeCredential } = require('./credentials');
const { ACTIONS, IntegrationError, stableStringify, sha256, publicExpense, publicIncome } = require('./actions');
const { describeScopes, normalizeScopes, isKnownScope } = require('./scopes');
const { executeDraft, draftStatus, replayOf } = require('./execute');
const { registerReads } = require('./reads');

const DRAFT_TTL_MS = 10 * 60 * 1000;
// Entwürfe, die Michael in der App freigeben muss, brauchen mehr Zeit.
const APP_DRAFT_TTL_MS = 72 * 60 * 60 * 1000;
const MAX_OPEN_DRAFTS = 50;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Audit: nur Metadaten. Niemals Token, Schlüssel, Beträge, Namen, Inhalte.
function audit(event, req, extra = {}) {
  const parts = [`[integration] ${event}`];
  if (req.integration) parts.push(`cred=${req.integration.credentialId.slice(0, 8)}`);
  for (const [k, v] of Object.entries(extra)) parts.push(`${k}=${v}`);
  console.log(parts.join(' '));
}

function sendError(res, err) {
  if (err instanceof IntegrationError) {
    return res.status(err.status).json({ error: err.code, message: err.message, ...(err.errors ? { errors: err.errors } : {}) });
  }
  // Transaktion konnte nicht rechtzeitig starten (viele parallele Schreib-
  // vorgänge warten auf dieselbe Sperre). Es wurde nichts gespeichert —
  // gefahrlos mit demselben Idempotency-Key wiederholbar.
  if (err && err.code === 'P2028') {
    return res.status(503).json({ error: 'BUSY', message: 'Gerade ausgelastet. Bitte mit demselben Idempotency-Key erneut senden.' });
  }
  console.error('[integration] interner Fehler:', err && err.message);
  return res.status(500).json({ error: 'INTERNAL', message: 'Interner Fehler. Es wurde nichts gespeichert.' });
}

// ------------------------------------------------------------
// Middleware
// ------------------------------------------------------------

function loopbackOnly(req, res, next) {
  const fromLoopback = LOOPBACK.has(req.socket.remoteAddress);
  const viaProxy = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers.forwarded;
  if (!fromLoopback || viaProxy) {
    return res.status(403).json({ error: 'LOCAL_ONLY', message: 'Nur lokal erreichbar.' });
  }
  next();
}

const envInt = (name, fallback) => parseInt(process.env[name], 10) || fallback;

function makeLimiters() {
  const common = { windowMs: 15 * 60 * 1000, standardHeaders: true, legacyHeaders: false };
  const perCred = (name, fallback, message) => rateLimit({
    ...common,
    max: envInt(name, fallback),
    keyGenerator: req => req.integration.credentialId,
    message: { error: 'RATE_LIMITED', message },
  });
  return {
    // Fehlgeschlagene Anmeldungen (alles kommt von 127.0.0.1 → global).
    authFail: rateLimit({
      ...common,
      max: envInt('INTEGRATION_RATE_AUTH_FAIL', 30),
      skipSuccessfulRequests: true,
      message: { error: 'RATE_LIMITED', message: 'Zu viele fehlgeschlagene Anmeldungen.' },
    }),
    read: perCred('INTEGRATION_RATE_READ', 300, 'Zu viele Leseanfragen.'),
    write: perCred('INTEGRATION_RATE_WRITE', 60, 'Zu viele Schreibanfragen. Bitte warte einen Moment.'),
    // SSH auf fremde Server: eng.
    ssh: perCred('INTEGRATION_RATE_SSH', 30, 'Zu viele Server-Abfragen.'),
    // KI-Fotosuche kostet echte CPU-Inferenz.
    photoSearch: perCred('INTEGRATION_RATE_PHOTO_SEARCH', 60, 'Zu viele Fotosuchen.'),
  };
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

async function requireIntegration(req, res, next) {
  try {
    const result = await authenticate(prisma, bearer(req));
    if (!result.ok) {
      audit('auth-failed', req, { status: result.status });
      return res.status(result.status).json({
        error: result.code,
        message: result.status === 403 ? 'Konto gesperrt.' : 'Zugang ungültig oder widerrufen.',
      });
    }
    req.integration = result;
    next();
  } catch (err) {
    sendError(res, err);
  }
}

// Berechtigung prüfen (wird bei JEDER Anfrage frisch aus der DB gelesen).
function need(scope) {
  return (req, res, next) => {
    if (req.integration.scopes.includes(scope)) return next();
    audit('scope-denied', req, { scope });
    res.status(403).json({ error: 'SCOPE_MISSING', message: `Berechtigung ${scope} ist nicht erteilt. Freischalten kann nur Michael in toolb0x.` });
  };
}

const ctxOf = req => ({
  userId: req.integration.userId,
  key: req.integration.key,
  startDay: req.integration.startDay,
  credentialId: req.integration.credentialId,
  role: req.integration.role,
});

function monthParam(req) {
  const month = req.query.month || currentPeriod(req.integration.startDay);
  if (typeof month !== 'string' || !MONTH.test(month)) {
    throw new IntegrationError(400, 'VALIDATION', 'Ungültiges Monatsformat, erwartet YYYY-MM.');
  }
  return month;
}

const sumCents = list => list.reduce((s, v) => s + finance.toCents(v), 0) / 100;

// ------------------------------------------------------------
// Router
// ------------------------------------------------------------

function createRouter(limiters) {
  const router = express.Router();
  router.use(limiters.authFail, requireIntegration);

  // ---------- Status: Berechtigungen und Freigabestufen ----------
  router.get('/status', limiters.read, (req, res) => {
    const { startDay, scopes, role } = req.integration;
    const cur = currentPeriod(startDay);
    res.json({
      budgetStartDay: startDay,
      currentPeriod: cur,
      period: periodRange(cur, startDay),
      draftTtlSeconds: DRAFT_TTL_MS / 1000,
      appApprovalTtlSeconds: APP_DRAFT_TTL_MS / 1000,
      scopes: describeScopes(scopes, role),
      // Freigabestufe je Aktion — Zephyr richtet sein Verhalten danach:
      // auto = ohne Rückfrage, chat = vorher im Chat fragen,
      // app = Michael gibt in toolb0x frei (technisch erzwungen).
      actions: Object.entries(ACTIONS).map(([name, a]) => ({
        name, scope: a.scope, level: a.level, granted: scopes.includes(a.scope),
      })),
    });
  });

  // ---------- Finanzen lesen (ohne Nebenwirkungen) ----------
  router.get('/categories', limiters.read, need('finance.read'), async (req, res) => {
    try {
      const { userId, key } = ctxOf(req);
      const rows = await prisma.category.findMany({ where: { userId } });
      const categories = rows
        .map(c => ({ id: c.id, name: entschaerfe(decrypt(c.name, key)) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'de'));
      res.json({ categories });
    } catch (err) { sendError(res, err); }
  });

  router.get('/expenses', limiters.read, need('finance.read'), async (req, res) => {
    try {
      const ctx = ctxOf(req);
      const month = monthParam(req);
      const rows = await prisma.expense.findMany({ where: { userId: ctx.userId, month }, include: finance.EXPENSE_INCLUDE });
      const expenses = rows.map(e => publicExpense(finance.decryptExpense(e, ctx.key)));
      expenses.sort((a, b) => (b.spentOn || '').localeCompare(a.spentOn || ''));
      res.json({
        month,
        period: periodRange(month, ctx.startDay),
        // false = Monat wurde noch nie geöffnet; wiederkehrende Einträge
        // (Miete, Abos) erscheinen erst nach dem Öffnen in der App oder
        // beim ersten bestätigten Schreibvorgang in diesen Monat.
        initialized: await finance.isMonthInitialized(prisma, ctx.userId, month, 'expense'),
        expenses,
        total: sumCents(expenses.map(e => e.amount)),
      });
    } catch (err) { sendError(res, err); }
  });

  router.get('/income', limiters.read, need('finance.read'), async (req, res) => {
    try {
      const ctx = ctxOf(req);
      const month = monthParam(req);
      const rows = await prisma.income.findMany({ where: { userId: ctx.userId, month } });
      const incomes = rows.map(i => publicIncome(finance.decryptIncome(i, ctx.key)));
      res.json({
        month,
        initialized: await finance.isMonthInitialized(prisma, ctx.userId, month, 'income'),
        incomes,
        total: sumCents(incomes.map(i => i.amount)),
      });
    } catch (err) { sendError(res, err); }
  });

  router.get('/summary', limiters.read, need('finance.read'), async (req, res) => {
    try {
      res.json(await finance.computeSummary(prisma, ctxOf(req), monthParam(req)));
    } catch (err) { sendError(res, err); }
  });

  router.get('/history', limiters.read, need('finance.read'), async (req, res) => {
    try {
      const n = Math.min(24, Math.max(3, parseInt(req.query.months, 10) || 12));
      res.json(await finance.computeHistory(prisma, ctxOf(req), monthParam(req), n));
    } catch (err) { sendError(res, err); }
  });

  // ---------- Weitere Bereiche lesen (reads.js) ----------
  registerReads(router, { need, limiters, ctxOf, sendError });

  // Was dieser Zugang geschrieben hat (nur Metadaten).
  router.get('/writes', limiters.read, async (req, res) => {
    try {
      const rows = await prisma.integrationWrite.findMany({ where: { credentialId: req.integration.credentialId } });
      const writes = rows
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 50)
        .map(w => ({ action: w.action, targetType: w.targetType, targetId: w.targetId, month: w.month, createdAt: w.createdAt }));
      res.json({ writes });
    } catch (err) { sendError(res, err); }
  });

  // ---------- Schreiben: Entwurf ----------
  router.post('/drafts', limiters.write, async (req, res) => {
    try {
      const body = req.body || {};
      const extra = Object.keys(body).filter(k => k !== 'action' && k !== 'params');
      if (extra.length) throw new IntegrationError(400, 'VALIDATION', 'Unbekannte Felder.', extra.map(k => `Unbekanntes Feld: ${k}`));
      const spec = Object.prototype.hasOwnProperty.call(ACTIONS, body.action) ? ACTIONS[body.action] : null;
      if (!spec) throw new IntegrationError(400, 'UNKNOWN_ACTION', `Unbekannte Aktion. Erlaubt: ${Object.keys(ACTIONS).join(', ')}`);
      if (!req.integration.scopes.includes(spec.scope)) {
        audit('scope-denied', req, { scope: spec.scope, action: body.action });
        throw new IntegrationError(403, 'SCOPE_MISSING', `Berechtigung ${spec.scope} ist nicht erteilt. Freischalten kann nur Michael in toolb0x.`);
      }

      const ctx = ctxOf(req);
      const prepared = await spec.prepare(prisma, ctx, body.params);
      const payload = { action: body.action, params: prepared.params, version: prepared.version };
      const contentHash = sha256(stableStringify(payload));

      const now = new Date();
      await prisma.integrationDraft.deleteMany({ where: { credentialId: ctx.credentialId, expiresAt: { lt: now } } });
      const open = await prisma.integrationDraft.findMany({ where: { credentialId: ctx.credentialId } });
      if (open.length >= MAX_OPEN_DRAFTS) {
        throw new IntegrationError(429, 'TOO_MANY_DRAFTS', 'Zu viele offene Entwürfe. Bitte bestätigen oder ablaufen lassen.');
      }

      const expiresAt = new Date(now.getTime() + (spec.level === 'app' ? APP_DRAFT_TTL_MS : DRAFT_TTL_MS));
      const draft = await prisma.integrationDraft.create({
        data: {
          id: crypto.randomUUID(),
          credentialId: ctx.credentialId,
          userId: ctx.userId,
          action: body.action,
          scope: spec.scope,
          level: spec.level,
          payload: encrypt(JSON.stringify(payload), ctx.key),
          summary: encrypt(JSON.stringify(prepared.summary), ctx.key),
          contentHash,
          expiresAt,
          usedAt: null,
          decision: null,
        },
      });
      audit('draft', req, { action: body.action, level: spec.level, draft: draft.id.slice(0, 8) });
      res.status(201).json({
        draftId: draft.id, action: body.action, scope: spec.scope, level: spec.level,
        contentHash, expiresAt, summary: prepared.summary,
        ...(spec.level === 'app' ? { next: 'Michael muss diesen Entwurf in toolb0x freigeben (Profil → Hermes-Zugang → Offene Freigaben). Status: GET /v1/drafts/<draftId>.' } : {}),
      });
    } catch (err) { sendError(res, err); }
  });

  // ---------- Status eines Entwurfs (v. a. für App-Freigaben) ----------
  router.get('/drafts/:id', limiters.read, async (req, res) => {
    try {
      if (!UUID.test(req.params.id)) throw new IntegrationError(404, 'DRAFT_NOT_FOUND', 'Entwurf nicht gefunden.');
      res.json(await draftStatus(prisma, ctxOf(req), req.params.id));
    } catch (err) { sendError(res, err); }
  });

  // ---------- Schreiben: Bestätigung durch Zephyr ----------
  router.post('/drafts/:id/confirm', limiters.write, async (req, res) => {
    const ctx = ctxOf(req);
    const draftId = req.params.id;
    const idempotencyKey = req.get('Idempotency-Key');
    try {
      if (!UUID.test(draftId)) throw new IntegrationError(404, 'DRAFT_NOT_FOUND', 'Entwurf nicht gefunden.');
      if (!idempotencyKey) throw new IntegrationError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Header Idempotency-Key fehlt.');
      if (!IDEMPOTENCY_RE.test(idempotencyKey)) throw new IntegrationError(400, 'VALIDATION', 'Idempotency-Key: 16–128 Zeichen aus A–Z, a–z, 0–9, _ und -.');
      const body = req.body || {};
      const extra = Object.keys(body).filter(k => k !== 'contentHash');
      if (extra.length || typeof body.contentHash !== 'string' || !HASH_RE.test(body.contentHash)) {
        throw new IntegrationError(400, 'VALIDATION', 'Erwartet genau { contentHash } aus dem Entwurf.');
      }
      const out = await executeDraft(prisma, ctx, { draftId, idempotencyKey, contentHash: body.contentHash });
      audit(out.replayed ? 'confirm-replay' : 'confirm', req, { action: out.action || '-', status: out.status });
      res.status(out.status).json(out.body);
    } catch (err) {
      // Wettlauf um denselben Idempotency-Key (PostgreSQL: Unique-Verletzung):
      // die andere Anfrage hat gewonnen → deren Ergebnis liefern.
      if (err && err.code === 'P2002' && idempotencyKey) {
        try {
          const prior = await prisma.integrationWrite.findUnique({
            where: { credentialId_idempotencyKey: { credentialId: ctx.credentialId, idempotencyKey } },
          });
          if (prior) {
            const out = replayOf(prior, sha256(`${draftId}:${(req.body || {}).contentHash}`), ctx);
            audit('confirm-replay', req, { status: out.status });
            return res.status(out.status).json(out.body);
          }
        } catch (inner) { return sendError(res, inner); }
      }
      if (err instanceof IntegrationError) audit('confirm-rejected', req, { code: err.code });
      sendError(res, err);
    }
  });

  // ---------- Selbstbeschränkung: Berechtigung abgeben ----------
  // Zephyr kann Rechte nur VERRINGERN, nie erweitern.
  router.post('/scopes/drop', async (req, res) => {
    try {
      const scope = (req.body || {}).scope;
      if (typeof scope !== 'string' || !isKnownScope(scope)) throw new IntegrationError(400, 'VALIDATION', 'scope: unbekannte Berechtigung.');
      const cred = await prisma.integrationCredential.findUnique({ where: { id: req.integration.credentialId } });
      const remaining = normalizeScopes(cred.scopes).filter(s => s !== scope);
      await prisma.integrationCredential.updateMany({ where: { id: cred.id, revokedAt: null }, data: { scopes: remaining } });
      audit('scope-dropped', req, { scope });
      res.json({ dropped: scope, scopes: remaining });
    } catch (err) { sendError(res, err); }
  });

  // ---------- Selbst-Widerruf („Zephyr, Zugang sperren") ----------
  router.post('/revoke', async (req, res) => {
    try {
      await revokeCredential(prisma, { id: req.integration.credentialId, userId: req.integration.userId });
      audit('revoked-by-integration', req);
      res.json({ revoked: true });
    } catch (err) { sendError(res, err); }
  });

  return router;
}

function createIntegrationApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(loopbackOnly);
  // Notizen können lang sein (bis 100.000 Zeichen Text); sonst kleine Bodies.
  app.use(express.json({ limit: '256kb' }));
  app.use('/v1', createRouter(makeLimiters()));
  app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'Unbekannter Endpunkt.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'VALIDATION', message: 'Ungültiges JSON.' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'TOO_LARGE', message: 'Anfrage zu groß.' });
    sendError(res, err);
  });
  return app;
}

/**
 * Startet den Listener — IMMER auf 127.0.0.1, unabhängig von HOST.
 * INTEGRATION_PORT=0 schaltet ihn ab.
 */
function startIntegrationServer() {
  const port = process.env.INTEGRATION_PORT === undefined ? 3001 : parseInt(process.env.INTEGRATION_PORT, 10);
  if (!port) return null;
  const server = createIntegrationApp().listen(port, '127.0.0.1', () => {
    console.log(`🤖 Integration: http://127.0.0.1:${port}/v1 (nur lokal)`);
  });
  // Port belegt o. ä.: nur die Integration fällt aus, nicht die ganze App.
  server.on('error', (err) => {
    console.error(`[integration] Listener auf 127.0.0.1:${port} nicht gestartet: ${err.code || err.message}`);
  });
  return server;
}

module.exports = { createIntegrationApp, startIntegrationServer, sendError };
