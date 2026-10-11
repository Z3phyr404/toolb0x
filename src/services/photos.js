// ============================================================
// FOTO-LOGIK — gemeinsam für /api/fotos und die Zephyr-Integration
// ============================================================
// Bis 2026-10-12 stand das direkt in routes/fotos.js. Die Integration
// (src/integration/app.js) braucht dieselben Funktionen; damit beide exakt
// gleich prüfen (Namens-Whitelists, Marker-Format für fotob0x), liegen sie
// hier. Verzeichnisse werden bei JEDEM Aufruf aus der Umgebung gelesen,
// damit Tests sie über process.env umbiegen können.
// ============================================================

const fs = require('fs/promises');
const path = require('path');
const { loadSearchIndex, rankPhotos, trimToRelevant } = require('../utils/fotoSearch');
const fotoEmbedder = require('../utils/fotoEmbedder');

const dirs = () => ({
  // Auf dem Server /var/www/fotos; lokal per Env übersteuerbar (Dev/Tests).
  fotos: process.env.FOTOS_DIR || '/var/www/fotos',
  // Privater Bibliotheks-Mirror („Alle Fotos", fotob0x Web-Sync).
  // Wird bewusst NICHT von nginx ausgeliefert.
  privat: process.env.FOTOS_PRIVAT_DIR || '/var/www/fotos-privat',
});

// Mirror-Dateinamen sind "<assetId>.jpg" (numerische fotob0x-IDs).
const PHOTO_NAME_RE = /^\d{1,12}\.jpg$/;

// Galerie-Tokens aus fotob0x sind 24 Zeichen base64url — alles andere
// (versteckte Dateien, Fremdordner) wird ignoriert.
const TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/;

// Obergrenze wie MAX_QUERY_LENGTH in fotob0x ai.ts.
const SEARCH_MAX_QUERY_LENGTH = 300;
// So lange darf eine Suchanfrage auf das (noch) ladende Modell warten.
const SEARCH_MODEL_WAIT_MS = 25_000;

// Tags: sichtbare Zeichen, keine Steuerzeichen/Pfade, wie fotob0x sie kennt.
const EDIT_TAG_MAX_LEN = 60;
const EDIT_TAGS_MAX = 20;
const MAX_IDS = 500;

class PhotoError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

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

/** Liste der geteilten Alben (Ordner unter FOTOS_DIR), neueste zuerst. */
async function listSharedAlbums() {
  const { fotos } = dirs();
  let entries;
  try {
    entries = await fs.readdir(fotos, { withFileTypes: true });
  } catch (err) {
    // Verzeichnis fehlt (z.B. lokale Entwicklung) → leere Liste, kein Fehler
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const albums = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !TOKEN_RE.test(entry.name)) continue;
    const dir = path.join(fotos, entry.name);
    const album = { token: entry.name, title: entry.name, photoCount: 0, sharedAt: null, thumb: null };

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

  albums.sort((a, b) => String(b.sharedAt).localeCompare(String(a.sharedAt)));
  return albums;
}

// Alben (fotob0x, 2026-08-07): {n, ids}-Objekte, Cap bei 200.
function sanitizeAlbums(albums) {
  if (!Array.isArray(albums)) return [];
  const out = [];
  for (const album of albums) {
    if (out.length >= 200) break;
    if (!album || typeof album !== 'object') continue;
    if (typeof album.n !== 'string' || album.n.length === 0) continue;
    if (!Array.isArray(album.ids)) continue;
    const ids = album.ids.filter((id) => typeof id === 'number' && Number.isFinite(id));
    if (ids.length === 0) continue;
    out.push({ n: album.n, ids });
  }
  return out;
}

// Events (fotob0x Etappe 6) — simple {n, s, e, ids}-Objekte, Cap bei 500.
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

/** Manifest der privaten Bibliothek (library.json von fotob0x). */
async function readLibrary() {
  try {
    const raw = await fs.readFile(path.join(dirs().privat, 'library.json'), 'utf8');
    const manifest = JSON.parse(raw);
    return {
      generatedAt: typeof manifest.generatedAt === 'string' ? manifest.generatedAt : null,
      photoCount: Number.isInteger(manifest.photoCount) ? manifest.photoCount : 0,
      persons: Array.isArray(manifest.persons) ? manifest.persons : [],
      events: sanitizeEvents(manifest.events),
      albums: sanitizeAlbums(manifest.albums),
      photos: Array.isArray(manifest.photos) ? manifest.photos : [],
    };
  } catch (error) {
    // Noch nie gesynct → leere Bibliothek, kein Fehler
    if (error.code === 'ENOENT') {
      return { generatedAt: null, photoCount: 0, persons: [], events: [], albums: [], photos: [] };
    }
    throw error;
  }
}

/** Absoluter Pfad eines Mirror-Bilds oder null bei ungültigem Namen. */
function privatePhotoRoot(subdir, name) {
  if (!PHOTO_NAME_RE.test(name) || !['img', 'thumb'].includes(subdir)) return null;
  return path.join(dirs().privat, subdir);
}

async function searchStatus() {
  const index = await loadSearchIndex(dirs().privat);
  return {
    available: !!index,
    count: index ? index.count : 0,
    model: index ? index.model : null,
    modelReady: index ? fotoEmbedder.isReady(index.model) : false,
  };
}

/**
 * Semantische KI-Suche. Wirft PhotoError (400/404/503) mit deutscher Meldung.
 * @returns {{ ids: number[], scores: number[] }}
 */
async function searchPhotos(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new PhotoError(400, 'Bitte einen Suchtext eingeben.');
  }
  const query = raw.trim();
  if (query.length > SEARCH_MAX_QUERY_LENGTH) {
    throw new PhotoError(400, `Der Suchtext ist zu lang (maximal ${SEARCH_MAX_QUERY_LENGTH} Zeichen).`);
  }

  const index = await loadSearchIndex(dirs().privat);
  if (!index) {
    throw new PhotoError(404, 'Die App hat noch keine Suchvektoren hochgeladen — einmal Websync laufen lassen.');
  }

  let variants;
  try {
    variants = await fotoEmbedder.embedQueryVariants(query, index.model, { maxWaitMs: SEARCH_MODEL_WAIT_MS });
  } catch (err) {
    if (err && err.code === 'MODEL_LOADING') {
      throw new PhotoError(503, 'Das KI-Modell wird gerade geladen (beim ersten Mal einige Minuten) — bitte gleich noch einmal versuchen.');
    }
    throw err;
  }

  // Passt der Text-Tower nicht zu den Vektoren (sollte nie passieren,
  // beide kommen aus index.json), lieber laut scheitern als Unsinn ranken.
  if (variants.some((v) => v.length !== index.dims)) {
    console.error(`KI-Suche: Vektorlänge passt nicht (Modell ${index.model}, erwartet ${index.dims}).`);
    throw new PhotoError(500, 'Der Suchindex passt nicht zum KI-Modell — bitte in fotob0x den Websync erneut laufen lassen.');
  }

  const results = trimToRelevant(rankPhotos(index, variants));
  return {
    ids: results.map((r) => r.id),
    // 4 Nachkommastellen reichen und halten die Antwort klein.
    scores: results.map((r) => Math.round(r.score * 10000) / 10000),
  };
}

/** Foto-IDs säubern: positive Ganzzahlen, ohne Duplikate, max. 500. */
function cleanPhotoIds(list) {
  const ids = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0 && n < 1e12 && !ids.includes(n)) ids.push(n);
    if (ids.length >= MAX_IDS) break;
  }
  return ids;
}

function cleanEditTags(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const tag = raw.replace(/\s+/g, ' ').trim();
    if (!tag || tag.length > EDIT_TAG_MAX_LEN) continue;
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f/\\]/.test(tag)) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= EDIT_TAGS_MAX) break;
  }
  return out;
}

// ------------------------------------------------------------
// Lösch-Warteschlange — online löschen -> PC-Papierkorb
// ------------------------------------------------------------
// „Alle Fotos" ist eine schreibgeschützte Kopie; der PC bleibt die Wahrheit.
// Ein Löschen online legt nur einen MARKER an (leere Datei je Asset-ID unter
// fotos-privat/delete-queue). fotob0x holt die Marker ab, verschiebt die
// Fotos lokal in den Papierkorb (wiederherstellbar!) und löscht die Marker.
const deleteQueueDir = () => path.join(dirs().privat, 'delete-queue');
const editQueueDir = () => path.join(dirs().privat, 'edit-queue');

/** @param {number[]} ids bereits gesäubert (cleanPhotoIds) */
async function queueDelete(ids) {
  if (ids.length === 0) throw new PhotoError(400, 'Keine gültigen Foto-IDs.');
  await fs.mkdir(deleteQueueDir(), { recursive: true });
  for (const id of ids) {
    // wx: nur anlegen, doppelte Anfragen sind harmlos (schon markiert).
    await fs.writeFile(path.join(deleteQueueDir(), String(id)), '', { flag: 'wx' }).catch((e) => {
      if (e.code !== 'EEXIST') throw e;
    });
  }
  return { queued: ids.length };
}

async function pendingDeletes() {
  const entries = await fs.readdir(deleteQueueDir()).catch((e) => {
    if (e.code === 'ENOENT') return [];
    throw e;
  });
  return entries.filter((n) => /^\d{1,12}$/.test(n)).length;
}

// ------------------------------------------------------------
// Änderungs-Warteschlange — Bewerten/Taggen im Web -> PC
// ------------------------------------------------------------
// Marker "<assetId>.json" ({ r: 0-5, add: [...], del: [...] }); mehrere
// Änderungen am selben Foto werden in EINEN Marker gemischt (letzte
// Bewertung gewinnt, add/del heben sich gegenseitig auf).

/**
 * @param {{ ids: number[], rating: number|null, addTags: string[], removeTags: string[] }} change
 *   bereits gesäubert; rating null = Bewertung nicht ändern
 */
async function queueEdit({ ids, rating, addTags, removeTags }) {
  if (ids.length === 0) throw new PhotoError(400, 'Keine gültige Foto-ID.');
  const hasRating = rating !== null && rating !== undefined;
  if (hasRating && (!Number.isInteger(rating) || rating < 0 || rating > 5)) {
    throw new PhotoError(400, 'Die Bewertung muss zwischen 0 und 5 Sternen liegen.');
  }
  if (!hasRating && addTags.length === 0 && removeTags.length === 0) {
    throw new PhotoError(400, 'Keine Änderung angegeben.');
  }

  await fs.mkdir(editQueueDir(), { recursive: true });
  for (const id of ids) {
    const file = path.join(editQueueDir(), id + '.json');
    // Bestehenden Marker einmischen (Read-Modify-Write; ein Nutzer, kein Lock).
    let marker = {};
    try {
      marker = JSON.parse(await fs.readFile(file, 'utf8')) || {};
    } catch {
      marker = {};
    }
    const add = new Set(cleanEditTags(marker.add));
    const del = new Set(cleanEditTags(marker.del));
    for (const tag of addTags) { add.add(tag); del.delete(tag); }
    for (const tag of removeTags) { del.add(tag); add.delete(tag); }
    const next = {};
    if (hasRating) next.r = rating;
    else if (Number.isInteger(marker.r) && marker.r >= 0 && marker.r <= 5) next.r = marker.r;
    if (add.size > 0) next.add = [...add];
    if (del.size > 0) next.del = [...del];
    await fs.writeFile(file, JSON.stringify(next));
  }
  return { queued: ids.length };
}

async function pendingEdits() {
  const entries = await fs.readdir(editQueueDir()).catch((e) => {
    if (e.code === 'ENOENT') return [];
    throw e;
  });
  return entries.filter((n) => /^\d{1,12}\.json$/.test(n)).length;
}

module.exports = {
  PhotoError,
  PHOTO_NAME_RE,
  dirs,
  listSharedAlbums,
  readLibrary,
  privatePhotoRoot,
  searchStatus,
  searchPhotos,
  cleanPhotoIds,
  cleanEditTags,
  queueDelete,
  pendingDeletes,
  queueEdit,
  pendingEdits,
};
