// ============================================================
// SESSION-TIMEOUT — Automatisches Logout bei Inaktivität
// ============================================================
// - Logout nach 20 Minuten ohne Benutzerinteraktion
// - Logout beim Schließen des Browsers (sessionStorage-Check)
//
// sessionStorage wird beim Schließen des Browsers IMMER gelöscht,
// auch wenn Chrome "Dort weitermachen..." aktiviert hat.
// Beim nächsten Seitenaufruf fehlt das Flag → Logout.
// ============================================================

(function () {
  'use strict';

  const TIMEOUT_MS = 20 * 60 * 1000; // 20 Minuten
  const API = '/api';
  const SESSION_KEY = 'toolbox_active';

  let timeoutId = null;
  let logoutCallback = null;

  // ── Inaktivitäts-Timer ──────────────────────────────────

  function resetTimer() {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(onTimeout, TIMEOUT_MS);
  }

  function onTimeout() {
    // Session serverseitig beenden
    fetch(API + '/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
    stopTracking();
    if (logoutCallback) logoutCallback();
  }

  // ── Aktivitäts-Erkennung ────────────────────────────────

  const EVENTS = ['mousedown', 'keydown', 'scroll', 'touchstart'];

  function startTracking() {
    EVENTS.forEach(function (evt) {
      document.addEventListener(evt, resetTimer, { passive: true });
    });
    resetTimer();
  }

  function stopTracking() {
    EVENTS.forEach(function (evt) {
      document.removeEventListener(evt, resetTimer);
    });
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }

  // ── Öffentliche API ─────────────────────────────────────

  window.SessionTimeout = {
    /**
     * Tracking starten (nach erfolgreichem Login aufrufen).
     * Setzt sessionStorage-Flag, damit Browser-Neustart erkannt wird.
     */
    start: function (onLogout) {
      logoutCallback = onLogout;
      sessionStorage.setItem(SESSION_KEY, '1');
      startTracking();
    },

    /** Tracking stoppen (bei manuellem Logout aufrufen). */
    stop: function () {
      stopTracking();
      sessionStorage.removeItem(SESSION_KEY);
      logoutCallback = null;
    },

    /**
     * Prüft, ob der Browser geschlossen und neu geöffnet wurde.
     * Gibt true zurück, wenn die Session ungültig ist (kein sessionStorage-Flag).
     * In dem Fall wird die serverseitige Session automatisch beendet.
     */
    wasRestarted: function () {
      return !sessionStorage.getItem(SESSION_KEY);
    },
  };
})();
