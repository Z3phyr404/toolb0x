// ============================================================
// SHARE-ROUTEN — Sicheres Teilen von Geheimnissen per Link
// ============================================================
// Zero-Knowledge: Der Blob ist bereits im Browser des Absenders
// verschlüsselt (Web Crypto, AES-256-GCM). Der Schlüssel steht im
// URL-Fragment und erreicht den Server NIE. Der Server behandelt
// `blob` rein opak — er kann das Geheimnis nicht entschlüsseln.
//
// Öffentliche Routen (kein Login) sind bewusst VOR requireAuth
// definiert, damit sie die Auth-Middleware umgehen:
//   GET  /:token          → Metadaten (kein Burn)
//   POST /:token/reveal    → gibt Blob heraus + zählt Ansicht hoch (Burn)
//
// Owner-Routen (requireAuth):
//   POST   /               → Share anlegen
//   GET    /               → eigene Shares auflisten
//   DELETE /:token         → eigenen Share widerrufen
// ============================================================

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Defense-in-Depth: Reveal ist öffentlich → strengeres Limit gegen
// automatisiertes Absuchen (Token sind ohnehin 24 Zufallsbytes).
const revealLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen. Bitte warte einen Moment.' },
});

const MAX_VIEWS_CAP = 100;          // Obergrenze für maxViews (0 = unbegrenzt bis Ablauf)
const MAX_BLOB_LENGTH = 8000;       // Sicherheitsnetz (Body-Limit ist ohnehin 10kb)

// Erlaubte Ablauf-Optionen → Millisekunden
const EXPIRY_OPTIONS = {
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

// Verbleibende Ansichten berechnen (null = unbegrenzt)
function remainingViews(share) {
  if (share.maxViews === 0) return null;
  return Math.max(0, share.maxViews - share.viewCount);
}

// Prüft, ob ein Share abgelaufen (Zeit oder Ansichten aufgebraucht) ist
function isExhausted(share) {
  if (share.expiresAt.getTime() <= Date.now()) return true;
  if (share.maxViews > 0 && share.viewCount >= share.maxViews) return true;
  return false;
}

// ============================================================
// ÖFFENTLICHE ROUTEN (kein Login) — vor requireAuth
// ============================================================

// GET /api/share/:token — Metadaten ohne Burn (für die View-Seite).
// Gibt KEINEN Blob heraus und zählt NICHT hoch, damit Link-Vorschau-Bots
// keine Ansicht verbrennen.
router.get('/:token', async (req, res) => {
  try {
    const share = await prisma.share.findUnique({ where: { token: req.params.token } });

    if (!share) {
      return res.status(404).json({ error: 'Dieser Link existiert nicht (mehr).' });
    }

    if (isExhausted(share)) {
      // Lazy-Cleanup abgelaufener/aufgebrauchter Shares
      await prisma.share.delete({ where: { id: share.id } }).catch(() => {});
      return res.status(404).json({ error: 'Dieser Link ist abgelaufen.' });
    }

    res.json({
      hasPin: share.hasPin,
      remainingViews: remainingViews(share),
      expiresAt: share.expiresAt,
    });
  } catch (error) {
    console.error('Share-Metadaten laden fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Link konnte nicht geladen werden.' });
  }
});

// POST /api/share/:token/reveal — gibt den Blob heraus und zählt die
// Ansicht hoch. Löscht den Share, wenn das View-Limit erreicht ist.
router.post('/:token/reveal', revealLimiter, async (req, res) => {
  try {
    const share = await prisma.share.findUnique({ where: { token: req.params.token } });

    if (!share) {
      return res.status(404).json({ error: 'Dieser Link existiert nicht (mehr).' });
    }

    if (isExhausted(share)) {
      await prisma.share.delete({ where: { id: share.id } }).catch(() => {});
      return res.status(404).json({ error: 'Dieser Link ist abgelaufen.' });
    }

    // Ansicht atomar hochzählen (verhindert Race bei parallelen Aufrufen)
    const updated = await prisma.share.update({
      where: { id: share.id },
      data: { viewCount: { increment: 1 } },
    });

    // Wenn diese Ansicht die letzte war → Share löschen (burn-after-read)
    if (updated.maxViews > 0 && updated.viewCount >= updated.maxViews) {
      await prisma.share.delete({ where: { id: updated.id } }).catch(() => {});
    }

    res.json({
      blob: share.blob,
      hasPin: share.hasPin,
      remainingViews: remainingViews(updated),
    });
  } catch (error) {
    console.error('Share aufdecken fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Link konnte nicht geöffnet werden.' });
  }
});

// ============================================================
// OWNER-ROUTEN (Login erforderlich)
// ============================================================
router.use(requireAuth);

// POST /api/share — neuen Share-Link anlegen
router.post('/', async (req, res) => {
  try {
    const { blob, hasPin, maxViews, expiresIn } = req.body;

    if (typeof blob !== 'string' || blob.length === 0 || blob.length > MAX_BLOB_LENGTH) {
      return res.status(400).json({ error: 'Ungültige Daten.' });
    }
    if (!EXPIRY_OPTIONS[expiresIn]) {
      return res.status(400).json({ error: 'Ungültige Ablaufzeit.' });
    }

    // maxViews validieren: 0 = unbegrenzt, sonst 1..CAP
    const views = Number.isInteger(maxViews) ? maxViews : 1;
    if (views < 0 || views > MAX_VIEWS_CAP) {
      return res.status(400).json({ error: 'Ungültige Anzahl Ansichten.' });
    }

    const token = crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + EXPIRY_OPTIONS[expiresIn]);

    await prisma.share.create({
      data: {
        token,
        blob,
        hasPin: Boolean(hasPin),
        maxViews: views,
        expiresAt,
        userId: req.userId,
      },
    });

    res.status(201).json({ token });
  } catch (error) {
    console.error('Share erstellen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Link konnte nicht erstellt werden.' });
  }
});

// GET /api/share — eigene aktive Shares auflisten (ohne Blob/Schlüssel)
router.get('/', async (req, res) => {
  try {
    const shares = await prisma.share.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
      select: {
        token: true,
        hasPin: true,
        maxViews: true,
        viewCount: true,
        expiresAt: true,
        createdAt: true,
      },
    });

    const result = shares.map(s => ({
      token: s.token,
      hasPin: s.hasPin,
      remainingViews: remainingViews(s),
      expiresAt: s.expiresAt,
      createdAt: s.createdAt,
      expired: isExhausted(s),
    }));

    res.json({ shares: result });
  } catch (error) {
    console.error('Shares laden fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Links konnten nicht geladen werden.' });
  }
});

// DELETE /api/share/:token — eigenen Share widerrufen
router.delete('/:token', async (req, res) => {
  try {
    // Row-Level Security: nur eigene Shares löschbar
    const result = await prisma.share.deleteMany({
      where: { token: req.params.token, userId: req.userId },
    });

    if (result.count === 0) {
      return res.status(404).json({ error: 'Link nicht gefunden.' });
    }

    res.json({ message: 'Link widerrufen.' });
  } catch (error) {
    console.error('Share löschen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Link konnte nicht widerrufen werden.' });
  }
});

module.exports = router;
