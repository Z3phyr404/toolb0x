# CLAUDE.md — Toolb0x Projektgedächtnis

Dieses Dokument ist die zentrale Wissensdatei für alle KI-Assistenten. Vor jeder Arbeit am Projekt lesen und beachten.

---

## Projektübersicht

**Toolb0x** ist ein persönliches, verschlüsseltes Tool-Portal mit iOS 26 Liquid Glass Design.
- Einmalige Anmeldung im Portal → Zugang zu allen Tools (shared cookie auth)
- Zero-Knowledge-Verschlüsselung: Alle Nutzerdaten sind mit AES-256-GCM verschlüsselt, bevor sie in die DB kommen
- Privates Einzelnutzer-Projekt (kein Multi-Tenant im öffentlichen Sinne, aber Multi-User-fähig)

**Stack:** Node.js + Express, PostgreSQL, Prisma ORM, Vanilla JS Frontend (kein Framework)

---

## Dateistruktur

```
toolb0x/
├── server.js                            # Hauptserver, Routing, CSP-Nonce-Injection
├── package.json
├── prisma/
│   ├── schema.prisma                    # DB-Schema (User, Category, Expense, Income, MonthInit)
│   └── seed.js                          # Testdaten mit verschlüsselten Einträgen
├── src/
│   ├── utils/
│   │   ├── encryption.js                # AES-256-GCM + PBKDF2 Key Wrapping
│   │   ├── sessionStore.js              # RAM-basierter Session-Store (Singleton)
│   │   ├── prisma.js                    # Zentrale Prisma-Instanz (ein Pool)
│   │   └── validation.js               # Eingabe-Validierung & Sanitization
│   ├── middleware/
│   │   ├── auth.js                      # requireAuth: JWT prüfen + Enc-Key aus RAM holen
│   │   └── security.js                  # Helmet, CORS, Rate-Limiting, HPP, Body-Parser
│   └── routes/
│       ├── auth.js                      # /api/auth/* (login, register, logout, me, password, profile)
│       ├── categories.js                # /api/categories CRUD
│       ├── expenses.js                  # /api/expenses CRUD + summary
│       └── income.js                    # /api/income CRUD
└── public/
    ├── portal/
    │   ├── index.html                   # Tool-Übersicht (Auth + Portal in einer Datei)
    │   └── profil.html                  # Profil-/Einstellungsseite
    ├── apps/
    │   └── finanzen/
    │       └── index.html               # Finanz-App (komplette SPA in einer HTML-Datei)
    └── shared/
        └── session-timeout.js           # Inaktivitäts-Timeout (20min), Browser-Restart-Erkennung
```

---

## URL-Routing (server.js)

| URL | Beschreibung |
|-----|-------------|
| `/` | Redirect → `/portal` |
| `/portal` | Tool-Übersicht (HTML mit Nonce) |
| `/portal/profil` | Profilseite (HTML mit Nonce) |
| `/app/finanzen` | Finanz-App (HTML mit Nonce) |
| `/app/<neues-tool>` | Zukünftige Tools (gleicher Mechanismus) |
| `/api/auth/*` | Auth-API |
| `/api/categories/*` | Kategorien-API |
| `/api/expenses/*` | Ausgaben-API |
| `/api/income/*` | Einnahmen-API |

**CSP-Nonce:** Alle HTML-Dateien werden mit `serveHtmlWithNonce()` ausgeliefert. Inline-Scripts müssen `nonce="__CSP_NONCE__"` haben — der Platzhalter wird serverseitig ersetzt.

---

## Authentifizierung & Session-Architektur

### Ablauf
1. User loggt sich im Portal ein (`POST /api/auth/login`)
2. Server entschlüsselt den Encryption Key mit dem Passwort
3. Session wird im RAM-Store angelegt (`sessionStore.create(userId, encKey)`)
4. JWT enthält nur `{ userId, sid: sessionId }` — **KEIN Encryption Key im JWT**
5. JWT wird als HttpOnly-Cookie gesetzt (`path: '/'`, gilt für ALLE Pfade)
6. Jede API-Anfrage: `requireAuth` prüft JWT → holt Key aus RAM → hängt an `req.encryptionKey`
7. **Sliding Session:** Bei jeder Anfrage wird der JWT mit neuer 20min-Ablaufzeit erneuert

### Session-Persistenz über Tools
- Cookie `auth_token` gilt für `path: '/'` → automatisch gültig für `/portal`, `/app/finanzen`, alle zukünftigen `/app/*`
- Kein separater Login pro Tool nötig
- **Muster für neue Tools:** Wenn nicht eingeloggt → `window.location.href = '/portal'` (nicht eigene Auth-Seite zeigen)

### Session-Timeout (Frontend)
- `public/shared/session-timeout.js` — globale Datei, in alle HTML-Seiten einbinden
- Logout nach 20 Min Inaktivität (mousedown, keydown, scroll, touchstart)
- Erkennt Browser-Neustart via `sessionStorage` — loggt dann automatisch aus
- API: `SessionTimeout.start(callback)`, `.stop()`, `.markActive()`, `.wasRestarted()`

### Passwort-Validierung
- Min. 8 Zeichen, min. 1 Großbuchstabe, min. 1 Zahl

---

## Zero-Knowledge Verschlüsselung (`src/utils/encryption.js`)

### Prinzip
- Jeder User bekommt bei Registrierung einen zufälligen 256-Bit Encryption Key
- Dieser Key wird mit dem Passwort verschlüsselt in der DB gespeichert (`encryptedKey`)
- Beim Login: Key entschlüsseln, in RAM-Session halten
- Alle Datenbankfelder mit sensiblen Daten werden server-seitig ver-/entschlüsselt

### Algorithmen
- **AES-256-GCM** für Datenverschlüsselung (authentifiziert, manipulationssicher)
- **PBKDF2** (SHA-512, 100.000 Iterationen) für Key-Ableitung aus Passwort
- **bcrypt** (Cost 12) für Passwort-Hashing (separat vom Encryption Key)

### Verschlüsselte Felder in der DB
| Modell | Verschlüsselte Felder |
|--------|----------------------|
| Category | `name`, `color` |
| Expense | `name`, `amount`, `tags` |
| Income | `name`, `amount` |

**Nicht verschlüsselt:** `month` (Format YYYY-MM, für DB-Queries), `isRecurring`, alle IDs, Timestamps

### Hilfsfunktionen
```js
encrypt(plaintext, key)          // String → "iv:authTag:ciphertext"
decrypt(ciphertext, key)         // "iv:authTag:ciphertext" → String
encryptFields(obj, key, fields)  // Objekt mit ausgewählten Feldern verschlüsseln
decryptFields(obj, key, fields)  // Objekt mit ausgewählten Feldern entschlüsseln
```

---

## Datenbankschema (Prisma)

### User
```
id (UUID), email (unique), password (bcrypt), name, encryptedKey
createdAt, updatedAt
→ hat: categories[], expenses[], incomes[], monthInits[]
```

### Category
```
id (UUID), name (enc), color (enc)
userId → User (Cascade Delete)
→ hat: expenses[]
```

### Expense
```
id (UUID), name (enc), amount (enc, String), categoryId → Category
tags (enc, JSON-Array als String, default ""), month (YYYY-MM, nicht enc)
isRecurring (Boolean), userId → User (Cascade Delete)
Index: [userId, month]
```

### Income
```
id (UUID), name (enc), amount (enc, String)
month (YYYY-MM), isRecurring (Boolean), userId → User (Cascade Delete)
Index: [userId, month]
```

### MonthInit
```
id, userId, month, type ("expense"|"income")
Unique: [userId, month, type]
Zweck: Verhindert dass gelöschte Einträge nach Monatswechsel wieder auftauchen
```

---

## API-Routen

### Auth (`/api/auth/`)
| Methode | Route | Beschreibung |
|---------|-------|-------------|
| POST | `/login` | Login, gibt Cookie zurück |
| POST | `/register` | Registrierung + Default-Kategorien anlegen |
| POST | `/logout` | Session löschen, Cookie leeren |
| GET | `/me` | Aktueller User (`requireAuth`) |
| PUT | `/password` | Passwort ändern (alle Sessions invalidieren) |
| PUT | `/profile` | Name/E-Mail ändern (Passwort zur Bestätigung) |
| DELETE | `/account` | Konto + alle Daten löschen |

### Categories (`/api/categories/`)
- GET `/` — Alle Kategorien (entschlüsselt)
- POST `/` — Neue Kategorie
- PUT `/:id` — Kategorie bearbeiten
- DELETE `/:id` — Kategorie löschen

### Expenses (`/api/expenses/`)
- GET `/?month=YYYY-MM` — Ausgaben für Monat
- GET `/summary?month=YYYY-MM` — Dashboard-Daten (Summen, Kategorien)
- POST `/` — Neue Ausgabe
- PUT `/:id` — Ausgabe bearbeiten
- DELETE `/:id` — Ausgabe löschen

### Income (`/api/income/`)
- GET `/?month=YYYY-MM` — Einnahmen für Monat
- POST `/` — Neue Einnahme
- PUT `/:id` — Einnahme bearbeiten
- DELETE `/:id` — Einnahme löschen

---

## Sicherheitsmaßnahmen (`src/middleware/security.js`)

- **Helmet** mit CSP (script-src nur nonce-basiert, keine unsafe-inline)
- **CORS** whitelist via `CORS_ORIGIN` env var
- **Rate-Limiting:** Allgemein 100/15min, Login 10/15min, Register 5/h
- **HPP** — HTTP Parameter Pollution Schutz
- **Body-Parser** — Max 10kb
- **Timing-Attack-Schutz** — Dummy-Hash beim Login für nicht existierende Users
- **Row-Level Security** — Alle Queries mit `userId` gefiltert

---

## Design-System (iOS 26 Liquid Glass)

Konsistentes CSS-System, das in allen HTML-Dateien gleich ist:

```css
/* CSS-Variablen */
--glass-bg: rgba(255,255,255,0.12)       /* Glas-Hintergrund */
--glass-bg-heavy: rgba(255,255,255,0.18) /* Dickeres Glas */
--glass-border: rgba(255,255,255,0.22)   /* Glas-Rand */
--glass-shadow: ...                       /* Schatten */
--glass-inset: inset 0 1px 0 ...         /* Innen-Highlight */
--glass-blur: 40px
--glass-saturate: 1.8

/* Farben */
--blue: #007AFF  --green: #30D158  --red: #FF3B30  --orange: #FF9500
--purple: #AF52DE  --pink: #FF2D55  --teal: #5AC8FA  --indigo: #5856D6
--mint: #00C7BE  --yellow: #FFCC00

/* Radien */
--radius-sm: 12px  --radius: 20px  --radius-lg: 26px  --radius-xl: 32px

/* Textfarben */
--text: rgba(0,0,0,0.85)
--text-secondary: rgba(0,0,0,0.55)
--text-tertiary: rgba(0,0,0,0.35)
```

**Klassen:** `.glass`, `.glass-heavy` — immer mit `backdrop-filter: blur(40px) saturate(1.8)`

**Hintergrund:** Animiertes Gradient in allen Seiten gleich:
`linear-gradient(135deg, #a8c8f0 0%, #d4b8e8 25%, #f0c8c8 50%, #b8d8f0 75%, #c8e8d0 100%)`

**Font:** SF Pro (System-Font via `local()`), kein externer Font-Download

---

## Neues Tool hinzufügen — Checkliste

1. **HTML-Datei** anlegen: `public/apps/<tool-name>/index.html`
   - CSS-Variablen und `.glass`-Klassen übernehmen
   - `<script nonce="__CSP_NONCE__" src="/shared/session-timeout.js">` einbinden
   - Bei Auth-Fehler → `window.location.href = '/portal'` (KEIN eigenes Login-Formular)
   - Bei Logout → `window.location.href = '/portal'`

2. **server.js** erweitern:
   ```js
   // Statische Dateien
   app.use('/app/<tool-name>', express.static(path.join(__dirname, 'public', 'apps', '<tool-name>'), { etag: true, index: false }));
   // Route
   app.get('/app/<tool-name>', serveHtmlWithNonce(path.join(__dirname, 'public', 'apps', '<tool-name>', 'index.html')));
   // Console-Log ergänzen
   ```

3. **API-Routen** unter `src/routes/<tool-name>.js` anlegen
   - Immer `requireAuth` Middleware verwenden
   - Sensible Daten mit `encryptFields`/`decryptFields` verarbeiten
   - Alle Queries mit `userId: req.userId` filtern (Row-Level Security)

4. **Prisma-Schema** erweitern, Migration ausführen

5. **Portal-Karte** in `public/portal/index.html` hinzufügen (`.tool-card.glass`)

6. **Sidebar-Back-Link** im Tool: `<a href="/portal" class="nav-btn back-portal-btn">← Zur Übersicht</a>`

---

## Entwicklungsumgebung

```bash
npm run dev        # Node --watch (kein nodemon nötig)
npm run db:migrate # Prisma-Migration
npm run db:seed    # Testdaten einspielen
npm run db:studio  # Prisma Studio (DB-Browser)
```

**Testlogin:** `michael@test.de` / `Test1234!`

**Ports:** Server läuft auf `PORT` aus `.env` (Standard: 3000)

**Umgebungsvariablen:**
```
DATABASE_URL=postgresql://...
JWT_SECRET=<min. 32 Zeichen, random bytes empfohlen>
NODE_ENV=development|production
CORS_ORIGIN=http://localhost:3000
RATE_LIMIT_LOGIN=10
```

---

## Wichtige Designentscheidungen

- **Kein Frontend-Framework** — reines Vanilla JS, alles in einer HTML-Datei pro Tool
- **Kein Redis** — Session-Store im RAM (bei Server-Neustart müssen sich alle neu einloggen — gewollt)
- **Sliding Sessions** — JWT-Ablauf wird bei jeder Anfrage zurückgesetzt (20min Inaktivität)
- **Nonce statt unsafe-inline** — CSP ist strict, alle Inline-Scripts brauchen Nonce
- **Einzelne HTML-Datei pro Tool** — SPA-Charakter ohne Build-Step
- **Portal als einziger Auth-Einstiegspunkt** — Tools zeigen kein eigenes Login mehr

---

## Bekannte Besonderheiten / Fallstricke

- `amount` ist in der DB ein String (Base64-verschlüsselt), kein Number — beim Rechnen immer `parseFloat()` verwenden
- `tags` ist ein verschlüsselter JSON-Array-String (z.B. `'["Tag1","Tag2"]'`) — vor Speichern `JSON.stringify()`, nach Lesen `JSON.parse()`
- `month` ist NICHT verschlüsselt (für DB-Queries nötig) — kein sensibles Datum
- `MonthInit` verhindert, dass gelöschte `isRecurring`-Einträge bei Monatswechsel wieder entstehen
- Bei Passwort-Änderung: ALLE Sessions des Users werden invalidiert (neu einloggen erforderlich)
- Session-Store ist ein Singleton — `require('../utils/sessionStore')` gibt immer dieselbe Instanz zurück
