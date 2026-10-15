// ============================================================
// AUSGABEN-ROUTEN — mit Verschlüsselung
// ============================================================
// Die eigentliche Logik (Auto-Kopie, Propagation, Sammelposten-Summen)
// liegt seit 2026-10-11 in ../services/finance.js — die Hermes-Integration
// (routes/integration.js) nutzt dieselben Funktionen.
// ============================================================

const express = require('express');
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { validateExpense, validateBooking, sanitize } = require('../utils/validation');
const { currentPeriod } = require('../utils/budgetPeriod');
const finance = require('../services/finance');

const { decryptExpense, decryptBooking, EXPENSE_INCLUDE, CATEGORY_SELECT } = finance;

const router = express.Router();

router.use(requireAuth);

function ctxOf(req) {
  return { userId: req.userId, key: req.encryptionKey, startDay: req.budgetStartDay };
}

// spentOn aus dem Request lesen: leer/fehlend -> null (Validierung lief schon).
function readSpentOn(body) {
  return body.spentOn ? body.spentOn : null;
}

function readTags(body) {
  return Array.isArray(body.tags)
    ? body.tags.map(t => sanitize(t.trim())).filter(Boolean)
    : [];
}

// GET /api/expenses/summary — MUSS vor /:id stehen!
router.get('/summary', async (req, res) => {
  try {
    const month = req.query.month || currentPeriod(req.budgetStartDay);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'Ungültiges Monatsformat.' });
    }
    res.json(await finance.computeSummary(prisma, ctxOf(req), month));
  } catch (error) {
    console.error('Summary fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Zusammenfassung konnte nicht geladen werden.' });
  }
});

// ============================================================
// GET /api/expenses/history?months=12 — Monatsverlauf (MUSS vor /:id stehen!)
// ============================================================
// Aggregiert die letzten N Monate (Ende = ?month oder aktueller Monat).
// Es werden KEINE Einzelposten zurückgegeben, nur Summen.
router.get('/history', async (req, res) => {
  try {
    const n = Math.min(24, Math.max(3, parseInt(req.query.months, 10) || 12));
    const endMonth = req.query.month || currentPeriod(req.budgetStartDay);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(endMonth)) {
      return res.status(400).json({ error: 'Ungültiges Monatsformat.' });
    }
    res.json(await finance.computeHistory(prisma, ctxOf(req), endMonth, n));
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
      include: EXPENSE_INCLUDE,
    });

    // Wenn keine Ausgaben: nur kopieren wenn der Monat noch NICHT initialisiert wurde
    // (d.h. der User hat noch NICHTS für diesen Monat gemacht — kein Löschen, kein Hinzufügen)
    if (rawExpenses.length === 0) {
      const kopiert = await finance.initExpenseMonth(prisma, ctxOf(req), month);
      if (kopiert) {
        rawExpenses = await prisma.expense.findMany({
          where: { userId: req.userId, month },
          include: EXPENSE_INCLUDE,
        });
      }
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
      include: { category: CATEGORY_SELECT },
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

    const expense = await finance.createExpense(prisma, ctxOf(req), {
      name: sanitize(req.body.name),
      amount: String(parseFloat(req.body.amount)),
      categoryId: req.body.categoryId,
      tags: readTags(req.body),
      month,
      spentOn: readSpentOn(req.body),
      isRecurring: req.body.isRecurring !== false,
      isCollector: req.body.isCollector === true,
    });

    res.status(201).json({ expense: decryptExpense(expense, req.encryptionKey) });

  } catch (error) {
    console.error('Ausgabe erstellen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Ausgabe konnte nicht erstellt werden.' });
  }
});

// PUT /api/expenses/:id
router.put('/:id', async (req, res) => {
  try {
    const result = await prisma.$transaction(async tx => {
      // Same expense-row lock as bookings; load only after a waiting writer commits.
      await finance.lockRow(tx, 'expenses', req.params.id);
      const existing = await tx.expense.findFirst({
        where: { id: req.params.id, userId: req.userId },
      });
      if (!existing) return { status: 404, body: { error: 'Ausgabe nicht gefunden.' } };

      const zielMonat = req.body.month || existing.month;
      const errors = validateExpense({ ...req.body, month: zielMonat }, req.budgetStartDay);
      if (errors.length > 0) return { status: 400, body: { errors } };

      if (req.body.categoryId !== existing.categoryId) {
        const cat = await tx.category.findFirst({
          where: { id: req.body.categoryId, userId: req.userId },
        });
        if (!cat) return { status: 400, body: { errors: ['Ungültige Kategorie.'] } };
      }

      const expense = await finance.updateExpense(tx, ctxOf(req), existing, {
        name: sanitize(req.body.name),
        amount: String(parseFloat(req.body.amount)),
        categoryId: req.body.categoryId,
        tags: readTags(req.body),
        month: req.body.month,
        spentOn: req.body.spentOn !== undefined ? readSpentOn(req.body) : undefined,
        isRecurring: req.body.isRecurring,
        isCollector: req.body.isCollector !== undefined ? req.body.isCollector === true : undefined,
      });
      return { status: 200, body: { expense: decryptExpense(expense, req.encryptionKey) } };
    });
    res.status(result.status).json(result.body);

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

    await finance.deleteExpense(prisma, ctxOf(req), existing);

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
// Änderung wird die Summe neu berechnet und in Expense.amount geschrieben.
// Buchung + Summe laufen seit 2026-10-11 in EINER Transaktion mit Sperre
// auf dem Posten (parallele Buchungen konnten die Summe verfälschen).
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

function readBooking(body) {
  return {
    amount: String(parseFloat(body.amount)),
    note: body.note ? sanitize(body.note) : '',
    bookedOn: body.bookedOn ? body.bookedOn : null,
  };
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

    const { buchung, total } = await prisma.$transaction(tx =>
      finance.createBooking(tx, ctxOf(req), posten, readBooking(req.body)));

    res.status(201).json({
      booking: decryptBooking(buchung, req.encryptionKey),
      total,
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

    const { buchung, total } = await prisma.$transaction(tx =>
      finance.updateBooking(tx, ctxOf(req), posten, vorhanden, readBooking(req.body)));
    res.json({ booking: decryptBooking(buchung, req.encryptionKey), total });

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

    const { total } = await prisma.$transaction(tx =>
      finance.deleteBooking(tx, ctxOf(req), posten, vorhanden));

    res.json({ message: 'Buchung gelöscht.', total });

  } catch (error) {
    console.error('Buchung löschen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Die Buchung konnte nicht gelöscht werden.' });
  }
});

module.exports = router;
