// ============================================================
// SICHERHEITS-MIDDLEWARE
// ============================================================

const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const hpp = require('hpp');
const crypto = require('crypto');

function setupSecurity(app) {

  // 1. HELMET — Sichere HTTP-Header mit Nonce-Unterstützung
  app.use((req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", `'nonce-${res.locals.cspNonce}'`],
          // Schriften liegen lokal (public/shared/fonts) — kein Google mehr,
          // daher braucht weder style-src noch font-src eine externe Quelle.
          // Das ist zugleich DSGVO-relevant: keine IP-Abflüsse an Dritte.
          styleSrc: ["'self'", `'nonce-${res.locals.cspNonce}'`],
          // Inline style="..."-Attribute erlauben (Glow-Blobs, Layout, Akzentfarben).
          // Muss ein eigenes style-src-attr sein: In styleSrc würde 'unsafe-inline'
          // wegen des Nonce vom Browser ignoriert. script-src bleibt strikt nonce-basiert.
          styleSrcAttr: ["'unsafe-inline'"],
          fontSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          // Explizit gesetzt (Helmet-Defaults, hier sichtbar gemacht):
          // verhindert <base>-Hijacking, Form-Exfiltration, Plugins, Framing
          baseUri: ["'self'"],
          formAction: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'self'"],
        },
      },
    })(req, res, next);
  });

  // 2. CORS
  const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000')
    .split(',')
    .map(o => o.trim());

  const corsOptions = {
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('CORS: Origin nicht erlaubt.'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
    maxAge: 86400,
  };
  app.use(cors(corsOptions));

  // 3. RATE LIMITING
  // Das generelle Limit gilt PRO IP — hinter einer NAT (Familie, Büro) teilen
  // sich alle Nutzer dasselbe Budget. Normale Nutzung ist API-intensiv
  // (Seitenaufruf ~5 Calls, jedes Speichern ~5), deshalb großzügig: 100 wären
  // schon bei ~20 Ausgaben in 15 Min erschöpft. Die wirklich sensiblen
  // Endpunkte (Login, Register, Reset, Konto) haben eigene, enge Limits.
  const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_GENERAL) || 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Zu viele Anfragen. Bitte warte einen Moment.' },
  });
  app.use('/api/', generalLimiter);

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_LOGIN) || 10,
    message: { error: 'Zu viele Login-Versuche. Bitte warte 15 Minuten.' },
    skipSuccessfulRequests: false,
  });
  app.use('/api/auth/login', loginLimiter);

  const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { error: 'Zu viele Registrierungen. Bitte versuche es später.' },
  });
  app.use('/api/auth/register', registerLimiter);

  // Passwort-Reset (öffentlich): streng limitieren gegen
  // Brute-Force auf Recovery-Codes und Reset-Tokens
  const resetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { errors: ['Zu viele Versuche. Bitte warte 15 Minuten.'] },
  });
  app.use('/api/auth/reset-password', resetLimiter);
  app.use('/api/auth/reset-with-token', resetLimiter);

  // Sensitive Endpunkte: strengeres Rate-Limit.
  // WICHTIG: Jeder Endpunkt braucht eine EIGENE Limiter-Instanz. Teilt man
  // eine Instanz über mehrere app.use(), zählen alle Pfade auf denselben
  // Zähler — dann sperrt z.B. mehrmaliges Profil-Speichern die Konto-Löschung.
  function sensitiveLimiter(max) {
    return rateLimit({
      windowMs: 15 * 60 * 1000,
      max,
      message: { errors: ['Zu viele Versuche. Bitte warte einen Moment.'] },
    });
  }
  // Profil darf man öfter speichern (Tippfehler, mehrere Anläufe) …
  app.use('/api/auth/profile', sensitiveLimiter(15));
  // … Passwort ändern und Konto löschen bleiben eng.
  app.use('/api/auth/password', sensitiveLimiter(5));
  app.use('/api/auth/account', sensitiveLimiter(5));

  // 4. HPP
  app.use(hpp());

  // 5. Body-Parser Limits
  // /api/notes ist ausgenommen: Notizen (WYSIWYG-HTML) brauchen mehr Platz,
  // der Notes-Router hat seinen eigenen Parser mit 500kb-Limit.
  const express = require('express');
  const jsonParser = express.json({ limit: '10kb' });
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/notes')) return next();
    jsonParser(req, res, next);
  });
  app.use(express.urlencoded({ extended: false, limit: '10kb' }));

  // 6. CSRF-Schutz (Double-Submit-Cookie-Pattern)
  // Bei jeder Antwort wird ein CSRF-Token als Cookie gesetzt.
  // State-changing Requests müssen dieses Token im Header mitschicken.
  app.use((req, res, next) => {
    // Token generieren falls noch nicht vorhanden
    if (!req.cookies?.csrf_token) {
      const csrfToken = crypto.randomBytes(32).toString('hex');
      res.cookie('csrf_token', csrfToken, {
        httpOnly: false,    // JS muss darauf zugreifen können
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',
      });
    }

    // GET/HEAD/OPTIONS sind safe — kein CSRF-Check nötig
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return next();
    }

    // Login und Register sind ausgenommen (noch kein Token vorhanden)
    if (req.path === '/api/auth/login' || req.path === '/api/auth/register') {
      return next();
    }

    // Nur API-Routen prüfen
    if (!req.path.startsWith('/api/')) {
      return next();
    }

    const cookieToken = req.cookies?.csrf_token;
    const headerToken = req.headers['x-csrf-token'];

    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
      return res.status(403).json({ error: 'CSRF-Token ungültig.' });
    }

    next();
  });
}

module.exports = { setupSecurity };
