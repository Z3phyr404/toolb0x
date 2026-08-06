// ============================================================
// FOTOS-ROUTEN — Übersicht der geteilten fotob0x-Galerien
// ============================================================
// Read-only und nur für Admins: listet die Galerie-Ordner unter
// /var/www/fotos (dorthin lädt die Desktop-App fotob0x per SFTP
// hoch, nginx liefert sie unter /fotos/<token>/ aus — siehe
// deploy/nginx-fotos.conf). Diese Route liest NUR das Dateisystem;
// angelegt/gelöscht wird ausschließlich über fotob0x.
// ============================================================

const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Alle Foto-Routen erfordern Auth + Admin-Rolle
router.use(requireAuth, requireAdmin);

// Auf dem Server /var/www/fotos; lokal per Env übersteuerbar (Dev/Tests).
const FOTOS_DIR = process.env.FOTOS_DIR || '/var/www/fotos';

// Galerie-Tokens aus fotob0x sind 24 Zeichen base64url — alles andere
// (versteckte Dateien, Fremdordner) wird ignoriert.
const TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/;

// Galerie-Titel steht HTML-escaped im <title> der index.html —
// die fünf Entities von escapeHtml (fotob0x share.ts) zurückwandeln.
function unescapeHtml(str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// ============================================================
// GET /api/fotos — Liste der geteilten Alben
// ============================================================
router.get('/', async (req, res) => {
  try {
    let entries;
    try {
      entries = await fs.readdir(FOTOS_DIR, { withFileTypes: true });
    } catch (err) {
      // Verzeichnis fehlt (z.B. lokale Entwicklung) → leere Liste, kein Fehler
      if (err.code === 'ENOENT') return res.json({ albums: [] });
      throw err;
    }

    const albums = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !TOKEN_RE.test(entry.name)) continue;
      const dir = path.join(FOTOS_DIR, entry.name);
      const album = {
        token: entry.name,
        title: entry.name,
        photoCount: 0,
        sharedAt: null,
        thumb: null,
      };

      try {
        album.sharedAt = (await fs.stat(dir)).mtime.toISOString();
      } catch {
        // Ordner zwischenzeitlich gelöscht ("Teilen beenden") — überspringen
        continue;
      }

      try {
        const html = await fs.readFile(path.join(dir, 'index.html'), 'utf8');
        const m = html.match(/<title>([^<]*)<\/title>/i);
        if (m && m[1].trim()) album.title = unescapeHtml(m[1].trim());
      } catch {
        // Ohne index.html bleibt der Token als Titel stehen
      }

      try {
        const thumbs = (await fs.readdir(path.join(dir, 'thumb')))
          .filter((f) => /\.jpe?g$/i.test(f))
          .sort();
        album.photoCount = thumbs.length;
        if (thumbs.length > 0) album.thumb = thumbs[0];
      } catch {
        // Kein thumb-Ordner → Anzahl 0, Karte ohne Vorschaubild
      }

      albums.push(album);
    }

    // Neueste zuerst
    albums.sort((a, b) => String(b.sharedAt).localeCompare(String(a.sharedAt)));

    res.json({ albums });
  } catch (error) {
    console.error('Foto-Übersicht fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

module.exports = router;
