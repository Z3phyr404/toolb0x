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

// Privater Bibliotheks-Mirror („Alle Fotos", fotob0x Web-Sync).
// WICHTIG: Dieses Verzeichnis wird bewusst NICHT von nginx ausgeliefert -
// die Bilder gibt es nur über die Routen unten, und die verlangen Admin.
const PRIVAT_DIR = process.env.FOTOS_PRIVAT_DIR || '/var/www/fotos-privat';

// Mirror-Dateinamen sind "<assetId>.jpg" (numerische fotob0x-IDs).
const PHOTO_NAME_RE = /^\d{1,12}\.jpg$/;

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

// ============================================================
// GET /api/fotos/library — Manifest der privaten Bibliothek
// ============================================================
// library.json schreibt fotob0x beim Web-Sync (Dateiname + Aufnahme-
// datum; die Web-Kopien selbst sind bewusst EXIF-frei).
router.get('/library', async (req, res) => {
  try {
    const raw = await fs.readFile(path.join(PRIVAT_DIR, 'library.json'), 'utf8');
    const manifest = JSON.parse(raw);
    res.json({
      generatedAt: typeof manifest.generatedAt === 'string' ? manifest.generatedAt : null,
      photoCount: Number.isInteger(manifest.photoCount) ? manifest.photoCount : 0,
      // Benannte Personen (fotob0x KI Etappe 5) für den Personen-Filter
      persons: Array.isArray(manifest.persons) ? manifest.persons : [],
      photos: Array.isArray(manifest.photos) ? manifest.photos : [],
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Noch nie gesynct → leere Bibliothek, kein Fehler
      return res.json({ generatedAt: null, photoCount: 0, photos: [] });
    }
    console.error('Bibliotheks-Manifest fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// ============================================================
// GET /api/fotos/library/(img|thumb)/:name — Bild ausliefern
// ============================================================
// Streamt genau eine Datei aus dem privaten Mirror. Der Name wird
// streng geprüft (nur "<zahl>.jpg") und sendFile bekommt ein root -
// Pfad-Ausbrüche sind damit doppelt ausgeschlossen.
function servePrivatePhoto(subdir) {
  return (req, res) => {
    const name = req.params.name;
    if (!PHOTO_NAME_RE.test(name)) {
      return res.status(400).json({ error: 'Ungültiger Bildname.' });
    }
    res.sendFile(name, {
      root: path.join(PRIVAT_DIR, subdir),
      dotfiles: 'deny',
      headers: {
        'Content-Type': 'image/jpeg',
        // privat: nur der Browser des Admins darf cachen
        'Cache-Control': 'private, max-age=86400',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    }, (err) => {
      if (err && !res.headersSent) {
        res.status(err.statusCode === 404 ? 404 : 500).json({ error: 'Bild nicht gefunden.' });
      }
    });
  };
}

router.get('/library/img/:name', servePrivatePhoto('img'));
router.get('/library/thumb/:name', servePrivatePhoto('thumb'));

module.exports = router;
