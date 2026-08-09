// ============================================================
// KI-FOTOSUCHE — Anfrage-Encoder (SigLIP2-Text-Tower, 2026-08-09)
// ============================================================
// Bettet den Suchtext in denselben Vektorraum ein wie die Bildvektoren,
// die fotob0x beim Web-Sync hochlädt — mit EXAKT der Suchpipeline aus
// fotob0x (src/main/ai.ts, dort ausführlich begründet):
//   1. Anfrage KLEINSCHREIBEN (SigLIP2 ist auf kleingeschriebene
//      Bildunterschriften trainiert — "Schnee" trifft nichts, "schnee" schon).
//   2. Zusätzlich mit Opus-MT de->en ÜBERSETZEN und mit BEIDEN Varianten
//      suchen (das Modell ist zu ~90 % englisch trainiert; das Original
//      bleibt immer dabei, weil der Übersetzer englische Eingaben und
//      Eigennamen gelegentlich verstümmelt).
//   3. Je Variante das Mittel aus "q" und "a photo of q" einbetten
//      (Prompt-Ensembling), renormalisiert.
// Je Foto zählt später der beste Wert über die Varianten.
//
// SPEICHER & PLATZ (wichtig auf dem 4-GB-VPS):
// - Es wird NIEMALS der Vision-Tower geladen — nur Tokenizer + Text-Tower
//   (q8) + Übersetzer (q8). RAM grob: standard-Modell ~150 MB, high-Modell
//   (so400m) ~500 MB, Übersetzer ~150 MB — zusammen 0,3-0,7 GB.
// - Modelldateien landen in FOTOS_MODELS_DIR (Default
//   /var/www/toolbox/models). Platzbedarf auf der Platte: ~0,5 GB
//   (standard) bis ~1,5 GB (high), Übersetzer ~110 MB.
// - Der ERSTE Suchaufruf lädt die Modelle von Hugging Face herunter —
//   das kann mehrere Minuten dauern. Solange antwortet die Route mit 503
//   und einem freundlichen Hinweis; danach bleiben die Modelle im RAM.
// ============================================================

const os = require('os');

// Ablageort der Modelldateien (transformers.js-Cache).
const MODELS_DIR = process.env.FOTOS_MODELS_DIR || '/var/www/toolbox/models';

// Übersetzer wie in fotob0x (TRANSLATOR_ID in ai.ts) — de->en, q8, ~110 MB.
const TRANSLATOR_ID = 'Xenova/opus-mt-de-en';

// Tokenizer-Einstellung des SigLIP2-Modells (feste Sequenzlänge, wie ai.ts).
const TEXT_MAX_LENGTH = 64;

// q8 ist die auch in fotob0x geprüfte Quantisierung (klein + schnell genug).
const MODEL_DTYPE = 'q8';

// ONNX nicht alle Kerne belegen lassen — auf dem VPS laufen daneben
// Node/Postgres/nginx weiter (gleiche Überlegung wie ONNX_THREADS in ai.ts).
const ONNX_THREADS = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));
const SESSION_OPTIONS = { intraOpNumThreads: ONNX_THREADS, interOpNumThreads: 1 };

let transformersModule = null;

/** Lädt @huggingface/transformers erst beim ersten Bedarf (großes Paket). */
function loadTransformers() {
  if (!transformersModule) {
    // eslint-disable-next-line global-require
    const mod = require('@huggingface/transformers');
    mod.env.cacheDir = MODELS_DIR;
    // Nur der Cache oben und (einmalig) Hugging Face sind gültige Quellen —
    // kein Suchen in einem ./models-Ordner relativ zum Arbeitsverzeichnis.
    mod.env.allowLocalModels = false;
    transformersModule = mod;
  }
  return transformersModule;
}

// Geladene Modelle: immer genau EIN SigLIP2-Text-Tower (der aus index.json;
// wechselt Michael in fotob0x die Modellstufe, kommt beim nächsten Websync
// eine andere Repo-ID an und hier wird umgeladen) + der Übersetzer.
let loaded = null; // { modelId, tokenizer, textModel, translate }
let loading = null; // { modelId, promise } — Mutex wie in ai.ts

/** Ist der Text-Tower für dieses Modell fertig geladen? (für die Status-Route) */
function isReady(modelId) {
  return !!(loaded && loaded.modelId === modelId);
}

async function loadAll(modelId) {
  const t = loadTransformers();
  const modelOptions = { dtype: MODEL_DTYPE, session_options: SESSION_OPTIONS };
  const tokenizer = await t.AutoTokenizer.from_pretrained(modelId);
  // WICHTIG: SiglipTextModel lädt NUR onnx/text_model_quantized.onnx —
  // der große Vision-Tower bleibt auf Hugging Face bzw. der Platte.
  const textModel = await t.SiglipTextModel.from_pretrained(modelId, modelOptions);
  const translate = await t.pipeline('translation', TRANSLATOR_ID, {
    dtype: MODEL_DTYPE,
    session_options: SESSION_OPTIONS,
  });
  return { modelId, tokenizer, textModel, translate };
}

/**
 * Liefert die geladenen Modelle; lädt sie beim ersten Aufruf (inkl.
 * einmaligem Download) und hält sie danach im RAM. Parallele Aufrufer
 * teilen sich denselben Ladevorgang.
 */
function ensureLoaded(modelId) {
  if (loaded && loaded.modelId === modelId) return Promise.resolve(loaded);
  if (loading && loading.modelId === modelId) return loading.promise;
  // Modellwechsel: alten Stand freigeben, damit nie zwei Text-Tower im RAM sind.
  loaded = null;
  const promise = loadAll(modelId)
    .then((result) => {
      loaded = result;
      return result;
    })
    .finally(() => {
      if (loading && loading.promise === promise) loading = null;
    });
  loading = { modelId, promise };
  return promise;
}

/** Normalisiert IN PLACE auf Länge 1 (wie normalize in ai.ts). */
function normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const len = Math.sqrt(sum);
  if (len > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] = vec[i] / len;
  }
  return vec;
}

/** Tokenisiert und bettet einen Text ein (normalisierter Float32Array). */
async function embedText(models, text) {
  const inputs = models.tokenizer(text, {
    padding: 'max_length',
    truncation: true,
    max_length: TEXT_MAX_LENGTH,
  });
  const output = await models.textModel(inputs);
  const tensor = output.pooler_output;
  if (!tensor || !tensor.data || tensor.data.length === 0) {
    throw new Error('Das KI-Modell hat kein verwertbares Merkmal geliefert (pooler_output fehlt).');
  }
  return normalize(Float32Array.from(tensor.data));
}

/**
 * Anfrage-Vektoren für die Freitext-Suche — die fotob0x-Pipeline
 * (queryVectors in ai.ts): Kleinschreibung, Übersetzung als Zusatz-
 * variante, je Variante das renormalisierte Mittel aus "q" und
 * "a photo of q".
 *
 * @param {string} query bereits validierter Suchtext
 * @param {string} modelId HF-Repo-ID aus search/index.json
 * @param {{ maxWaitMs?: number }} [options] Ist das Modell nach maxWaitMs
 *   noch nicht geladen (erster Aufruf = Download!), fliegt ein Fehler mit
 *   code 'MODEL_LOADING' — der Ladevorgang läuft im Hintergrund weiter,
 *   ein späterer Aufruf kommt dann sofort durch.
 * @returns {Promise<Float32Array[]>}
 */
async function embedQueryVariants(query, modelId, options) {
  const maxWaitMs = options && options.maxWaitMs;
  const loadingPromise = ensureLoaded(modelId);

  let models;
  if (maxWaitMs && !isReady(modelId)) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), maxWaitMs);
    });
    const winner = await Promise.race([loadingPromise.then(() => 'loaded'), timeout]);
    clearTimeout(timer);
    if (winner === 'timeout') {
      const err = new Error('Das KI-Modell wird noch geladen.');
      err.code = 'MODEL_LOADING';
      throw err;
    }
    models = await loadingPromise;
  } else {
    models = await loadingPromise;
  }

  const variants = [query.toLowerCase()];
  try {
    const result = await models.translate(query);
    const translated = result && result[0] && result[0].translation_text
      ? result[0].translation_text.trim().toLowerCase()
      : '';
    if (translated && translated !== variants[0]) variants.push(translated);
  } catch (err) {
    // Nur mit dem Original suchen — schlechter als mit Übersetzung, aber
    // besser als gar kein Ergebnis.
    console.error('KI-Suche: Übersetzung der Anfrage fehlgeschlagen:', err.message);
  }

  const vectors = [];
  for (const variant of variants) {
    const plain = await embedText(models, variant);
    const templated = await embedText(models, 'a photo of ' + variant);
    const sum = new Float32Array(plain.length);
    for (let i = 0; i < sum.length; i++) sum[i] = plain[i] + templated[i];
    vectors.push(normalize(sum));
  }
  return vectors;
}

module.exports = { embedQueryVariants, ensureLoaded, isReady, MODELS_DIR, TRANSLATOR_ID };
