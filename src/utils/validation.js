// ============================================================
// EINGABE-VALIDIERUNG
// ============================================================
// Goldene Regel: VERTRAUE NIEMALS dem Client!
//
// Alles was vom Browser kommt, kann manipuliert sein.
// Selbst wenn dein Frontend ein Feld auf 100 Zeichen begrenzt,
// kann jemand mit Postman/curl beliebige Daten senden.
//
// Deshalb prüfen wir JEDE Eingabe serverseitig.
// ============================================================

const validator = require('validator');
const { isInPeriod, periodRange, normalizeStartDay } = require('./budgetPeriod');

// --------------------------------------------------------
// Registrierung validieren
// --------------------------------------------------------
function validateRegistration(data) {
  const errors = [];

  // E-Mail
  if (!data.email || !validator.isEmail(data.email)) {
    errors.push('Bitte gib eine gültige E-Mail-Adresse ein.');
  }

  // Passwort — Mindestanforderungen
  if (!data.password || data.password.length < 8) {
    errors.push('Das Passwort muss mindestens 8 Zeichen lang sein.');
  }
  if (data.password && !/[A-Z]/.test(data.password)) {
    errors.push('Das Passwort braucht mindestens einen Großbuchstaben.');
  }
  if (data.password && !/[0-9]/.test(data.password)) {
    errors.push('Das Passwort braucht mindestens eine Zahl.');
  }

  // Name
  if (!data.name || data.name.trim().length < 2) {
    errors.push('Bitte gib deinen Namen ein (mindestens 2 Zeichen).');
  }
  if (data.name && data.name.length > 50) {
    errors.push('Der Name darf maximal 50 Zeichen lang sein.');
  }

  return errors;
}

// --------------------------------------------------------
// Login validieren
// --------------------------------------------------------
function validateLogin(data) {
  const errors = [];

  if (!data.email || !validator.isEmail(data.email)) {
    errors.push('Bitte gib eine gültige E-Mail-Adresse ein.');
  }
  if (!data.password || data.password.length === 0) {
    errors.push('Bitte gib dein Passwort ein.');
  }

  return errors;
}

// Ein Nicht-String im Namensfeld ({"name": 123} oder {"name": ["x"]}) lief
// früher in `data.name.trim()` und damit in einen TypeError — die Route
// antwortete mit 500 statt mit einer verständlichen 400.
function istText(v) {
  return typeof v === 'string';
}

// "2026-02-31" besteht den Ziffern-Regex, existiert aber nicht.
function istEchtesDatum(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// "2026-10-14" -> "14.10.2026" (nur für Fehlermeldungen)
function fmtTag(ymd) {
  return `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`;
}

// --------------------------------------------------------
// Ausgabe validieren
// --------------------------------------------------------
// startDay = erster Tag des Finanzmonats (1-28). Bei 1 ist die Periode der
// Kalendermonat — das bisherige Verhalten.
function validateExpense(data, startDay = 1) {
  const errors = [];
  const start = normalizeStartDay(startDay);

  // Name der Ausgabe
  if (!istText(data.name) || data.name.trim().length === 0) {
    errors.push('Bitte gib einen Namen für die Ausgabe ein.');
  } else if (data.name.length > 100) {
    errors.push('Der Name darf maximal 100 Zeichen lang sein.');
  }

  // Betrag
  // parseFloat('abc') = NaN, parseFloat('12.50') = 12.5
  const amount = parseFloat(data.amount);
  if (isNaN(amount) || amount <= 0) {
    errors.push('Bitte gib einen gültigen Betrag größer als 0 ein.');
  }
  if (amount > 999999.99) {
    errors.push('Der Betrag darf maximal 999.999,99 € sein.');
  }

  // Kategorie-ID (muss eine UUID sein)
  if (!data.categoryId || !validator.isUUID(data.categoryId)) {
    errors.push('Bitte wähle eine gültige Kategorie.');
  }

  // Monat (Format: YYYY-MM)
  if (data.month && (!istText(data.month) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(data.month))) {
    errors.push('Ungültiges Monatsformat. Erwartet: YYYY-MM (z.B. 2026-02).');
  }

  // Tagesdatum (optional, YYYY-MM-DD) — muss in der PERIODE liegen.
  // Bei Starttag 1 ist das der Kalendermonat, bei Starttag 15 z.B. der
  // Zeitraum 15.09.-14.10. Die Periode heißt nach ihrem Startmonat.
  if (data.spentOn !== undefined && data.spentOn !== null && data.spentOn !== '') {
    if (!istText(data.spentOn) || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(data.spentOn)) {
      errors.push('Ungültiges Datum. Erwartet: YYYY-MM-DD (z.B. 2026-08-22).');
    } else if (!istEchtesDatum(data.spentOn)) {
      // Der Regex prüft nur die Ziffernform: der 31.02. käme sonst durch.
      errors.push('Dieses Datum gibt es nicht.');
    } else if (data.month && !isInPeriod(data.spentOn, data.month, start)) {
      const { start: von, end: bis } = periodRange(data.month, start);
      errors.push(start === 1
        ? 'Das Datum muss im gewählten Monat liegen.'
        : `Das Datum muss im Zeitraum ${fmtTag(von)} bis ${fmtTag(bis)} liegen.`);
    }
  }

  // Tags (optional)
  if (data.tags !== undefined && data.tags !== null) {
    if (!Array.isArray(data.tags)) {
      errors.push('Tags müssen als Array übergeben werden.');
    } else {
      if (data.tags.length > 10) {
        errors.push('Maximal 10 Tags pro Ausgabe erlaubt.');
      }
      for (const tag of data.tags) {
        if (typeof tag !== 'string' || tag.trim().length === 0) {
          errors.push('Tags dürfen nicht leer sein.');
          break;
        }
        if (tag.length > 30) {
          errors.push('Ein Tag darf maximal 30 Zeichen lang sein.');
          break;
        }
      }
    }
  }

  return errors;
}

// --------------------------------------------------------
// Buchung auf einen Sammelposten validieren
// --------------------------------------------------------
// Anders als eine Ausgabe hat eine Buchung keinen eigenen Namen und keine
// Kategorie — die kommen vom Posten. `bookedOn` muss in der Periode des
// Postens liegen, deshalb kommt der Monat von der Route.
function validateBooking(data, month, startDay = 1) {
  const errors = [];
  const start = normalizeStartDay(startDay);

  const amount = parseFloat(data.amount);
  if (isNaN(amount) || amount <= 0) {
    errors.push('Bitte gib einen gültigen Betrag größer als 0 ein.');
  }
  if (amount > 999999.99) {
    errors.push('Der Betrag darf maximal 999.999,99 € sein.');
  }

  if (data.note !== undefined && data.note !== null && data.note !== '') {
    if (!istText(data.note)) {
      errors.push('Die Notiz muss Text sein.');
    } else if (data.note.length > 100) {
      errors.push('Die Notiz darf maximal 100 Zeichen lang sein.');
    }
  }

  if (data.bookedOn !== undefined && data.bookedOn !== null && data.bookedOn !== '') {
    if (!istText(data.bookedOn) || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(data.bookedOn)) {
      errors.push('Ungültiges Datum. Erwartet: YYYY-MM-DD (z.B. 2026-08-22).');
    } else if (!istEchtesDatum(data.bookedOn)) {
      errors.push('Dieses Datum gibt es nicht.');
    } else if (month && !isInPeriod(data.bookedOn, month, start)) {
      const { start: von, end: bis } = periodRange(month, start);
      errors.push(start === 1
        ? 'Das Datum muss im gewählten Monat liegen.'
        : `Das Datum muss im Zeitraum ${fmtTag(von)} bis ${fmtTag(bis)} liegen.`);
    }
  }

  return errors;
}

// --------------------------------------------------------
// Einnahme validieren
// --------------------------------------------------------
function validateIncome(data) {
  const errors = [];

  if (!istText(data.name) || data.name.trim().length === 0) {
    errors.push('Bitte gib einen Namen für die Einnahme ein.');
  } else if (data.name.length > 100) {
    errors.push('Der Name darf maximal 100 Zeichen lang sein.');
  }

  const amount = parseFloat(data.amount);
  if (isNaN(amount) || amount <= 0) {
    errors.push('Bitte gib einen gültigen Betrag größer als 0 ein.');
  }
  if (amount > 999999.99) {
    errors.push('Der Betrag darf maximal 999.999,99 € sein.');
  }

  if (data.month && (!istText(data.month) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(data.month))) {
    errors.push('Ungültiges Monatsformat. Erwartet: YYYY-MM (z.B. 2026-02).');
  }

  return errors;
}

// --------------------------------------------------------
// Kategorie validieren
// --------------------------------------------------------
function validateCategory(data) {
  const errors = [];

  if (!istText(data.name) || data.name.trim().length === 0) {
    errors.push('Bitte gib einen Namen für die Kategorie ein.');
  } else if (data.name.length > 50) {
    errors.push('Der Kategorie-Name darf maximal 50 Zeichen lang sein.');
  }

  // Farbe muss ein gültiger Hex-Code sein
  if (data.color && (!istText(data.color) || !/^#[0-9A-Fa-f]{6}$/.test(data.color))) {
    errors.push('Ungültige Farbe. Erwartet: Hex-Code wie #FF5733.');
  }

  return errors;
}

// --------------------------------------------------------
// Text bereinigen
// --------------------------------------------------------
// Früher stand hier validator.escape(): Nutzertext wurde in HTML-Entities
// umgewandelt, BEVOR er verschlüsselt gespeichert wurde. Das war Escaping
// auf der falschen Ebene und hat mehr kaputtgemacht als geschützt:
//
//   - Der Server rendert nie HTML, die Frontends escapen beim Anzeigen
//     ohnehin selbst. Der Schutz war also doppelt gemoppelt ...
//   - ... und dadurch sichtbar falsch: aus "Haushalt & Garten" wurde für den
//     Nutzer "Haushalt &amp; Garten", aus "Mueller's" wurde "Mueller&#x27;s".
//     Im PDF- und im DSGVO-Export stand derselbe Unsinn.
//
// XSS-Schutz gehört an die Ausgabe, nicht an die Eingabe: alle Frontends
// escapen inklusive Anführungszeichen (siehe escapeHtml/esc dort).
// Hier bleibt nur, was wirklich in die Datenbank gehört: keine
// Steuerzeichen, keine führenden/abschließenden Leerzeichen.
// Zeilenumbrüche bleiben erhalten - mehrzeilige Notizen laufen ebenfalls
// hier durch.
// Bestandsdaten werden beim LESEN entschärft, siehe src/utils/legacyText.js.
const STEUERZEICHEN = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');

function sanitize(text) {
  if (typeof text !== 'string') return text;
  return text.replace(STEUERZEICHEN, '').trim();
}

// --------------------------------------------------------
// Erinnerung validieren
// --------------------------------------------------------
function validateReminder(data) {
  const errors = [];

  // Erinnerungsdatum (Pflicht)
  if (!data.reminderDate) {
    errors.push('Bitte gib ein Datum für die Erinnerung ein.');
  } else {
    const d = new Date(data.reminderDate);
    if (isNaN(d.getTime())) {
      errors.push('Ungültiges Datumsformat.');
    }
  }

  // Tage vorher (Pflicht, 0–90)
  const days = parseInt(data.daysBefore);
  if (isNaN(days) || days < 0 || days > 90) {
    errors.push('Tage vorher muss zwischen 0 und 90 liegen.');
  }

  // Notiz (optional, max 200 Zeichen)
  if (data.note && data.note.length > 200) {
    errors.push('Die Notiz darf maximal 200 Zeichen lang sein.');
  }

  // Expense-ID (optional, aber wenn gesetzt → gültige UUID)
  if (data.expenseId && !validator.isUUID(data.expenseId)) {
    errors.push('Ungültige Ausgaben-ID.');
  }

  // Status (optional, nur bei Updates)
  if (data.status && !['pending', 'done', 'dismissed'].includes(data.status)) {
    errors.push('Ungültiger Status.');
  }

  return errors;
}

// --------------------------------------------------------
// Notiz validieren
// --------------------------------------------------------
function validateNote(data) {
  const errors = [];

  // Titel (Pflicht)
  if (!data.title || data.title.trim().length === 0) {
    errors.push('Bitte gib einen Titel ein.');
  }
  if (data.title && data.title.length > 200) {
    errors.push('Der Titel darf maximal 200 Zeichen lang sein.');
  }

  // Content (optional, max 100.000 Zeichen)
  // NICHT mit sanitize() bereinigen — HTML aus WYSIWYG muss erhalten bleiben
  if (data.content !== undefined && data.content !== null && data.content.length > 100000) {
    errors.push('Der Inhalt darf maximal 100.000 Zeichen lang sein.');
  }

  // Icon (optional, Emoji)
  if (data.icon !== undefined && data.icon !== null && data.icon.length > 10) {
    errors.push('Ungültiges Icon.');
  }

  // ParentId (optional, muss UUID sein)
  if (data.parentId && !validator.isUUID(data.parentId)) {
    errors.push('Ungültige übergeordnete Seite.');
  }

  return errors;
}

// --------------------------------------------------------
// Gespeichertes Passwort validieren
// --------------------------------------------------------
function validateStoredPassword(data) {
  const errors = [];

  if (!data.name || data.name.trim().length === 0) {
    errors.push('Bitte gib einen Namen ein (z.B. "Netflix").');
  }
  if (data.name && data.name.length > 100) {
    errors.push('Der Name darf maximal 100 Zeichen lang sein.');
  }

  if (!data.password || data.password.length === 0) {
    errors.push('Bitte gib ein Passwort ein.');
  }
  if (data.password && data.password.length > 500) {
    errors.push('Das Passwort darf maximal 500 Zeichen lang sein.');
  }

  if (data.username && data.username.length > 200) {
    errors.push('Der Benutzername darf maximal 200 Zeichen lang sein.');
  }

  if (data.website && data.website.length > 500) {
    errors.push('Die Website-URL darf maximal 500 Zeichen lang sein.');
  }

  if (data.notes && data.notes.length > 2000) {
    errors.push('Notizen dürfen maximal 2000 Zeichen lang sein.');
  }

  return errors;
}

// --------------------------------------------------------
// Server validieren
// --------------------------------------------------------
function validateServer(data) {
  const errors = [];

  if (!data.label || data.label.trim().length === 0) {
    errors.push('Bitte gib einen Namen ein (z.B. "Hetzner VPS").');
  }
  if (data.label && data.label.length > 100) {
    errors.push('Der Name darf maximal 100 Zeichen lang sein.');
  }

  if (!data.host || data.host.trim().length === 0) {
    errors.push('Bitte gib einen Hostnamen oder eine IP-Adresse ein.');
  }
  if (data.host && data.host.length > 255) {
    errors.push('Der Hostname darf maximal 255 Zeichen lang sein.');
  }

  if (data.port !== undefined && data.port !== '') {
    const port = parseInt(data.port);
    if (isNaN(port) || port < 1 || port > 65535) {
      errors.push('Der Port muss zwischen 1 und 65535 liegen.');
    }
  }

  if (!data.username || data.username.trim().length === 0) {
    errors.push('Bitte gib einen SSH-Benutzernamen ein.');
  }
  if (data.username && data.username.length > 100) {
    errors.push('Der Benutzername darf maximal 100 Zeichen lang sein.');
  }

  if (!data.authType || !['password', 'key'].includes(data.authType)) {
    errors.push('Ungültiger Authentifizierungstyp.');
  }

  if (data.authType === 'password' && (!data.password || data.password.length === 0)) {
    errors.push('Bitte gib ein SSH-Passwort ein.');
  }

  if (data.authType === 'key' && (!data.privateKey || data.privateKey.length === 0)) {
    errors.push('Bitte gib einen SSH Private Key ein.');
  }

  if (data.notes && data.notes.length > 2000) {
    errors.push('Notizen dürfen maximal 2000 Zeichen lang sein.');
  }

  return errors;
}

module.exports = {
  validateRegistration,
  validateLogin,
  validateExpense,
  validateBooking,
  validateIncome,
  validateCategory,
  validateReminder,
  validateNote,
  validateStoredPassword,
  validateServer,
  sanitize,
};
