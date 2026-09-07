// ============================================================
// AUSGABEN-ROUTEN — mit Verschlüsselung
// ============================================================

const express = require('express');
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { validateExpense, validateBooking, sanitize } = require('../utils/validation');
const { encrypt, decrypt } = require('../utils/encryption');
const { entschaerfe, entschaerfeListe } = require('../utils/legacyText');
const { prevMonth, currentPeriod, carryDayToPeriod } = require('../utils/budgetPeriod');

const router = express.Router();

router.use(requireAuth);

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

// Summe der Buchungen eines Sammelpostens neu berechnen und in `amount`
// zurückschreiben. Dadurch bleibt `amount` überall die eine Wahrheit —
// Dashboard, Donut, Verlauf, PDF- und JSON-Export lesen unverändert weiter.
async function summeNeuBerechnen(expenseId, key) {
  const buchungen = await prisma.expenseBooking.findMany({ where: { expenseId } });
  const summe = buchungen.reduce((s, b) => {
    const n = parseFloat(decrypt(b.amount, key));
    return s + (isNaN(n) ? 0 : n);
  }, 0);
  const gerundet = Math.round(summe * 100) / 100;
  await prisma.expense.update({
    where: { id: expenseId },
    data: { amount: encrypt(String(gerundet), key) },
  });
  return gerundet;
}

// prevMonth, currentPeriod und carryDayToPeriod liegen in
// ../utils/budgetPeriod — dort steckt auch die Logik für einen
// verschobenen Monatsanfang (z.B. 15. bis 14.).

// spentOn aus dem Request lesen: leer/fehlend -> null (Validierung lief schon).
function readSpentOn(body) {
  return body.spentOn ? body.spentOn : null;
}

// GET /api/expenses/summary — MUSS vor /:id stehen!
router.get('/summary', async (req, res) => {
  try {
    const month = req.query.month || currentPeriod(req.budgetStartDay);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'Ungültiges Monatsformat.' });
    }

    const rawExpenses = await prisma.expense.findMany({
      where: { userId: req.userId, month },
      include: {
        category: { select: { id: true, name: true, color: true } },
        bookings: true,
      },
    });

    const rawIncomes = await prisma.income.findMany({
      where: { userId: req.userId, month },
    });

    const key = req.encryptionKey;
    const expenses = rawExpenses.map(e => decryptExpense(e, key));
    const incomes = rawIncomes.map(i => ({
      ...i,
      name: entschaerfe(decrypt(i.name, key)),
      amount: decrypt(i.amount, key),
    }));

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
    const prevRaw = await prisma.expense.findMany({
      where: { userId: req.userId, month: pm },
    });
    const prevTotal = prevRaw.reduce((s, e) => {
      const decrypted = decrypt(e.amount, key);
      const num = parseFloat(decrypted);
      return s + (isNaN(num) ? 0 : num);
    }, 0);

    res.json({
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
    });
  } catch (error) {
    console.error('Summary fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Zusammenfassung konnte nicht geladen werden.' });
  }
});

// ============================================================
// GET /api/expenses/history?months=12 — Monatsverlauf (MUSS vor /:id stehen!)
// ============================================================
// Aggregiert die letzten N Monate (Ende = ?month oder aktueller Monat):
// je Monat Ausgaben- und Einnahmensumme, dazu Kategoriesummen über das
// ganze Fenster. Beträge sind verschlüsselt — die Aggregation entschlüsselt
// serverseitig (Einzelnutzer-Datenmengen, unkritisch). Es werden KEINE
// Einzelposten zurückgegeben, nur Summen.
router.get('/history', async (req, res) => {
  try {
    const n = Math.min(24, Math.max(3, parseInt(req.query.months, 10) || 12));
    const endMonth = req.query.month || currentPeriod(req.budgetStartDay);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(endMonth)) {
      return res.status(400).json({ error: 'Ungültiges Monatsformat.' });
    }
    const monthList = [endMonth];
    while (monthList.length < n) monthList.unshift(prevMonth(monthList[0]));

    const [rawExpenses, rawIncomes] = await Promise.all([
      prisma.expense.findMany({
        where: { userId: req.userId, month: { in: monthList } },
        include: { category: { select: { id: true, name: true, color: true } } },
      }),
      prisma.income.findMany({
        where: { userId: req.userId, month: { in: monthList } },
      }),
    ]);

    const key = req.encryptionKey;
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
    res.json({
      months: monthList.map((m) => ({
        month: m,
        expenses: round2(perMonth[m].expenses),
        income: round2(perMonth[m].income),
      })),
      byCategory: Object.values(byCategory)
        .map((c) => ({ ...c, total: round2(c.total) }))
        .sort((a, b) => b.total - a.total),
    });
  } catch (error) {
    console.error('Verlauf fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Der Verlauf konnte nicht geladen werden.' });
  }
});

// ============================================================
// GET /api/expenses
// Lädt Ausgaben für den Monat.
// Falls keine existieren: wiederkehrende aus dem letzten
// bekannten Monat automatisch kopieren.
// ============================================================
router.get('/', async (req, res) => {
  try {
    const month = req.query.month || currentPeriod(req.budgetStartDay);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'Ungültiges Monatsformat.' });
    }

    let rawExpenses = await prisma.expense.findMany({
      where: { userId: req.userId, month },
      include: {
        category: { select: { id: true, name: true, color: true } },
        bookings: true,
      },
    });

    // Wenn keine Ausgaben: nur kopieren wenn der Monat noch NICHT initialisiert wurde
    // (d.h. der User hat noch NICHTS für diesen Monat gemacht — kein Löschen, kein Hinzufügen)
    if (rawExpenses.length === 0) {
      const alreadyInit = await prisma.monthInit.findUnique({
        where: { userId_month_type: { userId: req.userId, month, type: 'expense' } },
      });

      if (alreadyInit) {
        // Monat wurde bereits initialisiert → nicht neu kopieren, leer lassen
        return res.json({ expenses: [], total: 0, month });
      }

      // Letzten Monat mit Ausgaben finden (max. 24 Monate zurück).
      // Stoppt wenn ein Monat gefunden wird, der vom User explizit bearbeitet
      // wurde (monthInit vorhanden) — auch wenn er leer ist. Das verhindert,
      // dass absichtlich gelöschte Einträge aus noch älteren Monaten zurückkommen.
      let sourceMonth = prevMonth(month);
      let sourceExpenses = [];

      for (let i = 0; i < 24; i++) {
        const found = await prisma.expense.findMany({
          where: { userId: req.userId, month: sourceMonth, isRecurring: true },
        });
        if (found.length > 0) {
          sourceExpenses = found;
          break;
        }
        const wasModified = await prisma.monthInit.findUnique({
          where: { userId_month_type: { userId: req.userId, month: sourceMonth, type: 'expense' } },
        });
        if (wasModified) break;
        sourceMonth = prevMonth(sourceMonth);
      }

      // Wiederkehrende in den neuen Monat kopieren
      if (sourceExpenses.length > 0) {
        await prisma.expense.createMany({
          data: sourceExpenses.map(e => ({
            name: e.name,           // bleibt verschlüsselt
            categoryId: e.categoryId,
            tags: e.tags,           // bleibt verschlüsselt
            userId: e.userId,
            month,
            spentOn: e.isCollector ? null : carryDayToPeriod(e.spentOn, month, req.budgetStartDay),
            isRecurring: true,
            // Sammelposten fangen jeden Monat bei null Buchungen an; der
            // Budgetwert wandert mit, die Buchungen bleiben im alten Monat.
            isCollector: e.isCollector,
            plannedAmount: e.plannedAmount,
            amount: e.isCollector ? encrypt('0', req.encryptionKey) : e.amount,
          })),
        });

        // Neu erstellte laden
        rawExpenses = await prisma.expense.findMany({
          where: { userId: req.userId, month },
          include: {
            category: { select: { id: true, name: true, color: true } },
            bookings: true,
          },
        });
      }

      // Monat als initialisiert markieren (egal ob Daten kopiert wurden oder nicht)
      await prisma.monthInit.upsert({
        where: { userId_month_type: { userId: req.userId, month, type: 'expense' } },
        create: { userId: req.userId, month, type: 'expense' },
        update: {},
      });
    }

    const expenses = rawExpenses.map(e => decryptExpense(e, req.encryptionKey));
    expenses.sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount));
    const total = expenses.reduce((s, e) => s + parseFloat(e.amount), 0);

    res.json({ expenses, total: Math.round(total * 100) / 100, month });

  } catch (error) {
    console.error('Ausgaben laden fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Ausgaben konnten nicht geladen werden.' });
  }
});

// GET /api/expenses/:id
router.get('/:id', async (req, res) => {
  try {
    const expense = await prisma.expense.findFirst({
      where: { id: req.params.id, userId: req.userId },
      include: { category: { select: { id: true, name: true, color: true } } },
    });

    if (!expense) return res.status(404).json({ error: 'Ausgabe nicht gefunden.' });

    res.json({ expense: decryptExpense(expense, req.encryptionKey) });

  } catch (error) {
    console.error('Ausgabe laden fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Ausgabe konnte nicht geladen werden.' });
  }
});

// POST /api/expenses
router.post('/', async (req, res) => {
  try {
    // Den Monat VOR der Validierung festlegen: sonst wird `spentOn` gegen
    // gar nichts geprüft, wenn der Client kein `month` mitschickt — und ein
    // Datum aus einem ganz anderen Monat rutscht durch.
    const month = req.body.month || currentPeriod(req.budgetStartDay);

    const errors = validateExpense({ ...req.body, month }, req.budgetStartDay);
    if (errors.length > 0) return res.status(400).json({ errors });

    const category = await prisma.category.findFirst({
      where: { id: req.body.categoryId, userId: req.userId },
    });
    if (!category) return res.status(400).json({ errors: ['Ungültige Kategorie.'] });
    const key = req.encryptionKey;

    const tags = Array.isArray(req.body.tags)
      ? req.body.tags.map(t => sanitize(t.trim())).filter(Boolean)
      : [];
    const encryptedTags = tags.length > 0 ? encrypt(JSON.stringify(tags), key) : '';

    // Sammelposten: der eingegebene Betrag ist der PLAN, nicht der Ist-Wert.
    // Gebucht wird nachher einzeln, `amount` startet deshalb bei 0.
    const istSammelposten = req.body.isCollector === true;
    const betrag = String(parseFloat(req.body.amount));

    const expense = await prisma.expense.create({
      data: {
        name: encrypt(sanitize(req.body.name), key),
        amount: encrypt(istSammelposten ? '0' : betrag, key),
        plannedAmount: istSammelposten ? encrypt(betrag, key) : null,
        isCollector: istSammelposten,
        categoryId: req.body.categoryId,
        tags: encryptedTags,
        userId: req.userId,
        month,
        spentOn: istSammelposten ? null : readSpentOn(req.body),
        isRecurring: req.body.isRecurring !== false,
      },
      include: { category: { select: { id: true, name: true, color: true } } },
    });

    // Neue wiederkehrende Ausgabe in bereits initialisierte Zukunftsmonate kopieren,
    // damit sie dort nicht fehlt, wenn der Monat schon mal besucht wurde.
    if (expense.isRecurring) {
      const futureInits = await prisma.monthInit.findMany({
        where: { userId: req.userId, type: 'expense', month: { gt: month } },
      });
      if (futureInits.length > 0) {
        await prisma.expense.createMany({
          data: futureInits.map(fi => ({
            name: expense.name,
            amount: expense.amount, // bei Sammelposten bereits '0'
            plannedAmount: expense.plannedAmount,
            isCollector: expense.isCollector,
            categoryId: expense.categoryId,
            tags: expense.tags,
            userId: expense.userId,
            month: fi.month,
            spentOn: expense.isCollector ? null : carryDayToPeriod(expense.spentOn, fi.month, req.budgetStartDay),
            isRecurring: true,
          })),
        });
      }
    }

    res.status(201).json({ expense: decryptExpense(expense, key) });

  } catch (error) {
    console.error('Ausgabe erstellen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Ausgabe konnte nicht erstellt werden.' });
  }
});

// PUT /api/expenses/:id
router.put('/:id', async (req, res) => {
  try {
    const existing = await prisma.expense.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!existing) return res.status(404).json({ error: 'Ausgabe nicht gefunden.' });

    // Erst laden, dann validieren: der effektive Monat (Body oder Bestand)
    // wird für die Datumsprüfung gebraucht.
    const zielMonat = req.body.month || existing.month;
    const errors = validateExpense({ ...req.body, month: zielMonat }, req.budgetStartDay);
    if (errors.length > 0) return res.status(400).json({ errors });

    if (req.body.categoryId !== existing.categoryId) {
      const cat = await prisma.category.findFirst({
        where: { id: req.body.categoryId, userId: req.userId },
      });
      if (!cat) return res.status(400).json({ errors: ['Ungültige Kategorie.'] });
    }

    const key = req.encryptionKey;

    const tags = Array.isArray(req.body.tags)
      ? req.body.tags.map(t => sanitize(t.trim())).filter(Boolean)
      : [];
    const encryptedTags = tags.length > 0 ? encrypt(JSON.stringify(tags), key) : '';

    // Sammelposten-Umschaltung:
    //   normal -> Sammelposten: der eingegebene Betrag wird zum PLAN,
    //     `amount` fällt auf 0 zurück (es gibt noch keine Buchungen).
    //   Sammelposten -> normal: die Buchungen verlieren ihren Sinn und
    //     werden entfernt, der eingegebene Betrag wird wieder der Ist-Wert.
    const willSammelposten = req.body.isCollector !== undefined
      ? req.body.isCollector === true
      : existing.isCollector;
    const betrag = String(parseFloat(req.body.amount));

    if (existing.isCollector && !willSammelposten) {
      await prisma.expenseBooking.deleteMany({ where: { expenseId: existing.id } });
    }

    // Bei einem Sammelposten ist `amount` die Summe der Buchungen und darf
    // NICHT aus dem Formular überschrieben werden — sonst wäre der Ist-Wert
    // beim nächsten Speichern des Dialogs wieder weg.
    const bleibtSammelposten = existing.isCollector && willSammelposten;

    const expense = await prisma.expense.update({
      where: { id: req.params.id },
      data: {
        name: encrypt(sanitize(req.body.name), key),
        amount: bleibtSammelposten
          ? existing.amount
          : encrypt(willSammelposten ? '0' : betrag, key),
        plannedAmount: willSammelposten ? encrypt(betrag, key) : null,
        isCollector: willSammelposten,
        categoryId: req.body.categoryId,
        tags: encryptedTags,
        month: req.body.month || existing.month,
        spentOn: willSammelposten
          ? null
          : (req.body.spentOn !== undefined ? readSpentOn(req.body) : existing.spentOn),
        isRecurring: req.body.isRecurring ?? existing.isRecurring,
      },
      include: { category: { select: { id: true, name: true, color: true } } },
    });

    // Änderungen an wiederkehrenden Ausgaben in Zukunftsmonate propagieren.
    // Kopien werden anhand des alten verschlüsselten Namens gefunden
    // (beim Kopieren werden die verschlüsselten Werte 1:1 übernommen).
    if (expense.isRecurring && existing.isRecurring) {
      const kopien = await prisma.expense.findMany({
        where: {
          userId: req.userId,
          name: existing.name,
          isRecurring: true,
          month: { gt: existing.month },
        },
        select: { id: true, month: true },
      });
      // Einzeln statt updateMany, weil das Tagesdatum je Zielmonat anders
      // ausfällt (carryDayToPeriod). Vorher blieb spentOn in den Kopien auf
      // dem alten Tag stehen: wer den Zahltag einer Abbuchung änderte, hatte
      // ihn in allen Folgemonaten weiter auf dem alten Wert.
      for (const kopie of kopien) {
        await prisma.expense.update({
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
              : carryDayToPeriod(expense.spentOn, kopie.month, req.budgetStartDay),
          },
        });
      }
    } else if (existing.isRecurring && !expense.isRecurring) {
      // Wiederkehrend abgeschaltet → die Auto-Kopien in Zukunftsmonaten sind
      // nur wegen "wiederkehrend" entstanden und müssen mit verschwinden.
      await prisma.expense.deleteMany({
        where: {
          userId: req.userId,
          name: existing.name,
          isRecurring: true,
          month: { gt: existing.month },
        },
      });
    }

    res.json({ expense: decryptExpense(expense, key) });

  } catch (error) {
    console.error('Ausgabe bearbeiten fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Ausgabe konnte nicht geändert werden.' });
  }
});

// DELETE /api/expenses/:id
router.delete('/:id', async (req, res) => {
  try {
    const existing = await prisma.expense.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!existing) return res.status(404).json({ error: 'Ausgabe nicht gefunden.' });

    await prisma.expense.delete({ where: { id: req.params.id } });

    // Auto-Kopien in bereits initialisierten Zukunftsmonaten mitlöschen — sonst
    // taucht die Ausgabe im nächsten Monat wieder auf, sobald der schon einmal
    // geöffnet wurde. Kopien erkennt man am identischen verschlüsselten Namen
    // (unabhängig bearbeitete Kopien haben einen anderen Ciphertext und bleiben).
    if (existing.isRecurring) {
      await prisma.expense.deleteMany({
        where: {
          userId: req.userId,
          name: existing.name,
          isRecurring: true,
          month: { gt: existing.month },
        },
      });
    }

    // Monat als initialisiert markieren → verhindert Auto-Copy beim nächsten Laden
    await prisma.monthInit.upsert({
      where: { userId_month_type: { userId: req.userId, month: existing.month, type: 'expense' } },
      create: { userId: req.userId, month: existing.month, type: 'expense' },
      update: {},
    });

    res.json({ message: 'Ausgabe gelöscht.' });

  } catch (error) {
    console.error('Ausgabe löschen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Ausgabe konnte nicht gelöscht werden.' });
  }
});

// ============================================================
// BUCHUNGEN AUF SAMMELPOSTEN
// ============================================================
// Ein Sammelposten ("Rewe") sammelt Einzelbuchungen ein. Nach jeder
// Änderung wird die Summe neu berechnet und in Expense.amount geschrieben —
// dadurch lesen Dashboard, Verlauf und Export unverändert weiter.
// Buchungen werden NIE in Folgemonate kopiert.
// ============================================================

// Posten laden und prüfen, dass er dem Nutzer gehört und Buchungen annimmt.
async function ladeSammelposten(req, res) {
  const posten = await prisma.expense.findFirst({
    where: { id: req.params.id, userId: req.userId },
  });
  if (!posten) {
    res.status(404).json({ error: 'Ausgabe nicht gefunden.' });
    return null;
  }
  if (!posten.isCollector) {
    res.status(400).json({ error: 'Auf diese Ausgabe kann nicht gebucht werden. Sie ist kein Sammelposten.' });
    return null;
  }
  return posten;
}

// GET /api/expenses/:id/bookings — Buchungen eines Postens
router.get('/:id/bookings', async (req, res) => {
  try {
    const posten = await ladeSammelposten(req, res);
    if (!posten) return;

    const buchungen = await prisma.expenseBooking.findMany({
      where: { expenseId: posten.id },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ bookings: buchungen.map(b => decryptBooking(b, req.encryptionKey)) });

  } catch (error) {
    console.error('Buchungen laden fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Buchungen konnten nicht geladen werden.' });
  }
});

// POST /api/expenses/:id/bookings — schnell etwas auf den Posten buchen
router.post('/:id/bookings', async (req, res) => {
  try {
    const posten = await ladeSammelposten(req, res);
    if (!posten) return;

    const errors = validateBooking(req.body, posten.month, req.budgetStartDay);
    if (errors.length > 0) return res.status(400).json({ errors });

    const key = req.encryptionKey;
    const buchung = await prisma.expenseBooking.create({
      data: {
        amount: encrypt(String(parseFloat(req.body.amount)), key),
        note: req.body.note ? encrypt(sanitize(req.body.note), key) : '',
        bookedOn: req.body.bookedOn ? req.body.bookedOn : null,
        expenseId: posten.id,
        userId: req.userId,
      },
    });

    const summe = await summeNeuBerechnen(posten.id, key);

    res.status(201).json({
      booking: decryptBooking(buchung, key),
      total: summe,
    });

  } catch (error) {
    console.error('Buchung anlegen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Die Buchung konnte nicht gespeichert werden.' });
  }
});

// PUT /api/expenses/:id/bookings/:bookingId
router.put('/:id/bookings/:bookingId', async (req, res) => {
  try {
    const posten = await ladeSammelposten(req, res);
    if (!posten) return;

    const vorhanden = await prisma.expenseBooking.findFirst({
      where: { id: req.params.bookingId, expenseId: posten.id, userId: req.userId },
    });
    if (!vorhanden) return res.status(404).json({ error: 'Buchung nicht gefunden.' });

    const errors = validateBooking(req.body, posten.month, req.budgetStartDay);
    if (errors.length > 0) return res.status(400).json({ errors });

    const key = req.encryptionKey;
    const buchung = await prisma.expenseBooking.update({
      where: { id: vorhanden.id },
      data: {
        amount: encrypt(String(parseFloat(req.body.amount)), key),
        note: req.body.note ? encrypt(sanitize(req.body.note), key) : '',
        bookedOn: req.body.bookedOn ? req.body.bookedOn : null,
      },
    });

    const summe = await summeNeuBerechnen(posten.id, key);
    res.json({ booking: decryptBooking(buchung, key), total: summe });

  } catch (error) {
    console.error('Buchung ändern fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Die Buchung konnte nicht geändert werden.' });
  }
});

// DELETE /api/expenses/:id/bookings/:bookingId
router.delete('/:id/bookings/:bookingId', async (req, res) => {
  try {
    const posten = await ladeSammelposten(req, res);
    if (!posten) return;

    const vorhanden = await prisma.expenseBooking.findFirst({
      where: { id: req.params.bookingId, expenseId: posten.id, userId: req.userId },
    });
    if (!vorhanden) return res.status(404).json({ error: 'Buchung nicht gefunden.' });

    await prisma.expenseBooking.delete({ where: { id: vorhanden.id } });
    const summe = await summeNeuBerechnen(posten.id, req.encryptionKey);

    res.json({ message: 'Buchung gelöscht.', total: summe });

  } catch (error) {
    console.error('Buchung löschen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Die Buchung konnte nicht gelöscht werden.' });
  }
});

module.exports = router;