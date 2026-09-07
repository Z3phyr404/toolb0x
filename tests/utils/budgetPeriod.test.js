// ============================================================
// FINANZ-PERIODEN — Tests
// ============================================================
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeStartDay,
  isValidStartDay,
  periodRange,
  periodOf,
  isInPeriod,
  currentPeriod,
  carryDayToPeriod,
  heute,
} = require('../../src/utils/budgetPeriod');

describe('normalizeStartDay / isValidStartDay', () => {
  it('lässt 1 bis 28 durch', () => {
    for (const d of [1, 5, 15, 28]) {
      assert.equal(normalizeStartDay(d), d);
      assert.equal(isValidStartDay(d), true);
    }
  });

  it('fängt alles Ungültige auf den 1. ab', () => {
    for (const bad of [0, 29, 31, -3, null, undefined, '', 'abc', 1.5, NaN]) {
      assert.equal(normalizeStartDay(bad), 1, `Wert: ${bad}`);
    }
  });

  it('weist ungültige Eingaben zurück', () => {
    for (const bad of [0, 29, 31, -1, 'abc', '', null, '15x', 1.5]) {
      assert.equal(isValidStartDay(bad), false, `Wert: ${bad}`);
    }
  });
});

describe('periodRange', () => {
  it('Starttag 1 entspricht exakt dem Kalendermonat', () => {
    assert.deepEqual(periodRange('2026-09', 1), { start: '2026-09-01', end: '2026-09-30' });
    assert.deepEqual(periodRange('2026-02', 1), { start: '2026-02-01', end: '2026-02-28' });
    assert.deepEqual(periodRange('2024-02', 1), { start: '2024-02-01', end: '2024-02-29' });
  });

  it('Starttag 15 läuft bis zum 14. des Folgemonats', () => {
    assert.deepEqual(periodRange('2026-09', 15), { start: '2026-09-15', end: '2026-10-14' });
  });

  it('funktioniert über den Jahreswechsel', () => {
    assert.deepEqual(periodRange('2026-12', 15), { start: '2026-12-15', end: '2027-01-14' });
  });

  it('Starttag 28 im Februar (kurzer Folgemonat ist der Grenzfall)', () => {
    assert.deepEqual(periodRange('2026-01', 28), { start: '2026-01-28', end: '2026-02-27' });
    assert.deepEqual(periodRange('2026-02', 28), { start: '2026-02-28', end: '2026-03-27' });
  });

  it('Perioden schließen lückenlos aneinander an', () => {
    for (const startDay of [1, 5, 15, 28]) {
      let m = '2025-11';
      for (let i = 0; i < 15; i++) {
        const a = periodRange(m, startDay);
        const naechsterMonat = m.endsWith('-12')
          ? `${Number(m.slice(0, 4)) + 1}-01`
          : `${m.slice(0, 4)}-${String(Number(m.slice(5, 7)) + 1).padStart(2, '0')}`;
        const b = periodRange(naechsterMonat, startDay);
        const tagNachEnde = new Date(a.end + 'T00:00:00Z');
        tagNachEnde.setUTCDate(tagNachEnde.getUTCDate() + 1);
        assert.equal(
          tagNachEnde.toISOString().slice(0, 10), b.start,
          `Lücke/Überlappung zwischen ${m} und ${naechsterMonat} bei Starttag ${startDay}`,
        );
        m = naechsterMonat;
      }
    }
  });
});

describe('periodOf', () => {
  it('Starttag 1: Periode = Kalendermonat', () => {
    assert.equal(periodOf('2026-09-01', 1), '2026-09');
    assert.equal(periodOf('2026-09-30', 1), '2026-09');
  });

  it('Starttag 15: der Monatsanfang gehört noch zur Vorperiode', () => {
    assert.equal(periodOf('2026-09-14', 15), '2026-08');
    assert.equal(periodOf('2026-09-15', 15), '2026-09');
    assert.equal(periodOf('2026-10-05', 15), '2026-09');
    assert.equal(periodOf('2026-10-15', 15), '2026-10');
  });

  it('über den Jahreswechsel', () => {
    assert.equal(periodOf('2027-01-05', 15), '2026-12');
    assert.equal(periodOf('2027-01-15', 15), '2027-01');
  });

  it('ist die Umkehrung von periodRange', () => {
    for (const startDay of [1, 5, 15, 28]) {
      for (const m of ['2026-01', '2026-02', '2026-06', '2026-12']) {
        const { start, end } = periodRange(m, startDay);
        assert.equal(periodOf(start, startDay), m, `Start ${start} @${startDay}`);
        assert.equal(periodOf(end, startDay), m, `Ende ${end} @${startDay}`);
      }
    }
  });
});

describe('isInPeriod', () => {
  it('grenzt korrekt ab', () => {
    assert.equal(isInPeriod('2026-09-15', '2026-09', 15), true);
    assert.equal(isInPeriod('2026-10-14', '2026-09', 15), true);
    assert.equal(isInPeriod('2026-09-14', '2026-09', 15), false);
    assert.equal(isInPeriod('2026-10-15', '2026-09', 15), false);
  });
});

describe('currentPeriod / heute', () => {
  it('rechnet in LOKALER Zeit, nicht in UTC', () => {
    // 1. Oktober, 00:30 deutscher Zeit = 30. September 22:30 UTC.
    // toISOString() hätte hier den September geliefert.
    const lokalErsterOktober = new Date(2026, 9, 1, 0, 30, 0);
    assert.equal(heute(lokalErsterOktober), '2026-10-01');
    assert.equal(currentPeriod(1, lokalErsterOktober), '2026-10');
  });

  it('berücksichtigt den Starttag', () => {
    const zehnterOktober = new Date(2026, 9, 10, 12, 0, 0);
    assert.equal(currentPeriod(1, zehnterOktober), '2026-10');
    assert.equal(currentPeriod(15, zehnterOktober), '2026-09');
  });
});

describe('carryDayToPeriod', () => {
  it('ohne Datum bleibt es ohne Datum', () => {
    assert.equal(carryDayToPeriod(null, '2026-10', 15), null);
    assert.equal(carryDayToPeriod('', '2026-10', 1), null);
  });

  it('Starttag 1: gleicher Tag im Zielmonat', () => {
    assert.equal(carryDayToPeriod('2026-09-05', '2026-10', 1), '2026-10-05');
    assert.equal(carryDayToPeriod('2026-01-31', '2026-02', 1), '2026-02-28');
  });

  it('Starttag 15: Tag landet im richtigen Kalendermonat der Zielperiode', () => {
    // 20. liegt im ERSTEN Monat der Periode
    assert.equal(carryDayToPeriod('2026-09-20', '2026-10', 15), '2026-10-20');
    // 5. liegt im ZWEITEN Monat der Periode
    assert.equal(carryDayToPeriod('2026-10-05', '2026-10', 15), '2026-11-05');
  });

  it('das übertragene Datum liegt IMMER in der Zielperiode', () => {
    for (const startDay of [1, 5, 15, 28]) {
      for (const tag of [1, 5, 14, 15, 27, 28, 29, 30, 31]) {
        for (const ziel of ['2026-01', '2026-02', '2026-04', '2026-12', '2024-02']) {
          const quelle = `2025-07-${String(tag).padStart(2, '0')}`;
          const neu = carryDayToPeriod(quelle, ziel, startDay);
          assert.equal(
            isInPeriod(neu, ziel, startDay), true,
            `Tag ${tag} -> ${neu} liegt nicht in Periode ${ziel} (Starttag ${startDay})`,
          );
        }
      }
    }
  });
});
