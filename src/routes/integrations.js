// ============================================================
// INTEGRATIONS-VERWALTUNG — /api/integrations (angemeldet, in der App)
// ============================================================
// Hier erzeugt und widerruft der Nutzer seinen Hermes-Zugang. Nur über
// die normale Sitzung (requireAuth): nur hier liegt der entpackte
// User-Key vor, aus dem die Schlüsselkopie für den Zugang entsteht.
//
// GET    /            → eigene Zugänge (ohne Hash, ohne Schlüsselkopie)
// POST   /            → { password, name? } — neuer Zugang; Token NUR in
//                        dieser Antwort (danach nie wieder abrufbar)
// DELETE /:id         → Zugang widerrufen (sofort wirksam)
//
// Der Zugang selbst wird NICHT hier benutzt, sondern über den lokalen
// Listener (src/integration/app.js, 127.0.0.1:3001).
// ============================================================

const express = require('express');
const bcrypt = require('bcrypt');
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { sanitize } = require('../utils/validation');
const {
  MAX_ACTIVE_PER_USER, createCredential, revokeCredential, publicCredential, rotateCredential, setScopes,
} = require('../integration/credentials');
const { SCOPES, isKnownScope, allowedForRole, normalizeScopes, describeScopes } = require('../integration/scopes');
const { executeDraft } = require('../integration/execute');
const { decryptStrict } = require('../utils/encryption');
const { IntegrationError } = require('../integration/actions');

const router = express.Router();
router.use(requireAuth);

async function checkPassword(req, password) {
  if (typeof password !== 'string' || !password) return false;
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  return !!user && bcrypt.compare(password, user.password);
}

async function roleOf(req) {
  const u = await prisma.user.findUnique({ where: { id: req.userId }, select: { role: true } });
  return (u && u.role) || 'user';
}

router.get('/', async (req, res) => {
  try {
    const role = await roleOf(req);
    const rows = await prisma.integrationCredential.findMany({ where: { userId: req.userId } });
    const credentials = rows
      .map(c => ({ ...publicCredential(c), scopeDetails: describeScopes(normalizeScopes(c.scopes), role) }))
      .sort((a, b) => (b.active - a.active) || (new Date(b.createdAt) - new Date(a.createdAt)));
    res.json({ credentials });
  } catch (error) {
    console.error('Integrationen laden fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Zugänge konnten nicht geladen werden.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { password } = req.body || {};
    if (typeof password !== 'string' || !password) {
      return res.status(400).json({ errors: ['Bitte bestätige mit deinem Passwort.'] });
    }
    const rawName = typeof req.body.name === 'string' ? sanitize(req.body.name) : '';
    const name = rawName ? rawName.slice(0, 40) : 'Hermes';

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ errors: ['Das Passwort ist falsch.'] });
    }

    const active = (await prisma.integrationCredential.findMany({ where: { userId: req.userId, revokedAt: null } }))
      .filter(c => c.wrappedKey);
    if (active.length >= MAX_ACTIVE_PER_USER) {
      return res.status(400).json({ errors: [`Höchstens ${MAX_ACTIVE_PER_USER} aktive Zugänge. Bitte zuerst einen widerrufen.`] });
    }

    const { credential, token } = await createCredential(prisma, {
      userId: req.userId,
      encryptionKey: req.encryptionKey,
      name,
    });
    console.log(`[integration] created cred=${credential.id.slice(0, 8)}`);
    res.status(201).json({ credential: publicCredential(credential), token });
  } catch (error) {
    console.error('Integration anlegen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Zugang konnte nicht angelegt werden.' });
  }
});

// ------------------------------------------------------------
// Berechtigungen setzen. Einschalten neuer Rechte braucht das Passwort,
// Abschalten nicht (Rechte zu verringern ist immer erlaubt).
// PUT /:id/scopes { scopes: [...], password? }
// ------------------------------------------------------------
router.put('/:id/scopes', async (req, res) => {
  try {
    const wanted = req.body && req.body.scopes;
    if (!Array.isArray(wanted) || wanted.some(s => typeof s !== 'string' || !isKnownScope(s))) {
      return res.status(400).json({ errors: ['Unbekannte Berechtigung.'] });
    }
    const cred = await prisma.integrationCredential.findFirst({ where: { id: req.params.id, userId: req.userId, revokedAt: null } });
    if (!cred || !cred.wrappedKey) return res.status(404).json({ error: 'Zugang nicht gefunden oder widerrufen.' });
    const role = await roleOf(req);
    const notAllowed = wanted.filter(s => !allowedForRole(s, role));
    if (notAllowed.length) return res.status(403).json({ errors: [`Nur für Admin-Konten: ${notAllowed.join(', ')}`] });
    const current = normalizeScopes(cred.scopes);
    const added = [...new Set(wanted)].filter(s => !current.includes(s));
    if (added.length && !(await checkPassword(req, req.body.password))) {
      return res.status(401).json({ errors: ['Zum Einschalten neuer Berechtigungen bitte mit deinem Passwort bestätigen.'] });
    }
    await setScopes(prisma, { id: cred.id, userId: req.userId, scopes: wanted });
    const removed = current.filter(s => !wanted.includes(s));
    console.log(`[integration] scopes cred=${cred.id.slice(0, 8)} added=${added.join(',') || '-'} removed=${removed.join(',') || '-'}`);
    res.json({ scopes: normalizeScopes(wanted) });
  } catch (error) {
    console.error('Berechtigungen setzen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Berechtigungen konnten nicht gespeichert werden.' });
  }
});

// Rotation: neuer Schlüssel, alter sofort ungültig. POST /:id/rotate { password }
router.post('/:id/rotate', async (req, res) => {
  try {
    if (!(await checkPassword(req, (req.body || {}).password))) {
      return res.status(401).json({ errors: ['Das Passwort ist falsch.'] });
    }
    const rotated = await rotateCredential(prisma, { id: req.params.id, userId: req.userId, encryptionKey: req.encryptionKey });
    if (!rotated) return res.status(404).json({ error: 'Zugang nicht gefunden oder widerrufen.' });
    console.log(`[integration] rotated cred=${req.params.id.slice(0, 8)} -> ${rotated.credential.id.slice(0, 8)}`);
    res.status(201).json({ credential: publicCredential(rotated.credential), token: rotated.token });
  } catch (error) {
    console.error('Rotation fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Der Schlüssel konnte nicht erneuert werden.' });
  }
});

// ------------------------------------------------------------
// Offene Freigaben (Entwürfe der Stufe "app")
// ------------------------------------------------------------
// Nur hier — mit Michaels angemeldeter Sitzung — können solche Entwürfe
// ausgeführt werden. Zephyr sieht nur den Status.
router.get('/approvals', async (req, res) => {
  try {
    const now = new Date();
    const creds = await prisma.integrationCredential.findMany({ where: { userId: req.userId, revokedAt: null } });
    const active = new Map(creds.filter(c => c.wrappedKey).map(c => [c.id, c]));
    const drafts = await prisma.integrationDraft.findMany({ where: { userId: req.userId, level: 'app', usedAt: null } });
    const approvals = [];
    for (const d of drafts) {
      if (d.decision || new Date(d.expiresAt) < now || !active.has(d.credentialId)) continue;
      let summary = null;
      try { summary = JSON.parse(decryptStrict(d.summary, req.encryptionKey)); } catch { summary = null; }
      approvals.push({
        id: d.id,
        action: d.action,
        scope: d.scope,
        scopeLabel: SCOPES[d.scope] ? SCOPES[d.scope].label : d.scope,
        credentialName: active.get(d.credentialId).name,
        summary,
        contentHash: d.contentHash,
        createdAt: d.createdAt,
        expiresAt: d.expiresAt,
      });
    }
    approvals.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    res.json({ approvals });
  } catch (error) {
    console.error('Freigaben laden fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Freigaben konnten nicht geladen werden.' });
  }
});

// POST /approvals/:id/approve { contentHash } — führt den Entwurf aus
router.post('/approvals/:id/approve', async (req, res) => {
  try {
    const contentHash = (req.body || {}).contentHash;
    const draft = await prisma.integrationDraft.findFirst({ where: { id: req.params.id, userId: req.userId, level: 'app' } });
    if (!draft) return res.status(404).json({ error: 'Freigabe nicht gefunden.' });
    if (typeof contentHash !== 'string' || contentHash !== draft.contentHash) {
      return res.status(409).json({ error: 'Die Freigabe passt nicht (mehr) zu diesem Entwurf. Bitte Seite neu laden.' });
    }
    const out = await executeDraft(prisma, {
      userId: req.userId,
      key: req.encryptionKey,
      startDay: req.budgetStartDay,
      credentialId: draft.credentialId,
      role: await roleOf(req),
    }, { draftId: draft.id, idempotencyKey: `app-approval-${draft.id}`, contentHash, viaApp: true });
    console.log(`[integration] approved-in-app cred=${draft.credentialId.slice(0, 8)} action=${draft.action} status=${out.status}`);
    res.status(out.status).json(out.body);
  } catch (error) {
    if (error instanceof IntegrationError) return res.status(error.status).json({ error: error.message, code: error.code });
    if (error && error.code === 'P2002') return res.status(409).json({ error: 'Diese Freigabe wurde bereits ausgeführt.' });
    console.error('Freigabe fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Die Freigabe ist fehlgeschlagen. Es wurde nichts ausgeführt.' });
  }
});

// POST /approvals/:id/reject — endgültig ablehnen
router.post('/approvals/:id/reject', async (req, res) => {
  try {
    const now = new Date();
    const r = await prisma.integrationDraft.updateMany({
      where: { id: req.params.id, userId: req.userId, level: 'app', usedAt: null, decision: null },
      data: { decision: 'rejected', decidedAt: now, usedAt: now },
    });
    if (r.count !== 1) return res.status(404).json({ error: 'Freigabe nicht gefunden oder schon entschieden.' });
    console.log(`[integration] rejected-in-app draft=${req.params.id.slice(0, 8)}`);
    res.json({ message: 'Abgelehnt.' });
  } catch (error) {
    console.error('Ablehnen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Ablehnen fehlgeschlagen.' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const ok = await revokeCredential(prisma, { id: req.params.id, userId: req.userId });
    if (!ok) return res.status(404).json({ error: 'Zugang nicht gefunden oder schon widerrufen.' });
    console.log(`[integration] revoked cred=${req.params.id.slice(0, 8)}`);
    res.json({ message: 'Zugang widerrufen.' });
  } catch (error) {
    console.error('Integration widerrufen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Zugang konnte nicht widerrufen werden.' });
  }
});

module.exports = router;
