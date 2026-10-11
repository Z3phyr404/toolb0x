// ============================================================
// INTEGRATIONS-ZUGÄNGE — Token erzeugen, prüfen, widerrufen
// ============================================================
// Token: "tbxi_<credentialId>.<secret>" — secret = 32 Zufallsbytes
// (base64url). Der Server speichert NIE den Token, nur:
//   secretHash = SHA-256(secret)                (Nachschlagen/Vergleich)
//   wrappedKey = AES-GCM(User-Key, HKDF(secret))  (Schlüsselkopie)
// Wer den Token hat, kann damit (und nur damit) den User-Key entpacken.
// Widerruf löscht wrappedKey — danach ist der Token endgültig wertlos,
// auch wenn er irgendwo kopiert wurde.
// ============================================================

const crypto = require('crypto');
const { wrapKeyWithSecret, unwrapKeyWithSecret } = require('../utils/encryption');
const { normalizeStartDay } = require('../utils/budgetPeriod');
const { DEFAULT_SCOPES, normalizeScopes, effectiveScopes } = require('./scopes');

const TOKEN_RE = /^tbxi_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;
const MAX_ACTIVE_PER_USER = 3;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Legt einen Zugang an. Braucht den entpackten User-Key (also eine
 * angemeldete Sitzung) — die Kopie wird nur hier erzeugt.
 * @returns {{ credential, token }} token NUR in dieser Rückgabe
 */
async function createCredential(db, { userId, encryptionKey, name = 'Hermes', scopes = DEFAULT_SCOPES }) {
  const id = crypto.randomUUID();
  const secret = crypto.randomBytes(32).toString('base64url');
  const credential = await db.integrationCredential.create({
    data: {
      id,
      userId,
      name,
      scope: 'finance',
      scopes: normalizeScopes(scopes),
      secretHash: sha256(secret),
      wrappedKey: wrapKeyWithSecret(encryptionKey, secret, id),
      lastUsedAt: null,
      revokedAt: null,
    },
  });
  return { credential, token: `tbxi_${id}.${secret}` };
}

/** Widerruft einen Zugang (Schlüsselkopie weg, offene Entwürfe weg). */
async function revokeCredential(db, { id, userId }) {
  const res = await db.integrationCredential.updateMany({
    where: { id, userId, revokedAt: null },
    data: { wrappedKey: null, revokedAt: new Date() },
  });
  await db.integrationDraft.deleteMany({ where: { credentialId: id } });
  return res.count > 0;
}

/**
 * Rotation: neuer Token mit gleichem Namen und gleichen Berechtigungen, der
 * alte ist im SELBEN Schritt widerrufen. Braucht den User-Key (Sitzung).
 * @returns {{ credential, token } | null} null = alter Zugang nicht aktiv
 */
async function rotateCredential(db, { id, userId, encryptionKey }) {
  return db.$transaction(async (tx) => {
    const old = await tx.integrationCredential.findFirst({ where: { id, userId, revokedAt: null } });
    if (!old || !old.wrappedKey) return null;
    const res = await tx.integrationCredential.updateMany({
      where: { id, userId, revokedAt: null },
      data: { wrappedKey: null, revokedAt: new Date() },
    });
    if (res.count !== 1) return null;
    await tx.integrationDraft.deleteMany({ where: { credentialId: id } });
    return createCredential(tx, { userId, encryptionKey, name: old.name, scopes: normalizeScopes(old.scopes) });
  });
}

/** Berechtigungen setzen (Prüfung auf Rolle/Passwort macht der Aufrufer). */
async function setScopes(db, { id, userId, scopes }) {
  const res = await db.integrationCredential.updateMany({
    where: { id, userId, revokedAt: null },
    data: { scopes: normalizeScopes(scopes) },
  });
  return res.count > 0;
}

/** Öffentliche Sicht auf einen Zugang — ohne Hash, ohne Schlüsselkopie. */
function publicCredential(c) {
  return {
    id: c.id,
    name: c.name,
    scopes: normalizeScopes(c.scopes),
    createdAt: c.createdAt,
    lastUsedAt: c.lastUsedAt,
    revokedAt: c.revokedAt,
    active: !c.revokedAt && !!c.wrappedKey,
  };
}

/**
 * Prüft einen Bearer-Token.
 * @returns {{ ok: true, credentialId, userId, key, startDay } | { ok: false, status, code }}
 */
async function authenticate(db, token) {
  const m = TOKEN_RE.exec(token || '');
  if (!m) return { ok: false, status: 401, code: 'UNAUTHORIZED' };
  const [, id, secret] = m;

  const cred = await db.integrationCredential.findUnique({ where: { id } });
  if (!cred || cred.revokedAt || !cred.wrappedKey) return { ok: false, status: 401, code: 'UNAUTHORIZED' };

  const a = Buffer.from(sha256(secret), 'hex');
  const b = Buffer.from(String(cred.secretHash), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, status: 401, code: 'UNAUTHORIZED' };
  }

  const key = unwrapKeyWithSecret(cred.wrappedKey, secret, cred.id);
  if (!key) return { ok: false, status: 401, code: 'UNAUTHORIZED' };

  const user = await db.user.findUnique({
    where: { id: cred.userId },
    select: { suspended: true, budgetStartDay: true, role: true },
  });
  if (!user) return { ok: false, status: 401, code: 'UNAUTHORIZED' };
  if (user.suspended) return { ok: false, status: 403, code: 'ACCOUNT_SUSPENDED' };

  // lastUsedAt höchstens minütlich schreiben (Lesezugriffe sollen die DB
  // nicht bei jedem Aufruf beschreiben).
  const now = Date.now();
  if (!cred.lastUsedAt || now - new Date(cred.lastUsedAt).getTime() > 60_000) {
    await db.integrationCredential.updateMany({ where: { id: cred.id }, data: { lastUsedAt: new Date(now) } });
  }

  return {
    ok: true,
    credentialId: cred.id,
    userId: cred.userId,
    key,
    startDay: normalizeStartDay(user.budgetStartDay),
    role: user.role || 'user',
    // Rolle wird bei JEDER Anfrage neu gelesen: verliert das Konto die
    // Admin-Rolle, verfallen Foto-/Server-Rechte sofort.
    scopes: effectiveScopes(cred.scopes, user.role || 'user'),
  };
}

module.exports = {
  MAX_ACTIVE_PER_USER,
  createCredential,
  rotateCredential,
  setScopes,
  revokeCredential,
  publicCredential,
  authenticate,
  sha256,
};
