# 🧰 ToolBox — Verschlüsseltes Tool-Portal

Persönliches Tool-Portal mit iOS 26 Liquid Glass Design und Zero-Knowledge-Verschlüsselung.

## 🔒 Zero-Knowledge-Architektur

Alle sensiblen Nutzerdaten (Finanzen, Beträge, Bezeichnungen) werden mit **AES-256-GCM** verschlüsselt, bevor sie die Datenbank erreichen. Der Verschlüsselungsschlüssel wird aus dem Passwort des Nutzers abgeleitet. **Selbst der Betreiber kann die Daten nicht lesen.**

```
Was der Nutzer sieht:          Was in der Datenbank steht:
┌──────────────────────┐       ┌──────────────────────────────────┐
│ Miete        640 €   │       │ dGhpc:abc123...  c29tZ:def456...│
│ Netflix    13,99 €   │       │ ZW5jcn:ghi789... a2V5d:jkl012...│
└──────────────────────┘       └──────────────────────────────────┘
```

## 🏗️ Architektur

```
Browser                    Server (Node.js)              Datenbank (PostgreSQL)
┌────────────────┐        ┌──────────────────┐          ┌────────────────────┐
│ /portal        │        │ Express + Helmet │          │ Verschlüsselte     │
│ /app/finanzen  │◄──────►│ JWT HttpOnly     │◄────────►│ Daten (AES-256)    │
│ /app/...       │  JSON  │ Rate-Limiting    │  Prisma  │                    │
└────────────────┘        └──────────────────┘          └────────────────────┘
```

## 📂 Projektstruktur

```
toolbox/
├── server.js                         # Hauptserver mit Portal-Routing
├── public/
│   ├── portal/index.html             # Tool-Übersicht
│   └── apps/finanzen/index.html      # Finanz-App (Liquid Glass UI)
├── src/
│   ├── utils/
│   │   ├── encryption.js             # AES-256-GCM + PBKDF2 Key-Wrapping
│   │   └── validation.js             # Eingabe-Validierung & XSS-Schutz
│   ├── middleware/
│   │   ├── auth.js                   # JWT-Verifizierung + Encryption Key
│   │   └── security.js               # Helmet, CORS, Rate-Limiting, HPP
│   └── routes/
│       ├── auth.js                   # Login, Register, Logout
│       ├── categories.js             # Kategorien CRUD (verschlüsselt)
│       ├── expenses.js               # Ausgaben CRUD (verschlüsselt)
│       └── income.js                 # Einnahmen CRUD (verschlüsselt)
├── prisma/
│   ├── schema.prisma                 # Datenbank-Schema
│   └── seed.js                       # Verschlüsselte Testdaten
├── .env.example                      # Vorlage für Umgebungsvariablen
└── .gitignore
```

## 🔐 Sicherheitsmaßnahmen

| Maßnahme | Schutz |
|---|---|
| AES-256-GCM | Daten in der Datenbank |
| PBKDF2 (100k Iterationen) | Schlüssel-Ableitung aus Passwort |
| bcrypt (Cost 12) | Passwort-Hashing |
| JWT in HttpOnly-Cookies | Session-Schutz (XSS-sicher) |
| SameSite Strict | CSRF-Schutz |
| Helmet (15+ Header) | Browser-Sicherheit |
| Rate-Limiting | Brute-Force-Schutz |
| CORS | API-Zugriffskontrolle |
| Input-Validierung | Injection-Schutz |
| Row-Level Security | Daten-Isolation zwischen Nutzern |
| Timing-Attack-Schutz | E-Mail-Enumeration verhindern |
| HPP | Parameter-Manipulation |

## 🚀 Setup

### Voraussetzungen
- Node.js 20+
- PostgreSQL 15+

### Installation
```bash
git clone https://github.com/DEIN_USERNAME/toolbox.git
cd toolbox
npm install
```

### Konfiguration
```bash
cp .env.example .env

# JWT-Secret generieren:
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
# → Ergebnis in .env bei JWT_SECRET einfügen

# DATABASE_URL in .env anpassen
```

### Datenbank
```bash
createdb finanzapp
npm run db:migrate
npm run db:seed
```

### Starten
```bash
npm run dev    # Development
npm start      # Production
```

### Öffnen
- Portal: `http://localhost:3000/portal`
- Finanz-App: `http://localhost:3000/app/finanzen`
- Testlogin: `michael@test.de` / `Test1234!`

## 📡 API

| Methode | Route | Beschreibung |
|---|---|---|
| POST | `/api/auth/register` | Registrierung (nur mit Einladungslink) |
| POST | `/api/auth/login` | Login |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/auth/me` | Aktueller Nutzer |
| GET | `/api/categories` | Kategorien |
| POST/PUT/DELETE | `/api/categories/:id` | Kategorien CRUD |
| GET | `/api/expenses?month=YYYY-MM` | Ausgaben |
| GET | `/api/expenses/summary` | Dashboard-Daten |
| POST/PUT/DELETE | `/api/expenses/:id` | Ausgaben CRUD |
| GET | `/api/income?month=YYYY-MM` | Einnahmen |
| POST/PUT/DELETE | `/api/income/:id` | Einnahmen CRUD |

## 📜 Lizenz

Privates Projekt.
