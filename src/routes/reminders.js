// ============================================================
// ERINNERUNGS-ROUTEN — mit Verschlüsselung
// ============================================================
// Kündigungserinnerungen für Ausgaben.
// note ist verschlüsselt (Zero-Knowledge).
// reminderDate, daysBefore, status sind NICHT verschlüsselt.
// ============================================================

const express = require('express');
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { validateReminder, sanitize } = require('../utils/validation');
const { encrypt, decrypt } = require('../utils/encryption');

const router = express.Router();

router.use(requireAuth);

// Hilfsfunktion: Erinnerung entschlüsseln (inkl. verknüpfter Expense)
function decryptReminder(rem, key) {
  let note = '';
  if (rem.note) {
    try { note = decrypt(rem.note, key); } catch { note = ''; }
  }
  return {
    ...rem,
    note,
    expense: rem.expense ? {
      ...rem.expense,
      name: decrypt(rem.expense.name, key),
      amount: decrypt(rem.expense.amount, key),
    } : null,
  };
}

// --------------------------------------------------------
// GET /api/reminders — Alle Erinnerungen (mit optionalen Filtern)
// --------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const where = { userId: req.userId };

    // Optional: nach Status filtern
    if (req.query.status && ['pending', 'done', 'dismissed'].includes(req.query.status)) {
      where.status = req.query.status;
    }

    // Optional: nach Expense filtern
    if (req.query.expenseId) {
      where.expenseId = req.query.expenseId;
    }

    const reminders = await prisma.reminder.findMany({
      where,
      include: { expense: { select: { id: true, name: true, amount: true } } },
      orderBy: { reminderDate: 'asc' },
    });

    res.json({
      reminders: reminders.map(r => decryptReminder(r, req.encryptionKey)),
    });
  } catch (error) {
    console.error('Fehler beim Laden der Erinnerungen:', error.message);
    res.status(500).json({ error: 'Erinnerungen konnten nicht geladen werden.' });
  }
});

// --------------------------------------------------------
// GET /api/reminders/upcoming — Fällige Erinnerungen
// --------------------------------------------------------
// Eine Erinnerung ist "fällig" wenn:
// reminderDate - daysBefore <= heute UND status === "pending"
// --------------------------------------------------------
router.get('/upcoming', async (req, res) => {
  try {
    const all = await prisma.reminder.findMany({
      where: { userId: req.userId, status: 'pending' },
      include: { expense: { select: { id: true, name: true, amount: true } } },
      orderBy: { reminderDate: 'asc' },
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const upcoming = all.filter(r => {
      const alertDate = new Date(r.reminderDate);
      alertDate.setDate(alertDate.getDate() - r.daysBefore);
      alertDate.setHours(0, 0, 0, 0);
      return alertDate <= today;
    });

    res.json({
      reminders: upcoming.map(r => decryptReminder(r, req.encryptionKey)),
    });
  } catch (error) {
    console.error('Fehler beim Laden fälliger Erinnerungen:', error.message);
    res.status(500).json({ error: 'Fällige Erinnerungen konnten nicht geladen werden.' });
  }
});

// --------------------------------------------------------
// POST /api/reminders — Neue Erinnerung erstellen
// --------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const errors = validateReminder(req.body);
    if (errors.length > 0) return res.status(400).json({ errors });

    // Wenn Expense verknüpft → Ownership prüfen
    if (req.body.expenseId) {
      const expense = await prisma.expense.findFirst({
        where: { id: req.body.expenseId, userId: req.userId },
      });
      if (!expense) {
        return res.status(404).json({ error: 'Ausgabe nicht gefunden.' });
      }
    }

    const data = {
      reminderDate: new Date(req.body.reminderDate),
      daysBefore: parseInt(req.body.daysBefore) || 3,
      status: 'pending',
      userId: req.userId,
    };

    // Notiz verschlüsseln (optional)
    if (req.body.note && req.body.note.trim()) {
      data.note = encrypt(sanitize(req.body.note.trim()), req.encryptionKey);
    }

    // Expense verknüpfen (optional)
    if (req.body.expenseId) {
      data.expenseId = req.body.expenseId;
    }

    const reminder = await prisma.reminder.create({
      data,
      include: { expense: { select: { id: true, name: true, amount: true } } },
    });

    res.status(201).json({
      reminder: decryptReminder(reminder, req.encryptionKey),
    });
  } catch (error) {
    console.error('Fehler beim Erstellen der Erinnerung:', error.message);
    res.status(500).json({ error: 'Erinnerung konnte nicht erstellt werden.' });
  }
});

// --------------------------------------------------------
// PUT /api/reminders/:id — Erinnerung bearbeiten
// --------------------------------------------------------
router.put('/:id', async (req, res) => {
  try {
    const existing = await prisma.reminder.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Erinnerung nicht gefunden.' });
    }

    const errors = validateReminder(req.body);
    if (errors.length > 0) return res.status(400).json({ errors });

    // Wenn Expense verknüpft → Ownership prüfen
    if (req.body.expenseId) {
      const expense = await prisma.expense.findFirst({
        where: { id: req.body.expenseId, userId: req.userId },
      });
      if (!expense) {
        return res.status(404).json({ error: 'Ausgabe nicht gefunden.' });
      }
    }

    const data = {
      reminderDate: new Date(req.body.reminderDate),
      daysBefore: parseInt(req.body.daysBefore) || 3,
    };

    // Notiz verschlüsseln
    if (req.body.note !== undefined) {
      data.note = req.body.note.trim()
        ? encrypt(sanitize(req.body.note.trim()), req.encryptionKey)
        : '';
    }

    // Expense-Verknüpfung aktualisieren
    if (req.body.expenseId !== undefined) {
      data.expenseId = req.body.expenseId || null;
    }

    const reminder = await prisma.reminder.update({
      where: { id: req.params.id },
      data,
      include: { expense: { select: { id: true, name: true, amount: true } } },
    });

    res.json({
      reminder: decryptReminder(reminder, req.encryptionKey),
    });
  } catch (error) {
    console.error('Fehler beim Aktualisieren der Erinnerung:', error.message);
    res.status(500).json({ error: 'Erinnerung konnte nicht aktualisiert werden.' });
  }
});

// --------------------------------------------------------
// DELETE /api/reminders/:id — Erinnerung löschen
// --------------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    const existing = await prisma.reminder.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Erinnerung nicht gefunden.' });
    }

    await prisma.reminder.delete({ where: { id: req.params.id } });

    res.json({ message: 'Erinnerung gelöscht.' });
  } catch (error) {
    console.error('Fehler beim Löschen der Erinnerung:', error.message);
    res.status(500).json({ error: 'Erinnerung konnte nicht gelöscht werden.' });
  }
});

// --------------------------------------------------------
// PATCH /api/reminders/:id/status — Status ändern
// --------------------------------------------------------
// Mögliche Status: "done" (erledigt), "dismissed" (ausgeblendet)
// --------------------------------------------------------
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!status || !['done', 'dismissed'].includes(status)) {
      return res.status(400).json({ error: 'Ungültiger Status. Erlaubt: done, dismissed.' });
    }

    const existing = await prisma.reminder.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Erinnerung nicht gefunden.' });
    }

    const reminder = await prisma.reminder.update({
      where: { id: req.params.id },
      data: { status },
      include: { expense: { select: { id: true, name: true, amount: true } } },
    });

    res.json({
      reminder: decryptReminder(reminder, req.encryptionKey),
    });
  } catch (error) {
    console.error('Fehler beim Status-Update der Erinnerung:', error.message);
    res.status(500).json({ error: 'Status konnte nicht aktualisiert werden.' });
  }
});

module.exports = router;
