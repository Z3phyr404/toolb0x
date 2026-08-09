// ============================================================
// KI-FOTOSUCHE — Vektor-Index laden + Ranking (2026-08-09)
// ============================================================
// fotob0x exportiert beim Web-Sync die SigLIP2-Bildvektoren der
// Bibliothek nach <fotos-privat>/search/:
//   index.json  { model, dims, count, ids, scales }
//   vectors.bin count * dims Int8-Werte dicht hintereinander
// Die Vektoren wurden VOR der Int8-Quantisierung L2-normalisiert;
// je Vektor gilt q[i] = round(v[i] * S) mit S = scales[n]. Für einen
// normalisierten Anfragevektor t ist damit Kosinus ≈ dot(q, t) / S.
//
// Dieses Modul hält den Index im RAM (bei 5.000 Fotos und 768
// Dimensionen sind das ~4 MB) und lädt ihn nur neu, wenn sich die
// Dateien auf der Platte geändert haben (mtime/Größe — der Web-Sync
// der App schreibt beide Dateien bei jedem Lauf neu).
// ============================================================

const fs = require('fs/promises');
const path = require('path');

// Wie in fotob0x (ai.ts): höchstens so viele Kandidaten in die Rangliste …
const MAX_RESULTS = 100;
// … und unterhalb dieser Trefferzahl wird nie beschnitten (sonst wirken
// enge Suchen leer).
const TRIM_MIN_RESULTS = 12;

// Cache über Modulgrenzen: ein Index pro Prozess reicht (Single-Server).
let cache = null; // { key, index }

/**
 * Lädt den Such-Index aus <privatDir>/search (mit RAM-Cache).
 * @returns {Promise<null | { model: string, dims: number, count: number,
 *   ids: number[], scales: number[], vectors: Int8Array }>}
 *   null = es liegen (noch) keine Suchvektoren auf der Platte.
 */
async function loadSearchIndex(privatDir) {
  const indexPath = path.join(privatDir, 'search', 'index.json');
  const binPath = path.join(privatDir, 'search', 'vectors.bin');

  let indexStat, binStat;
  try {
    indexStat = await fs.stat(indexPath);
    binStat = await fs.stat(binPath);
  } catch (err) {
    if (err.code === 'ENOENT') return null; // noch nie ein Websync mit KI-Index
    throw err;
  }

  // Cache-Schlüssel aus mtime + Größe BEIDER Dateien: ändert der Websync
  // den Index, wird hier automatisch neu geladen.
  const key = privatDir + '|' + indexStat.mtimeMs + ':' + indexStat.size +
    '|' + binStat.mtimeMs + ':' + binStat.size;
  if (cache && cache.key === key) return cache.index;

  const meta = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  const raw = await fs.readFile(binPath);

  // Billige Validierung wie bei den Manifest-Feldern (fotos.js): der Index
  // kommt zwar von der eigenen App, aber ein halb hochgeladener Bestand
  // (rclone mittendrin) soll keine kaputten Ergebnisse liefern.
  const dims = Number(meta.dims);
  const count = Number(meta.count);
  if (
    typeof meta.model !== 'string' || meta.model.length === 0 ||
    !Number.isInteger(dims) || dims <= 0 ||
    !Number.isInteger(count) || count <= 0 ||
    !Array.isArray(meta.ids) || meta.ids.length !== count ||
    !Array.isArray(meta.scales) || meta.scales.length !== count ||
    raw.byteLength !== count * dims
  ) {
    console.error('KI-Suchindex unbrauchbar (index.json passt nicht zu vectors.bin) — wird ignoriert.');
    return null;
  }

  const index = {
    model: meta.model,
    dims,
    count,
    ids: meta.ids,
    scales: meta.scales,
    vectors: new Int8Array(raw.buffer, raw.byteOffset, raw.byteLength),
  };
  cache = { key, index };
  return index;
}

/** Nur für Tests: Cache verwerfen (z.B. nach Umbiegen des Verzeichnisses). */
function invalidateSearchCache() {
  cache = null;
}

/**
 * Skalarprodukt der Anfrage-Vektoren gegen alle Int8-Vektoren; je Foto
 * zählt der beste Wert über die Varianten (Original + Übersetzung), genau
 * wie rankAgainstIndex in fotob0x ai.ts. Ergebnis absteigend sortiert,
 * höchstens MAX_RESULTS Einträge.
 * @param {object} index Ergebnis von loadSearchIndex
 * @param {Float32Array[]} variants normalisierte Anfrage-Vektoren
 * @returns {{ id: number, score: number }[]}
 */
function rankPhotos(index, variants) {
  if (!variants || variants.length === 0) return [];
  const { dims, count, ids, scales, vectors } = index;
  const scored = [];
  for (let n = 0; n < count; n++) {
    const base = n * dims;
    const invScale = 1 / scales[n];
    let best = -Infinity;
    for (const variant of variants) {
      let dot = 0;
      for (let i = 0; i < dims; i++) dot += variant[i] * vectors[base + i];
      const cos = dot * invScale; // Rück-Skalierung der Int8-Quantisierung
      if (cos > best) best = cos;
    }
    scored.push({ id: ids[n], score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_RESULTS);
}

/**
 * Schneidet den unpassenden „Schwanz" der Rangliste ab — 1:1 die Logik von
 * trimToRelevant in fotob0x ai.ts: behalten wird, was in der oberen Hälfte
 * (relative Schwelle 0.55) der Spanne zwischen bestem und schlechtestem
 * Kandidaten liegt; bei flacher Verteilung bleiben die besten
 * TRIM_MIN_RESULTS als ehrliches Minimum.
 * @param {{ id: number, score: number }[]} results absteigend sortiert
 */
function trimToRelevant(results) {
  if (results.length <= TRIM_MIN_RESULTS) return results;
  const top = results[0].score;
  const bottom = results[results.length - 1].score;
  const span = top - bottom;
  if (span <= 1e-6) return results.slice(0, TRIM_MIN_RESULTS);
  const cutoff = bottom + span * 0.55;
  const kept = results.filter((r) => r.score >= cutoff);
  return kept.length < TRIM_MIN_RESULTS ? results.slice(0, TRIM_MIN_RESULTS) : kept;
}

module.exports = { loadSearchIndex, invalidateSearchCache, rankPhotos, trimToRelevant };
