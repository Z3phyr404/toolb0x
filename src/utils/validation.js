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

// --------------------------------------------------------
// Ausgabe validieren
// --------------------------------------------------------
function validateExpense(data) {
  const errors = [];

  // Name der Ausgabe
  if (!data.name || data.name.trim().length === 0) {
    errors.push('Bitte gib einen Namen für die Ausgabe ein.');
  }
  if (data.name && data.name.length > 100) {
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
  if (data.month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(data.month)) {
    errors.push('Ungültiges Monatsformat. Erwartet: YYYY-MM (z.B. 2026-02).');
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
// Einnahme validieren
// --------------------------------------------------------
function validateIncome(data) {
  const errors = [];

  if (!data.name || data.name.trim().length === 0) {
    errors.push('Bitte gib einen Namen für die Einnahme ein.');
  }
  if (data.name && data.name.length > 100) {
    errors.push('Der Name darf maximal 100 Zeichen lang sein.');
  }

  const amount = parseFloat(data.amount);
  if (isNaN(amount) || amount <= 0) {
    errors.push('Bitte gib einen gültigen Betrag größer als 0 ein.');
  }
  if (amount > 999999.99) {
    errors.push('Der Betrag darf maximal 999.999,99 € sein.');
  }

  if (data.month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(data.month)) {
    errors.push('Ungültiges Monatsformat. Erwartet: YYYY-MM (z.B. 2026-02).');
  }

  return errors;
}

// --------------------------------------------------------
// Kategorie validieren
// --------------------------------------------------------
function validateCategory(data) {
  const errors = [];

  if (!data.name || data.name.trim().length === 0) {
    errors.push('Bitte gib einen Namen für die Kategorie ein.');
  }
  if (data.name && data.name.length > 50) {
    errors.push('Der Kategorie-Name darf maximal 50 Zeichen lang sein.');
  }

  // Farbe muss ein gültiger Hex-Code sein
  if (data.color && !/^#[0-9A-Fa-f]{6}$/.test(data.color)) {
    errors.push('Ungültige Farbe. Erwartet: Hex-Code wie #FF5733.');
  }

  return errors;
}

// --------------------------------------------------------
// Text bereinigen (XSS-Schutz)
// --------------------------------------------------------
// XSS = Cross-Site Scripting. Jemand gibt als Ausgaben-Name
// ein: <script>stealCookies()</script>
// Ohne Bereinigung würde das als HTML ausgeführt werden.
function sanitize(text) {
  if (typeof text !== 'string') return text;
  return validator.escape(text.trim());
  // escape() wandelt < > " ' & in ungefährliche HTML-Entities um:
  // < wird zu &lt;
  // > wird zu &gt;
  // Das Script wird dann nur als Text angezeigt, nicht ausgeführt.
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

module.exports = {
  validateRegistration,
  validateLogin,
  validateExpense,
  validateIncome,
  validateCategory,
  validateReminder,
  validateNote,
  sanitize,
};
