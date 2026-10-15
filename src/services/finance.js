// ============================================================
// FINANZ-LOGIK — gemeinsam für App-Routen und Integrationen
// ============================================================
// Bis 2026-10-11 stand diese Logik direkt in routes/expenses.js und
// routes/income.js. Seit dem Hermes-Zugang gibt es einen zweiten Weg in
// dieselben Daten (src/routes/integration.js). Damit beide exakt gleich
// funktionieren — Auto-Kopie wiederkehrender Einträge, Propagation in
// Zukunftsmonate, Löschschutz über MonthInit, Sammelposten-Summen —
// liegt sie jetzt hier.
//
// Jede Funktion bekommt `db`: entweder den Prisma-Client oder eine
// Transaktion (tx aus prisma.$transaction). Keine Funktion öffnet selbst
// eine Transaktion — das entscheidet der Aufrufer.
//
// ctx = { userId, key, startDay }
// ============================================================

const { encrypt, decrypt } = require('../utils/encryption');
const { entschaerfe, entschaerfeListe } = require('../utils/legacyText');
const { prevMonth, carryDayToPeriod } = require('../utils/budgetPeriod');

const CATEGORY_SELECT = { select: { id: true, name: true, color: true } };
const EXPENSE_INCLUDE = { category: CATEGORY_SELECT, bookings: true };

// ------------------------------------------------------------
// Entschlüsseln
// ------------------------------------------------------------

function decryptBooking(b, key) {
  return {
    id: b.id,
    expenseId: b.expenseId,
    amount: decrypt(b.amount, key),
    note: b.note ? entschaerfe(decrypt(b.note, key)) : '',
    bookedOn: b.bookedOn || null,
    createdAt: b.createdAt,
  };
}

function decryptExpense(exp, key) {
  let tags = [];
  if (exp.tags) {
    try { tags = JSON.parse(decrypt(exp.tags, key)); } catch { tags = []; }
  }
  return {
    ...exp,
    name: entschaerfe(decrypt(exp.name, key)),
    amount: decrypt(exp.amount, key),
    // Bei Sammelposten ist `amount` die Summe der Buchungen, plannedAmount
    // der Budgetwert daneben ("geplant / gebucht").
    plannedAmount: exp.plannedAmount ? decrypt(exp.plannedAmount, key) : null,
    tags: entschaerfeListe(tags),
    bookings: exp.bookings ? exp.bookings.map(b => decryptBooking(b, key)) : undefined,
    bookingCount: exp.bookings ? exp.bookings.length : undefined,
    category: exp.category ? {
      ...exp.category,
      name: entschaerfe(decrypt(exp.category.name, key)),
      color: decrypt(exp.category.color, key),
    } : undefined,
  };
}

function decryptIncome(inc, key) {
  return {
    ...inc,
    name: entschaerfe(decrypt(inc.name, key)),
    amount: decrypt(inc.amount, key),
  };
}

// Betrag aus einem entschlüsselten String in ganze Cent. decrypt() wirft
// nicht, sondern liefert bei defekten Daten einen Platzhalter — der zählt
// als 0, damit eine kaputte Zeile nicht die ganze Summe zu NaN macht.
function toCents(plain) {
  const n = parseFloat(plain);
  return isNaN(n) ? 0 : Math.round(n * 100);
}

// ------------------------------------------------------------
// Sperren (nur PostgreSQL)
// ------------------------------------------------------------
// In einer Transaktion halten diese Sperren bis zum Commit. Außerhalb einer
// Transaktion sind sie wirkungslos, aber harmlos. Der Test-Mock kennt
// $queryRawUnsafe als No-Op.

const LOCKABLE = { expenses: 'expenses', incomes: 'incomes', expense_bookings: 'expense_bookings' };

async function lockRow(db, table, id) {
  if (!LOCKABLE[table] || typeof db.$queryRawUnsafe !== 'function') return;
  await db.$queryRawUnsafe(`SELECT id FROM "${LOCKABLE[table]}" WHERE id = $1 FOR UPDATE`, id);
}

// Serialisiert die Monats-Initialisierung je Nutzer/Monat/Typ, damit zwei
// parallele Schreibvorgänge die wiederkehrenden Einträge nicht doppelt
// kopieren.
async function lockMonth(db, userId, month, type) {
  if (typeof db.$queryRawUnsafe !== 'function') return;
  await db.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))::text AS ok', `monthinit:${userId}:${month}:${type}`);
}

// ------------------------------------------------------------
// Monats-Initialisierung (Auto-Kopie wiederkehrender Einträge)
// ------------------------------------------------------------

/**
 * Kopiert wiederkehrende Ausgaben aus dem letzten bekannten Monat in einen
 * noch nicht initialisierten Monat und markiert ihn als initialisiert.
 * Voraussetzung (prüft der Aufrufer): der Monat hat noch KEINE Ausgaben.
 * @returns {boolean} true, wenn Einträge kopiert wurden
 */
async function initExpenseMonth(db, ctx, month) {
  const { userId, key, startDay } = ctx;
  const alreadyInit = await db.monthInit.findUnique({
    where: { userId_month_type: { userId, month, type: 'expense' } },
  });
  // Monat wurde bereits initialisiert → nicht neu kopieren, leer lassen
  if (alreadyInit) return false;

  // Letzten Monat mit Ausgaben finden (max. 24 Monate zurück).
  // Stoppt wenn ein Monat gefunden wird, der vom User explizit bearbeitet
  // wurde (monthInit vorhanden) — auch wenn er leer ist. Das verhindert,
  // dass absichtlich gelöschte Einträge aus noch älteren Monaten zurückkommen.
  let sourceMonth = prevMonth(month);
  let sourceExpenses = [];
  for (let i = 0; i < 24; i++) {
    const found = await db.expense.findMany({
      where: { userId, month: sourceMonth, isRecurring: true },
    });
    if (found.length > 0) {
      sourceExpenses = found;
      break;
    }
    const wasModified = await db.monthInit.findUnique({
      where: { userId_month_type: { userId, month: sourceMonth, type: 'expense' } },
    });
    if (wasModified) break;
    sourceMonth = prevMonth(sourceMonth);
  }

  if (sourceExpenses.length > 0) {
    await db.expense.createMany({
      data: sourceExpenses.map(e => ({
        name: e.name,           // bleibt verschlüsselt
        categoryId: e.categoryId,
        tags: e.tags,           // bleibt verschlüsselt
        userId: e.userId,
        month,
        spentOn: e.isCollector ? null : carryDayToPeriod(e.spentOn, month, startDay),
        isRecurring: true,
        // Sammelposten fangen jeden Monat bei null Buchungen an; der
        // Budgetwert wandert mit, die Buchungen bleiben im alten Monat.
        isCollector: e.isCollector,
        plannedAmount: e.plannedAmount,
        amount: e.isCollector ? encrypt('0', key) : e.amount,
      })),
    });
  }

  // Monat als initialisiert markieren (egal ob Daten kopiert wurden oder nicht)
  await db.monthInit.upsert({
    where: { userId_month_type: { userId, month, type: 'expense' } },
    create: { userId, month, type: 'expense' },
    update: {},
  });
  return sourceExpenses.length > 0;
}

/** Wie initExpenseMonth, für Einnahmen. */
async function initIncomeMonth(db, ctx, month) {
  const { userId } = ctx;
  const alreadyInit = await db.monthInit.findUnique({
    where: { userId_month_type: { userId, month, type: 'income' } },
  });
  if (alreadyInit) return false;

  let sourceMonth = prevMonth(month);
  let sourceIncomes = [];
  for (let i = 0; i < 24; i++) {
    const found = await db.income.findMany({
      where: { userId, month: sourceMonth, isRecurring: true },
    });
    if (found.length > 0) {
      sourceIncomes = found;
      break;
    }
    const wasModified = await db.monthInit.findUnique({
      where: { userId_month_type: { userId, month: sourceMonth, type: 'income' } },
    });
    if (wasModified) break;
    sourceMonth = prevMonth(sourceMonth);
  }

  if (sourceIncomes.length > 0) {
    await db.income.createMany({
      data: sourceIncomes.map(i => ({
        name: i.name,       // bleibt verschlüsselt
        amount: i.amount,   // bleibt verschlüsselt
        userId: i.userId,
        month,
        isRecurring: true,
      })),
    });
  }

  await db.monthInit.upsert({
    where: { userId_month_type: { userId, month, type: 'income' } },
    create: { userId, month, type: 'income' },
    update: {},
  });
  return sourceIncomes.length > 0;
}

/**
 * Vor einem SCHREIBVORGANG der Integration: Monat initialisieren, falls er
 * noch nie geöffnet wurde. Sonst würde ein einzelner neuer Eintrag die
 * Auto-Kopie verhindern (die greift nur bei einem leeren Monat) und Miete
 * & Co. fehlten dort. Wird nie beim Lesen aufgerufen.
 */
async function ensureMonthForWrite(db, ctx, month, type) {
  await lockMonth(db, ctx.userId, month, type);
  if (type === 'expense') {
    const any = await db.expense.findFirst({ where: { userId: ctx.userId, month } });
    if (!any) await initExpenseMonth(db, ctx, month);
  } else {
    const any = await db.income.findFirst({ where: { userId: ctx.userId, month } });
    if (!any) await initIncomeMonth(db, ctx, month);
  }
}

/** Ist der Monat schon initialisiert oder hat er Einträge? (rein lesend) */
async function isMonthInitialized(db, userId, month, type) {
  const init = await db.monthInit.findUnique({
    where: { userId_month_type: { userId, month, type } },
  });
  if (init) return true;
  const any = type === 'expense'
    ? await db.expense.findFirst({ where: { userId, month } })
    : await db.income.findFirst({ where: { userId, month } });
  return !!any;
}

// ------------------------------------------------------------
// Ausgaben
// ------------------------------------------------------------

/**
 * Legt eine Ausgabe an (bereits validiert) und kopiert eine wiederkehrende
 * in bereits initialisierte Zukunftsmonate.
 * input = { name, amount, categoryId, tags[], month, spentOn, isRecurring, isCollector }
 *   name/tags bereits bereinigt, amount als String.
 */
async function createExpense(db, ctx, input) {
  const { userId, key, startDay } = ctx;
  const encryptedTags = input.tags.length > 0 ? encrypt(JSON.stringify(input.tags), key) : '';
  // Sammelposten: der eingegebene Betrag ist der PLAN, nicht der Ist-Wert.
  // Gebucht wird nachher einzeln, `amount` startet deshalb bei 0.
  const istSammelposten = input.isCollector === true;

  const expense = await db.expense.create({
    data: {
      name: encrypt(input.name, key),
      amount: encrypt(istSammelposten ? '0' : input.amount, key),
      plannedAmount: istSammelposten ? encrypt(input.amount, key) : null,
      isCollector: istSammelposten,
      categoryId: input.categoryId,
      tags: encryptedTags,
      userId,
      month: input.month,
      spentOn: istSammelposten ? null : (input.spentOn || null),
      isRecurring: input.isRecurring,
    },
    include: { category: CATEGORY_SELECT },
  });

  // Neue wiederkehrende Ausgabe in bereits initialisierte Zukunftsmonate kopieren,
  // damit sie dort nicht fehlt, wenn der Monat schon mal besucht wurde.
  if (expense.isRecurring) {
    const futureInits = await db.monthInit.findMany({
      where: { userId, type: 'expense', month: { gt: input.month } },
    });
    if (futureInits.length > 0) {
      await db.expense.createMany({
        data: futureInits.map(fi => ({
          name: expense.name,
          amount: expense.amount, // bei Sammelposten bereits '0'
          plannedAmount: expense.plannedAmount,
          isCollector: expense.isCollector,
          categoryId: expense.categoryId,
          tags: expense.tags,
          userId: expense.userId,
          month: fi.month,
          spentOn: expense.isCollector ? null : carryDayToPeriod(expense.spentOn, fi.month, startDay),
          isRecurring: true,
        })),
      });
    }
  }
  return expense;
}

/**
 * Ändert eine Ausgabe (bereits validiert) inkl. Sammelposten-Umschaltung
 * und Propagation in Zukunftsmonate.
 * input = { name, amount, categoryId, tags[], month, spentOn?, isRecurring?, isCollector? }
 *   spentOn/isRecurring/isCollector: undefined = Bestand behalten.
 * Caller must supply an actual transaction and hold the source expense-row
 * lock; this service must not open a nested transaction.
 */
async function updateExpense(db, ctx, existing, input) {
  const { userId, key, startDay } = ctx;
  const encryptedTags = input.tags.length > 0 ? encrypt(JSON.stringify(input.tags), key) : '';

  // Sammelposten-Umschaltung:
  //   normal -> Sammelposten: der eingegebene Betrag wird zum PLAN,
  //     `amount` fällt auf 0 zurück (es gibt noch keine Buchungen).
  //   Sammelposten -> normal: die Buchungen verlieren ihren Sinn und
  //     werden entfernt, der eingegebene Betrag wird wieder der Ist-Wert.
  const willSammelposten = input.isCollector !== undefined
    ? input.isCollector === true
    : existing.isCollector;

  if (existing.isCollector && !willSammelposten) {
    await db.expenseBooking.deleteMany({ where: { expenseId: existing.id } });
  }

  // Bei einem Sammelposten ist `amount` die Summe der Buchungen und darf
  // NICHT aus dem Formular überschrieben werden — sonst wäre der Ist-Wert
  // beim nächsten Speichern des Dialogs wieder weg.
  const bleibtSammelposten = existing.isCollector && willSammelposten;

  const expense = await db.expense.update({
    where: { id: existing.id },
    data: {
      name: encrypt(input.name, key),
      amount: bleibtSammelposten
        ? existing.amount
        : encrypt(willSammelposten ? '0' : input.amount, key),
      plannedAmount: willSammelposten ? encrypt(input.amount, key) : null,
      isCollector: willSammelposten,
      categoryId: input.categoryId,
      tags: encryptedTags,
      month: input.month || existing.month,
      spentOn: willSammelposten
        ? null
        : (input.spentOn !== undefined ? (input.spentOn || null) : existing.spentOn),
      isRecurring: input.isRecurring ?? existing.isRecurring,
    },
    include: { category: CATEGORY_SELECT },
  });

  // Änderungen an wiederkehrenden Ausgaben in Zukunftsmonate propagieren.
  // Kopien werden anhand des alten verschlüsselten Namens gefunden
  // (beim Kopieren werden die verschlüsselten Werte 1:1 übernommen).
  if (expense.isRecurring && existing.isRecurring) {
    const kopien = await db.expense.findMany({
      where: {
        userId,
        name: existing.name,
        isRecurring: true,
        month: { gt: existing.month },
      },
      select: { id: true, month: true },
    });
    kopien.sort((a, b) => a.month.localeCompare(b.month) || a.id.localeCompare(b.id));
    // Einzeln statt updateMany, weil das Tagesdatum je Zielmonat anders
    // ausfällt (carryDayToPeriod). Vorher blieb spentOn in den Kopien auf
    // dem alten Tag stehen: wer den Zahltag einer Abbuchung änderte, hatte
    // ihn in allen Folgemonaten weiter auf dem alten Wert.
    for (const candidate of kopien) {
      // Booking writers lock this same parent row. Keep the lock through the
      // flag change and booking sum, and never trust the enumeration snapshot.
      await lockRow(db, 'expenses', candidate.id);
      const kopie = await db.expense.findFirst({ where: { id: candidate.id } });
      if (!kopie || kopie.userId !== userId || kopie.name !== existing.name ||
          !kopie.isRecurring || kopie.month !== candidate.month || kopie.month <= existing.month) continue;
      await db.expense.update({
        where: { id: kopie.id },
        data: {
          name: expense.name,
          // Bei Sammelposten wandert nur der PLAN weiter. Der gebuchte
          // Ist-Wert gehört dem jeweiligen Monat und darf von einer
          // Korrektur im September nicht in den Oktober geschrieben werden.
          ...(expense.isCollector ? {} : { amount: expense.amount }),
          plannedAmount: expense.plannedAmount,
          isCollector: expense.isCollector,
          categoryId: expense.categoryId,
          tags: expense.tags,
          spentOn: expense.isCollector
            ? null
            : carryDayToPeriod(expense.spentOn, kopie.month, startDay),
        },
      });
      // Eine bisher normale Zukunftskopie hat noch ihren alten Ist-Betrag.
      // Beim Typwechsel nur aus IHREN Buchungen ableiten, nie aus der Quelle.
      if (expense.isCollector && !kopie.isCollector) {
        await summeNeuBerechnen(db, key, kopie.id);
      }
    }
  } else if (existing.isRecurring && !expense.isRecurring) {
    // Wiederkehrend abgeschaltet → die Auto-Kopien in Zukunftsmonaten sind
    // nur wegen "wiederkehrend" entstanden und müssen mit verschwinden.
    await db.expense.deleteMany({
      where: {
        userId,
        name: existing.name,
        isRecurring: true,
        month: { gt: existing.month },
      },
    });
  }
  return expense;
}

/** Löscht eine Ausgabe inkl. Auto-Kopien und markiert den Monat. */
async function deleteExpense(db, ctx, existing) {
  const { userId } = ctx;
  await db.expense.delete({ where: { id: existing.id } });

  // Auto-Kopien in bereits initialisierten Zukunftsmonaten mitlöschen — sonst
  // taucht die Ausgabe im nächsten Monat wieder auf, sobald der schon einmal
  // geöffnet wurde. Kopien erkennt man am identischen verschlüsselten Namen
  // (unabhängig bearbeitete Kopien haben einen anderen Ciphertext und bleiben).
  if (existing.isRecurring) {
    await db.expense.deleteMany({
      where: {
        userId,
        name: existing.name,
        isRecurring: true,
        month: { gt: existing.month },
      },
    });
  }

  // Monat als initialisiert markieren → verhindert Auto-Copy beim nächsten Laden
  await db.monthInit.upsert({
    where: { userId_month_type: { userId, month: existing.month, type: 'expense' } },
    create: { userId, month: existing.month, type: 'expense' },
    update: {},
  });
}

// ------------------------------------------------------------
// Buchungen auf Sammelposten
// ------------------------------------------------------------
// Nach jeder Änderung wird die Summe neu berechnet und in Expense.amount
// geschrieben — dadurch lesen Dashboard, Verlauf und Export unverändert
// weiter. Seit 2026-10-11 in ganzen Cent (vorher Gleitkomma + Runden) und
// unter einer Zeilensperre auf dem Posten: zwei gleichzeitige Buchungen
// konnten sonst eine Summe hinterlassen, in der eine von beiden fehlte.

async function summeNeuBerechnen(db, key, expenseId) {
  const buchungen = await db.expenseBooking.findMany({ where: { expenseId } });
  const cents = buchungen.reduce((s, b) => s + toCents(decrypt(b.amount, key)), 0);
  const summe = cents / 100;
  await db.expense.update({
    where: { id: expenseId },
    data: { amount: encrypt(String(summe), key) },
  });
  return summe;
}

/** data = { amount (String), note (bereinigt oder ''), bookedOn|null } */
async function createBooking(db, ctx, posten, data) {
  await lockRow(db, 'expenses', posten.id);
  const buchung = await db.expenseBooking.create({
    data: {
      amount: encrypt(data.amount, ctx.key),
      note: data.note ? encrypt(data.note, ctx.key) : '',
      bookedOn: data.bookedOn || null,
      expenseId: posten.id,
      userId: ctx.userId,
    },
  });
  const total = await summeNeuBerechnen(db, ctx.key, posten.id);
  return { buchung, total };
}

async function updateBooking(db, ctx, posten, vorhanden, data) {
  await lockRow(db, 'expenses', posten.id);
  const buchung = await db.expenseBooking.update({
    where: { id: vorhanden.id },
    data: {
      amount: encrypt(data.amount, ctx.key),
      note: data.note ? encrypt(data.note, ctx.key) : '',
      bookedOn: data.bookedOn || null,
    },
  });
  const total = await summeNeuBerechnen(db, ctx.key, posten.id);
  return { buchung, total };
}

async function deleteBooking(db, ctx, posten, vorhanden) {
  await lockRow(db, 'expenses', posten.id);
  await db.expenseBooking.delete({ where: { id: vorhanden.id } });
  const total = await summeNeuBerechnen(db, ctx.key, posten.id);
  return { total };
}

// ------------------------------------------------------------
// Einnahmen
// ------------------------------------------------------------

/** input = { name (bereinigt), amount (String), month, isRecurring } */
async function createIncome(db, ctx, input) {
  const { userId, key } = ctx;
  const income = await db.income.create({
    data: {
      name: encrypt(input.name, key),
      amount: encrypt(input.amount, key),
      userId,
      month: input.month,
      isRecurring: input.isRecurring,
    },
  });

  // Neue wiederkehrende Einnahme in bereits initialisierte Zukunftsmonate kopieren.
  if (income.isRecurring) {
    const futureInits = await db.monthInit.findMany({
      where: { userId, type: 'income', month: { gt: input.month } },
    });
    if (futureInits.length > 0) {
      await db.income.createMany({
        data: futureInits.map(fi => ({
          name: income.name,
          amount: income.amount,
          userId: income.userId,
          month: fi.month,
          isRecurring: true,
        })),
      });
    }
  }
  return income;
}

/** input = { name, amount, month?, isRecurring? } */
async function updateIncome(db, ctx, existing, input) {
  const { userId, key } = ctx;
  const income = await db.income.update({
    where: { id: existing.id },
    data: {
      name: encrypt(input.name, key),
      amount: encrypt(input.amount, key),
      month: input.month || existing.month,
      isRecurring: input.isRecurring ?? existing.isRecurring,
    },
  });

  // Änderungen an wiederkehrenden Einnahmen in Zukunftsmonate propagieren.
  if (income.isRecurring && existing.isRecurring) {
    await db.income.updateMany({
      where: {
        userId,
        name: existing.name,
        isRecurring: true,
        month: { gt: existing.month },
      },
      data: {
        name: income.name,
        amount: income.amount,
      },
    });
  } else if (existing.isRecurring && !income.isRecurring) {
    // Wiederkehrend abgeschaltet → Auto-Kopien in Zukunftsmonaten entfernen.
    await db.income.deleteMany({
      where: {
        userId,
        name: existing.name,
        isRecurring: true,
        month: { gt: existing.month },
      },
    });
  }
  return income;
}

async function deleteIncome(db, ctx, existing) {
  const { userId } = ctx;
  await db.income.delete({ where: { id: existing.id } });

  // Auto-Kopien in bereits initialisierten Zukunftsmonaten mitlöschen
  // (gleiche Logik wie bei Ausgaben).
  if (existing.isRecurring) {
    await db.income.deleteMany({
      where: {
        userId,
        name: existing.name,
        isRecurring: true,
        month: { gt: existing.month },
      },
    });
  }

  // Monat als initialisiert markieren → verhindert Auto-Copy beim nächsten Laden
  await db.monthInit.upsert({
    where: { userId_month_type: { userId, month: existing.month, type: 'income' } },
    create: { userId, month: existing.month, type: 'income' },
    update: {},
  });
}

// ------------------------------------------------------------
// Kategorien
// ------------------------------------------------------------

/**
 * Löscht eine Kategorie. Zugeordnete Ausgaben wandern nach "Sonstiges":
 * immer ein ANDERES "Sonstiges" als die gelöschte Kategorie (bei mehreren
 * das älteste, Vergleich case-insensitiv); gibt es keins, wird es angelegt.
 * @returns {{ movedExpenses: number } | { error: string }}
 */
async function deleteCategory(db, ctx, category) {
  const { userId, key } = ctx;
  const expenses = await db.expense.findMany({ where: { categoryId: category.id } });
  if (expenses.length > 0) {
    const allCats = await db.category.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
    const istSonstiges = c => entschaerfe(decrypt(c.name, key))?.trim().toLowerCase() === 'sonstiges';
    let fallback = allCats.find(c => c.id !== category.id && istSonstiges(c));
    if (!fallback) {
      if (istSonstiges(category)) {
        return { error: '"Sonstiges" kann nicht gelöscht werden, solange Ausgaben zugeordnet sind.' };
      }
      fallback = await db.category.create({
        data: { name: encrypt('Sonstiges', key), color: encrypt('#8E8E93', key), userId },
      });
    }
    await db.expense.updateMany({ where: { categoryId: category.id }, data: { categoryId: fallback.id } });
  }
  await db.category.delete({ where: { id: category.id } });
  return { movedExpenses: expenses.length };
}

// ------------------------------------------------------------
// Auswertungen (rein lesend)
// ------------------------------------------------------------

async function computeSummary(db, ctx, month) {
  const { userId, key } = ctx;
  const rawExpenses = await db.expense.findMany({
    where: { userId, month },
    include: { category: CATEGORY_SELECT, bookings: true },
  });
  const rawIncomes = await db.income.findMany({ where: { userId, month } });

  const expenses = rawExpenses.map(e => decryptExpense(e, key));
  const incomes = rawIncomes.map(i => decryptIncome(i, key));

  const totalExpenses = expenses.reduce((s, e) => s + parseFloat(e.amount), 0);
  const totalIncome = incomes.reduce((s, i) => s + parseFloat(i.amount), 0);

  // Sammelposten: was vom Budget noch NICHT gebucht ist. `totalExpenses`
  // zählt nur echte Buchungen — ohne diesen Rest sähe der Monatsanfang so
  // aus, als wäre noch alles Geld da, obwohl es längst eingeplant ist.
  let plannedOpen = 0;
  let plannedTotal = 0;
  let bookedTotal = 0;
  for (const e of expenses) {
    if (!e.isCollector) continue;
    const plan = parseFloat(e.plannedAmount);
    const gebucht = parseFloat(e.amount);
    const p = isNaN(plan) ? 0 : plan;
    const g = isNaN(gebucht) ? 0 : gebucht;
    plannedTotal += p;
    bookedTotal += g;
    plannedOpen += Math.max(0, p - g);
  }

  const byCategory = {};
  for (const expense of expenses) {
    const catId = expense.category?.id;
    if (!catId) continue;
    if (!byCategory[catId]) {
      byCategory[catId] = { category: expense.category, total: 0, count: 0 };
    }
    byCategory[catId].total += parseFloat(expense.amount);
    byCategory[catId].count += 1;
  }

  const byTag = {};
  for (const expense of expenses) {
    const tags = expense.tags || [];
    for (const tag of tags) {
      if (!byTag[tag]) byTag[tag] = { tag, total: 0, count: 0 };
      byTag[tag].total += parseFloat(expense.amount);
      byTag[tag].count += 1;
    }
  }

  const pm = prevMonth(month);
  const prevRaw = await db.expense.findMany({ where: { userId, month: pm } });
  const prevTotal = prevRaw.reduce((s, e) => {
    const num = parseFloat(decrypt(e.amount, key));
    return s + (isNaN(num) ? 0 : num);
  }, 0);

  return {
    month,
    totalExpenses: Math.round(totalExpenses * 100) / 100,
    totalIncome: Math.round(totalIncome * 100) / 100,
    remaining: Math.round((totalIncome - totalExpenses) * 100) / 100,
    // "geplant / gebucht" der Sammelposten und was davon noch offen ist.
    collectors: {
      planned: Math.round(plannedTotal * 100) / 100,
      booked: Math.round(bookedTotal * 100) / 100,
      open: Math.round(plannedOpen * 100) / 100,
    },
    // Verbleibend, wenn man den noch nicht gebuchten Planrest schon abzieht.
    remainingAfterPlan: Math.round((totalIncome - totalExpenses - plannedOpen) * 100) / 100,
    byCategory: Object.values(byCategory).sort((a, b) => b.total - a.total),
    byTag: Object.values(byTag).sort((a, b) => b.total - a.total),
    comparison: {
      previousMonth: pm,
      previousTotal: Math.round(prevTotal * 100) / 100,
      change: Math.round((totalExpenses - prevTotal) * 100) / 100,
      changePercent: prevTotal > 0
        ? Math.round(((totalExpenses - prevTotal) / prevTotal) * 10000) / 100
        : null,
    },
  };
}

// Aggregiert die letzten N Monate (Ende = endMonth): je Monat Ausgaben- und
// Einnahmensumme, dazu Kategoriesummen über das ganze Fenster. Es werden
// KEINE Einzelposten zurückgegeben, nur Summen.
async function computeHistory(db, ctx, endMonth, n) {
  const { userId, key } = ctx;
  const monthList = [endMonth];
  while (monthList.length < n) monthList.unshift(prevMonth(monthList[0]));

  const [rawExpenses, rawIncomes] = await Promise.all([
    db.expense.findMany({
      where: { userId, month: { in: monthList } },
      include: { category: CATEGORY_SELECT },
    }),
    db.income.findMany({
      where: { userId, month: { in: monthList } },
    }),
  ]);

  const parseAmount = (enc) => {
    const num = parseFloat(decrypt(enc, key));
    return isNaN(num) ? 0 : num;
  };

  const perMonth = {};
  for (const m of monthList) perMonth[m] = { month: m, expenses: 0, income: 0 };
  const byCategory = {};
  const catNames = {}; // Kategorie nur EINMAL entschlüsseln

  for (const e of rawExpenses) {
    const amount = parseAmount(e.amount);
    perMonth[e.month].expenses += amount;
    if (e.category) {
      if (!catNames[e.category.id]) {
        catNames[e.category.id] = {
          id: e.category.id,
          name: entschaerfe(decrypt(e.category.name, key)),
          color: decrypt(e.category.color, key),
        };
      }
      const cat = catNames[e.category.id];
      if (!byCategory[cat.id]) byCategory[cat.id] = { ...cat, total: 0, count: 0 };
      byCategory[cat.id].total += amount;
      byCategory[cat.id].count += 1;
    }
  }
  for (const i of rawIncomes) perMonth[i.month].income += parseAmount(i.amount);

  const round2 = (v) => Math.round(v * 100) / 100;
  return {
    months: monthList.map((m) => ({
      month: m,
      expenses: round2(perMonth[m].expenses),
      income: round2(perMonth[m].income),
    })),
    byCategory: Object.values(byCategory)
      .map((c) => ({ ...c, total: round2(c.total) }))
      .sort((a, b) => b.total - a.total),
  };
}

module.exports = {
  CATEGORY_SELECT,
  EXPENSE_INCLUDE,
  decryptExpense,
  decryptBooking,
  decryptIncome,
  toCents,
  lockRow,
  initExpenseMonth,
  initIncomeMonth,
  ensureMonthForWrite,
  isMonthInitialized,
  createExpense,
  updateExpense,
  deleteExpense,
  summeNeuBerechnen,
  createBooking,
  updateBooking,
  deleteBooking,
  createIncome,
  updateIncome,
  deleteIncome,
  deleteCategory,
  computeSummary,
  computeHistory,
};
