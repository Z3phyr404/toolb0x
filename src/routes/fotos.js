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
// Logik (Alben, Manifest, KI-Suche, Lösch-/Änderungs-Warteschlange) seit
// 2026-10-12 in ../services/photos.js — gemeinsam mit der Zephyr-Integration.
const photos = require('../services/photos');

const router = express.Router();

// Alle Foto-Routen erfordern Auth + Admin-Rolle
router.use(requireAuth, requireAdmin);

// Upload-Posteingang (2026-08-07): Transit-Ordner für Fotos von iPad/Mac.
// fotob0x auf dem Windows-Rechner (der SSOT bleibt) holt die Dateien per
// SFTP ab, importiert sie in die Bibliothek und leert den Ordner danach.
// Auch dieses Verzeichnis liefert nginx bewusst NICHT aus.
const INBOX_DIR = process.env.FOTOS_INBOX_DIR || '/var/www/fotos-inbox';

function sendPhotoError(res, error, logLabel) {
  if (error instanceof photos.PhotoError) return res.status(error.status).json({ error: error.message });
  console.error(logLabel, error.message);
  res.status(500).json({ error: 'Ein Fehler ist aufgetreten.' });
}

// GET /api/fotos — Liste der geteilten Alben
router.get('/', async (req, res) => {
  try {
    res.json({ albums: await photos.listSharedAlbums() });
  } catch (error) {
    sendPhotoError(res, error, 'Foto-Übersicht fehlgeschlagen:');
  }
});

// GET /api/fotos/library — Manifest der privaten Bibliothek
router.get('/library', async (req, res) => {
  try {
    res.json(await photos.readLibrary());
  } catch (error) {
    sendPhotoError(res, error, 'Bibliotheks-Manifest fehlgeschlagen:');
  }
});

// GET /api/fotos/library/(img|thumb)/:name — Bild ausliefern
// Name streng geprüft (nur "<zahl>.jpg"), sendFile mit root — Pfad-Ausbrüche
// sind damit doppelt ausgeschlossen.
function servePrivatePhoto(subdir) {
  return (req, res) => {
    const name = req.params.name;
    const root = photos.privatePhotoRoot(subdir, name);
    if (!root) return res.status(400).json({ error: 'Ungültiger Bildname.' });
    res.sendFile(name, {
      root,
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

// KI-Suche (2026-08-09) — Details in services/photos.js. Eigener
// Rate-Limiter in security.js, jede Suche kostet echte CPU-Inferenz.
router.get('/search/status', async (req, res) => {
  try {
    res.json(await photos.searchStatus());
  } catch (error) {
    sendPhotoError(res, error, 'KI-Suche-Status fehlgeschlagen:');
  }
});

// POST /api/fotos/search  { q } → { ids, scores }
router.post('/search', async (req, res) => {
  try {
    res.json(await photos.searchPhotos(req.body && req.body.q));
  } catch (error) {
    if (error instanceof photos.PhotoError) return res.status(error.status).json({ error: error.message });
    console.error('KI-Suche fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Die KI-Suche ist fehlgeschlagen. Bitte später erneut versuchen.' });
  }
});

// POST /api/fotos/delete-request  { ids: [123, 456, ...] } — Marker für fotob0x
router.post('/delete-request', async (req, res) => {
  try {
    res.json(await photos.queueDelete(photos.cleanPhotoIds(req.body.ids)));
  } catch (error) {
    sendPhotoError(res, error, 'Lösch-Warteschlange fehlgeschlagen:');
  }
});

// GET /api/fotos/delete-request — offene Anzahl (für die UI)
router.get('/delete-request', async (req, res) => {
  try {
    res.json({ pending: await photos.pendingDeletes() });
  } catch (error) {
    sendPhotoError(res, error, 'Warteschlangen-Status fehlgeschlagen:');
  }
});

// POST /api/fotos/edit-request  { id | ids: [...], rating?, addTags?, removeTags? }
router.post('/edit-request', async (req, res) => {
  try {
    const ids = photos.cleanPhotoIds(Array.isArray(req.body.ids) ? req.body.ids : [req.body.id]);
    const hasRating = req.body.rating !== undefined && req.body.rating !== null;
    res.json(await photos.queueEdit({
      ids,
      rating: hasRating ? Number(req.body.rating) : null,
      addTags: photos.cleanEditTags(req.body.addTags),
      removeTags: photos.cleanEditTags(req.body.removeTags),
    }));
  } catch (error) {
    sendPhotoError(res, error, 'Änderungs-Warteschlange fehlgeschlagen:');
  }
});

// GET /api/fotos/edit-request — offene Anzahl (für die UI)
router.get('/edit-request', async (req, res) => {
  try {
    res.json({ pending: await photos.pendingEdits() });
  } catch (error) {
    sendPhotoError(res, error, 'Änderungs-Warteschlangen-Status fehlgeschlagen:');
  }
});

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
