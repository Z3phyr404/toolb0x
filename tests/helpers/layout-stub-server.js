// ============================================================
// LAYOUT-STUB-SERVER — nur für lokale UI-/Layout-Checks
// ============================================================
// Auf diesem Rechner gibt es keine lokale Postgres/.env, der echte
// Server kann also nicht starten. Dieser Stub serviert public/ mit
// ersetztem CSP-Nonce und fakt die API-Antworten, damit sich die
// Frontends im Browser rendern lassen (Layout, CSS, Interaktionen).
//
// Start:  node tests/helpers/layout-stub-server.js   (Port 3999)
// Hinweis: session-timeout.js erkennt "Browser-Neustart" — vor dem
// ersten Aufruf im Tab einmal ausführen:
//   sessionStorage.setItem('toolbox_active', '1')
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'public');
const PORT = 3999;

const USER = { id: 'stub-user-id', email: 'michael@test.de', name: 'Michael Test', role: 'admin', createdAt: '2026-01-01T00:00:00.000Z' };

const API = {
  '/api/auth/me': { user: { ...USER, hasRecoveryCode: true } },
  '/api/auth/register': { message: 'Konto erfolgreich erstellt!', user: USER, recoveryCode: 'AB2C-DE3F-GH4J-KM5N-PQ6R-ST7U' },
  '/api/auth/reset-password': { message: 'Passwort zurückgesetzt.' },
  '/api/auth/reset-with-token': { message: 'Passwort zurückgesetzt.', recoveryCode: 'AB2C-DE3F-GH4J-KM5N-PQ6R-ST7U' },
  '/api/auth/recovery-code': { message: 'Neuer Recovery-Code erstellt.', recoveryCode: 'AB2C-DE3F-GH4J-KM5N-PQ6R-ST7U' },
  '/api/vaults': { vaults: [] },
  '/api/passwords': { passwords: [
    { id: 'p1', name: 'Netflix', username: 'michael@test.de', password: 'Geheim1234!', website: 'https://netflix.com', notes: '', vaultId: null, createdAt: '2026-06-01T00:00:00.000Z' },
    { id: 'p2', name: 'GitHub', username: 'z3phyr', password: 'NochGeheimer99!', website: 'https://github.com', notes: '', vaultId: null, createdAt: '2026-06-02T00:00:00.000Z' },
  ] },
  '/api/servers': { servers: [] },
  '/api/reminders/upcoming': { reminders: [] },
  '/api/share': { shares: [] },
  '/api/notes': { notes: [] },
  '/api/categories': { categories: [] },
  '/api/admin/stats': { userCount: 1, newestUser: { name: 'Michael Test', createdAt: '2026-01-01T00:00:00.000Z' } },
  '/api/admin/users': { users: [
    { ...USER, suspended: false, _count: { categories: 0, expenses: 0, incomes: 0, reminders: 0 } },
    { id: 'user-2', email: 'lena@test.de', name: 'Lena Beispiel', role: 'user', suspended: false, createdAt: '2026-05-10T00:00:00.000Z', _count: { categories: 9, expenses: 4, incomes: 2, reminders: 1 } },
  ] },
  '/api/admin/users/user-2/reset-link': { message: 'Reset-Link erstellt.', token: 'deadbeef'.repeat(8), expiresAt: '2026-07-16T12:00:00.000Z' },
};

const PAGES = {
  '/': '/landing/index.html',
  '/portal': '/portal/index.html',
  '/portal/profil': '/portal/profil.html',
  '/app/passwords': '/apps/passwords/index.html',
  '/app/servers': '/apps/servers/index.html',
  '/app/admin': '/apps/admin/index.html',
  '/app/finanzen': '/apps/finanzen/index.html',
  '/app/notizen': '/apps/notizen/index.html',
  '/s': '/share/index.html',
};

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml' };

http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url.startsWith('/api/')) {
    const body = API[url] || {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(body));
  }

  const file = PAGES[url] || url;
  const full = path.join(ROOT, file);
  if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404); return res.end('not found: ' + url);
  }
  let content = fs.readFileSync(full);
  const ext = path.extname(full);
  if (ext === '.html') content = content.toString().replaceAll('__CSP_NONCE__', 'dev');
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(content);
}).listen(PORT, () => console.log('Layout-Stub läuft auf http://localhost:' + PORT));
