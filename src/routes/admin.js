// ============================================================
// ADMIN-ROUTEN — Nutzerübersicht und System-Statistiken
// ============================================================
// Alle Routen erfordern Admin-Rolle.
// Zero-Knowledge bleibt gewahrt: Nur unverschlüsselte Felder
// (name, email, createdAt) werden gelesen.
// ============================================================

const express = require('express');
const prisma = require('../utils/prisma');
const { requireAuth, requireAdmin } = require('../middleware/auth');

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

module.exports = router;
