// ============================================================
// TOOL-PORTAL — Hauptserver
// ============================================================
// Architektur:
//   /              → Weiterleitung zum Portal
//   /portal        → Tool-Übersicht (übergeordnete Startseite)
//   /app/finanzen  → Finanz-App
//   /app/xxx       → Zukünftige Tools
//   /api/...       → Backend-API
//
// Der Login ist zentral — einmal einloggen, alle Tools nutzen.
// ============================================================

require('dotenv').config();

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const { setupSecurity } = require('./src/middleware/security');

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('❌ FEHLER: JWT_SECRET nicht gesetzt oder zu kurz!');
  console.error('   Generiere mit: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
// Nur localhost: nach außen spricht ausschließlich nginx (proxy_pass auf
// 127.0.0.1:3000). Die Firewall blockt 3000 zwar auch, das hier ist die
// zweite Sicherung. HOST=0.0.0.0 nur, wenn wirklich nötig (z. B. Docker).
const HOST = process.env.HOST || '127.0.0.1';

// ============================================================
// NONCE-INJECTION — Für CSP-sichere Inline-Scripts
// ============================================================
function serveHtmlWithNonce(filePath) {
  return (req, res) => {
    fs.readFile(filePath, 'utf8', (err, html) => {
      if (err) return res.status(500).send('Fehler beim Laden der Seite.');
      const nonced = html.replace(/__CSP_NONCE__/g, res.locals.cspNonce);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(nonced);
    });
  };
}

// Middleware
app.use(cookieParser());
setupSecurity(app);

// Statische Dateien: Portal (nur CSS/JS/Bilder, kein HTML)
app.use('/portal', express.static(path.join(__dirname, 'public', 'portal'), {
  etag: true,
  index: false,
}));

// Statische Dateien: Finanz-App (nur CSS/JS/Bilder, kein HTML)
app.use('/app/finanzen', express.static(path.join(__dirname, 'public', 'apps', 'finanzen'), {
  etag: true,
  index: false,
}));

// Statische Dateien: Admin-Bereich (nur CSS/JS/Bilder, kein HTML)
app.use('/app/admin', express.static(path.join(__dirname, 'public', 'apps', 'admin'), {
  etag: true,
  index: false,
}));

// Statische Dateien: Notizen-App (nur CSS/JS/Bilder, kein HTML)
app.use('/app/notizen', express.static(path.join(__dirname, 'public', 'apps', 'notizen'), {
  etag: true,
  index: false,
}));

// Statische Dateien: Passwort-Manager (nur CSS/JS/Bilder, kein HTML)
app.use('/app/passwords', express.static(path.join(__dirname, 'public', 'apps', 'passwords'), {
  etag: true,
  index: false,
}));

// Statische Dateien: Server-Verwaltung (nur CSS/JS/Bilder, kein HTML)
app.use('/app/servers', express.static(path.join(__dirname, 'public', 'apps', 'servers'), {
  etag: true,
  index: false,
}));

// Statische Dateien: Fotos-Übersicht (nur CSS/JS/Bilder, kein HTML)
app.use('/app/fotos', express.static(path.join(__dirname, 'public', 'apps', 'fotos'), {
  etag: true,
  index: false,
}));

// Statische Dateien: Hermes-Chat (nur CSS/JS/Bilder, kein HTML)
app.use('/app/hermes', express.static(path.join(__dirname, 'public', 'apps', 'hermes'), {
  etag: true,
  index: false,
}));

// Statische Dateien: Öffentliche Share-Seite (nur Assets, HTML via Nonce)
app.use('/s', express.static(path.join(__dirname, 'public', 'share'), {
  etag: true,
  index: false,
}));

// Gemeinsame Assets (CSS, Fonts, etc.)
// Schriften ändern sich praktisch nie → lange cachen (muss VOR /shared stehen)
app.use('/shared/fonts', express.static(path.join(__dirname, 'public', 'shared', 'fonts'), {
  etag: true,
  immutable: true,
  maxAge: '1y',
}));
app.use('/shared', express.static(path.join(__dirname, 'public', 'shared'), { etag: true }));

// ============================================================
// API-ROUTEN
// ============================================================
const authRoutes = require('./src/routes/auth');
const categoryRoutes = require('./src/routes/categories');
const expenseRoutes = require('./src/routes/expenses');
const incomeRoutes = require('./src/routes/income');
const exportRoutes = require('./src/routes/export');
const reminderRoutes = require('./src/routes/reminders');
const adminRoutes = require('./src/routes/admin');
const noteRoutes = require('./src/routes/notes');
const passwordRoutes = require('./src/routes/passwords');
const serverRoutes = require('./src/routes/servers');
const fotoRoutes = require('./src/routes/fotos');
const shareRoutes = require('./src/routes/share');
const vaultRoutes = require('./src/routes/vaults');
const hermesRoutes = require('./src/routes/hermes');
const integrationRoutes = require('./src/routes/integrations');

app.use('/api/auth', authRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/income', incomeRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/reminders', reminderRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/notes', noteRoutes);
app.use('/api/passwords', passwordRoutes);
app.use('/api/servers', serverRoutes);
app.use('/api/fotos', fotoRoutes);
app.use('/api/share', shareRoutes);
app.use('/api/vaults', vaultRoutes);
app.use('/api/hermes', hermesRoutes);
// Verwaltung des Hermes-Zugangs (angemeldet). Der Zugang selbst läuft
// über einen eigenen, nur lokalen Listener — siehe unten.
app.use('/api/integrations', integrationRoutes);

// ============================================================
// FRONTEND-ROUTING
// ============================================================

// Root → direkt zur Anmeldung. Eine Landing Page gibt es seit 2026-10-10
// nicht mehr: privates Projekt, Konten nur per Einladungslink.
app.get('/', (req, res) => res.redirect(302, '/portal'));

// Portal
app.get('/portal', serveHtmlWithNonce(
  path.join(__dirname, 'public', 'portal', 'index.html')
));

// Profil-Seite
app.get('/portal/profil', serveHtmlWithNonce(
  path.join(__dirname, 'public', 'portal', 'profil.html')
));

// Finanz-App
app.get('/app/finanzen', serveHtmlWithNonce(
  path.join(__dirname, 'public', 'apps', 'finanzen', 'index.html')
));

// Admin-Bereich
app.get('/app/admin', serveHtmlWithNonce(
  path.join(__dirname, 'public', 'apps', 'admin', 'index.html')
));

// Notizen-App
app.get('/app/notizen', serveHtmlWithNonce(
  path.join(__dirname, 'public', 'apps', 'notizen', 'index.html')
));

// Passwort-Manager
app.get('/app/passwords', serveHtmlWithNonce(
  path.join(__dirname, 'public', 'apps', 'passwords', 'index.html')
));

// Server-Verwaltung
app.get('/app/servers', serveHtmlWithNonce(
  path.join(__dirname, 'public', 'apps', 'servers', 'index.html')
));

// Fotos-Übersicht (nur für Admins, HTML mit Nonce)
app.get('/app/fotos', serveHtmlWithNonce(
  path.join(__dirname, 'public', 'apps', 'fotos', 'index.html')
));

// Hermes-Chat (nur für Admins, HTML mit Nonce)
app.get('/app/hermes', serveHtmlWithNonce(
  path.join(__dirname, 'public', 'apps', 'hermes', 'index.html')
));

// Öffentliche Share-Seite (KEIN Login, KEIN Portal-Redirect)
app.get('/s', serveHtmlWithNonce(
  path.join(__dirname, 'public', 'share', 'index.html')
));

// 404 für API
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'API-Route nicht gefunden.' });
});

// Fehler-Handler
app.use((err, req, res, next) => {
  console.error('Unbehandelter Fehler:', err);
  const message = process.env.NODE_ENV === 'production'
    ? 'Ein interner Fehler ist aufgetreten.'
    : err.message;
  res.status(500).json({ error: message });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`\n🚀 Tool-Portal läuft auf http://localhost:${PORT}`);
  console.log(`📊 Portal:      http://localhost:${PORT}/portal`);
  console.log(`💰 Finanz-App:  http://localhost:${PORT}/app/finanzen`);
  console.log(`📡 API:         http://localhost:${PORT}/api`);
  console.log(`🔔 Erinnerungen: http://localhost:${PORT}/api/reminders`);
  console.log(`🔧 Admin:        http://localhost:${PORT}/app/admin`);
  console.log(`📝 Notizen:      http://localhost:${PORT}/app/notizen`);
  console.log(`🔐 Passwörter:   http://localhost:${PORT}/app/passwords`);
  console.log(`🖥️  Server:       http://localhost:${PORT}/app/servers`);
  console.log(`📷 Fotos:        http://localhost:${PORT}/app/fotos`);
  console.log(`☤  Hermes:       http://localhost:${PORT}/app/hermes`);
  console.log(`🔗 Share:        http://localhost:${PORT}/s`);
  console.log(`🔒 Umgebung:    ${process.env.NODE_ENV || 'development'}\n`);
});

// Foto-Uploads (roher Stream, /api/fotos/upload): Nodes Standard-requestTimeout
// (300 s) würde einen 1-GB-Upload über langsames WLAN abbrechen, BEVOR die
// 600 s aus nginx (deploy/nginx-fotos.conf) greifen. Wert bewusst über dem
// nginx-Timeout, damit immer nginx zuerst sauber abbricht.
server.requestTimeout = 660_000;

// Lokaler Integrations-Listener für Hermes (2026-10-11): eigener Port,
// IMMER 127.0.0.1, von nginx nicht erreichbar (proxy_pass zeigt nur auf
// PORT). INTEGRATION_PORT=0 schaltet ihn ab. Doku: docs/hermes-integration.md
require('./src/integration/app').startIntegrationServer();