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
const { setupSecurity } = require('./src/middleware/security');

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('❌ FEHLER: JWT_SECRET nicht gesetzt oder zu kurz!');
  console.error('   Generiere mit: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cookieParser());
setupSecurity(app);

// Statische Dateien: Portal
app.use('/portal', express.static(path.join(__dirname, 'public', 'portal'), { etag: true }));

// Statische Dateien: Finanz-App
app.use('/app/finanzen', express.static(path.join(__dirname, 'public', 'apps', 'finanzen'), { etag: true }));

// Gemeinsame Assets (CSS, Fonts, etc.)
app.use('/shared', express.static(path.join(__dirname, 'public', 'shared'), { etag: true }));

// ============================================================
// API-ROUTEN
// ============================================================
const authRoutes = require('./src/routes/auth');
const categoryRoutes = require('./src/routes/categories');
const expenseRoutes = require('./src/routes/expenses');
const incomeRoutes = require('./src/routes/income');

app.use('/api/auth', authRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/income', incomeRoutes);

// ============================================================
// FRONTEND-ROUTING
// ============================================================

// Root → Portal
app.get('/', (req, res) => res.redirect('/portal'));

// Portal SPA-Fallback
app.get('/portal', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'portal', 'index.html'));
});

// Finanz-App SPA-Fallback
app.get('/app/finanzen', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'apps', 'finanzen', 'index.html'));
});

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

app.listen(PORT, () => {
  console.log(`\n🚀 Tool-Portal läuft auf http://localhost:${PORT}`);
  console.log(`📊 Portal:      http://localhost:${PORT}/portal`);
  console.log(`💰 Finanz-App:  http://localhost:${PORT}/app/finanzen`);
  console.log(`📡 API:         http://localhost:${PORT}/api`);
  console.log(`🔒 Umgebung:    ${process.env.NODE_ENV || 'development'}\n`);
});
