// ============================================================
// MINIMALE TEST-APP
// ============================================================
// Express-App ohne Helmet, CORS, Rate-Limiting etc.
// Nur das Nötigste für Route-Tests.
// ============================================================

const express = require('express');
const cookieParser = require('cookie-parser');

/**
 * Erstellt eine minimale Express-App mit den angegebenen Routen.
 * @param  {...{ path: string, router: express.Router }} routes
 * @returns {express.Application}
 */
function createTestApp(...routes) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  for (const { path, router } of routes) {
    app.use(path, router);
  }
  return app;
}

module.exports = { createTestApp };
