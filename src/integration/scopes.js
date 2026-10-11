// ============================================================
// BERECHTIGUNGEN DER INTEGRATION (Zephyr/Hermes) — 2026-10-12
// ============================================================
// Jede Berechtigung ist einzeln schaltbar. Neue Berechtigungen sind
// standardmäßig AUS; einschalten geht nur in der App (mit Passwort),
// Zephyr selbst kann Berechtigungen nur abgeben (POST /v1/scopes/drop).
//
// admin: true  → zusätzlich muss das Konto die Rolle "admin" haben (wie
//               die entsprechenden App-Bereiche /app/fotos, /app/servers).
//
// BEWUSST NICHT VORHANDEN (Michaels Entscheidung 2026-10-12):
// Passwörter, Tresore, Freigabe-Links, Administration, Konto/Profil,
// Exporte, Hermes-Chat, Integrationsverwaltung.
// ============================================================

const SCOPES = {
  'finance.read': { label: 'Finanzen lesen (Ausgaben, Buchungen, Einnahmen, Übersicht, Verlauf, Kategorien)' },
  'finance.write': { label: 'Finanzen buchen (Ausgaben, Buchungen, Einnahmen anlegen/ändern/löschen)' },
  'finance.categories': { label: 'Kategorien anlegen, umbenennen, löschen' },
  'finance.balance': { label: 'Kontostand lesen und eintragen' },
  'reminders.read': { label: 'Erinnerungen lesen' },
  'reminders.write': { label: 'Erinnerungen anlegen, ändern, löschen' },
  'notes.read': { label: 'Notizen lesen und durchsuchen' },
  'notes.write': { label: 'Notizen anlegen, ändern, verschieben, löschen' },
  'photos.read': { label: 'Fotos: Alben, Bibliothek, KI-Suche (nur Metadaten)', admin: true },
  'photos.images': { label: 'Fotos: Bilddateien abrufen (gehen an das Sprachmodell bzw. Telegram)', admin: true },
  'photos.edit': { label: 'Fotos bewerten, taggen, Löschwunsch an fotob0x', admin: true },
  'servers.status': { label: 'Server: Status, Kennzahlen, Dienste (feste Lesebefehle per SSH)', admin: true },
  'servers.actions': { label: 'Server: Update, Dienst neu starten, Neustart', admin: true },
};

// Was ein NEUER Zugang bekommt — genau der bisherige Finanzzugang.
const DEFAULT_SCOPES = ['finance.read', 'finance.write'];

function isKnownScope(name) {
  return Object.prototype.hasOwnProperty.call(SCOPES, name);
}

/** Bereinigt eine gespeicherte Liste (unbekannte Einträge fallen weg). */
function normalizeScopes(list) {
  if (!Array.isArray(list)) return [...DEFAULT_SCOPES];
  return [...new Set(list.filter(isKnownScope))];
}

/** Darf dieses Konto die Berechtigung überhaupt haben? */
function allowedForRole(scope, role) {
  return isKnownScope(scope) && (!SCOPES[scope].admin || role === 'admin');
}

/** Effektiv wirksame Berechtigungen (gespeichert ∩ für die Rolle erlaubt). */
function effectiveScopes(stored, role) {
  return normalizeScopes(stored).filter(s => allowedForRole(s, role));
}

function describeScopes(granted, role) {
  return Object.entries(SCOPES).map(([name, def]) => ({
    name,
    label: def.label,
    adminOnly: !!def.admin,
    available: allowedForRole(name, role),
    granted: granted.includes(name),
  }));
}

module.exports = {
  SCOPES,
  DEFAULT_SCOPES,
  isKnownScope,
  normalizeScopes,
  allowedForRole,
  effectiveScopes,
  describeScopes,
};
