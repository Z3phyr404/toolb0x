// ============================================================
// EINNAHMEN-ROUTEN — mit Verschlüsselung
// ============================================================
// Logik (Auto-Kopie, Propagation, Löschschutz) seit 2026-10-11 in
// ../services/finance.js — gemeinsam mit der Hermes-Integration.
// ============================================================

const express = require('express');
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { validateIncome, sanitize } = require('../utils/validation');
const { currentPeriod } = require('../utils/budgetPeriod');
const finance = require('../services/finance');

const { decryptIncome } = finance;

const router = express.Router();

router.use(requireAuth);

function ctxOf(req) {
  return { userId: req.userId, key: req.encryptionKey, startDay: req.budgetStartDay };
}

// ============================================================
// GET /api/income
// Lädt Einnahmen für den Monat.
// Falls keine existieren: wiederkehrende aus dem letzten
// bekannten Monat automatisch kopieren.
// ============================================================
router.get('/', async (req, res) => {
  try {
    const month = req.query.month || currentPeriod(req.budgetStartDay);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'Ungültiges Monatsformat.' });
    }

    let raw = await prisma.income.findMany({
      where: { userId: req.userId, month },
    });

    // Wenn keine Einnahmen: nur kopieren wenn der Monat noch NICHT initialisiert wurde
    if (raw.length === 0) {
      const kopiert = await finance.initIncomeMonth(prisma, ctxOf(req), month);
      if (kopiert) {
        raw = await prisma.income.findMany({
          where: { userId: req.userId, month },
        });
      }
    }

    const incomes = raw.map(i => decryptIncome(i, req.encryptionKey));
    incomes.sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount));
    const total = incomes.reduce((s, i) => s + parseFloat(i.amount), 0);

    res.json({ incomes, total: Math.round(total * 100) / 100, month });

  } catch (error) {
    console.error('Einnahmen laden fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Einnahmen konnten nicht geladen werden.' });
  }
});

// POST /api/income
router.post('/', async (req, res) => {
  try {
    const errors = validateIncome(req.body);
    if (errors.length > 0) return res.status(400).json({ errors });

    const income = await finance.createIncome(prisma, ctxOf(req), {
      name: sanitize(req.body.name),
      amount: String(parseFloat(req.body.amount)),
      month: req.body.month || currentPeriod(req.budgetStartDay),
      isRecurring: req.body.isRecurring !== false,
    });

    res.status(201).json({ income: decryptIncome(income, req.encryptionKey) });

  } catch (error) {
    console.error('Einnahme erstellen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Einnahme konnte nicht erstellt werden.' });
  }
});

// PUT /api/income/:id
router.put('/:id', async (req, res) => {
  try {
    const errors = validateIncome(req.body);
    if (errors.length > 0) return res.status(400).json({ errors });

    const existing = await prisma.income.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!existing) return res.status(404).json({ error: 'Einnahme nicht gefunden.' });

    const income = await finance.updateIncome(prisma, ctxOf(req), existing, {
      name: sanitize(req.body.name),
      amount: String(parseFloat(req.body.amount)),
      month: req.body.month,
      isRecurring: req.body.isRecurring,
    });

    res.json({ income: decryptIncome(income, req.encryptionKey) });

  } catch (error) {
    console.error('Einnahme bearbeiten fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Einnahme konnte nicht geändert werden.' });
  }
});

// DELETE /api/income/:id
router.delete('/:id', async (req, res) => {
  try {
    const existing = await prisma.income.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!existing) return res.status(404).json({ error: 'Einnahme nicht gefunden.' });

    await finance.deleteIncome(prisma, ctxOf(req), existing);

    res.json({ message: 'Einnahme gelöscht.' });

  } catch (error) {
    console.error('Einnahme löschen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Einnahme konnte nicht gelöscht werden.' });
  }
});

module.exports = router;
