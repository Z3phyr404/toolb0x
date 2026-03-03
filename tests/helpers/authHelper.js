// ============================================================
// TEST AUTH-HELPER
// ============================================================
// Erstellt einen authentifizierten Test-User mit gültigem
// JWT-Token und Session. Umgeht damit die Login-Logik für Tests.
// ============================================================

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const sessionStore = require('../../src/utils/sessionStore');
const { generateEncryptionKey } = require('../../src/utils/encryption');

// JWT-Secret für Tests setzen (muss VOR dem Laden der Auth-Middleware passieren)
const TEST_JWT_SECRET = 'test-secret-fuer-unit-tests-min-32-zeichen!!';
process.env.JWT_SECRET = TEST_JWT_SECRET;

/**
 * Erstellt einen Test-User mit gültigem Auth-Token.
 * @returns {{ userId, encryptionKey, token, cookie }}
 */
function createTestAuth() {
  const userId = crypto.randomUUID();
  const encryptionKey = generateEncryptionKey();
  const sessionId = sessionStore.create(userId, encryptionKey);
  const token = jwt.sign(
    { userId, sid: sessionId },
    TEST_JWT_SECRET,
    { expiresIn: '20m' },
  );
  return {
    userId,
    encryptionKey,
    token,
    cookie: `auth_token=${token}`,
  };
}

/**
 * Räumt den Session-Store auf (nach Tests aufrufen).
 */
function cleanupAuth() {
  sessionStore.destroy();
}

module.exports = { createTestAuth, cleanupAuth, TEST_JWT_SECRET };
