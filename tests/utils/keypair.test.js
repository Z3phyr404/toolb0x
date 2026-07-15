const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  generateUserKeypair,
  wrapKeyWithPublicKey,
  unwrapKeyWithPrivateKey,
  generateEncryptionKey,
  encrypt,
  decrypt,
} = require('../../src/utils/encryption');

describe('Schlüsselpaare für geteilte Tresore', () => {
  const keypair = generateUserKeypair();

  it('erzeugt PEM-kodierte Schlüssel', () => {
    assert.ok(keypair.publicKey.includes('BEGIN PUBLIC KEY'));
    assert.ok(keypair.privateKey.includes('BEGIN PRIVATE KEY'));
  });

  it('Round-Trip: Tresor-Schlüssel wrappen und unwrappen', () => {
    const vaultKey = crypto.randomBytes(32);
    const wrapped = wrapKeyWithPublicKey(keypair.publicKey, vaultKey);
    const unwrapped = unwrapKeyWithPrivateKey(keypair.privateKey, wrapped);
    assert.ok(unwrapped.equals(vaultKey));
  });

  it('Unwrap mit fremdem Private Key schlägt fehl (null)', () => {
    const vaultKey = crypto.randomBytes(32);
    const wrapped = wrapKeyWithPublicKey(keypair.publicKey, vaultKey);
    const other = generateUserKeypair();
    assert.equal(unwrapKeyWithPrivateKey(other.privateKey, wrapped), null);
  });

  it('Unwrap mit kaputten Daten gibt null zurück (wirft nicht)', () => {
    assert.equal(unwrapKeyWithPrivateKey(keypair.privateKey, 'nicht-base64!!'), null);
  });

  it('Kompletter Tresor-Flow: Owner wrappt für Mitglied, Mitglied liest Eintrag', () => {
    // Owner erzeugt Tresor-Schlüssel und verschlüsselt einen Eintrag damit
    const vaultKey = crypto.randomBytes(32);
    const ciphertext = encrypt('Gemeinsames-WLAN-Passwort', vaultKey);

    // Mitglied hat eigenes Keypair; sein Private Key liegt (wie in der DB)
    // mit seinem User-Encryption-Key verschlüsselt vor
    const member = generateUserKeypair();
    const memberEncKey = generateEncryptionKey();
    const encryptedPrivateKey = encrypt(member.privateKey, memberEncKey);

    // Owner wrappt den Tresor-Schlüssel mit dem Public Key des Mitglieds
    const wrappedForMember = wrapKeyWithPublicKey(member.publicKey, vaultKey);

    // Mitglied: Private Key entschlüsseln → Tresor-Schlüssel unwrappen → Eintrag lesen
    const privatePem = decrypt(encryptedPrivateKey, memberEncKey);
    const recoveredVaultKey = unwrapKeyWithPrivateKey(privatePem, wrappedForMember);
    assert.equal(decrypt(ciphertext, recoveredVaultKey), 'Gemeinsames-WLAN-Passwort');
  });
});
