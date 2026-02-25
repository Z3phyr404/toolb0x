// ============================================================
// VERSCHLÜSSELUNG — Zero-Knowledge Architecture
// ============================================================
//
// PROBLEM: Du als Betreiber könntest in die PostgreSQL-Datenbank
// schauen und sehen: "Michael gibt 640€ für Miete aus".
// Bei Finanzdaten ist das ein No-Go.
//
// LÖSUNG: Alle sensiblen Daten werden verschlüsselt BEVOR sie
// in die Datenbank geschrieben werden. Der Schlüssel wird aus
// dem Passwort des Nutzers abgeleitet. Da du als Betreiber das
// Passwort nicht kennst, kannst du die Daten nicht entschlüsseln.
//
// WAS in der Datenbank steht:
//   name: "U2FsdGVkX1+abc123..."  (unlesbarer Kauderwelsch)
//   amount: "U2FsdGVkX1+xyz789..."
//
// WAS der Nutzer sieht (nach Entschlüsselung im Browser):
//   name: "Miete"
//   amount: "640.00"
//
// ARCHITEKTUR:
// ┌──────────┐     verschlüsselt     ┌──────────┐     verschlüsselt     ┌──────────┐
// │  Browser  │ ──────────────────► │  Server   │ ──────────────────► │ Datenbank │
// │ (Klartext)│ ◄────────────────── │ (blind)   │ ◄────────────────── │ (blind)   │
// └──────────┘     verschlüsselt     └──────────┘     verschlüsselt     └──────────┘
//
// Der Schlüssel existiert NUR:
//   1. Im Browser des Nutzers (als Variable im RAM)
//   2. Verschlüsselt in der Datenbank (mit dem Passwort-Hash)
//      → Nur mit dem richtigen Passwort entschlüsselbar
//
// ============================================================
// TECHNISCHE DETAILS:
//
// Algorithmus: AES-256-GCM
//   - AES = Advanced Encryption Standard (Industriestandard)
//   - 256 = 256-Bit Schlüssel (praktisch unknackbar)
//   - GCM = Galois/Counter Mode (verhindert Manipulation)
//
// Schlüssel-Ableitung: PBKDF2
//   - Password-Based Key Derivation Function 2
//   - Macht aus dem Passwort einen 256-Bit Schlüssel
//   - 100.000 Iterationen (absichtlich langsam gegen Brute-Force)
//
// Jede Verschlüsselung benutzt einen zufälligen IV (Initialization
// Vector). Das bedeutet: Derselbe Klartext ergibt jedes Mal einen
// ANDEREN verschlüsselten Text. Ein Angreifer kann nicht erkennen,
// ob zwei Einträge den gleichen Wert haben.
// ============================================================

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;        // 16 Bytes = 128 Bit (Standard für AES-GCM)
const TAG_LENGTH = 16;       // 16 Bytes Auth-Tag (GCM Integritätsprüfung)
const KEY_LENGTH = 32;       // 32 Bytes = 256 Bit Schlüssel
const PBKDF2_ITERATIONS = 100000;

// ============================================================
// ENCRYPTION KEY ABLEITUNG
// ============================================================
// Generiert einen zufälligen Encryption Key für jeden Nutzer.
// Dieser Key wird mit dem Passwort verschlüsselt gespeichert.
// ============================================================

/**
 * Generiert einen neuen zufälligen Encryption Key.
 * Wird einmalig bei der Registrierung erstellt.
 */
function generateEncryptionKey() {
  return crypto.randomBytes(KEY_LENGTH);
}

/**
 * Leitet aus einem Passwort einen Wrapping-Key ab.
 * Dieser Key wird benutzt um den eigentlichen Encryption Key
 * zu verschlüsseln ("Key Wrapping").
 *
 * Warum nicht direkt das Passwort als Key?
 * → Passwörter sind zu kurz/vorhersagbar für AES-256
 * → PBKDF2 streckt das Passwort auf 256 Bit
 * → Der Salt macht Rainbow-Table-Angriffe unmöglich
 */
function deriveKeyFromPassword(password, salt) {
  return crypto.pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    'sha512'
  );
}

/**
 * Verschlüsselt den Encryption Key mit dem Passwort des Nutzers.
 * Wird bei Registrierung und Passwort-Änderung aufgerufen.
 *
 * Rückgabe: String im Format "salt:iv:authTag:encryptedKey"
 * (alle Teile werden benötigt um den Key wieder zu entschlüsseln)
 */
function wrapEncryptionKey(encryptionKey, password) {
  const salt = crypto.randomBytes(32);
  const wrappingKey = deriveKeyFromPassword(password, salt);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, wrappingKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(encryptionKey),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Alles zusammenpacken als Base64-String
  return [
    salt.toString('base64'),
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

/**
 * Entschlüsselt den Encryption Key mit dem Passwort des Nutzers.
 * Wird beim Login aufgerufen.
 *
 * Gibt den Klartext-Key zurück (als Buffer),
 * oder null wenn das Passwort falsch ist.
 */
function unwrapEncryptionKey(wrappedKey, password) {
  try {
    const [saltB64, ivB64, tagB64, encB64] = wrappedKey.split(':');
    const salt = Buffer.from(saltB64, 'base64');
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(tagB64, 'base64');
    const encrypted = Buffer.from(encB64, 'base64');

    const wrappingKey = deriveKeyFromPassword(password, salt);

    const decipher = crypto.createDecipheriv(ALGORITHM, wrappingKey, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    return decrypted;
  } catch (err) {
    // Falsches Passwort → AuthTag-Verifizierung schlägt fehl
    return null;
  }
}

// ============================================================
// DATEN-VERSCHLÜSSELUNG
// ============================================================
// Diese Funktionen werden für jeden einzelnen Datensatz benutzt.
// ============================================================

/**
 * Verschlüsselt einen Klartext-String.
 *
 * @param {string} plaintext - z.B. "Miete" oder "640.00"
 * @param {Buffer} key - Der 256-Bit Encryption Key des Nutzers
 * @returns {string} - Verschlüsselter Text im Format "iv:authTag:ciphertext"
 */
function encrypt(plaintext, key) {
  if (plaintext === null || plaintext === undefined) return null;
  const text = String(plaintext);

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(text, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

/**
 * Entschlüsselt einen verschlüsselten String.
 *
 * @param {string} ciphertext - z.B. "abc123:def456:ghi789"
 * @param {Buffer} key - Der 256-Bit Encryption Key des Nutzers
 * @returns {string} - Klartext z.B. "Miete"
 */
function decrypt(ciphertext, key) {
  if (!ciphertext) return null;

  try {
    const [ivB64, tagB64, encB64] = ciphertext.split(':');
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(tagB64, 'base64');
    const encrypted = Buffer.from(encB64, 'base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  } catch (err) {
    console.error('Entschlüsselung fehlgeschlagen:', err.message);
    return '[Entschlüsselung fehlgeschlagen]';
  }
}

/**
 * Verschlüsselt ein ganzes Objekt (nur die angegebenen Felder).
 *
 * Beispiel:
 *   encryptFields({ name: 'Miete', amount: 640 }, key, ['name', 'amount'])
 *   → { name: 'abc:def:ghi', amount: 'jkl:mno:pqr' }
 */
function encryptFields(obj, key, fields) {
  const result = { ...obj };
  for (const field of fields) {
    if (result[field] !== undefined && result[field] !== null) {
      result[field] = encrypt(String(result[field]), key);
    }
  }
  return result;
}

/**
 * Entschlüsselt ein ganzes Objekt (nur die angegebenen Felder).
 */
function decryptFields(obj, key, fields) {
  const result = { ...obj };
  for (const field of fields) {
    if (result[field] && typeof result[field] === 'string' && result[field].includes(':')) {
      result[field] = decrypt(result[field], key);
    }
  }
  return result;
}

module.exports = {
  generateEncryptionKey,
  wrapEncryptionKey,
  unwrapEncryptionKey,
  encrypt,
  decrypt,
  encryptFields,
  decryptFields,
};
