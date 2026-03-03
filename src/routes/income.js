// ============================================================
// EINNAHMEN-ROUTEN — mit Verschlüsselung
// ============================================================

const express = require('express');
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { validateIncome, sanitize } = require('../utils/validation');
const { encrypt, decrypt } = require('../utils/encryption');

const router = express.Router();

router.use(requireAuth);

function decryptIncome(inc, key) {
  return {
    ...inc,
    name: decrypt(inc.name, key),
    amount: decrypt(inc.amount, key),
  };
}

// Hilfsfunktion: Vormonat berechnen
function prevMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const newM = m === 1 ? 12 : m - 1;
  const newY = m === 1 ? y - 1 : y;
  return `${newY}-${String(newM).padStart(2, '0')}`;
}

// ============================================================
// GET /api/income
// Lädt Einnahmen für den Monat.
// Falls keine existieren: wiederkehrende aus dem letzten
// bekannten Monat automatisch kopieren.
// ============================================================
router.get('/', async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'Ungültiges Monatsformat.' });
    }

    let raw = await prisma.income.findMany({
      where: { userId: req.userId, month },
    });

    // Wenn keine Einnahmen: nur kopieren wenn der Monat noch NICHT initialisiert wurde
    if (raw.length === 0) {
      const alreadyInit = await prisma.monthInit.findUnique({
        where: { userId_month_type: { userId: req.userId, month, type: 'income' } },
      });

      if (alreadyInit) {
        return res.json({ incomes: [], total: 0, month });
      }

      // Letzten Monat mit Einnahmen finden (max. 24 Monate zurück).
      // Stoppt wenn ein Monat gefunden wird, der vom User explizit bearbeitet
      // wurde (monthInit vorhanden) — auch wenn er leer ist.
      let sourceMonth = prevMonth(month);
      let sourceIncomes = [];

      for (let i = 0; i < 24; i++) {
        const found = await prisma.income.findMany({
          where: { userId: req.userId, month: sourceMonth, isRecurring: true },
        });
        if (found.length > 0) {
          sourceIncomes = found;
          break;
        }
        const wasModified = await prisma.monthInit.findUnique({
          where: { userId_month_type: { userId: req.userId, month: sourceMonth, type: 'income' } },
        });
        if (wasModified) break;
        sourceMonth = prevMonth(sourceMonth);
      }

      // Wiederkehrende in den neuen Monat kopieren
      if (sourceIncomes.length > 0) {
        await prisma.income.createMany({
          data: sourceIncomes.map(i => ({
            name: i.name,       // bleibt verschlüsselt
            amount: i.amount,   // bleibt verschlüsselt
            userId: i.userId,
            month,
            isRecurring: true,
          })),
        });

        // Neu erstellte laden
        raw = await prisma.income.findMany({
          where: { userId: req.userId, month },
        });
      }

      // Monat als initialisiert markieren
      await prisma.monthInit.upsert({
        where: { userId_month_type: { userId: req.userId, month, type: 'income' } },
        create: { userId: req.userId, month, type: 'income' },
        update: {},
      });
    }

    const incomes = raw.map(i => decryptIncome(i, req.encryptionKey));
    incomes.sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount));
    const total = incomes.reduce((s, i) => s + parseFloat(i.amount), 0);

    res.json({ incomes, total, month });

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

    const key = req.encryptionKey;
    const month = req.body.month || new Date().toISOString().slice(0, 7);

    const income = await prisma.income.create({
      data: {
        name: encrypt(sanitize(req.body.name), key),
        amount: encrypt(String(parseFloat(req.body.amount)), key),
        userId: req.userId,
        month,
        isRecurring: req.body.isRecurring !== false,
      },
    });

    // Neue wiederkehrende Einnahme in bereits initialisierte Zukunftsmonate kopieren.
    if (income.isRecurring) {
      const futureInits = await prisma.monthInit.findMany({
        where: { userId: req.userId, type: 'income', month: { gt: month } },
      });
      if (futureInits.length > 0) {
        await prisma.income.createMany({
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

    res.status(201).json({ income: decryptIncome(income, key) });

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

    const key = req.encryptionKey;

    const income = await prisma.income.update({
      where: { id: req.params.id },
      data: {
        name: encrypt(sanitize(req.body.name), key),
        amount: encrypt(String(parseFloat(req.body.amount)), key),
        month: req.body.month || existing.month,
        isRecurring: req.body.isRecurring ?? existing.isRecurring,
      },
    });

    // Änderungen an wiederkehrenden Einnahmen in Zukunftsmonate propagieren.
    if (income.isRecurring && existing.isRecurring) {
      await prisma.income.updateMany({
        where: {
          userId: req.userId,
          name: existing.name,
          isRecurring: true,
          month: { gt: existing.month },
        },
        data: {
          name: income.name,
          amount: income.amount,
        },
      });
    }

    res.json({ income: decryptIncome(income, key) });

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

    await prisma.income.delete({ where: { id: req.params.id } });

    // Monat als initialisiert markieren → verhindert Auto-Copy beim nächsten Laden
    await prisma.monthInit.upsert({
      where: { userId_month_type: { userId: req.userId, month: existing.month, type: 'income' } },
      create: { userId: req.userId, month: existing.month, type: 'income' },
      update: {},
    });

    res.json({ message: 'Einnahme gelöscht.' });

  } catch (error) {
    console.error('Einnahme löschen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Einnahme konnte nicht gelöscht werden.' });
  }
});

module.exports = router;