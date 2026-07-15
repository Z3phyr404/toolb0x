// ============================================================
// SHARE-CRYPTO — Clientseitige Zero-Knowledge-Verschlüsselung
// ============================================================
// Wird von der Teilen-UI (Passwort-Manager) UND der öffentlichen
// View-Seite (/s) genutzt. Läuft komplett im Browser via Web Crypto.
//
// Modell:
//   keyMaterial = 32 Zufallsbytes  → landet als base64url im URL-Fragment
//   salt        = 16 Zufallsbytes  → im Blob (öffentlich)
//   iv          = 12 Zufallsbytes  → im Blob (öffentlich)
//   AES-Key     = PBKDF2(keyMaterial ‖ PIN, salt, 200k, SHA-256)
//
// Bei gesetzter PIN kann ein geleakter Link ohne PIN NICHT
// entschlüsselt werden (GCM-Auth-Tag schlägt fehl). Der Server
// sieht weder Klartext noch Schlüssel noch PIN.
//
// Blob-Format (im DB-Feld, für den Server opak):
//   base64(salt):base64(iv):base64(ciphertext)
// ============================================================

(function (global) {
  'use strict';

  const PBKDF2_ITERATIONS = 200000;
  const KEY_MATERIAL_BYTES = 32;
  const SALT_BYTES = 16;
  const IV_BYTES = 12;

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // --- base64 / base64url Helfer ---
  function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function bytesToBase64Url(bytes) {
    return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64UrlToBytes(b64url) {
    let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return base64ToBytes(b64);
  }

  // --- Schlüssel aus keyMaterial (+ optionale PIN) ableiten ---
  async function deriveAesKey(keyMaterialBytes, pin, saltBytes) {
    // keyMaterial und PIN werden zu einem Eingabewert verkettet
    const pinBytes = enc.encode(pin || '');
    const combined = new Uint8Array(keyMaterialBytes.length + pinBytes.length);
    combined.set(keyMaterialBytes, 0);
    combined.set(pinBytes, keyMaterialBytes.length);

    const baseKey = await crypto.subtle.importKey(
      'raw', combined, { name: 'PBKDF2' }, false, ['deriveKey']
    );

    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  // --- Verschlüsseln ---
  // Rückgabe: { blob, keyFragment, hasPin }
  async function encryptSecret(plaintext, pin) {
    const keyMaterial = crypto.getRandomValues(new Uint8Array(KEY_MATERIAL_BYTES));
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

    const aesKey = await deriveAesKey(keyMaterial, pin, salt);
    const cipherBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      enc.encode(plaintext)
    );

    const blob = [
      bytesToBase64(salt),
      bytesToBase64(iv),
      bytesToBase64(new Uint8Array(cipherBuf)),
    ].join(':');

    return {
      blob,
      keyFragment: bytesToBase64Url(keyMaterial),
      hasPin: Boolean(pin),
    };
  }

  // --- Entschlüsseln ---
  // Wirft bei falscher/fehlender PIN oder manipuliertem Blob.
  async function decryptSecret(blob, keyFragment, pin) {
    const parts = String(blob).split(':');
    if (parts.length !== 3) throw new Error('Ungültiges Datenformat.');

    const salt = base64ToBytes(parts[0]);
    const iv = base64ToBytes(parts[1]);
    const cipher = base64ToBytes(parts[2]);
    const keyMaterial = base64UrlToBytes(keyFragment);

    const aesKey = await deriveAesKey(keyMaterial, pin, salt);
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      cipher
    );

    return dec.decode(plainBuf);
  }

  global.ShareCrypto = { encryptSecret, decryptSecret };
})(window);
