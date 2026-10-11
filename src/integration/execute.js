// ============================================================
// ENTWURF AUSFÜHREN — gemeinsamer Weg für Zephyr-Bestätigung und
// Freigabe in der App (2026-10-12)
// ============================================================
// Garantien (in EINER Transaktion):
//   - Idempotency-Key: derselbe Key liefert dasselbe Ergebnis, ein anderer
//     Inhalt mit demselben Key → 409 (Unique-Index in PostgreSQL)
//   - Entwurf gehört zu diesem Zugang, Hash passt, nicht abgelaufen,
//     nicht abgelehnt, genau EINMAL beansprucht (bedingtes updateMany)
//   - Stufe "app": nur über die App (viaApp) ausführbar
//   - Zugang noch aktiv UND Berechtigung noch erteilt (Widerruf/Abwahl
//     wirkt also auch auf bereits erstellte Entwürfe)
//   - Inhalt integritätsgeprüft entschlüsselt und gegen den Hash geprüft
// Externe Aktionen (Server) laufen nach dem Commit; ihr Ergebnis wird im
// Write-Datensatz nachgetragen ("running" → "done" | "failed").
// ============================================================

const { encrypt, decryptStrict } = require('../utils/encryption');
const { effectiveScopes } = require('./scopes');
const { ACTIONS, IntegrationError, stableStringify, sha256 } = require('./actions');

// Laufende externe Aktionen (nur für Tests abwartbar)
const runningExternal = new Map();

function replayOf(prior, requestHash, ctx) {
  if (prior.requestHash !== requestHash) {
    throw new IntegrationError(409, 'IDEMPOTENCY_CONFLICT', 'Dieser Idempotency-Key wurde bereits für eine andere Bestätigung verwendet.');
  }
  const stored = JSON.parse(decryptStrict(prior.result, ctx.key));
  return { status: 200, body: { ...stored.body, replayed: true }, replayed: true, action: prior.action };
}

/**
 * @param prisma  Prisma-Client
 * @param ctx     { userId, key, startDay, credentialId, role }
 * @param opts    { draftId, idempotencyKey, contentHash, viaApp }
 * @returns {{ status, body, action, replayed? }}
 */
async function executeDraft(prisma, ctx, { draftId, idempotencyKey, contentHash, viaApp = false }) {
  const requestHash = sha256(`${draftId}:${contentHash}`);
  let external = null;

  const out = await prisma.$transaction(async (tx) => {
    const prior = await tx.integrationWrite.findUnique({
      where: { credentialId_idempotencyKey: { credentialId: ctx.credentialId, idempotencyKey } },
    });
    if (prior) return replayOf(prior, requestHash, ctx);

    const draft = await tx.integrationDraft.findFirst({ where: { id: draftId, credentialId: ctx.credentialId } });
    if (!draft) throw new IntegrationError(404, 'DRAFT_NOT_FOUND', 'Entwurf nicht gefunden.');
    if (draft.contentHash !== contentHash) throw new IntegrationError(409, 'HASH_MISMATCH', 'Die Bestätigung passt nicht zu diesem Entwurf.');
    if ((draft.level || 'auto') === 'app' && !viaApp) {
      throw new IntegrationError(403, 'APP_APPROVAL_REQUIRED', 'Diese Aktion muss Michael in toolb0x freigeben (Profil → Hermes-Zugang → Offene Freigaben).');
    }
    if (draft.decision === 'rejected') throw new IntegrationError(409, 'DRAFT_REJECTED', 'Dieser Entwurf wurde abgelehnt.');
    if (draft.usedAt) throw new IntegrationError(409, 'DRAFT_USED', 'Dieser Entwurf wurde bereits verwendet.');
    if (new Date(draft.expiresAt) < new Date()) throw new IntegrationError(410, 'DRAFT_EXPIRED', 'Der Entwurf ist abgelaufen. Bitte neu erstellen.');

    // Zugang und Berechtigung NOCH gültig? (zwischen Entwurf und Ausführung
    // kann widerrufen oder die Berechtigung abgewählt worden sein)
    const cred = await tx.integrationCredential.findUnique({ where: { id: ctx.credentialId } });
    if (!cred || cred.revokedAt || !cred.wrappedKey || cred.userId !== ctx.userId) {
      throw new IntegrationError(401, 'UNAUTHORIZED', 'Zugang ungültig oder widerrufen.');
    }
    const user = await tx.user.findUnique({ where: { id: ctx.userId }, select: { role: true, suspended: true } });
    if (!user || user.suspended) throw new IntegrationError(403, 'ACCOUNT_SUSPENDED', 'Konto gesperrt.');
    const draftScope = draft.scope || 'finance.write';
    if (!effectiveScopes(cred.scopes, user.role || 'user').includes(draftScope)) {
      throw new IntegrationError(403, 'SCOPE_MISSING', `Berechtigung ${draftScope} ist nicht (mehr) erteilt.`);
    }

    const claim = await tx.integrationDraft.updateMany({
      where: { id: draft.id, usedAt: null },
      data: { usedAt: new Date(), ...(viaApp ? { decision: 'approved', decidedAt: new Date() } : {}) },
    });
    if (claim.count !== 1) throw new IntegrationError(409, 'DRAFT_USED', 'Dieser Entwurf wurde bereits verwendet.');

    let payload;
    try { payload = JSON.parse(decryptStrict(draft.payload, ctx.key)); } catch { payload = null; }
    const spec = payload && Object.prototype.hasOwnProperty.call(ACTIONS, payload.action) ? ACTIONS[payload.action] : null;
    if (!payload || !spec || sha256(stableStringify(payload)) !== draft.contentHash
        || payload.action !== draft.action || spec.scope !== draftScope) {
      throw new IntegrationError(409, 'HASH_MISMATCH', 'Der Entwurf wurde verändert und wird nicht ausgeführt.');
    }

    let status;
    let responseBody;
    if (spec.external) {
      const target = await spec.check(tx, ctx, payload.params, payload.version);
      status = 202;
      responseBody = { ok: true, draftId: draft.id, action: payload.action, targetType: 'server', targetId: payload.params.id, state: 'running' };
      external = { spec, params: payload.params, target, body: responseBody };
    } else {
      const result = await spec.execute(tx, ctx, payload.params, payload.version);
      ({ status } = result);
      const { status: _s, ...rest } = result;
      responseBody = { ok: true, draftId: draft.id, action: payload.action, ...rest };
    }

    await tx.integrationWrite.create({
      data: {
        credentialId: ctx.credentialId,
        userId: ctx.userId,
        idempotencyKey,
        requestHash,
        draftId: draft.id,
        action: payload.action,
        targetType: responseBody.targetType || 'none',
        targetId: responseBody.targetId || null,
        month: responseBody.month || null,
        result: encrypt(JSON.stringify({ status, body: responseBody }), ctx.key),
      },
    });
    return { status, body: responseBody, action: payload.action };
  }, { maxWait: 10000, timeout: 15000 });

  if (external) {
    const job = (async () => {
      let finalBody;
      try {
        const result = await external.spec.run(ctx, external.params, external.target);
        finalBody = { ...external.body, state: result && result.success === false ? 'failed' : 'done', result };
      } catch (err) {
        // Nur die Meldung, keine Zugangsdaten (die stehen nie in Fehlertexten
        // von services/servers.js); Host/IP wird bewusst nicht mitgeliefert.
        finalBody = { ...external.body, state: 'failed', result: { success: false, error: err.status ? err.message : 'SSH-Aktion fehlgeschlagen.' } };
      }
      await prisma.integrationWrite.updateMany({
        where: { draftId: external.body.draftId },
        data: { result: encrypt(JSON.stringify({ status: 200, body: finalBody }), ctx.key) },
      });
      console.log(`[integration] external ${external.body.action} cred=${ctx.credentialId.slice(0, 8)} state=${finalBody.state}`);
    })().catch(err => console.error('[integration] externe Aktion: Ergebnis nicht gespeichert:', err.message))
      .finally(() => runningExternal.delete(external.body.draftId));
    runningExternal.set(external.body.draftId, job);
  }
  return out;
}

/** Status eines Entwurfs für Zephyr (GET /v1/drafts/:id). */
async function draftStatus(prisma, ctx, draftId) {
  const draft = await prisma.integrationDraft.findFirst({ where: { id: draftId, credentialId: ctx.credentialId } });
  if (!draft) throw new IntegrationError(404, 'DRAFT_NOT_FOUND', 'Entwurf nicht gefunden.');
  const base = { draftId: draft.id, action: draft.action, scope: draft.scope, level: draft.level, expiresAt: draft.expiresAt };
  const write = await prisma.integrationWrite.findUnique({ where: { draftId: draft.id } });
  if (write) {
    const stored = JSON.parse(decryptStrict(write.result, ctx.key));
    return { ...base, status: 'executed', result: stored.body };
  }
  if (draft.decision === 'rejected') return { ...base, status: 'rejected' };
  if (new Date(draft.expiresAt) < new Date()) return { ...base, status: 'expired' };
  return { ...base, status: draft.level === 'app' ? 'pending_approval' : 'open' };
}

module.exports = { executeDraft, draftStatus, replayOf, runningExternal };
