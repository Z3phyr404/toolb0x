// ============================================================
// ADMIN-ROUTEN — Nutzerübersicht und System-Statistiken
// ============================================================
// Alle Routen erfordern Admin-Rolle.
// Zero-Knowledge bleibt gewahrt: Nur unverschlüsselte Felder
// (name, email, createdAt, role, suspended) werden gelesen.
// ============================================================

const express = require('express');
const crypto = require('crypto');
const prisma = require('../utils/prisma');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const sessionStore = require('../utils/sessionStore');

const router = express.Router();

// Alle Admin-Routen erfordern Auth + Admin-Rolle
router.use(requireAuth, requireAdmin);

// ============================================================
// GET /api/admin/stats — Nutzerstatistiken
// ============================================================
router.get('/stats', async (req, res) => {
  try {
    const userCount = await prisma.user.count();

    const newestUser = await prisma.user.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { name: true, createdAt: true },
    });

    res.json({
      userCount,
      newestUser: newestUser ? {
        name: newestUser.name,
        createdAt: newestUser.createdAt,
      } : null,
    });
  } catch (error) {
    console.error('Admin-Stats fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ============================================================
// GET /api/admin/users — Nutzerliste mit Datenstatistiken
// ============================================================
router.get('/users', async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        suspended: true,
        createdAt: true,
        _count: {
          select: {
            categories: true,
            expenses: true,
            incomes: true,
            reminders: true,
          },
        },
      },
    });

    res.json({ users });
  } catch (error) {
    console.error('Nutzerliste fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ============================================================
// PATCH /api/admin/users/:id/suspend — Nutzer sperren/entsperren
// ============================================================
router.patch('/users/:id/suspend', async (req, res) => {
  try {
    const { id } = req.params;
    const { suspended } = req.body;

    if (typeof suspended !== 'boolean') {
      return res.status(400).json({ error: 'Feld "suspended" (boolean) ist erforderlich.' });
    }

    // Admin kann sich nicht selbst sperren
    if (id === req.userId) {
      return res.status(400).json({ error: 'Du kannst dich nicht selbst sperren.' });
    }

    // Prüfen ob Nutzer existiert
    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true },
    });

    if (!user) {
      return res.status(404).json({ error: 'Nutzer nicht gefunden.' });
    }

    // Andere Admins können nicht gesperrt werden
    if (user.role === 'admin') {
      return res.status(400).json({ error: 'Admins können nicht gesperrt werden.' });
    }

    // Nutzer sperren/entsperren
    const updatedUser = await prisma.user.update({
      where: { id },
      data: { suspended },
      select: { id: true, name: true, suspended: true },
    });

    // Bei Sperrung: Alle aktiven Sessions des Nutzers sofort beenden
    if (suspended) {
      sessionStore.deleteAllForUser(id);
    }

    res.json({
      message: suspended
        ? `${updatedUser.name} wurde gesperrt.`
        : `${updatedUser.name} wurde entsperrt.`,
      user: updatedUser,
    });
  } catch (error) {
    console.error('Nutzer-Sperrung fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ============================================================
// POST /api/admin/users/:id/reset-link — Passwort-Reset-Link erzeugen
// ============================================================
// Notfall-Fallback, wenn ein Nutzer Passwort UND Recovery-Code
// verloren hat. Der Link setzt ein neues Passwort, LÖSCHT aber alle
// verschlüsselten Daten (Zero-Knowledge: ohne Key kein Zugriff).
// Der Admin gibt den Link selbst weiter (kein E-Mail-Versand nötig).
// In der DB liegt nur der SHA-256-Hash des Tokens (60 Min gültig).
router.post('/users/:id/reset-link', async (req, res) => {
  try {
    const { id } = req.params;

    if (id === req.userId) {
      return res.status(400).json({ error: 'Nutze für dein eigenes Konto den Recovery-Code.' });
    }

    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, name: true, role: true },
    });

    if (!user) {
      return res.status(404).json({ error: 'Nutzer nicht gefunden.' });
    }

    // Reset-Link für einen Admin = Kontoübernahme → nicht erlaubt
    if (user.role === 'admin') {
      return res.status(400).json({ error: 'Für Admins können keine Reset-Links erzeugt werden.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 60 Minuten

    await prisma.user.update({
      where: { id },
      data: { resetToken: tokenHash, resetTokenExpires: expiresAt },
    });

    res.json({
      message: `Reset-Link für ${user.name} erstellt (60 Minuten gültig).`,
      token,
      expiresAt,
    });
  } catch (error) {
    console.error('Reset-Link-Erstellung fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ============================================================
// DELETE /api/admin/users/:id — Nutzer endgültig löschen
// ============================================================
// Kaskade löscht alle Daten des Nutzers (Kategorien, Ausgaben,
// Einnahmen, Erinnerungen, Notizen, Passwörter, eigene Tresore).
router.delete('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Admin kann sich nicht selbst löschen
    if (id === req.userId) {
      return res.status(400).json({ error: 'Du kannst dich nicht selbst löschen.' });
    }

    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, name: true, role: true },
    });

    if (!user) {
      return res.status(404).json({ error: 'Nutzer nicht gefunden.' });
    }

    // Andere Admins können nicht gelöscht werden
    if (user.role === 'admin') {
      return res.status(400).json({ error: 'Admins können nicht gelöscht werden.' });
    }

    await prisma.user.delete({ where: { id } });

    // Aktive Sessions des Nutzers sofort beenden
    sessionStore.deleteAllForUser(id);

    res.json({ message: `${user.name} wurde endgültig gelöscht.` });
  } catch (error) {
    console.error('Nutzer-Löschung fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

module.exports = router;
