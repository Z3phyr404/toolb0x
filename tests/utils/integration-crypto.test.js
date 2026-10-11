// Schlüsselkopie für Integrationen + centgenaue Beträge
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  generateEncryptionKey, wrapKeyWithSecret, unwrapKeyWithSecret, encrypt, decryptStrict,
} = require('../../src/utils/encryption');
const { parseCents, centsToAmount } = require('../../src/utils/validation');

describe('wrapKeyWithSecret / unwrapKeyWithSecret', () => {
  const key = generateEncryptionKey();
  const secret = crypto.randomBytes(32).toString('base64url');

  it('Round-Trip liefert exakt den Schlüssel', () => {
    const w = wrapKeyWithSecret(key, secret, 'cred-1');
    assert.ok(unwrapKeyWithSecret(w, secret, 'cred-1').equals(key));
  });

  it('falsches Secret, falscher Salt oder manipulierte Kopie → null', () => {
    const w = wrapKeyWithSecret(key, secret, 'cred-1');
    assert.equal(unwrapKeyWithSecret(w, secret + 'x', 'cred-1'), null);
    assert.equal(unwrapKeyWithSecret(w, secret, 'cred-2'), null);
    const [iv, tag, enc] = w.split(':');
    const kaputt = Buffer.from(enc, 'base64'); kaputt[0] ^= 1;
    assert.equal(unwrapKeyWithSecret([iv, tag, kaputt.toString('base64')].join(':'), secret, 'cred-1'), null);
    assert.equal(unwrapKeyWithSecret(null, secret, 'cred-1'), null);
    assert.equal(unwrapKeyWithSecret('quatsch', secret, 'cred-1'), null);
  });

  it('Kopie enthält den Schlüssel nicht im Klartext', () => {
    const w = wrapKeyWithSecret(key, secret, 'cred-1');
    assert.ok(!w.includes(key.toString('base64')));
  });

  it('decryptStrict wirft bei Manipulation statt Platzhalter zu liefern', () => {
    const c = encrypt('{"a":1}', key);
    assert.equal(decryptStrict(c, key), '{"a":1}');
    assert.throws(() => decryptStrict(c, generateEncryptionKey()));
  });
});

describe('parseCents', () => {
  it('akzeptiert eindeutige Formen', () => {
    assert.equal(parseCents('12'), 1200);
    assert.equal(parseCents('12,5'), 1250);
    assert.equal(parseCents('12.05'), 1205);
    assert.equal(parseCents('0.01'), 1);
    assert.equal(parseCents(' 3,40 '), 340);
    assert.equal(parseCents('999999.99'), 99999999);
  });
  it('lehnt alles Mehrdeutige ab', () => {
    for (const v of ['0', '0.00', '-1', '12.345', '12abc', '1e3', '1.000,00', '012', '', '1000000', '12.', '.5', 12, null, undefined]) {
      assert.equal(parseCents(v), null, JSON.stringify(v));
    }
  });
  it('centsToAmount', () => {
    assert.equal(centsToAmount(1250), '12.50');
    assert.equal(centsToAmount(1), '0.01');
  });
});
