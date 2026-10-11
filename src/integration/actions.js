// ============================================================
// INTEGRATIONS-AKTIONEN — was Hermes schreiben darf
// ============================================================
// Jede Schreibaktion läuft zweistufig:
//   prepare(db, ctx, params)  → prüft streng, normalisiert, liefert eine
//                                Zusammenfassung für den Menschen und (bei
//                                Ändern/Löschen) einen Fingerabdruck des
//                                aktuellen Zustands. Schreibt NICHTS.
//   execute(tx, ctx, params, version) → läuft beim Bestätigen in EINER
//                                Transaktion: Zustand erneut prüfen,
//                                schreiben (über services/finance.js, also
//                                exakt wie die App), Eintrag zurücklesen und
//                                mit dem Entwurf vergleichen.
//
// Grundsätze:
//   - Unbekannte Felder werden abgelehnt (keine frei wählbare userId o. ä.).
//   - Nichts wird geraten: Datum (Ausgaben/Buchungen) und Monat (Einnahmen,
//     Sammelposten) sind Pflicht, Beträge nur in eindeutiger Cent-Form.
//   - Neue Ausgaben/Einnahmen sind EINMALIG, außer isRecurring: true.
//   - Alles wird mit dem User-Key verschlüsselt — dieselben Funktionen wie
//     in der App.
// ============================================================

const crypto = require('crypto');
const finance = require('../services/finance');
const {
  validateExpense, validateBooking, validateIncome, sanitize,
  parseCents, centsToAmount, isValidDate,
} = require('../utils/validation');
const { periodOf, isInPeriod, MONTH_RE } = require('../utils/budgetPeriod');
const { decrypt } = require('../utils/encryption');
const { entschaerfe } = require('../utils/legacyText');

const DECRYPT_FAILED = '[Entschlüsselung fehlgeschlagen]';
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

class IntegrationError extends Error {
  constructor(status, code, message, errors) {
    super(message);
    this.status = status;
    this.code = code;
    this.errors = errors;
  }
}

const fail = (status, code, message, errors) => { throw new IntegrationError(status, code, message, errors); };
const invalid = (errors) => fail(400, 'VALIDATION', 'Die Angaben sind unvollständig oder ungültig.', errors);
const notFound = (what) => fail(404, 'NOT_FOUND', `${what} nicht gefunden.`);
const changed = () => fail(409, 'TARGET_CHANGED', 'Der Eintrag wurde seit dem Entwurf verändert oder gelöscht. Bitte neuen Entwurf erstellen.');

function sha256(v) {
  return crypto.createHash('sha256').update(v).digest('hex');
}

// Deterministisches JSON (sortierte Schlüssel) für Hashes.
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

function checkFields(params, allowed, required) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) invalid(['params muss ein Objekt sein.']);
  const errors = [];
  for (const k of Object.keys(params)) {
    if (!allowed.includes(k)) errors.push(`Unbekanntes Feld: ${k}`);
  }
  for (const k of required) {
    if (params[k] === undefined || params[k] === null || params[k] === '') errors.push(`Pflichtfeld fehlt: ${k}`);
  }
  if (errors.length) invalid(errors);
}

function readCents(value, errors) {
  const cents = parseCents(value);
  if (cents === null) errors.push('amount: Betrag ungültig. Erlaubt ist z. B. "12", "12,5" oder "12.50" (größer 0, höchstens 999999.99).');
  return cents;
}

function readBool(params, field, fallback, errors) {
  if (params[field] === undefined) return fallback;
  if (typeof params[field] !== 'boolean') {
    errors.push(`${field} muss true oder false sein.`);
    return fallback;
  }
  return params[field];
}

function readTags(value, errors) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(t => typeof t !== 'string')) {
    errors.push('tags muss eine Liste von Texten sein.');
    return [];
  }
  return value.map(t => sanitize(t.trim())).filter(Boolean);
}

// Gespeicherten Betrag (z. B. "12.5") in die Ausgabeform "12.50" bringen.
// Ein nicht entschlüsselbarer Eintrag wird nie stillschweigend als 0 behandelt.
function storedAmount(plain) {
  if (plain === null || plain === undefined) return null;
  if (plain === DECRYPT_FAILED || isNaN(parseFloat(plain))) {
    fail(422, 'CORRUPT_ENTRY', 'Der Eintrag kann nicht entschlüsselt werden und wird nicht verändert.');
  }
  return centsToAmount(finance.toCents(plain));
}

function assertReadable(...values) {
  if (values.some(v => v === DECRYPT_FAILED)) {
    fail(422, 'CORRUPT_ENTRY', 'Der Eintrag kann nicht entschlüsselt werden und wird nicht verändert.');
  }
}

// ------------------------------------------------------------
// Öffentliche Darstellung (nur nötige Felder, keine internen IDs)
// ------------------------------------------------------------

function publicExpense(e) {
  return {
    id: e.id,
    name: e.name,
    amount: e.amount,
    plannedAmount: e.plannedAmount,
    isCollector: e.isCollector,
    isRecurring: e.isRecurring,
    month: e.month,
    spentOn: e.spentOn || null,
    tags: e.tags || [],
    category: e.category ? { id: e.category.id, name: e.category.name } : null,
    ...(e.bookings ? { bookings: e.bookings.map(publicBooking) } : {}),
  };
}

function publicBooking(b) {
  return { id: b.id, expenseId: b.expenseId, amount: b.amount, note: b.note || '', bookedOn: b.bookedOn || null };
}

function publicIncome(i) {
  return { id: i.id, name: i.name, amount: i.amount, isRecurring: i.isRecurring, month: i.month };
}

// Fingerabdrücke des gespeicherten Zustands (Ciphertexte ändern sich bei
// jedem Schreiben — zufälliger IV —, sind also ein verlässlicher
// Versionsmarker). Beim Sammelposten zählt `amount` nicht: das ist die
// Buchungssumme, die sich durch Buchungen ändern darf.
const fpExpense = e => sha256(stableStringify([
  e.name, e.isCollector ? null : e.amount, e.plannedAmount, e.categoryId, e.tags,
  e.month, e.spentOn, e.isRecurring, e.isCollector,
]));
const fpBooking = b => sha256(stableStringify([b.amount, b.note, b.bookedOn, b.expenseId]));
const fpIncome = i => sha256(stableStringify([i.name, i.amount, i.month, i.isRecurring]));

async function loadCategory(db, ctx, categoryId) {
  const cat = await db.category.findFirst({ where: { id: categoryId, userId: ctx.userId } });
  return cat ? { id: cat.id, name: entschaerfe(decrypt(cat.name, ctx.key)) } : null;
}

async function loadExpense(db, ctx, id) {
  if (typeof id !== 'string') return null;
  return db.expense.findFirst({ where: { id, userId: ctx.userId } });
}

async function loadCollector(db, ctx, expenseId) {
  const posten = await loadExpense(db, ctx, expenseId);
  if (!posten) notFound('Sammelposten');
  if (!posten.isCollector) fail(400, 'NOT_A_COLLECTOR', 'Auf diese Ausgabe kann nicht gebucht werden. Sie ist kein Sammelposten.');
  return posten;
}

async function loadBooking(db, ctx, posten, bookingId) {
  if (typeof bookingId !== 'string') return null;
  return db.expenseBooking.findFirst({ where: { id: bookingId, expenseId: posten.id, userId: ctx.userId } });
}

async function readBackExpense(tx, ctx, id) {
  const row = await tx.expense.findFirst({
    where: { id, userId: ctx.userId },
    include: { category: finance.CATEGORY_SELECT },
  });
  if (!row) fail(500, 'VERIFY_FAILED', 'Der gespeicherte Eintrag konnte nicht zurückgelesen werden.');
  return finance.decryptExpense(row, ctx.key);
}

function verify(cond) {
  if (!cond) fail(500, 'VERIFY_FAILED', 'Der gespeicherte Eintrag weicht vom Entwurf ab. Es wurde nichts gespeichert.');
}

function sameAmount(plain, normalized) {
  return finance.toCents(plain) === parseCents(normalized);
}

// ------------------------------------------------------------
// Aktionen
// ------------------------------------------------------------

const ACTIONS = {
  // ---------------- Ausgaben ----------------
  'expense.create': {
    async prepare(db, ctx, params) {
      checkFields(params, ['name', 'amount', 'categoryId', 'date', 'month', 'tags', 'isRecurring', 'isCollector'], ['name', 'amount', 'categoryId']);
      const errors = [];
      const cents = readCents(params.amount, errors);
      const isCollector = readBool(params, 'isCollector', false, errors);
      const isRecurring = readBool(params, 'isRecurring', false, errors);
      const tags = readTags(params.tags, errors) || [];

      let month = null;
      let spentOn = null;
      if (!isCollector) {
        if (!params.date) errors.push('Pflichtfeld fehlt: date (YYYY-MM-DD) — das Datum wird nicht geraten.');
        else if (!isValidDate(params.date)) errors.push('date: ungültiges Datum, erwartet YYYY-MM-DD.');
        else {
          spentOn = params.date;
          month = periodOf(spentOn, ctx.startDay);
          if (params.month !== undefined && params.month !== month) {
            errors.push(`month: Das Datum ${spentOn} gehört zum Finanzmonat ${month}, nicht zu ${params.month}.`);
          }
        }
      } else {
        // Sammelposten haben kein Tagesdatum, nur einen Monat (Budget).
        if (params.date !== undefined) errors.push('date: Ein Sammelposten hat kein Tagesdatum, bitte month angeben.');
        if (typeof params.month !== 'string' || !MONTH.test(params.month)) errors.push('Pflichtfeld fehlt: month (YYYY-MM) für den Sammelposten.');
        else month = params.month;
      }
      if (errors.length) invalid(errors);

      const amount = centsToAmount(cents);
      const vErrors = validateExpense({ name: params.name, amount, categoryId: params.categoryId, month, spentOn, tags }, ctx.startDay);
      if (vErrors.length) invalid(vErrors);

      const category = await loadCategory(db, ctx, params.categoryId);
      if (!category) invalid(['categoryId: Kategorie nicht gefunden.']);

      const normalized = { name: sanitize(params.name), amount, categoryId: category.id, month, spentOn, tags, isRecurring, isCollector };
      return {
        params: normalized,
        version: null,
        summary: { ...normalized, category, date: spentOn },
      };
    },
    async execute(tx, ctx, p) {
      await finance.ensureMonthForWrite(tx, ctx, p.month, 'expense');
      if (!(await loadCategory(tx, ctx, p.categoryId))) changed();
      const created = await finance.createExpense(tx, ctx, p);
      const e = await readBackExpense(tx, ctx, created.id);
      verify(e.name === p.name && e.categoryId === p.categoryId && e.month === p.month
        && e.isRecurring === p.isRecurring && e.isCollector === p.isCollector
        && (e.spentOn || null) === p.spentOn
        && (p.isCollector ? sameAmount(e.plannedAmount, p.amount) : sameAmount(e.amount, p.amount)));
      return { status: 201, targetType: 'expense', targetId: e.id, month: e.month, entry: publicExpense(e) };
    },
  },

  'expense.update': {
    async prepare(db, ctx, params) {
      checkFields(params, ['id', 'name', 'amount', 'categoryId', 'date', 'tags', 'isRecurring'], ['id']);
      const existing = await loadExpense(db, ctx, params.id);
      if (!existing) notFound('Ausgabe');
      const cur = finance.decryptExpense(existing, ctx.key);
      assertReadable(cur.name);
      const curAmount = storedAmount(existing.isCollector ? cur.plannedAmount : cur.amount);

      const errors = [];
      const name = params.name !== undefined ? params.name : cur.name;
      const amount = params.amount !== undefined ? centsToAmount(readCents(params.amount, errors) || 0) : curAmount;
      const categoryId = params.categoryId !== undefined ? params.categoryId : existing.categoryId;
      const tags = readTags(params.tags, errors) ?? cur.tags;
      const isRecurring = readBool(params, 'isRecurring', existing.isRecurring, errors);
      let spentOn = existing.spentOn || null;
      if (params.date !== undefined) {
        if (existing.isCollector) errors.push('date: Ein Sammelposten hat kein Tagesdatum.');
        else if (params.date === null) spentOn = null;
        else if (!isValidDate(params.date)) errors.push('date: ungültiges Datum, erwartet YYYY-MM-DD.');
        else if (!isInPeriod(params.date, existing.month, ctx.startDay)) errors.push(`date: Das Datum muss im Finanzmonat ${existing.month} liegen (Eintrag verschieben geht nur in der App).`);
        else spentOn = params.date;
      }
      if (errors.length) invalid(errors);

      const vErrors = validateExpense({ name, amount, categoryId, month: existing.month, spentOn, tags }, ctx.startDay);
      if (vErrors.length) invalid(vErrors);
      const category = await loadCategory(db, ctx, categoryId);
      if (!category) invalid(['categoryId: Kategorie nicht gefunden.']);

      const normalized = { id: existing.id, name: sanitize(name), amount, categoryId, spentOn, tags, isRecurring };
      const before = publicExpense({ ...cur, amount: storedAmount(cur.amount), plannedAmount: cur.plannedAmount ? storedAmount(cur.plannedAmount) : null });
      delete before.bookings;
      return {
        params: normalized,
        version: fpExpense(existing),
        summary: {
          before,
          after: { ...before, name: normalized.name, category, tags, spentOn, isRecurring,
            ...(existing.isCollector ? { plannedAmount: amount } : { amount }) },
        },
      };
    },
    async execute(tx, ctx, p, version) {
      const existing = await loadExpense(tx, ctx, p.id);
      if (!existing) changed();
      await finance.lockRow(tx, 'expenses', existing.id);
      if (fpExpense(existing) !== version) changed();
      if (!(await loadCategory(tx, ctx, p.categoryId))) changed();
      await finance.updateExpense(tx, ctx, existing, {
        name: p.name, amount: p.amount, categoryId: p.categoryId, tags: p.tags,
        month: existing.month, spentOn: p.spentOn, isRecurring: p.isRecurring,
      });
      const e = await readBackExpense(tx, ctx, existing.id);
      verify(e.name === p.name && e.categoryId === p.categoryId && (e.spentOn || null) === p.spentOn
        && e.isRecurring === p.isRecurring
        && (existing.isCollector ? sameAmount(e.plannedAmount, p.amount) : sameAmount(e.amount, p.amount)));
      return { status: 200, targetType: 'expense', targetId: e.id, month: e.month, entry: publicExpense(e) };
    },
  },

  'expense.delete': {
    async prepare(db, ctx, params) {
      checkFields(params, ['id'], ['id']);
      const existing = await loadExpense(db, ctx, params.id);
      if (!existing) notFound('Ausgabe');
      const cur = finance.decryptExpense(existing, ctx.key);
      const before = publicExpense(cur);
      delete before.bookings;
      const bookingCount = existing.isCollector
        ? (await db.expenseBooking.findMany({ where: { expenseId: existing.id } })).length
        : 0;
      return {
        params: { id: existing.id },
        version: fpExpense(existing),
        summary: { before, deletesBookings: bookingCount, deletesFutureCopies: existing.isRecurring },
      };
    },
    async execute(tx, ctx, p, version) {
      const existing = await loadExpense(tx, ctx, p.id);
      if (!existing) changed();
      await finance.lockRow(tx, 'expenses', existing.id);
      if (fpExpense(existing) !== version) changed();
      await finance.deleteExpense(tx, ctx, existing);
      verify(!(await tx.expense.findFirst({ where: { id: existing.id } })));
      return { status: 200, targetType: 'expense', targetId: existing.id, month: existing.month, entry: null, deleted: true };
    },
  },

  // ---------------- Buchungen auf Sammelposten ----------------
  'booking.create': {
    async prepare(db, ctx, params) {
      checkFields(params, ['expenseId', 'amount', 'date', 'note'], ['expenseId', 'amount']);
      const posten = await loadCollector(db, ctx, params.expenseId);
      const errors = [];
      const cents = readCents(params.amount, errors);
      if (!params.date) errors.push('Pflichtfeld fehlt: date (YYYY-MM-DD) — das Datum wird nicht geraten.');
      if (errors.length) invalid(errors);
      const amount = centsToAmount(cents);
      const vErrors = validateBooking({ amount, note: params.note, bookedOn: params.date }, posten.month, ctx.startDay);
      if (vErrors.length) invalid(vErrors);
      const note = params.note ? sanitize(params.note) : '';
      const normalized = { expenseId: posten.id, amount, note, bookedOn: params.date };
      return {
        params: normalized,
        version: null,
        summary: {
          collector: { id: posten.id, name: entschaerfe(decrypt(posten.name, ctx.key)), month: posten.month },
          amount, note, date: params.date,
        },
      };
    },
    async execute(tx, ctx, p) {
      const posten = await loadExpense(tx, ctx, p.expenseId);
      if (!posten || !posten.isCollector) changed();
      const { buchung, total } = await finance.createBooking(tx, ctx, posten, p);
      const b = await tx.expenseBooking.findFirst({ where: { id: buchung.id, userId: ctx.userId } });
      verify(b);
      const d = finance.decryptBooking(b, ctx.key);
      verify(sameAmount(d.amount, p.amount) && d.note === p.note && d.bookedOn === p.bookedOn);
      return { status: 201, targetType: 'booking', targetId: b.id, month: posten.month, entry: publicBooking(d), total };
    },
  },

  'booking.update': {
    async prepare(db, ctx, params) {
      checkFields(params, ['expenseId', 'bookingId', 'amount', 'date', 'note'], ['expenseId', 'bookingId']);
      const posten = await loadCollector(db, ctx, params.expenseId);
      const vorhanden = await loadBooking(db, ctx, posten, params.bookingId);
      if (!vorhanden) notFound('Buchung');
      const cur = finance.decryptBooking(vorhanden, ctx.key);
      assertReadable(cur.note);
      const errors = [];
      const amount = params.amount !== undefined ? centsToAmount(readCents(params.amount, errors) || 0) : storedAmount(cur.amount);
      const bookedOn = params.date !== undefined ? params.date : cur.bookedOn;
      const note = params.note !== undefined ? (params.note ? sanitize(params.note) : '') : cur.note;
      if (errors.length) invalid(errors);
      if (!bookedOn) invalid(['date: Die Buchung braucht ein Datum.']);
      const vErrors = validateBooking({ amount, note, bookedOn }, posten.month, ctx.startDay);
      if (vErrors.length) invalid(vErrors);
      const before = publicBooking({ ...cur, amount: storedAmount(cur.amount) });
      const normalized = { expenseId: posten.id, bookingId: vorhanden.id, amount, note, bookedOn };
      return {
        params: normalized,
        version: fpBooking(vorhanden),
        summary: { collector: { id: posten.id, name: entschaerfe(decrypt(posten.name, ctx.key)) }, before, after: { ...before, amount, note, bookedOn } },
      };
    },
    async execute(tx, ctx, p, version) {
      const posten = await loadExpense(tx, ctx, p.expenseId);
      if (!posten || !posten.isCollector) changed();
      await finance.lockRow(tx, 'expenses', posten.id);
      const vorhanden = await loadBooking(tx, ctx, posten, p.bookingId);
      if (!vorhanden || fpBooking(vorhanden) !== version) changed();
      const { buchung, total } = await finance.updateBooking(tx, ctx, posten, vorhanden, p);
      const b = await tx.expenseBooking.findFirst({ where: { id: buchung.id, userId: ctx.userId } });
      verify(b);
      const d = finance.decryptBooking(b, ctx.key);
      verify(sameAmount(d.amount, p.amount) && d.note === p.note && d.bookedOn === p.bookedOn);
      return { status: 200, targetType: 'booking', targetId: b.id, month: posten.month, entry: publicBooking(d), total };
    },
  },

  'booking.delete': {
    async prepare(db, ctx, params) {
      checkFields(params, ['expenseId', 'bookingId'], ['expenseId', 'bookingId']);
      const posten = await loadCollector(db, ctx, params.expenseId);
      const vorhanden = await loadBooking(db, ctx, posten, params.bookingId);
      if (!vorhanden) notFound('Buchung');
      const cur = finance.decryptBooking(vorhanden, ctx.key);
      return {
        params: { expenseId: posten.id, bookingId: vorhanden.id },
        version: fpBooking(vorhanden),
        summary: { collector: { id: posten.id, name: entschaerfe(decrypt(posten.name, ctx.key)) }, before: publicBooking(cur) },
      };
    },
    async execute(tx, ctx, p, version) {
      const posten = await loadExpense(tx, ctx, p.expenseId);
      if (!posten || !posten.isCollector) changed();
      await finance.lockRow(tx, 'expenses', posten.id);
      const vorhanden = await loadBooking(tx, ctx, posten, p.bookingId);
      if (!vorhanden || fpBooking(vorhanden) !== version) changed();
      const { total } = await finance.deleteBooking(tx, ctx, posten, vorhanden);
      verify(!(await tx.expenseBooking.findFirst({ where: { id: vorhanden.id } })));
      return { status: 200, targetType: 'booking', targetId: vorhanden.id, month: posten.month, entry: null, deleted: true, total };
    },
  },

  // ---------------- Einnahmen ----------------
  'income.create': {
    async prepare(db, ctx, params) {
      checkFields(params, ['name', 'amount', 'month', 'isRecurring'], ['name', 'amount', 'month']);
      const errors = [];
      const cents = readCents(params.amount, errors);
      const isRecurring = readBool(params, 'isRecurring', false, errors);
      if (typeof params.month !== 'string' || !MONTH_RE.test(params.month)) errors.push('month: erwartet YYYY-MM.');
      if (errors.length) invalid(errors);
      const amount = centsToAmount(cents);
      const vErrors = validateIncome({ name: params.name, amount, month: params.month });
      if (vErrors.length) invalid(vErrors);
      const normalized = { name: sanitize(params.name), amount, month: params.month, isRecurring };
      return { params: normalized, version: null, summary: normalized };
    },
    async execute(tx, ctx, p) {
      await finance.ensureMonthForWrite(tx, ctx, p.month, 'income');
      const created = await finance.createIncome(tx, ctx, p);
      const row = await tx.income.findFirst({ where: { id: created.id, userId: ctx.userId } });
      verify(row);
      const i = finance.decryptIncome(row, ctx.key);
      verify(i.name === p.name && sameAmount(i.amount, p.amount) && i.month === p.month && i.isRecurring === p.isRecurring);
      return { status: 201, targetType: 'income', targetId: i.id, month: i.month, entry: publicIncome(i) };
    },
  },

  'income.update': {
    async prepare(db, ctx, params) {
      checkFields(params, ['id', 'name', 'amount', 'isRecurring'], ['id']);
      const existing = typeof params.id === 'string'
        ? await db.income.findFirst({ where: { id: params.id, userId: ctx.userId } })
        : null;
      if (!existing) notFound('Einnahme');
      const cur = finance.decryptIncome(existing, ctx.key);
      assertReadable(cur.name);
      const errors = [];
      const name = params.name !== undefined ? params.name : cur.name;
      const amount = params.amount !== undefined ? centsToAmount(readCents(params.amount, errors) || 0) : storedAmount(cur.amount);
      const isRecurring = readBool(params, 'isRecurring', existing.isRecurring, errors);
      if (errors.length) invalid(errors);
      const vErrors = validateIncome({ name, amount, month: existing.month });
      if (vErrors.length) invalid(vErrors);
      const before = publicIncome({ ...cur, amount: storedAmount(cur.amount) });
      const normalized = { id: existing.id, name: sanitize(name), amount, isRecurring };
      return {
        params: normalized,
        version: fpIncome(existing),
        summary: { before, after: { ...before, name: normalized.name, amount, isRecurring } },
      };
    },
    async execute(tx, ctx, p, version) {
      const existing = await tx.income.findFirst({ where: { id: p.id, userId: ctx.userId } });
      if (!existing) changed();
      await finance.lockRow(tx, 'incomes', existing.id);
      if (fpIncome(existing) !== version) changed();
      await finance.updateIncome(tx, ctx, existing, { name: p.name, amount: p.amount, isRecurring: p.isRecurring });
      const row = await tx.income.findFirst({ where: { id: existing.id, userId: ctx.userId } });
      verify(row);
      const i = finance.decryptIncome(row, ctx.key);
      verify(i.name === p.name && sameAmount(i.amount, p.amount) && i.isRecurring === p.isRecurring);
      return { status: 200, targetType: 'income', targetId: i.id, month: i.month, entry: publicIncome(i) };
    },
  },

  'income.delete': {
    async prepare(db, ctx, params) {
      checkFields(params, ['id'], ['id']);
      const existing = typeof params.id === 'string'
        ? await db.income.findFirst({ where: { id: params.id, userId: ctx.userId } })
        : null;
      if (!existing) notFound('Einnahme');
      const cur = finance.decryptIncome(existing, ctx.key);
      return {
        params: { id: existing.id },
        version: fpIncome(existing),
        summary: { before: publicIncome(cur), deletesFutureCopies: existing.isRecurring },
      };
    },
    async execute(tx, ctx, p, version) {
      const existing = await tx.income.findFirst({ where: { id: p.id, userId: ctx.userId } });
      if (!existing) changed();
      await finance.lockRow(tx, 'incomes', existing.id);
      if (fpIncome(existing) !== version) changed();
      await finance.deleteIncome(tx, ctx, existing);
      verify(!(await tx.income.findFirst({ where: { id: existing.id } })));
      return { status: 200, targetType: 'income', targetId: existing.id, month: existing.month, entry: null, deleted: true };
    },
  },
};

// Finanzbuchhaltung: Michaels Vorgabe (2026-10-12) — klare Buchungsaufträge
// führt Zephyr ohne erneute Rückfrage aus. Der technische Entwurf/Commit-
// Ablauf bleibt trotzdem (Einmaligkeit, Idempotenz, Versionsbindung).
for (const name of Object.keys(ACTIONS)) {
  ACTIONS[name].scope = 'finance.write';
  ACTIONS[name].level = 'auto';
}

require('./actions-extra')(ACTIONS, {
  checkFields, invalid, fail, notFound, changed, verify, readBool, sha256, stableStringify,
});

module.exports = {
  ACTIONS,
  IntegrationError,
  stableStringify,
  sha256,
  publicExpense,
  publicBooking,
  publicIncome,
};
