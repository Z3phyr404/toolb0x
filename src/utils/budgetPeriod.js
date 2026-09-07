// ============================================================
// FINANZ-PERIODEN — verschiebbarer Monatsanfang
// ============================================================
// Nicht bei jedem beginnt der Finanzmonat am 1. Wer sein Geld am 15.
// bekommt, rechnet vom 15. bis zum 14. des Folgemonats.
//
// WICHTIG — was sich dadurch NICHT ändert:
// Der Datenbank-Schlüssel bleibt "YYYY-MM" (Feld `month`, unverschlüsselt,
// indiziert). Eine Periode heißt weiterhin nach dem Kalendermonat, in dem
// sie BEGINNT. Bei Starttag 15 umfasst die Periode "2026-09" also den
// Zeitraum 15.09.2026 bis 14.10.2026. Dadurch bleiben Index, Auto-Kopien
// wiederkehrender Einträge, MonthInit und der Verlauf unverändert — nur die
// erlaubte Datumsspanne und die Beschriftung hängen am Starttag.
//
// Starttag ist auf 1–28 begrenzt: ab 29 gäbe es Monate ohne diesen Tag,
// und "Periodenanfang mal am 28., mal am 29." wäre für den Nutzer nicht
// mehr vorhersagbar.
// ============================================================

const MIN_START_DAY = 1;
const MAX_START_DAY = 28;

/** Starttag auf einen gültigen Wert bringen (Fallback: 1). */
function normalizeStartDay(value) {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < MIN_START_DAY || n > MAX_START_DAY) return 1;
  return n;
}

/** Prüft, ob ein Wert ein zulässiger Starttag ist (für die Eingabevalidierung). */
function isValidStartDay(value) {
  const n = parseInt(value, 10);
  return !isNaN(n) && String(n) === String(value).trim() && n >= MIN_START_DAY && n <= MAX_START_DAY;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** "2026-09" -> "2026-10" */
function nextMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** "2026-09" -> "2026-08" */
function prevMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** Anzahl Tage im Kalendermonat "YYYY-MM". */
function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Tag an die Monatslänge anpassen und als "YYYY-MM-DD" zusammensetzen. */
function dateIn(ym, day) {
  const d = Math.min(day, daysInMonth(ym));
  return `${ym}-${String(d).padStart(2, '0')}`;
}

/**
 * Zeitraum einer Periode.
 * @returns {{start: string, end: string}} beide inklusiv, "YYYY-MM-DD"
 *
 * Starttag 1  + "2026-09" -> 2026-09-01 bis 2026-09-30 (Kalendermonat)
 * Starttag 15 + "2026-09" -> 2026-09-15 bis 2026-10-14
 */
function periodRange(month, startDay) {
  const day = normalizeStartDay(startDay);
  if (day === 1) {
    return { start: `${month}-01`, end: dateIn(month, 31) };
  }
  const naechster = nextMonth(month);
  // Ende = Tag vor dem Start der Folgeperiode. In kurzen Monaten wird der
  // Starttag gekappt (Februar mit Starttag 28 ist der Grenzfall), das Ende
  // rutscht dann entsprechend mit.
  const startNext = Math.min(day, daysInMonth(naechster));
  return {
    start: dateIn(month, day),
    end: startNext === 1 ? dateIn(month, 31) : `${naechster}-${String(startNext - 1).padStart(2, '0')}`,
  };
}

/**
 * Zu welcher Periode gehört ein Kalendertag?
 * Starttag 15: der 20.09. gehört zu "2026-09", der 05.10. ebenfalls.
 */
function periodOf(dateStr, startDay) {
  const day = normalizeStartDay(startDay);
  const ym = dateStr.slice(0, 7);
  if (day === 1) return ym;
  const tag = Number(dateStr.slice(8, 10));
  // Kurzer Monat: liegt der Starttag hinter dem Monatsende, beginnt die
  // Periode am letzten Tag des Monats.
  const startInMonat = Math.min(day, daysInMonth(ym));
  return tag >= startInMonat ? ym : prevMonth(ym);
}

/** Liegt ein Datum in der Periode? */
function isInPeriod(dateStr, month, startDay) {
  const { start, end } = periodRange(month, startDay);
  return dateStr >= start && dateStr <= end;
}

/** Heutiges Datum in LOKALER Zeit als "YYYY-MM-DD". */
function heute(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * Die Periode, in der heute liegt.
 * Ersetzt das alte `new Date().toISOString().slice(0, 7)`, das zusätzlich
 * in UTC rechnete und deshalb kurz nach Mitternacht den Vormonat lieferte.
 */
function currentPeriod(startDay, now = new Date()) {
  return periodOf(heute(now), startDay);
}

/**
 * Tagesdatum beim Kopieren eines wiederkehrenden Eintrags in die nächste
 * Periode übertragen: gleicher Tag im Monat, aber im richtigen Kalendermonat
 * der Zielperiode.
 *
 * Starttag 15, Zielperiode "2026-10" (15.10.–14.11.):
 *   20. -> 2026-10-20 (erster Monat der Periode)
 *    5. -> 2026-11-05 (zweiter Monat der Periode)
 *
 * Zu lange Tage werden auf die Monatslänge gekappt (aus dem 31. wird im
 * Februar der 28. bzw. 29.).
 */
function carryDayToPeriod(spentOn, targetMonth, startDay) {
  if (!spentOn) return null;
  const day = normalizeStartDay(startDay);
  const tag = Number(spentOn.slice(8, 10));
  if (day === 1) return dateIn(targetMonth, tag);
  const startInMonat = Math.min(day, daysInMonth(targetMonth));
  const zielMonat = tag >= startInMonat ? targetMonth : nextMonth(targetMonth);
  const datum = dateIn(zielMonat, tag);
  // Sicherheitsnetz: durch das Kappen kann der Tag aus der Periode fallen
  // (z.B. Starttag 28, Tag 30, Zielmonat Februar). Dann lieber auf den
  // Periodenanfang bzw. das Periodenende ziehen als ein Datum ausserhalb.
  const { start, end } = periodRange(targetMonth, day);
  if (datum < start) return start;
  if (datum > end) return end;
  return datum;
}

module.exports = {
  MIN_START_DAY,
  MAX_START_DAY,
  normalizeStartDay,
  isValidStartDay,
  periodRange,
  periodOf,
  isInPeriod,
  currentPeriod,
  carryDayToPeriod,
  heute,
  nextMonth,
  prevMonth,
  daysInMonth,
  MONTH_RE,
  DATE_RE,
};
