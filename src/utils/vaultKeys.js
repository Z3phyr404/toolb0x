// ============================================================
// TRESOR-SCHLÜSSEL — Zugriff auf geteilte Tresore
// ============================================================
// Jeder Tresor hat einen eigenen AES-256-Schlüssel. Pro Mitglied
// liegt er RSA-verschlüsselt in VaultMember.wrappedKey.
//
// Entpacken für einen User (nur während dessen Session möglich):
//   1. encryptedPrivateKey des Users mit dessen User-Key entschlüsseln
//   2. wrappedKey der Mitgliedschaft mit dem Private Key entschlüsseln
//   → Tresor-Schlüssel als Buffer
// ============================================================

const prisma = require('./prisma');
const { decrypt, unwrapKeyWithPrivateKey } = require('./encryption');

/**
 * Holt den Tresor-Schlüssel für einen User (oder null, wenn er kein
 * Mitglied ist / kein Schlüsselpaar hat).
 *
 * @param {string} vaultId
 * @param {string} userId
 * @param {Buffer} encryptionKey - User-Encryption-Key aus der Session
 * @returns {Promise<Buffer|null>}
 */
async function getVaultKeyForUser(vaultId, userId, encryptionKey) {
  const membership = await prisma.vaultMember.findUnique({
    where: { vaultId_userId: { vaultId, userId } },
  });
  if (!membership) return null;

  return unwrapMembershipKey(membership, userId, encryptionKey);
}

/**
 * Entpackt den Tresor-Schlüssel aus einer bereits geladenen Mitgliedschaft.
 */
async function unwrapMembershipKey(membership, userId, encryptionKey) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { encryptedPrivateKey: true },
  });
  if (!user || !user.encryptedPrivateKey) return null;

  const privateKeyPem = decrypt(user.encryptedPrivateKey, encryptionKey);
  if (!privateKeyPem || privateKeyPem === '[Entschlüsselung fehlgeschlagen]') return null;

  return unwrapKeyWithPrivateKey(privateKeyPem, membership.wrappedKey);
}

module.exports = { getVaultKeyForUser, unwrapMembershipKey };
