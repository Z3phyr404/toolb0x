# Handoff: Toolb0x — UI-Redesign („Obsidian")

## Overview
Komplettes visuelles Redesign des privaten Tool-Portals **Toolb0x** (Repo `Z3phyr404/toolb0x`).
Der alte Look war „iOS 26 Liquid Glass" (Glaskarten auf animiertem Pastell-Gradient, hell).
Das neue System **„Obsidian"** ist dunkel, technisch-präzise und ruhig, mit einem **cursor-reaktiven Glow**, **Scroll-Reveal-Animationen** und einer **pro Bereich eigenen Signaturfarbe**.

Betroffen sind alle Screens: Portal, Profil, Finanzen, Notizen, Passwort-Manager, Server, Admin.

## About the Design Files
Die `*.dc.html`-Dateien in diesem Bundle sind **Design-Referenzen** (HTML-Prototypen, die Aussehen und Verhalten zeigen) — **kein** Produktionscode zum 1:1-Kopieren. Sie sind in einem Komponenten-Format („Design Component") geschrieben; ignoriere das Wrapper-/Runtime-Format und übernimm nur **Markup-Struktur, Inline-Styles, Farben, Typografie und die Interaktions-Logik**.

**Zielumgebung = das bestehende Repo:** klassisches **Vanilla HTML/CSS/JS** (Node.js/Express-Backend, statische Seiten unter `public/…`, keine Frontend-Framework-Buildchain). Jede Seite ist eine `index.html` mit `<style nonce="__CSP_NONCE__">`-Block, Markup und einem `<script nonce="__CSP_NONCE__">`-Block, der die gesamte Logik enthält (Auth, `fetch`-API-Calls, CRUD, Rendering).

**Aufgabe:** In jeder Ziel-Datei den **`<style>`-Block und das statische Markup** durch den neuen Obsidian-Look ersetzen und die **bestehende JS-Logik unangetastet lassen** (gleiche Element-IDs/Klassen-Hooks beibehalten, damit die vorhandenen `document.getElementById(...)`-Referenzen weiter funktionieren). Die dynamisch per JS gerenderten Teile (Tabellenzeilen, Karten, Listen) müssen im JS-Template-String ebenfalls auf die neuen Styles umgestellt werden — Struktur bleibt, nur Klassen/Inline-Styles/Farben ändern sich.

> ⚠️ CSP: Die Seiten nutzen eine Content-Security-Policy mit Nonce. Neue `<style>`/`<script>` müssen das vorhandene `nonce="__CSP_NONCE__"`-Attribut behalten. Inline `style="…"`-Attribute sind ok. Keine externen Inline-Event-Handler hinzufügen.

## Fidelity
**High-fidelity (hi-fi).** Finale Farben, Typografie, Abstände, Radien und Interaktionen. Pixelgenau nachbauen. Fonts: **Space Grotesk** (UI/Headlines) + **JetBrains Mono** (Meta/Labels/Code/Zahlen-Mono) via Google Fonts.

---

## Design Tokens

### Farben — Basis (dunkel, für alle Screens gleich)
| Token | Hex / Wert | Verwendung |
|---|---|---|
| `--bg` | `#12161d` | Seiten-Hintergrund |
| `--panel` | `#1b212b` | Karten, Panels, Inputs-Container |
| `--panel-2` | `#161b23` | Sidebar-Panels / deaktivierte Karten |
| `--panel-inset` | `#12161d` | Code-Blöcke, Eingabefelder innerhalb Karten |
| `--border` | `rgba(255,255,255,0.08)` | Standard-Kartenrand |
| `--border-strong` | `rgba(255,255,255,0.12)` | Buttons, Hover-Ränder |
| `--text` | `#eef1f6` | Primärtext |
| `--text-2` | `rgba(238,241,246,0.55)` | Sekundärtext |
| `--text-3` | `rgba(238,241,246,0.4)` | Tertiär / Meta |
| `--text-mono` | `rgba(238,241,246,0.42)` | Monospace-Labels |
| Erfolg / Online | `#34d399` | Status ok, Einnahmen |
| Warnung | `#fbbf24` | „bald fällig", Amber |
| Fehler / Overdue | `#ff6b60` (Text), `#ff3b30` (Buttons) | überfällig, löschen |

### Signaturfarben — pro Bereich (Glow + Akzent)
Jeder Screen hat **eine** Signaturfarbe. Sie färbt: Standard-Glow, `// LABEL`-Kürzel, Logo-Mark-Verlauf, aktive Nav, Primär-Buttons, aktive Ränder.

| Bereich | Datei (Ziel) | Signatur | Akzent-Hex | Glow-RGBA | Verlauf (Mark/Button) |
|---|---|---|---|---|---|
| Portal | `public/portal/index.html` | Orange | `#f97316` | `rgba(255,146,32,0.28)` | `linear-gradient(135deg,#ffa83d,#f97316)` |
| Profil | `public/portal/profil.html` | Orange | `#f97316` | `rgba(255,146,32,0.24)` | `linear-gradient(135deg,#ffa83d,#f97316)` |
| Finanzen | `public/apps/finanzen/index.html` | Teal | `#2dd4bf` | `rgba(45,212,191,0.22)` | `linear-gradient(135deg,#2dd4bf,#0d9488)` |
| Notizen | `public/apps/notizen/index.html` | Violett | `#a78bfa` | `rgba(167,139,250,0.20)` | `linear-gradient(135deg,#c4b5fd,#8b5cf6)` |
| Passwörter | `public/apps/passwords/index.html` | Amber | `#fbbf24` | `rgba(251,191,36,0.20)` | `linear-gradient(135deg,#fcd34d,#f59e0b)` |
| Server | `public/apps/servers/index.html` | Blau | `#38bdf8` | `rgba(56,189,248,0.22)` | `linear-gradient(135deg,#7dd3fc,#0ea5e9)` |
| Admin | `public/apps/admin/index.html` | Indigo | `#818cf8` | `rgba(129,140,248,0.22)` | `linear-gradient(135deg,#a5b4fc,#6366f1)` |

**Tool-Karten im Portal** behalten zusätzlich je eine eigene Icon-Farbe: Finanzen Teal `#2dd4bf`, Notizen Violett `#a78bfa`, Passwörter Amber `#fbbf24`, Server Blau `#38bdf8`, Admin Indigo `#818cf8`. Icon-Kachel = Farbe bei 13 % Deckkraft als Hintergrund, Icon in Vollfarbe.

### Radien / Schrift / Schatten
- Radius: Karten `18–20px`, Buttons/Inputs `10–11px`, Icon-Kacheln `11–14px`, Pills `99px`.
- Font-Stack UI: `'Space Grotesk', system-ui, sans-serif`. Mono: `'JetBrains Mono', monospace`.
- Headlines: `font-weight:700`, `letter-spacing:-0.03em`. Meta-Labels: Mono, `10–12px`, `letter-spacing:0.08–0.14em`, uppercase.
- Karten-Schatten dezent; Primär-Buttons: `0 6px 20px <accent@0.3>`.
- Icons: durchweg **Stroke-Line-Icons** (`stroke-width:1.8–2`, `fill:none`, round caps) — **keine Emojis** (bewusste Design-Entscheidung des Users). Ausnahme: Notizen-Seitenbaum darf Emoji-Icons als Seiten-Symbole nutzen.

---

## Interaktionen & Verhalten (gilt für ALLE Screens)

Drei geteilte Verhaltensweisen. Der Referenzcode unten ist Vanilla-JS und kann direkt in den `<script>`-Block jeder Seite (nach dem Rendern) eingehängt werden. `SCOPE` = die Root-Element-ID der jeweiligen Seite (bzw. `document.body`).

### 1. Cursor-reaktiver Glow (Parallax + Bereichsfarbe)
Zwei radiale Glow-Flächen (`position:absolute`, `pointer-events:none`, `transition:transform .35s cubic-bezier(.2,.8,.2,1)`), die dem Cursor folgen. Beim Hover über eine Karte/KPI mit `data-glow-color` nimmt der Haupt-Glow deren Farbe an und kehrt beim Verlassen zurück.

```js
function initGlow(scope) {
  const glows = scope.querySelectorAll('[data-glow]');
  const primary = scope.querySelector('[data-glow-primary]');
  const baseBg = primary ? primary.style.background : '';
  scope.addEventListener('mousemove', (e) => {
    const r = scope.getBoundingClientRect();
    const rx = (e.clientX - r.left) / Math.max(r.width, 1) - 0.5;
    const ry = (e.clientY - r.top) / Math.max(r.height, 1) - 0.5;
    glows.forEach(g => {
      const d = parseFloat(g.dataset.depth || '40');
      g.style.transform = `translate(${(rx*d).toFixed(1)}px, ${(ry*d).toFixed(1)}px)`;
    });
  });
  scope.addEventListener('mouseleave', () => glows.forEach(g => g.style.transform = 'translate(0,0)'));
  scope.querySelectorAll('[data-glow-color]').forEach(card => {
    const c = card.getAttribute('data-glow-color');
    card.addEventListener('mouseenter', () => { if (primary) primary.style.background = `radial-gradient(circle, ${c}, transparent 70%)`; });
    card.addEventListener('mouseleave', () => { if (primary) primary.style.background = baseBg; });
  });
}
```
Glow-Markup (Signaturfarbe je Bereich einsetzen), als erste Kinder des Root-Containers (`overflow:hidden`, Root `position:relative`):
```html
<div data-glow data-glow-primary data-depth="55" style="position:absolute;top:-160px;right:-120px;width:600px;height:600px;background:radial-gradient(circle, <GLOW_RGBA>, transparent 70%);pointer-events:none;transition:transform .35s cubic-bezier(.2,.8,.2,1), background .5s ease;"></div>
<div data-glow data-depth="30" style="position:absolute;bottom:-200px;left:-140px;width:520px;height:520px;background:radial-gradient(circle, rgba(56,189,248,0.08), transparent 72%);pointer-events:none;transition:transform .55s cubic-bezier(.2,.8,.2,1);"></div>
```

### 2. Scroll-Reveal (gestaffeltes Einblenden)
Elemente mit `data-reveal` starten unsichtbar und steigen ein, sobald sie ins Sichtfeld kommen. Stagger über `data-reveal-index` (× 60–70 ms).
```js
function initReveal(scope) {
  const els = scope.querySelectorAll('[data-reveal]');
  els.forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(22px)';
    el.style.transition = 'opacity .7s cubic-bezier(.2,.8,.2,1), transform .7s cubic-bezier(.2,.8,.2,1)';
  });
  const io = new IntersectionObserver((entries) => {
    entries.forEach(en => {
      if (en.isIntersecting) {
        const el = en.target;
        const delay = (parseInt(el.dataset.revealIndex) || 0) * 65;
        setTimeout(() => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; }, delay);
        io.unobserve(el);
      }
    });
  }, { threshold: 0.1 });
  els.forEach(el => io.observe(el));
}
```
> Hinweis: `data-reveal` erst NACH dem dynamischen Rendern (z. B. nach dem Befüllen von Tabellen/Listen per fetch) initialisieren, sonst werden nachgeladene Elemente nicht beobachtet.

### 3. Text-Zittern beim Hover (dezent)
Headlines, Logo-Wortmarke und Tool-Namen zittern minimal beim Hover. Rein CSS:
```css
@keyframes jitter { 0%,100%{transform:translate(0,0)} 33%{transform:translate(-0.5px,0.5px)} 66%{transform:translate(0.5px,-0.5px)} }
```
Auf dem Element: `cursor:default;` + Hover-Regel `animation: jitter .4s ease;` (im DC-Prototyp als `style-hover` umgesetzt — in Vanilla als `.klasse:hover { animation: jitter .4s ease; }`).

### Weitere States
- **Karten-Hover:** `transform: translateY(-2 bis -3px)` + Rand in Signaturfarbe @0.3–0.4 + weicher Farbschatten (`0 14px 44px <accent@0.18>`). Transition `.25s`.
- **Buttons:** Primär (Verlauf) → `translateY(-1px)` + stärkerer Schatten. Ghost (`rgba(255,255,255,0.05)` + `1px border rgba(255,255,255,0.1)`) → Hintergrund auf `rgba(255,255,255,0.1)`.
- **Abmelden-Button-Hover:** rötlich (`background rgba(255,99,71,0.12)`, `color #ff8a70`).
- **Inputs-Fokus:** Rand in Signaturfarbe @0.6, Hintergrund `rgba(255,255,255,0.07)`.
- **Status-Punkt „ONLINE":** grün `#34d399` mit `@keyframes pulse {0%,100%{opacity:1}50%{opacity:.35}}` (2 s).

---

## Screens / Views

Details je Screen — Layout, Komponenten, Copy. **Exakte Struktur, Zahlen und Texte stehen in den beiliegenden `*.dc.html`-Dateien** (dort sind alle Inline-Styles final).

### 1. Portal — `Portal Redesign.dc.html` → `public/portal/index.html`  · Signatur **Orange**
- **Zweck:** Einstiegs-Übersicht; Auswahl eines Tools.
- **Layout:** Vollflächig, dunkel. Zentrierter Content `max-width:1040px`, `padding:40px 24px 80px`. Zwei Glow-Flächen dahinter.
- **Komponenten:**
  - Header (Reveal 0): Logo-Mark (Orange-Verlauf, 38px, innen 14px Border-Quadrat) + Wortmarke „ToolBox" (jitter). Rechts: Mono-Badge `AES-256 · ZERO-KNOWLEDGE`, Avatar „M", Name, Abmelden-Ghost-Button.
  - Begrüßung (Reveal 1): Mono-Kürzel `// PORTAL` (Orange `#ff9f43`), H1 „Willkommen zurück, Michael" (44px, jitter), Subline `--text-2`.
  - Erinnerungen-Panel (Reveal 2): Titel mit Glocken-Icon, Mono-Zähler; Zeilen mit Name + Datum/Notiz + Pill (Amber „3d verbleibend" / Rot „4d überfällig").
  - Tool-Grid (Reveal 3–7): `grid` `minmax(320px,1fr)`, gap 18. Karten (`<a>`): Icon-Kachel (Tool-Farbe@13 %, Line-Icon), Status-Pill (`● Verfügbar` / `● Admin`), Titel (jitter), Beschreibung, Mono-Routenhinweis `/app/… →`. Jede Karte `data-glow-color` = Tool-Farbe. „Aufgaben"-Karte deaktiviert (dashed border, `opacity .72`, Pill „Demnächst").
- **Verhalten:** Admin-Karten (Server, Administration) nur bei `user.role === 'admin'` einblenden (bestehende Logik beibehalten). Reminders-Karte per `/api/reminders/upcoming` befüllen (Logik bleibt, nur Markup/Styles neu).

### 2. Profil — `Profil.dc.html` → `public/portal/profil.html`  · Signatur **Orange**
- **Layout:** Zentrierte Einzelspalte `max-width:640px`.
- **Komponenten:** Zurück-Link + Name + Abmelden; `// KONTO` + H1 „Profil"; Karte Avatar (60px Orange-Verlauf) + „Mitglied seit"; Karte „Persönliche Daten" (Inputs Name/E-Mail/Aktuelles Passwort, Primär-Button „Änderungen speichern"); Karte „Datenexport" (Ghost-Button PDF); Karte „Gefahrenzone" (roter Rahmen `rgba(255,59,48,0.2)`, roter Button „Konto unwiderruflich löschen"). Löschen öffnet Bestätigungs-Modal (Passwort-Eingabe) — Modal im neuen Dark-Stil.

### 3. Finanzen (Dashboard) — `Finanzen.dc.html` → `public/apps/finanzen/index.html`  · Signatur **Teal**
- **Layout:** Sidebar (250px) + Main. Die App hat mehrere Seiten (Dashboard/Ausgaben/Einnahmen/Kategorien) — **hier ist das Dashboard ausgestaltet**; Ausgaben/Einnahmen/Kategorien nach demselben System bauen (Tabellen/Listen/Karten wie in Admin/Portal, Teal als Akzent).
- **Sidebar:** „Zur Übersicht", Logo „Finanz" (Teal-Mark, jitter), Gruppe ÜBERSICHT → Dashboard (aktiv, Teal-Rand+Füllung), Gruppe VERWALTUNG → Ausgaben/Einnahmen/Kategorien (Line-Icons), „Verbleibend"-Karte (Teal-Wert), Nutzerzeile + Logout.
- **Main:** Monatswähler (‹ Juli 2026 ›, oben rechts); Header `// DASHBOARD` + H1 + PDF-Export-Ghost-Button; 4 KPI-Karten (Einnahmen `#34d399`, Ausgaben `#fb7185`, Verbleibend `#2dd4bf`, Sparquote `#fbbf24`) je mit Icon-Kachel + Mono-Label + großer Zahl, `data-glow-color` = KPI-Farbe; Erinnerungen-Panel; Chart-Reihe: Donut „Ausgaben nach Kategorie" (CSS `conic-gradient`, Loch = Panel-Farbe, Center „Gesamt 1.653 €") + Legende, und „Top-Ausgaben" (horizontale Balken, Teal-Verlauf); „Budget-Verteilung" (segmentierter Balken + Legende).
- **Kategorie-Palette (Donut/Budget):** Wohnen `#2dd4bf`, Lebensmittel `#38bdf8`, Freizeit `#fb7185`, Mobilität `#a78bfa`, Versicherungen `#818cf8`, Gesundheit `#34d399`, Abonnements `#fbbf24`.

### 4. Notizen — `Notizen.dc.html` → `public/apps/notizen/index.html`  · Signatur **Violett**
- **Layout:** Sidebar (268px) + Editor-Main.
- **Sidebar:** „Zur Übersicht", Logo „Notizen" (Violett-Mark), Suchfeld, SEITEN-Baum (aufklappbare Ordner mit Emoji-Seitensymbolen; aktive Seite Violett-Füllung), „+ Neue Seite" (dashed Violett), Nutzerzeile.
- **Main-Editor:** Breadcrumbs (Mono), Titelzeile (Emoji-Icon + H1 „toolb0x" + „✓ Gespeichert" + Pin), Toolbar (B/I/U · H1/H2 · Liste · Code · Link) als Segmented-Bar, Editor-Inhalt (`contenteditable`) mit H2/H3, Absätzen, Code-Block (`panel-inset`, Violett-Mono), Liste mit Inline-`<code>` (Amber), Blockquote (Violett-Rand). Inline-Code-Farbe Amber `#fbbf24@bg 0.1`.

### 5. Passwort-Manager — `Passwörter.dc.html` → `public/apps/passwords/index.html`  · Signatur **Amber**
- **Layout:** Header + zentrierter Main `max-width:840px`.
- **Komponenten:** Generator-Karte (`// GENERATOR`): Passwort-Ausgabe (Mono, Amber, `#12161d`-Feld) + Kopieren/Neu-Buttons; Stärke-Balken (grün „Sehr stark") + Label; Längen-Slider (`input[type=range]`, `accent-color:#fbbf24`, Wert 16); Toggle-Grid (4 aktive Amber-Pills: Groß/Klein/Zahlen/Sonderzeichen + „Merkbar (Passphrase)" volle Breite); Primär-Button „Speichern". Darunter „Gespeicherte Passwörter": Suchfeld + „+ Manuell"; Liste von Karten (Buchstaben-Kachel, Name, Benutzername, maskierte Punkte `••••`, Anzeigen-/Kopieren-Icons). Beispiele: Netflix, GitHub, Amazon. Speichern/Bearbeiten & Löschen → Modals im Dark-Stil.

### 6. Server — `Server.dc.html` → `public/apps/servers/index.html`  · Signatur **Blau**
- **Layout:** Header + zentrierter Main `max-width:1000px`.
- **Komponenten:** Header `// INFRASTRUKTUR` + H1 „Meine Server" + Primär-Button „＋ Server hinzufügen"; Liste von Server-Karten: Icon-Kachel (Server-Line-Icon) + Name + Mono-`user@host:port`, Status-Pill (grün „ONLINE" mit Puls / rot „OFFLINE"), Refresh-Button; drei Mini-Auslastungs-Balken (CPU blau, RAM violett, Disk grün) mit Prozent; Aktions-Buttons (Updates prüfen [Blau], Neustart, Bearbeiten). Offline-Karte reduziert (ohne Stats, `opacity .85`). Add/Edit- & Confirm-Modals im Dark-Stil (Auth-Umschalter Passwort/SSH-Key).

### 7. Admin — `Admin.dc.html` → `public/apps/admin/index.html`  · Signatur **Indigo**
- **Layout:** Schmale Sidebar (230px) + Main.
- **Sidebar:** Logo „Admin" (Indigo-Mark), Nav „Übersicht" aktiv, unten „Zur Übersicht".
- **Main:** `// ADMINISTRATION` + H1 „System-Übersicht" + Subline; 4 Stat-Karten (Nutzer gesamt `#818cf8`, Aktiv `#34d399`, Gesperrt `#ff6b60`, Letzte Registrierung `#38bdf8`); Überschrift „Alle Nutzer"; Nutzertabelle (Spalten: Nutzer[Name+Mail], Rolle[Pill: Admin/Nutzer/Gesperrt], Registriert, Daten[„x Ausg. · y Einn. · z Kat."], Aktion[Sperren rot / Entsperren grün / „Du"]). Zeilen-Hover `rgba(255,255,255,0.03)`. Bestehende Sperr-/Entsperr-Logik beibehalten.

---

## State Management (bestehend beibehalten)
Keine neue State-Architektur nötig — alle Screens behalten ihre vorhandene Vanilla-JS-Logik:
- Auth via `/api/auth/me|login|logout|register`, Session-Timeout (`/shared/session-timeout.js`), CSRF-Token aus Cookie.
- Finanzen: Monat-State + `/api/expenses|income|categories|expenses/summary`.
- Passwörter/Server/Notizen/Admin: jeweilige CRUD-Endpunkte.
Nur das **Rendering** (Markup/Styles) ändert sich; IDs/Hooks beibehalten.

## Assets
Keine Bild-Assets. Alle Icons sind Inline-SVG-Line-Icons (in den `.dc.html`-Dateien enthalten, direkt übernehmbar). Fonts: Space Grotesk + JetBrains Mono über Google Fonts (`<link>` in `<head>`; bei strenger CSP ggf. Fonts selbst hosten und `font-src` erlauben).

## Files (in diesem Bundle)
- `Portal Redesign.dc.html` — Portal (Orange)
- `Profil.dc.html` — Profil (Orange)
- `Finanzen.dc.html` — Finanzen-Dashboard (Teal)
- `Notizen.dc.html` — Notizen-Editor (Violett)
- `Passwörter.dc.html` — Passwort-Manager (Amber)
- `Server.dc.html` — Server-Verwaltung (Blau)
- `Admin.dc.html` — Admin (Indigo)

## Umsetzungs-Reihenfolge (Vorschlag)
1. Ein gemeinsames „Obsidian"-Stylesheet + `initGlow/initReveal/jitter`-Helper anlegen und in alle Seiten einbinden (reduziert Duplikate).
2. Portal → Profil (einfachste, geteilte Muster) → Admin/Server/Passwörter (Header+Liste) → Finanzen (komplex, mehrere Unterseiten) → Notizen (Editor).
3. Pro Seite: `<style>` ersetzen, statisches Markup ersetzen, JS-gerenderte Template-Strings auf neue Klassen umstellen, Reveal nach Daten-Render initialisieren, testen (Login-Flow + CRUD unverändert).
