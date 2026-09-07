// ============================================================
// ALTDATEN-TEXT — doppeltes HTML-Escaping wieder auflösen
// ============================================================
// Bis 2026-09-07 hat `sanitize()` Nutzertext mit validator.escape() in
// HTML-Entities umgewandelt, BEVOR er verschlüsselt in die Datenbank ging.
// Das war Escaping auf der falschen Ebene: die Frontends escapen beim
// Anzeigen ohnehin selbst, der Server rendert nie HTML. Ergebnis war eine
// doppelt escapte Anzeige — aus der Kategorie "Haushalt & Garten" wurde für
// den Nutzer sichtbar "Haushalt &amp; Garten", aus "Müller's" wurde
// "Müller&#x27;s". Im PDF- und DSGVO-Export stand derselbe Unsinn.
//
// `sanitize()` escaped seitdem nicht mehr. Damit auch die BEREITS
// gespeicherten Einträge wieder richtig aussehen, werden genau die Felder,
// die früher durch sanitize() liefen, beim Lesen einmal durch unescape()
// geschickt. Auf sauberem neuen Text ist das ein No-Op.
//
// EINSCHRÄNKUNG: Wer wirklich die Zeichenfolge "&amp;" als Text speichert,
// bekommt sie als "&" zurück. Das ist der Preis dafür, Bestandsdaten ohne
// Migration zu reparieren — verschlüsselte Felder lassen sich per SQL nicht
// anfassen. Betrifft nur Text, den ein Mensch als Name eintippt.
//
// NUR auf ehemals sanitizte Felder anwenden:
//   Category.name, Expense.name, Expense.tags, Income.name,
//   Reminder.note, StoredPassword.name, Note.title
// NICHT auf Passwörter, Notiz-Inhalte, Server-Felder oder Tresornamen —
// die liefen nie durch sanitize() und würden hier verfälscht.
// ============================================================

const validator = require('validator');

/** Doppeltes HTML-Escaping aus Altdaten entfernen. */
function entschaerfe(text) {
  if (typeof text !== 'string') return text;
  return validator.unescape(text);
}

/** Wie entschaerfe(), aber für ein Array (z.B. Tags). */
function entschaerfeListe(werte) {
  return Array.isArray(werte) ? werte.map(entschaerfe) : werte;
}

module.exports = { entschaerfe, entschaerfeListe };
