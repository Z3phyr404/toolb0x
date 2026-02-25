// ============================================================
// SESSION-STORE — Encryption Keys sicher im RAM
// ============================================================
// PROBLEM VORHER:
// Der Encryption Key war im JWT-Cookie gespeichert und reiste
// bei JEDER Anfrage über das Netzwerk. JWTs sind nur Base64-
// kodiert, nicht verschlüsselt. Jeder der den Cookie abfängt,
// hat den Key.
//
// LÖSUNG:
// Der Key bleibt serverseitig im RAM (in einer Map).
// Das JWT enthält nur noch eine Session-ID.
// Der Key verlässt den Server NIE.
//
// ABLAUF:
// 1. Login → Key entschlüsseln → Session-ID generieren
//    → Key in Map speichern → Session-ID ins JWT
// 2. API-Call → JWT prüfen → Session-ID extrahieren
//    → Key aus Map holen → Daten ver-/entschlüsseln
// 3. Logout → Session aus Map löschen → sofort ungültig
//
// HINWEIS: Bei Server-Neustart gehen alle Sessions verloren
// (alle User müssen sich neu einloggen). Das ist gewollt —
// es ist sicherer als Sessions auf der Festplatte zu speichern.
// Für eine Produktionsumgebung mit mehreren Servern würde man
// Redis verwenden.
// ============================================================

const crypto = require('crypto');

class SessionStore {
  constructor() {
    // Map: sessionId → { userId, encryptionKey, createdAt }
    this.sessions = new Map();

    // Abgelaufene Sessions alle 15 Minuten aufräumen
    this.cleanupInterval = setInterval(() => this.cleanup(), 15 * 60 * 1000);

    // Session-Lebensdauer: 24 Stunden (muss mit JWT expiresIn übereinstimmen)
    this.maxAge = 24 * 60 * 60 * 1000;
  }

  /**
   * Erstellt eine neue Session.
   * @returns {string} Session-ID (zufällige 32 Bytes, hex-kodiert)
   */
  create(userId, encryptionKey) {
    const sessionId = crypto.randomBytes(32).toString('hex');
    this.sessions.set(sessionId, {
      userId,
      encryptionKey,  // Buffer — bleibt im RAM
      createdAt: Date.now(),
    });
    return sessionId;
  }

  /**
   * Holt eine Session.
   * @returns {{ userId, encryptionKey }} oder null
   */
  get(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Abgelaufen?
    if (Date.now() - session.createdAt > this.maxAge) {
      this.sessions.delete(sessionId);
      return null;
    }

    return session;
  }

  /**
   * Löscht eine einzelne Session (Logout).
   */
  delete(sessionId) {
    this.sessions.delete(sessionId);
  }

  /**
   * Löscht ALLE Sessions eines Users (z.B. nach Passwort-Änderung).
   */
  deleteAllForUser(userId) {
    for (const [sid, session] of this.sessions) {
      if (session.userId === userId) {
        this.sessions.delete(sid);
      }
    }
  }

  /**
   * Räumt abgelaufene Sessions auf.
   */
  cleanup() {
    const now = Date.now();
    let removed = 0;
    for (const [sid, session] of this.sessions) {
      if (now - session.createdAt > this.maxAge) {
        this.sessions.delete(sid);
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`🧹 ${removed} abgelaufene Session(s) aufgeräumt.`);
    }
  }

  /**
   * Anzahl aktiver Sessions (für Monitoring).
   */
  get size() {
    return this.sessions.size;
  }

  /**
   * Stoppt den Cleanup-Timer (für Tests / Shutdown).
   */
  destroy() {
    clearInterval(this.cleanupInterval);
    this.sessions.clear();
  }
}

// Singleton — eine Instanz für die gesamte App
const sessionStore = new SessionStore();

module.exports = sessionStore;
