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
  '/api/passwords': { passwords: Array.from({ length: 14 }, (_, i) => ({
    id: 'p' + i,
    name: ['Netflix', 'GitHub', 'Amazon', 'Spotify', 'PayPal', 'Gmail', 'Hetzner', 'Strato', 'Ebay', 'Steam', 'Discord', 'Reddit', 'LinkedIn', 'Dropbox'][i],
    username: 'michael@test.de',
    password: 'Geheim' + i + '234!',
    website: 'https://example-' + i + '.com',
    notes: '',
    vaultId: null,
    createdAt: '2026-06-01T00:00:00.000Z',
  })) },
  '/api/servers': { servers: [] },
  '/api/reminders/upcoming': { reminders: [] },
  '/api/reminders': { reminders: [] },
  '/api/expenses': { expenses: [] },
  '/api/income': { incomes: [] },
  '/api/share': { shares: [] },
  '/api/notes': { notes: [] },
  '/api/categories': { categories: [
    { id: 'c1', name: 'Wohnen & Grund', color: '#FF9500', _count: { expenses: 0 } },
    { id: 'c2', name: 'Lebensmittel', color: '#34C759', _count: { expenses: 0 } },
  ] },
  '/api/admin/stats': { userCount: 1, newestUser: { name: 'Michael Test', createdAt: '2026-01-01T00:00:00.000Z' } },
  '/api/admin/users': { users: [
    { ...USER, suspended: false, _count: { categories: 0, expenses: 0, incomes: 0, reminders: 0 } },
    { id: 'user-2', email: 'lena@test.de', name: 'Lena Beispiel', role: 'user', suspended: false, createdAt: '2026-05-10T00:00:00.000Z', _count: { categories: 9, expenses: 4, incomes: 2, reminders: 1 } },
  ] },
  '/api/admin/users/user-2/reset-link': { message: 'Reset-Link erstellt.', token: 'deadbeef'.repeat(8), expiresAt: '2026-07-16T12:00:00.000Z' },
  '/api/fotos/library': { generatedAt: '2026-08-06T12:00:00.000Z', photoCount: 74, persons: ['Lena', 'Michael'],
    // Zwei Beispiel-Events (fotob0x Etappe 6) für die Event-Gruppierung in
    // "Alle Fotos" - Asset-IDs müssen zu den unten generierten Fotos passen
    // (Monat 2026-08 → IDs 4979-5000, Monat 2026-07 → IDs 4961-4978).
    events: [
      { n: 'Wochenendtrip an den Königssee', s: '2026-08-20T09:00:00', e: '2026-08-23T20:00:00', ids: [4995, 4994, 4993, 4992] },
      { n: 'Grillabend im Garten', s: '2026-07-16T15:00:00', e: '2026-07-16T21:00:00', ids: [4967, 4966, 4965] },
    ],
    // Alben (2026-08-07) für die Album-Auswahl in "Alle Fotos"
    albums: [
      { n: 'Beste Aufnahmen 2026', ids: [5000, 4998, 4990, 4975, 4960] },
      { n: 'Königssee', ids: [4995, 4994, 4993, 4992, 4991] },
    ],
    photos: (function() {
    // 74 Fake-Fotos über 5 Monate (neueste zuerst), IDs wie im echten Mirror;
    // einige mit benannten Personen für den Personen-Filter
    const months = ['2026-08', '2026-07', '2026-05', '2025-12', 'unbekannt'];
    const counts = [22, 18, 15, 12, 7];
    const photos = [];
    let id = 5000;
    months.forEach((m, mi) => {
      for (let i = 0; i < counts[mi]; i++) {
        const entry = { n: (id--) + '.jpg', d: m === 'unbekannt' ? null : m + '-' + String(28 - i).padStart(2, '0') + 'T12:00:00' };
        if (i % 4 === 0) entry.p = ['Michael'];
        else if (i % 4 === 1) entry.p = ['Lena', 'Michael'];
        // KI-Bildunterschriften (fotob0x Paket 5) für die Textsuche
        if (i % 3 === 0) entry.c = ['Sonnenuntergang über einem ruhigen Bergsee',
          'Zwei Wanderer rasten auf einem Felsvorsprung',
          'Festlich gedeckter Tisch im Garten'][i % 3 === 0 ? (i / 3) % 3 : 0];
        photos.push(entry);
      }
    });
    return photos;
  })() },
  '/api/fotos/upload/status': { ready: true, freeBytes: 62 * 1024 * 1024 * 1024, files: [
    { name: 'DSC00123.ARW', size: 42 * 1024 * 1024, mtime: '2026-08-07T09:12:00.000Z' },
    { name: 'IMG_2210.jpg', size: 3.4 * 1024 * 1024, mtime: '2026-08-07T09:10:00.000Z' },
  ] },
  '/api/fotos': { albums: [
    { token: 'aB3dEfGh1jKlMnOpQrStUvWx', title: 'Sommerurlaub Kroatien 2026', photoCount: 87, sharedAt: '2026-08-06T10:30:00.000Z', thumb: 'IMG_0001.jpg' },
    { token: 'zY9xWvUtSrQpOnMlKjIhGfEd', title: 'Nicoles Geburtstag', photoCount: 23, sharedAt: '2026-07-21T18:05:00.000Z', thumb: 'IMG_0042.jpg' },
    { token: 'Qq1Ww2Ee3Rr4Tt5Zz6Uu7Ii8', title: 'Wanderung Zugspitze', photoCount: 1, sharedAt: '2026-06-02T09:00:00.000Z', thumb: null },
  ] },
};

const PAGES = {
  '/': '/landing/index.html',
  '/portal': '/portal/index.html',
  '/portal/profil': '/portal/profil.html',
  '/app/passwords': '/apps/passwords/index.html',
  '/app/servers': '/apps/servers/index.html',
  '/app/admin': '/apps/admin/index.html',
  '/app/finanzen': '/apps/finanzen/index.html',
  '/app/fotos': '/apps/fotos/index.html',
  '/app/notizen': '/apps/notizen/index.html',
  '/s': '/share/index.html',
  '/impressum': '/legal/impressum.html',
  '/datenschutz': '/legal/datenschutz.html',
};

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain' };

http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // Private Bibliotheksbilder (auf Prod von der Node-App gestreamt) → Platzhalter
  if (url.startsWith('/api/fotos/library/img/') || url.startsWith('/api/fotos/library/thumb/')) {
    const hue = (parseInt(url.replace(/\D/g, ''), 10) * 37) % 360;
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">'
      + '<rect width="400" height="400" fill="hsl(' + hue + ',30%,25%)"/>'
      + '<circle cx="140" cy="120" r="34" fill="hsl(' + hue + ',60%,70%)"/>'
      + '<path d="M0 400 L150 220 L260 320 L330 250 L400 340 L400 400 Z" fill="hsl(' + hue + ',25%,35%)"/>'
      + '</svg>');
  }

  if (url.startsWith('/api/')) {
    const body = API[url] || {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(body));
  }

  // Galerie-Thumbnails (auf Prod von nginx) → Platzhalter-Bild
  if (url.startsWith('/fotos/')) {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400">'
      + '<rect width="640" height="400" fill="#2a2f3a"/>'
      + '<circle cx="230" cy="150" r="40" fill="#f9d977"/>'
      + '<path d="M0 400 L220 210 L390 330 L500 240 L640 360 L640 400 Z" fill="#3d4657"/>'
      + '</svg>');
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
