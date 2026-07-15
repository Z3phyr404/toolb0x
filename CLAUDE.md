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
│   ├── schema.prisma                    # DB-Schema (User, Category, Expense, Income, MonthInit, Reminder)
│   └── seed.js                          # Testdaten mit verschlüsselten Einträgen
├── src/
│   ├── utils/
│   │   ├── encryption.js                # AES-256-GCM + PBKDF2 Key Wrapping + RSA-Keypairs (Tresore)
│   │   ├── sessionStore.js              # RAM-basierter Session-Store (Singleton, sliding)
│   │   ├── vaultKeys.js                 # Tresor-Schlüssel entpacken (geteilte Tresore)
│   │   ├── prisma.js                    # Zentrale Prisma-Instanz (ein Pool)
│   │   └── validation.js               # Eingabe-Validierung & Sanitization
│   ├── middleware/
│   │   ├── auth.js                      # requireAuth + requireAdmin: JWT prüfen + Enc-Key aus RAM holen
│   │   └── security.js                  # Helmet, CORS, Rate-Limiting, HPP, Body-Parser
│   └── routes/
│       ├── auth.js                      # /api/auth/* (login, register, logout, me, password, profile)
│       ├── categories.js                # /api/categories CRUD
│       ├── expenses.js                  # /api/expenses CRUD + summary
│       ├── income.js                    # /api/income CRUD
│       ├── reminders.js                 # /api/reminders CRUD + upcoming (Kündigungserinnerungen)
│       ├── admin.js                     # /api/admin/* — Admin-Statistiken, Nutzerliste, Sperren (requireAdmin)
│       ├── export.js                    # /api/export/pdf + /pdf-all — PDF-Export (Monat & Gesamt)
│       ├── passwords.js                 # /api/passwords CRUD (privat + Tresor-Einträge)
│       ├── vaults.js                    # /api/vaults/* — Geteilte Tresore (Mitglieder, Key-Wrapping)
│       └── share.js                     # /api/share/* — Zero-Knowledge Secret-Sharing per Link
└── public/
    ├── portal/
    │   ├── index.html                   # Tool-Übersicht (Auth + Portal in einer Datei)
    │   └── profil.html                  # Profil-/Einstellungsseite
    ├── apps/
    │   ├── finanzen/
    │   │   └── index.html               # Finanz-App (komplette SPA in einer HTML-Datei)
    │   ├── admin/
    │   │   └── index.html               # Admin-Bereich (Nutzerübersicht, nur für Admins)
    │   └── passwords/
    │       └── index.html               # Passwort-Manager (Generator + verschlüsselter Tresor + Teilen)
    ├── share/
    │   └── index.html                   # ÖFFENTLICHE View-Seite für geteilte Links (/s, kein Login)
    └── shared/
        ├── session-timeout.js           # Inaktivitäts-Timeout (20min), Browser-Restart-Erkennung
        └── share-crypto.js              # Clientseitige Web-Crypto (Zero-Knowledge Share, beide Seiten)
```

---

## URL-Routing (server.js)

| URL | Beschreibung |
|-----|-------------|
| `/` | Redirect → `/portal` |
| `/portal` | Tool-Übersicht (HTML mit Nonce) |
| `/portal/profil` | Profilseite (HTML mit Nonce) |
| `/app/finanzen` | Finanz-App (HTML mit Nonce) |
| `/app/admin` | Admin-Bereich (nur für Admins, HTML mit Nonce) |
| `/app/passwords` | Passwort-Manager (HTML mit Nonce) |
| `/app/<neues-tool>` | Zukünftige Tools (gleicher Mechanismus) |
| `/s` | **Öffentliche** View-Seite für geteilte Links (KEIN Login, KEIN Portal-Redirect) — Schlüssel steht im URL-Fragment `#<token>~<key>` |
| `/api/auth/*` | Auth-API |
| `/api/categories/*` | Kategorien-API |
| `/api/expenses/*` | Ausgaben-API |
| `/api/income/*` | Einnahmen-API |
| `/api/reminders/*` | Erinnerungs-API |
| `/api/passwords/*` | Passwort-Manager-API (CRUD, privat + Tresor) |
| `/api/vaults/*` | Geteilte Tresore (anlegen, Mitglieder, löschen) |
| `/api/share/*` | Secret-Sharing-API (öffentliches Reveal + Owner-CRUD) |
| `/api/admin/stats` | Admin-Statistiken (Nutzeranzahl, neuester Nutzer) |
| `/api/export/pdf?month=YYYY-MM` | PDF-Export der Monatsübersicht |
| `/api/export/pdf-all` | PDF-Export aller Finanzdaten (alle Monate) |

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
| Reminder | `note` |
| StoredPassword | `name`, `username`, `password`, `website`, `notes` |

**Nicht verschlüsselt:** `month` (Format YYYY-MM, für DB-Queries), `isRecurring`, `reminderDate`, `daysBefore`, `status`, alle IDs, Timestamps

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
id (UUID), email (unique), password (bcrypt), name, role (default "user"), suspended (default false), encryptedKey
createdAt, updatedAt
→ hat: categories[], expenses[], incomes[], monthInits[], reminders[]
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
→ hat: reminders[]
```

### Income
```
id (UUID), name (enc), amount (enc, String)
month (YYYY-MM), isRecurring (Boolean), userId → User (Cascade Delete)
Index: [userId, month]
```

### Reminder
```
id (UUID), note (enc, optional), reminderDate (DateTime, nicht enc)
daysBefore (Int, 0–90), status ("pending"|"done"|"dismissed")
expenseId → Expense (optional, SetNull bei Delete)
userId → User (Cascade Delete)
Index: [userId, status], [userId, reminderDate]
Zweck: Kündigungserinnerungen für Ausgaben (Abos, Verträge)
```

### MonthInit
```
id, userId, month, type ("expense"|"income")
Unique: [userId, month, type]
Zweck: Verhindert dass gelöschte Einträge nach Monatswechsel wieder auftauchen
```

### StoredPassword
```
id (UUID), name (enc), username (enc), password (enc), website (enc), notes (enc)
userId → User (Cascade Delete), vaultId → Vault (optional, Cascade Delete)
Index: [userId], [vaultId]
Zweck: Verschlüsselter Passwort-Tresor (Passwort-Manager)
WICHTIG: vaultId gesetzt → Felder sind mit dem TRESOR-Schlüssel verschlüsselt
(nicht mit dem User-Key). userId ist dann nur noch der Ersteller.
```

### Vault / VaultMember (Geteilte Tresore)
```
Vault:       id, name (enc mit Tresor-Schlüssel), ownerId → User (Cascade)
VaultMember: id, vaultId → Vault (Cascade), userId → User (Cascade),
             wrappedKey (Tresor-Schlüssel, RSA-OAEP-verschlüsselt mit dem
             Public Key des Mitglieds), role ("owner"|"member")
             Unique: [vaultId, userId]
Zweck: Gemeinsame Passwörter zwischen Nutzern (z.B. Team-Zugänge).
Krypto: Jeder User hat ein RSA-2048-Keypair (User.publicKey klartext,
User.encryptedPrivateKey mit User-Key verschlüsselt — wird beim Login
provisioniert, Bestandsnutzer brauchen also EINEN Login nach Deploy).
Tresor-Schlüssel = 32 Zufallsbytes, pro Mitglied per Public Key gewrappt
→ Zero-Knowledge at rest bleibt erhalten, Einladen geht auch wenn das
Mitglied offline ist. Beim Entfernen eines Mitglieds wird der Schlüssel
NICHT rotiert (dokumentiert, Hinweis in der UI).
```

### Share
```
id (UUID), token (unique, URL-sicherer Zufalls-Token für Lookup)
blob (Text, CLIENTSEITIG verschlüsselt — Server blind, KEIN Server-Key im Spiel)
hasPin (Boolean, steuert nur die PIN-Abfrage im View)
maxViews (Int, 0 = unbegrenzt bis Ablauf), viewCount (Int)
expiresAt (DateTime, nicht enc), userId → User (Cascade Delete)
Index: [userId]
Zweck: Sicheres Teilen von Geheimnissen per Link (Zero-Knowledge)
WICHTIG: Der Entschlüsselungs-Schlüssel steht im URL-Fragment und erreicht
den Server NIE. blob wird im Browser des Absenders mit Web Crypto (AES-256-GCM)
ver- und beim Empfänger entschlüsselt. Server sieht weder Klartext noch Key noch PIN.
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

### Reminders (`/api/reminders/`)
| Methode | Route | Beschreibung |
|---------|-------|-------------|
| GET | `/` | Alle Erinnerungen (optional `?status=`, `?expenseId=`) |
| GET | `/upcoming` | Fällige Erinnerungen (alertDate <= heute) |
| POST | `/` | Neue Erinnerung (optional mit Expense verlinkt) |
| PUT | `/:id` | Erinnerung bearbeiten |
| DELETE | `/:id` | Erinnerung löschen |
| PATCH | `/:id/status` | Status ändern (done/dismissed) |

### Export (`/api/export/`)
- GET `/pdf?month=YYYY-MM` — PDF-Export der Monatsübersicht (KPIs, Kategorien, Top 10, Einnahmen, Tags)
- GET `/pdf-all` — Gesamt-PDF-Export aller Einnahmen & Ausgaben (Monatsübersicht + Details pro Monat)

### Passwords (`/api/passwords/`)
| Methode | Route | Beschreibung |
|---------|-------|-------------|
| GET | `/` | Eigene private + alle Tresor-Einträge (entschlüsselt, mit `vaultId`/`vaultName`/`createdBy`) |
| POST | `/` | Neues Passwort (optional `vaultId` → landet im Tresor) |
| PUT | `/:id` | Bearbeiten; `vaultId` im Body verschiebt privat ↔ Tresor (Re-Encrypt) |
| DELETE | `/:id` | Löschen (eigene private ODER Tresor-Einträge als Mitglied) |

### Vaults (`/api/vaults/`) — Geteilte Tresore
| Methode | Route | Beschreibung |
|---------|-------|-------------|
| POST | `/` | Tresor anlegen (erzeugt Tresor-Schlüssel, wrappt für Owner) |
| GET | `/` | Eigene Tresore inkl. Mitgliederliste |
| POST | `/:id/members` | Mitglied per E-Mail einladen (nur Owner; Invitee braucht Keypair) |
| DELETE | `/:id/members/:userId` | Mitglied entfernen (Owner) oder selbst verlassen |
| DELETE | `/:id` | Tresor + alle Einträge löschen (nur Owner) |

### Share (`/api/share/`)
| Methode | Route | Auth | Beschreibung |
|---------|-------|------|-------------|
| GET | `/:token` | öffentlich | Metadaten (hasPin, remainingViews, expiresAt) — **kein Burn**, kein Blob (schützt vor Link-Vorschau-Bots) |
| POST | `/:token/reveal` | öffentlich | Gibt `blob` heraus + zählt Ansicht hoch; löscht bei erreichtem View-Limit (burn-after-read). Eigener Rate-Limiter (30/15min) |
| POST | `/` | `requireAuth` | Share anlegen (`blob`, `hasPin`, `maxViews`, `expiresIn` ∈ 1h/1d/7d) → gibt `token` zurück |
| GET | `/` | `requireAuth` | Eigene aktive Shares auflisten (ohne Blob/Key) |
| DELETE | `/:token` | `requireAuth` | Eigenen Share widerrufen (userId-gefiltert) |

**Wichtig:** Öffentliche Routen sind in `share.js` VOR `router.use(requireAuth)` definiert (Express matcht in Reihenfolge → umgehen die Auth-Middleware).

### Admin (`/api/admin/`)
| Methode | Route | Beschreibung |
|---------|-------|-------------|
| GET | `/stats` | Nutzeranzahl + neuester Nutzer (`requireAuth` + `requireAdmin`) |
| GET | `/users` | Nutzerliste mit E-Mail, Rolle, Datenstatistiken |
| PATCH | `/users/:id/suspend` | Nutzer sperren/entsperren (body: `{ suspended: bool }`) |

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

## Deployment (Produktion)

**Server:** `ubuntu-4gb-nbg1-1` (Hetzner) · **Pfad:** `/var/www/toolbox/finanz-app` · **Domain:** `toolb0x.eu`

### Deploy-Ablauf — nach JEDEM Deploy vollständig ausführen
```bash
cd /var/www/toolbox/finanz-app
git pull                   # neuen Code holen (inkl. neuer Prisma-Migrationen)
npm install                # bei geänderten Dependencies — sonst 502
npx prisma migrate deploy  # wendet ausstehende Migrationen auf die Prod-DB an
npx prisma generate        # regeneriert den Prisma-Client aus dem aktuellen Schema
pm2 restart all            # Prozess neu starten — lädt neuen Client + Code in den RAM
```

**Warum jeder Schritt zählt:**
- `prisma migrate deploy` **vergessen** → DB-Spalte fehlt → Laufzeit-Fehler bei Queries auf das neue Feld.
- `prisma generate` **vergessen** → veralteter Client lehnt neue Felder ab: `Unknown argument \`feldname\`. Available options are marked with ?` (Client-Validierung, KEIN DB-Fehler).
- **Restart vergessen** → der Node-Prozess läuft mit dem alten, im RAM geladenen Client/Code weiter — `git pull` allein reicht nie.
- `npm install` vergessen → fehlende Dependencies → 502.

> **Symptom-Beispiel:** Serverüberwachung zeigte alle Server als „offline", weil `prisma.server.update({ data: { hostKeyFingerprint } })` (Trust-on-first-use beim ersten Connect) fehlschlug — Schema/Migration waren im Repo vorhanden, auf Prod fehlten aber `migrate deploy` + `generate` + Restart.

**Wichtig:** Schema-Änderungen (`schema.prisma`) IMMER als committete Migration deployen — nie nur das Schema pushen. `prisma migrate dev` erzeugt lokal die Migration, `prisma migrate deploy` wendet sie auf Prod an.

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
- PDF-Export nutzt `pdfkit` (server-seitig) — Decrypt-Helfer sind in `export.js` repliziert (gleiche Logik wie `expenses.js`/`income.js`)
- Gesamt-PDF-Export (`/api/export/pdf-all`) — exportiert alle Monate auf einmal, Button auf der Profilseite (`/portal/profil`)
- **Erinnerungen** sind an Ausgaben gekoppelt (optional), überleben aber gelöschte Ausgaben (`onDelete: SetNull`)
- `reminderDate` ist NICHT verschlüsselt (für DB-Queries nötig), `note` ist verschlüsselt
- Recurring Expenses kopieren KEINE Erinnerungen (Erinnerungen sind einmalige Kalender-Events)
- Portal zeigt fällige Erinnerungen als dynamische Glass-Karte (nur sichtbar wenn Erinnerungen anstehen)
- **Admin-Bereich** (`/app/admin`): Nur für User mit `role: 'admin'` sichtbar. Admin-Karte im Portal wird per JS bedingt angezeigt. Backend geschützt durch `requireAdmin` Middleware. Admin sieht nur unverschlüsselte Felder (Zero-Knowledge gewahrt). Admin-Rolle nur per DB-Zugriff setzbar.
- **Nutzersperre** (`suspended`-Feld): Gesperrte Nutzer können sich nicht einloggen (403 beim Login). Beim Sperren werden alle aktiven Sessions sofort beendet (`sessionStore.deleteAllForUser`). Admins können nicht gesperrt werden. Admin kann sich nicht selbst sperren.
- **Secret-Sharing** (`/app/passwords` → Teilen-Button/Ad-hoc-Box, View unter `/s`): Anders als der Rest der App nutzt Sharing **NICHT** den User-Encryption-Key aus `encryption.js`. Stattdessen erzeugt der Browser des Absenders einen frischen Zufalls-Schlüssel (`public/shared/share-crypto.js`, Web Crypto), verschlüsselt clientseitig (AES-256-GCM) und legt nur den opaken `blob` auf dem Server ab. Der Schlüssel wandert im **URL-Fragment** (`/s#<token>~<key>`) — Fragmente werden vom Browser nicht an den Server gesendet → echter Zero-Knowledge, auch der Betreiber kann geteilte Geheimnisse nicht lesen.
- **PIN beim Share** ist kein Server-Check: die PIN wird via `PBKDF2(keyMaterial ‖ PIN, salt)` kryptografisch in den AES-Key eingemischt. Falsche/fehlende PIN → GCM-Auth-Tag schlägt fehl → Entschlüsselung wirft. `hasPin` (DB) steuert nur die PIN-Abfrage im View.
- **Reveal vs. Meta getrennt:** `GET /api/share/:token` liefert nur Metadaten (kein Burn), erst `POST …/reveal` gibt den Blob heraus und zählt hoch. So verbrennen Link-Vorschau-Bots (Signal/WhatsApp/Slack) keine burn-after-read-Ansicht.
- **Neue Prisma-Migration** `20260715_add_share` (Modell `Share`) — bei Deploy `migrate deploy` + `generate` + Restart nicht vergessen (siehe Deployment).
- **Geteilte Tresore** (`/app/passwords` → „Tresore"-Button): Gemeinsame Passwörter zwischen Nutzern. Pro User RSA-2048-Keypair (Provisionierung beim Login → Bestandsnutzer müssen sich nach Deploy EINMAL einloggen, bevor sie eingeladen werden können). Tresor-Einträge sind mit dem Tresor-Schlüssel verschlüsselt, `StoredPassword.vaultId` unterscheidet privat/geteilt. Details: Schema-Abschnitt „Vault / VaultMember".
- **Body-Limit-Ausnahme**: Der globale 10kb-JSON-Parser (security.js) überspringt `/api/notes` — der Notes-Router hat einen eigenen 500kb-Parser. Sonst könnten Notizen > 10kb nie gespeichert werden.
- **Session-Store ist sliding**: `get()` frischt `lastActivity` auf; 30-Min-Fenster gilt für INAKTIVITÄT, nicht absolut (passend zum JWT-Sliding).
- **Share-Reveal ist race-sicher**: View wird per bedingtem `updateMany` (WHERE viewCount < maxViews) atomar reserviert — parallele Reveals können das Limit nicht überschreiten.
