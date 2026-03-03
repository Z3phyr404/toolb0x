const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  generateEncryptionKey,
  wrapEncryptionKey,
  unwrapEncryptionKey,
  encrypt,
  decrypt,
  encryptFields,
  decryptFields,
} = require('../../src/utils/encryption');

// Test-Key (32 Bytes für AES-256)
const key = generateEncryptionKey();

describe('encrypt / decrypt', () => {
  it('Round-Trip: encrypt → decrypt ergibt den Originaltext', () => {
    const plaintext = 'Miete';
    const ciphertext = encrypt(plaintext, key);
    const result = decrypt(ciphertext, key);
    assert.equal(result, plaintext);
  });

  it('Gleicher Text ergibt verschiedenen Ciphertext (Random IV)', () => {
    const plaintext = 'Gehalt';
    const c1 = encrypt(plaintext, key);
    const c2 = encrypt(plaintext, key);
    assert.notEqual(c1, c2);
    // Aber beide entschlüsseln zum gleichen Text
    assert.equal(decrypt(c1, key), plaintext);
    assert.equal(decrypt(c2, key), plaintext);
  });

  it('Zahlen werden korrekt verschlüsselt und entschlüsselt', () => {
    const amount = '640.50';
    const ciphertext = encrypt(amount, key);
    assert.equal(decrypt(ciphertext, key), amount);
  });

  it('encrypt(null) gibt null zurück', () => {
    assert.equal(encrypt(null, key), null);
  });

  it('encrypt(undefined) gibt null zurück', () => {
    assert.equal(encrypt(undefined, key), null);
  });

  it('decrypt(null) gibt null zurück', () => {
    assert.equal(decrypt(null, key), null);
  });

  it('decrypt mit falschem Key gibt Fehlermeldung', () => {
    const ciphertext = encrypt('Geheim', key);
    const wrongKey = generateEncryptionKey();
    const result = decrypt(ciphertext, wrongKey);
    assert.equal(result, '[Entschlüsselung fehlgeschlagen]');
  });

  it('decrypt mit leerem String gibt null zurück', () => {
    assert.equal(decrypt('', key), null);
  });
});

describe('encryptFields / decryptFields', () => {
  it('verschlüsselt nur die angegebenen Felder', () => {
    const obj = { name: 'Miete', amount: '640', other: 'bleibt' };
    const encrypted = encryptFields(obj, key, ['name', 'amount']);
    assert.notEqual(encrypted.name, 'Miete');
    assert.notEqual(encrypted.amount, '640');
    assert.equal(encrypted.other, 'bleibt');
  });

  it('encryptFields → decryptFields Round-Trip', () => {
    const obj = { name: 'Strom', amount: '85.20', id: '123' };
    const encrypted = encryptFields(obj, key, ['name', 'amount']);
    const decrypted = decryptFields(encrypted, key, ['name', 'amount']);
    assert.equal(decrypted.name, 'Strom');
    assert.equal(decrypted.amount, '85.20');
    assert.equal(decrypted.id, '123');
  });
});

describe('Key-Wrapping', () => {
  it('generateEncryptionKey erzeugt einen 32-Byte Buffer', () => {
    const k = generateEncryptionKey();
    assert.ok(Buffer.isBuffer(k));
    assert.equal(k.length, 32);
  });

  it('wrapEncryptionKey → unwrapEncryptionKey Round-Trip', () => {
    const encKey = generateEncryptionKey();
    const password = 'MeinSicheresPasswort1!';
    const wrapped = wrapEncryptionKey(encKey, password);
    const unwrapped = unwrapEncryptionKey(wrapped, password);
    assert.ok(Buffer.isBuffer(unwrapped));
    assert.deepEqual(unwrapped, encKey);
  });

  it('unwrapEncryptionKey mit falschem Passwort gibt null zurück', () => {
    const encKey = generateEncryptionKey();
    const wrapped = wrapEncryptionKey(encKey, 'RichtigesPasswort1!');
    const result = unwrapEncryptionKey(wrapped, 'FalschesPasswort1!');
    assert.equal(result, null);
  });
});
