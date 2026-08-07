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
const fsSync = require('fs');
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

// Upload-Posteingang (2026-08-07): Transit-Ordner für Fotos von iPad/Mac.
// fotob0x auf dem Windows-Rechner (der SSOT bleibt) holt die Dateien per
// SFTP ab, importiert sie in die Bibliothek und leert den Ordner danach.
// Auch dieses Verzeichnis liefert nginx bewusst NICHT aus.
const INBOX_DIR = process.env.FOTOS_INBOX_DIR || '/var/www/fotos-inbox';

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

// Events (fotob0x Etappe 6, "Ereignisse") kommen als eigenes Manifest-Feld -
// billige Validierung statt Schema-Lib, weil wir dem Client nur simple
// {n, s, e, ids}-Objekte weiterreichen (nie mehr als 500, sonst Cap).
function sanitizeEvents(events) {
  if (!Array.isArray(events)) return [];
  const out = [];
  for (const ev of events) {
    if (out.length >= 500) break;
    if (!ev || typeof ev !== 'object') continue;
    if (typeof ev.n !== 'string') continue;
    if (!Array.isArray(ev.ids)) continue;
    const s = typeof ev.s === 'string' || ev.s === null ? ev.s : null;
    const e = typeof ev.e === 'string' || ev.e === null ? ev.e : null;
    const ids = ev.ids.filter((id) => typeof id === 'number' && Number.isFinite(id));
    out.push({ n: ev.n, s, e, ids });
  }
  return out;
}

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
      // Ereignisse (fotob0x Etappe 6) für die Event-Gruppierung in "Alle Fotos"
      events: sanitizeEvents(manifest.events),
      photos: Array.isArray(manifest.photos) ? manifest.photos : [],
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Noch nie gesynct → leere Bibliothek, kein Fehler
      return res.json({ generatedAt: null, photoCount: 0, persons: [], events: [], photos: [] });
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

// ============================================================
// Upload-Posteingang — Fotos von iPad/Mac sichern (2026-08-07)
// ============================================================
// Der Upload läuft als ROHER Body-Stream (PUT, application/octet-stream,
// Dateiname in der URL) — bewusst KEIN multipart/multer: kein neues Paket,
// kein Puffern im RAM, und der globale 10kb-JSON-Parser (security.js)
// greift bei diesem Content-Type nicht. nginx braucht für diese Route ein
// eigenes client_max_body_size (deploy/nginx-fotos.conf).

// Nur Formate, die fotob0x auch scannen kann — alles andere läge sonst
// unsichtbar in der Bibliothek (DNG/TIF stehen dort im Backlog).
const INBOX_EXT_RE = /\.(jpe?g|png|heic|heif|arw|mp4)$/i;

// Pro Datei maximal 1 GB (ARW ~30-60 MB, iPhone-Videos können groß werden).
const INBOX_MAX_BYTES = 1024 * 1024 * 1024;

// Dateiname: auf ein sicheres Repertoire eindampfen. fotob0x prüft beim
// Abholen dasselbe Muster — was hier durchkommt, kann dort abgeholt werden.
function sanitizeInboxName(raw) {
  const base = path.basename(String(raw || '')).replace(/[^A-Za-z0-9._-]/g, '_');
  if (!base || base.startsWith('.') || base.length > 180) return null;
  if (!INBOX_EXT_RE.test(base)) return null;
  return base;
}

// Gleiche Prüfung für BESTEHENDE Dateien (Status-Liste): nur Namen zeigen,
// die DELETE auch annehmen und fotob0x auch abholen würde — sonst bekäme
// z.B. eine per SFTP entstandene "Föhn.jpg" einen ×-Button, der immer
// 400 liefert.
function isListableInboxName(name) {
  return sanitizeInboxName(name) === name;
}

// Namen, in die gerade ein PUT schreibt: ein gleichzeitiges DELETE würde
// die Datei unter dem laufenden Stream wegziehen (der PUT meldete dann
// Erfolg für eine gelöschte Inode) — solange lieber 409 antworten.
const activeUploads = new Set();

// Kollisionen nie überschreiben: "name.arw" → "name-2.arw" → "name-3.arw" …
async function reserveInboxPath(name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = attempt === 0 ? name : `${stem}-${attempt + 1}${ext}`;
    const target = path.join(INBOX_DIR, candidate);
    try {
      // wx = exklusiv anlegen, schlägt fehl wenn vorhanden (keine Race-Lücke)
      const handle = await fs.open(target, 'wx');
      return { target, candidate, handle };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('Kein freier Dateiname im Posteingang gefunden.');
}

// GET /api/fotos/upload/status — Posteingang + freier Speicher (für die UI)
router.get('/upload/status', async (req, res) => {
  try {
    let files = [];
    try {
      const entries = await fs.readdir(INBOX_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !isListableInboxName(entry.name)) continue;
        const info = await fs.stat(path.join(INBOX_DIR, entry.name)).catch(() => null);
        if (info) files.push({ name: entry.name, size: info.size, mtime: info.mtime.toISOString() });
      }
      files.sort((a, b) => b.mtime.localeCompare(a.mtime));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // Ordner fehlt noch (einmalige Server-Einrichtung ausstehend)
      return res.json({ ready: false, files: [], freeBytes: null });
    }
    let freeBytes = null;
    try {
      const stat = await fs.statfs(INBOX_DIR);
      freeBytes = Number(stat.bavail) * Number(stat.bsize);
    } catch {
      // statfs nicht verfügbar → UI zeigt den freien Speicher einfach nicht
    }
    res.json({ ready: true, files, freeBytes });
  } catch (error) {
    console.error('Posteingang-Status fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

// PUT /api/fotos/upload/:name — eine Datei als roher Stream
router.put('/upload/:name', async (req, res) => {
  const name = sanitizeInboxName(req.params.name);
  if (!name) {
    return res.status(400).json({
      error: 'Ungültiger Dateiname. Erlaubt sind JPEG, PNG, HEIC, ARW und MP4.',
    });
  }
  if (!fsSync.existsSync(INBOX_DIR)) {
    return res.status(503).json({
      error: 'Der Posteingang ist auf dem Server noch nicht eingerichtet (fotos-inbox fehlt).',
    });
  }

  const declared = Number(req.headers['content-length'] || 0);
  if (declared > INBOX_MAX_BYTES) {
    return res.status(413).json({ error: 'Die Datei ist größer als 1 GB.' });
  }

  let reserved;
  try {
    reserved = await reserveInboxPath(name);
  } catch (error) {
    console.error('Posteingang-Reservierung fehlgeschlagen:', error.message);
    return res.status(500).json({ error: 'Die Datei konnte nicht angelegt werden.' });
  }

  const { target, candidate, handle } = reserved;
  activeUploads.add(candidate);
  const out = handle.createWriteStream();
  let received = 0;
  let failed = false;

  const abort = async (status, message) => {
    if (failed) return;
    failed = true;
    req.unpipe(out);
    out.destroy();
    await fs.unlink(target).catch(() => {});
    activeUploads.delete(candidate);
    if (!res.headersSent) res.status(status).json({ error: message });
    // Der Client sendet ggf. weiter (Flowing-Mode durch den data-Listener) —
    // die Verbindung ist nach einem Mitten-im-Stream-Abbruch unbrauchbar,
    // also kappen. NUR wenn der Body noch nicht zu Ende gelesen war: sonst
    // (z.B. leere Datei) würde das Kappen die Fehlerantwort verschlucken.
    if (!req.readableEnded) req.destroy();
  };

  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > INBOX_MAX_BYTES) void abort(413, 'Die Datei ist größer als 1 GB.');
  });
  req.on('aborted', () => void abort(499, 'Der Upload wurde abgebrochen.'));
  // Ohne diesen Handler crasht ein ECONNRESET nach unpipe() den Prozess
  // (unpipe entfernt den Error-Listener, den pipe() intern gesetzt hatte).
  req.on('error', () => void abort(499, 'Der Upload wurde abgebrochen.'));
  out.on('error', (err) => {
    console.error('Posteingang-Schreibfehler:', err.message);
    void abort(500, 'Die Datei konnte nicht gespeichert werden.');
  });
  out.on('finish', () => {
    if (failed) return;
    if (received === 0) {
      void abort(400, 'Es sind keine Daten angekommen (leere Datei).');
      return;
    }
    activeUploads.delete(candidate);
    res.json({ name: candidate, size: received });
  });

  req.pipe(out);
});

// DELETE /api/fotos/upload/:name — versehentlichen Upload zurücknehmen.
// Löscht ausschließlich im Posteingang (Transit) — nie in der Bibliothek.
router.delete('/upload/:name', async (req, res) => {
  const name = sanitizeInboxName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Ungültiger Dateiname.' });
  if (activeUploads.has(name)) {
    return res.status(409).json({ error: 'Diese Datei wird gerade hochgeladen — kurz warten.' });
  }
  try {
    await fs.unlink(path.join(INBOX_DIR, name));
    res.json({ ok: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Die Datei liegt nicht (mehr) im Posteingang.' });
    }
    console.error('Posteingang-Löschen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
  }
});

module.exports = router;
