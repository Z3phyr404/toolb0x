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
          scriptSrc: ["'self'", `'nonce-${res.locals.cspNonce}'`, "'unsafe-hashes'"],
          scriptSrcAttr: ["'unsafe-hashes'"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
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
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  };
  app.use(cors(corsOptions));

  // 3. RATE LIMITING
  const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
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

  // 4. HPP
  app.use(hpp());

  // 5. Body-Parser Limits
  const express = require('express');
  app.use(express.json({ limit: '10kb' }));
  app.use(express.urlencoded({ extended: false, limit: '10kb' }));
}

module.exports = { setupSecurity };
