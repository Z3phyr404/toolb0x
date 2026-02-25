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

// GET /api/income
router.get('/', async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'Ungültiges Monatsformat.' });
    }

    const raw = await prisma.income.findMany({
      where: { userId: req.userId, month },
    });

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
    res.json({ message: 'Einnahme gelöscht.' });

  } catch (error) {
    console.error('Einnahme löschen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Einnahme konnte nicht gelöscht werden.' });
  }
});

module.exports = router;
