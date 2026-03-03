const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateExpense,
  validateIncome,
  validateRegistration,
  validateCategory,
  sanitize,
} = require('../../src/utils/validation');

describe('validateExpense', () => {
  const valid = {
    name: 'Miete',
    amount: '640',
    categoryId: '550e8400-e29b-41d4-a716-446655440000',
    month: '2026-03',
  };

  it('gültige Daten → keine Fehler', () => {
    assert.deepEqual(validateExpense(valid), []);
  });

  it('fehlender Name → Fehler', () => {
    const errors = validateExpense({ ...valid, name: '' });
    assert.ok(errors.length > 0);
  });

  it('Name nur Whitespace → Fehler', () => {
    const errors = validateExpense({ ...valid, name: '   ' });
    assert.ok(errors.length > 0);
  });

  it('Name über 100 Zeichen → Fehler', () => {
    const errors = validateExpense({ ...valid, name: 'x'.repeat(101) });
    assert.ok(errors.length > 0);
  });

  it('Betrag = 0 → Fehler', () => {
    const errors = validateExpense({ ...valid, amount: '0' });
    assert.ok(errors.length > 0);
  });

  it('Betrag negativ → Fehler', () => {
    const errors = validateExpense({ ...valid, amount: '-5' });
    assert.ok(errors.length > 0);
  });

  it('Betrag kein Zahl → Fehler', () => {
    const errors = validateExpense({ ...valid, amount: 'abc' });
    assert.ok(errors.length > 0);
  });

  it('Betrag zu hoch → Fehler', () => {
    const errors = validateExpense({ ...valid, amount: '1000000' });
    assert.ok(errors.length > 0);
  });

  it('ungültige categoryId → Fehler', () => {
    const errors = validateExpense({ ...valid, categoryId: 'nicht-uuid' });
    assert.ok(errors.length > 0);
  });

  it('ungültiges Monatsformat → Fehler', () => {
    const errors = validateExpense({ ...valid, month: '2026-13' });
    assert.ok(errors.length > 0);
  });

  it('Monat optional — kein Fehler wenn nicht angegeben', () => {
    const { month, ...noMonth } = valid;
    assert.deepEqual(validateExpense(noMonth), []);
  });
});

describe('validateIncome', () => {
  const valid = { name: 'Gehalt', amount: '3000', month: '2026-03' };

  it('gültige Daten → keine Fehler', () => {
    assert.deepEqual(validateIncome(valid), []);
  });

  it('fehlender Name → Fehler', () => {
    const errors = validateIncome({ ...valid, name: '' });
    assert.ok(errors.length > 0);
  });

  it('Betrag = 0 → Fehler', () => {
    const errors = validateIncome({ ...valid, amount: '0' });
    assert.ok(errors.length > 0);
  });

  it('ungültiges Monatsformat → Fehler', () => {
    const errors = validateIncome({ ...valid, month: 'März 2026' });
    assert.ok(errors.length > 0);
  });
});

describe('validateRegistration', () => {
  const valid = {
    email: 'test@example.com',
    password: 'Sicher123',
    name: 'Max',
  };

  it('gültige Daten → keine Fehler', () => {
    assert.deepEqual(validateRegistration(valid), []);
  });

  it('ungültige Email → Fehler', () => {
    const errors = validateRegistration({ ...valid, email: 'nicht-email' });
    assert.ok(errors.length > 0);
  });

  it('Passwort zu kurz → Fehler', () => {
    const errors = validateRegistration({ ...valid, password: 'Ab1' });
    assert.ok(errors.length > 0);
  });

  it('Passwort ohne Großbuchstabe → Fehler', () => {
    const errors = validateRegistration({ ...valid, password: 'sicher123' });
    assert.ok(errors.length > 0);
  });

  it('Passwort ohne Zahl → Fehler', () => {
    const errors = validateRegistration({ ...valid, password: 'SicherOhne' });
    assert.ok(errors.length > 0);
  });

  it('Name zu kurz → Fehler', () => {
    const errors = validateRegistration({ ...valid, name: 'M' });
    assert.ok(errors.length > 0);
  });
});

describe('sanitize', () => {
  it('entfernt HTML-Tags', () => {
    const result = sanitize('<script>alert("XSS")</script>');
    assert.ok(!result.includes('<script>'));
    assert.ok(result.includes('&lt;'));
  });

  it('trimmt Whitespace', () => {
    assert.equal(sanitize('  Miete  '), 'Miete');
  });

  it('gibt Nicht-Strings unverändert zurück', () => {
    assert.equal(sanitize(42), 42);
    assert.equal(sanitize(null), null);
  });
});
