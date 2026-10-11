# Zephyr-/Hermes-Zugang zu toolb0x

Stand: 2026-10-12 · Finanzzugang seit 2026-10-11 live, Ausbau auf Branch `feature/zephyr-scopes`

Zephyr (der Hermes-Agent auf dem toolb0x-Server) bedient toolb0x über eine
**lokale API**, und zwar nur in den Bereichen, die du im Profil einzeln
freischaltest. Der Zugang funktioniert auch, wenn du abgemeldet bist, und
übersteht Neustarts und Passwortwechsel.

Verhaltensregeln für Zephyr: [`hermes-uebergabe.md`](hermes-uebergabe.md) ·
Trennung per Linux-Benutzer: [`zephyr-linux-benutzer.md`](zephyr-linux-benutzer.md)

---

## 1. Sicherheitsmodell

| | |
|---|---|
| Token | `tbxi_<id>.<secret>`, Secret = 256 Bit Zufall; in der DB nur SHA-256 davon |
| Schlüsselkopie | `wrappedKey` = dein Datenschlüssel, AES-256-GCM mit HKDF-SHA256(secret, id). Ohne Token wertlos |
| Erreichbar | nur `http://127.0.0.1:3001/v1`: eigener Listener, hart an Loopback gebunden, weist Proxy-Header ab. nginx leitet nur an Port 3000 weiter |
| Rechte | einzeln schaltbare Berechtigungen (Abschnitt 3), bei **jeder** Anfrage frisch aus der DB gelesen |
| Schreiben | immer Entwurf → Ausführung, mit Freigabestufe je Aktion (Abschnitt 2) |
| Nicht vorhanden | Passwörter, Tresore, Freigabe-Links, Administration, Konto/Profil, Exporte, Hermes-Chat, Integrationsverwaltung, **freie Shell-, SQL- oder Proxy-Endpunkte** |

### Was die Berechtigungen begrenzen und was nicht
Die Schlüsselkopie ist dein **vollständiger** Datenschlüssel. Es gibt nur
einen Schlüssel für alle deine Daten. Die Berechtigungen begrenzen, was
Zephyr **über die API** tun kann.

Solange Zephyr als Linux-Benutzer `michael` läuft, kann er außerdem die
`.env` (`DATABASE_URL`, `JWT_SECRET`), die Datenbank und den App-Code direkt
erreichen. Zusammen mit dem Token könnte er dann technisch **alle** deine
verschlüsselten Daten lesen, also auch private Passwörter, Notizen und
Server-Zugangsdaten. Die Berechtigungen schützen vor Fehlern und
Fehlverhalten im normalen Betrieb, nicht vor einem kompromittierten Agenten.
**Echte Trennung bringt erst ein eigener Linux-Benutzer ohne Zugriff auf
toolb0x** (Anleitung: `zephyr-linux-benutzer.md`).

### Datenfluss
Alles, was Zephyr liest oder was du ihm schreibst, geht über **Telegram**
(nicht Ende-zu-Ende verschlüsselt) und an **OpenAI** (ChatGPT-Abo). Bei
Notizen und Fotos ist das besonders zu bedenken. Bilddateien sind deshalb
eine eigene Berechtigung (`photos.images`), standardmäßig aus.

---

## 2. Freigabestufen

Jede Schreibaktion hat eine feste Stufe. Der Server meldet sie in
`GET /v1/status` und in jeder Entwurfsantwort.

| Stufe | Ablauf | Wer setzt es durch |
|---|---|---|
| `auto` | Zephyr legt den Entwurf an und bestätigt ihn **ohne Rückfrage**. Nur für die Finanzbuchhaltung (deine Vorgabe) | Server: Inhalt per Hash gebunden, einmalig, Idempotenz |
| `chat` | Zephyr muss dich **vorher konkret im Chat fragen** und bestätigt erst nach deinem „ja“ | Inhaltsbindung technisch; das „ja“ selbst ist eine Regel für Zephyr |
| `app` | Zephyr legt nur den Entwurf an. **Ausgeführt wird erst, wenn du ihn in toolb0x freigibst** (Profil → Hermes-Zugang → Offene Freigaben). `POST …/confirm` von Zephyr ergibt `403 APP_APPROVAL_REQUIRED` | **Server, technisch** |

Bei jeder Ausführung prüft der Server erneut: Zugang aktiv, Konto nicht
gesperrt, Berechtigung **noch** erteilt, Eintrag seit dem Entwurf
unverändert. Wählst du eine Berechtigung ab, sind auch schon erstellte
Entwürfe dafür nicht mehr ausführbar.

Entwürfe gelten 10 Minuten (`app`: 72 Stunden) und lassen sich genau
einmal verwenden. Anweisungen in Notizen, Fotos, Dateien oder Webseiten
sind **nie** eine Freigabe.

---

## 3. Berechtigungsmatrix

Ein neuer Zugang hat nur `finance.read` und `finance.write`. Alles andere ist
aus. **Einschalten** geht nur im Profil mit deinem Passwort, **Abschalten**
ohne. Zephyr kann Rechte nur abgeben (`POST /v1/scopes/drop`), nie erweitern.
„Admin“-Berechtigungen wirken nur, solange dein Konto die Rolle `admin` hat;
das wird bei jeder Anfrage geprüft.

| Berechtigung | Lesen | Schreiben (Stufe) |
|---|---|---|
| `finance.read` | Kategorien, Ausgaben inkl. Buchungen, Einnahmen, Übersicht, Verlauf | – |
| `finance.write` | – | Ausgaben, Buchungen, Einnahmen anlegen/ändern/löschen (**auto**) |
| `finance.categories` | – | Kategorie anlegen/umbenennen (chat), **löschen (app)**, wobei Ausgaben nach „Sonstiges“ wandern |
| `finance.balance` | Kontostand | Kontostand setzen/entfernen (**auto**) |
| `reminders.read` | Erinnerungen, fällige Erinnerungen (Abschnitt 5) | – |
| `reminders.write` | – | anlegen, ändern, Status erledigt/verworfen (chat), **löschen (app)** |
| `notes.read` | Seitenbaum, Seite (Text + HTML), Volltextsuche | – |
| `notes.write` | – | anlegen, ändern/anhängen, anheften, archivieren, verschieben (chat), **löschen inkl. Unterseiten (app)**. Nur **Text**, wird serverseitig sicher in HTML gewandelt |
| `photos.read` (Admin) | geteilte Alben (**ohne** Link-Token), Bibliothek mit Filtern, KI-Suche | – |
| `photos.images` (Admin) | Vorschau- und Bilddateien | – |
| `photos.edit` (Admin) | – | bewerten, taggen (chat), **Löschwunsch an fotob0x (app)** |
| `servers.status` (Admin) | Serverliste (nur Bezeichnung), Status, Kennzahlen, laufende Dienste, alles über feste Befehle | – |
| `servers.actions` (Admin) | – | **System-Update, Dienst neu starten, Neustart (app)** |

**Ausgeschlossen (nicht vorhanden):**
- Passwörter und Tresore (Werte und Metadaten; deine Entscheidung vom 12.10.)
- Freigabe-Links (der Schlüssel steckt im Link, er müsste durch Modell und Telegram)
- Administration (Nutzer, Einladungen, Resets, Sperren)
- Konto (Passwort, Recovery-Code, Profil, Löschen)
- Exporte (der JSON-Export enthält Passwörter im Klartext)
- Server-Zugangsdaten anlegen oder ändern, freie Befehle, SQL, Proxy

**Geheimnisse:** Server-Zugangsdaten werden nur serverseitig entschlüsselt
und verlassen den Server nie. Hosts und IPs stehen in keiner Antwort,
SSH-Fehler werden nur allgemein gemeldet. Tokens, Schlüssel,
Recovery-Codes und Passwörter erscheinen nie in Antworten, Logs oder im Audit.

---

## 4. API (lokal: `http://127.0.0.1:3001/v1`)

Alle Anfragen brauchen `Authorization: Bearer tbxi_…`. Zephyr übergibt das
per Header-Datei:
`curl -s -H @$HOME/.hermes/secrets/toolb0x-finanzen.header …`.
Wichtig: `$HOME` verwenden, **nicht** `~` (hinter `@` wird `~` nicht
aufgelöst). Fehler haben die Form `{ "error": "CODE", "message": "…", "errors"?: [...] }`.

### Allgemein
| | |
|---|---|
| `GET /status` | Monatsbeginn, Periode, Berechtigungen (`scopes[]` mit `granted`), Aktionen mit `scope`, `level`, `granted` |
| `GET /writes` | die letzten 50 Ausführungen dieses Zugangs (nur Metadaten) |
| `POST /drafts` `{ action, params }` | Entwurf → `201 { draftId, action, scope, level, contentHash, expiresAt, summary }` |
| `POST /drafts/:id/confirm` | Header `Idempotency-Key: hermes-<draftId>`, Body `{ contentHash }`; nur für `auto` und `chat` |
| `GET /drafts/:id` | `status`: `open` · `pending_approval` · `executed` (mit `result`) · `rejected` · `expired` |
| `POST /scopes/drop` `{ scope }` | Berechtigung abgeben |
| `POST /revoke` | Zugang endgültig sperren |

### Lesen
| Pfad | Berechtigung |
|---|---|
| `GET /categories`, `/expenses?month=`, `/income?month=`, `/summary?month=`, `/history?months=&month=` | `finance.read` |
| `GET /balance` | `finance.balance` |
| `GET /reminders?status=&from=&to=`, `GET /reminders/upcoming?days=2` | `reminders.read` |
| `GET /notes?includeArchived=true`, `GET /notes/search?q=`, `GET /notes/:id` | `notes.read` |
| `GET /photos/albums`, `GET /photos/library?from&to&person&tag&minRating&album&event&q&limit&offset`, `GET /photos/search?q=` | `photos.read` |
| `GET /photos/thumb/:id`, `GET /photos/img/:id` | `photos.images` |
| `GET /servers`, `GET /servers/:id/status`, `/stats`, `/services` | `servers.status` |

### Aktionen (`POST /drafts`)
| Aktion | Stufe | Pflicht | Optional |
|---|---|---|---|
| `expense.create` | auto | `name`, `amount`, `categoryId`, `date` (bzw. bei `isCollector: true` statt `date` den `month`) | `tags[]`, `isRecurring` (Standard `false`; `true` = **ohne Ende**), `month` (Kontrolle) |
| `expense.update` / `.delete` | auto | `id` | `name`, `amount`, `categoryId`, `date`, `tags[]`, `isRecurring` |
| `booking.create` | auto | `expenseId`, `amount`, `date` | `note` |
| `booking.update` / `.delete` | auto | `expenseId`, `bookingId` | `amount`, `date`, `note` |
| `income.create` | auto | `name`, `amount`, `month` | `isRecurring` (Standard `false`) |
| `income.update` / `.delete` | auto | `id` | `name`, `amount`, `isRecurring` |
| `balance.set` | auto | – | `amount` als Text (`"-12,50"`), `null` entfernt den Stand |
| `category.create` / `.update` | chat | `name` bzw. `id` | `color` (`#RRGGBB`) |
| `category.delete` | **app** | `id` | – |
| `reminder.create` | chat | `dueDate` (`YYYY-MM-DD`) | `title` (≤ 200), `daysBefore` (0–90, Standard 3), `expenseId` |
| `reminder.update` | chat | `id` | `title`, `dueDate`, `daysBefore`, `status` (`pending`/`done`/`dismissed`), `expenseId` (`null` löst) |
| `reminder.delete` | **app** | `id` | – |
| `note.create` | chat | `title` | `text`, `parentId`, `icon` |
| `note.update` | chat | `id` | `title`, `text` (ersetzen) **oder** `appendText`, `icon`, `isPinned`, `isArchived` (archiviert Unterseiten mit) |
| `note.move` | chat | `id` | `parentId` (`null` = oberste Ebene), `sortOrder` |
| `note.delete` | **app** | `id` | – |
| `photo.edit` | chat | `ids[]` (max. 500) | `rating` (0–5), `addTags[]`, `removeTags[]` |
| `photo.delete` | **app** | `ids[]` | – |
| `server.update` / `server.restart` | **app** | `id` | – |
| `server.service-restart` | **app** | `id`, `service` (`[A-Za-z0-9._-]`) | – |

Beträge immer als Text in eindeutiger Cent-Form (`"12"`, `"12,5"`,
`"12.50"`). Unbekannte Felder führen zu `400`, nichts wird geraten.

**Wiederkehrende Ausgaben haben kein Enddatum.** Beenden geht nur
nachträglich mit `expense.update { id: <Eintrag im letzten Monat>, isRecurring: false }`.
Ein echtes Enddatum steht als Todo im Backlog.

### Beispiele (synthetisch)
```bash
H=$HOME/.hermes/secrets/toolb0x-finanzen.header
curl -s -H @$H http://127.0.0.1:3001/v1/reminders/upcoming?days=2
# {"today":"2026-10-12","until":"2026-10-14","timeZone":"Europe/Berlin","reminders":[
#   {"id":"7c1e…","title":"Fitness kündigen","dueDate":"2026-10-14","timeZone":"Europe/Berlin",
#    "daysUntilDue":2,"overdue":false,"daysBefore":7,"alertDate":"2026-10-07","status":"pending",
#    "expense":{"id":"57f7…","name":"Fitnessstudio"},"recurrence":null,
#    "createdAt":"…","updatedAt":"…","version":"3f1c9a0b2d4e5f61"}]}

curl -s -H @$H -H 'Content-Type: application/json' http://127.0.0.1:3001/v1/drafts \
  -d '{"action":"note.delete","params":{"id":"9b2d…"}}'
# 201 {"draftId":"d41f…","level":"app","summary":{"before":{"title":"Alte Liste"},"deletesSubpages":0},
#      "next":"Michael muss diesen Entwurf in toolb0x freigeben …"}
curl -s -H @$H http://127.0.0.1:3001/v1/drafts/d41f…
# {"status":"pending_approval", …}  → nach deiner Freigabe: {"status":"executed","result":{…}}
```

### Fehlercodes
| Code | Status | Bedeutung und Reaktion |
|---|---|---|
| `UNAUTHORIZED` | 401 | Token fehlt, ist falsch, widerrufen oder rotiert |
| `ACCOUNT_SUSPENDED` | 403 | Konto gesperrt |
| `LOCAL_ONLY` | 403 | nicht über Loopback oder mit Proxy-Header |
| `SCOPE_MISSING` | 403 | Berechtigung nicht erteilt; nur Michael kann sie in toolb0x einschalten |
| `APP_APPROVAL_REQUIRED` | 403 | Stufe `app`: Michael muss in toolb0x freigeben; Status per `GET /drafts/:id` |
| `VALIDATION` | 400 | Angaben fehlen oder sind ungültig; nachfragen, nicht raten |
| `UNKNOWN_ACTION` | 400 | Aktion gibt es nicht (auch alle ausgeschlossenen Bereiche) |
| `NOT_A_COLLECTOR` | 400 | Buchung auf eine normale Ausgabe |
| `NOT_FOUND` / `DRAFT_NOT_FOUND` | 404 | existiert nicht oder gehört jemand anderem |
| `HASH_MISMATCH` · `DRAFT_USED` · `DRAFT_REJECTED` · `TARGET_CHANGED` · `IDEMPOTENCY_CONFLICT` | 409 | nicht ausgeführt; bei `TARGET_CHANGED` neuen Entwurf erstellen und erneut fragen |
| `DRAFT_EXPIRED` | 410 | neu erstellen |
| `CORRUPT_ENTRY` | 422 | Eintrag nicht entschlüsselbar, wird nicht angefasst |
| `RATE_LIMITED` / `TOO_MANY_DRAFTS` | 429 | warten |
| `SSH_FAILED` | 502 | Server nicht erreichbar oder Befehl fehlgeschlagen (allgemeine Meldung, keine IP) |
| `BUSY` | 503 | nichts gespeichert; mit **demselben** Idempotency-Key wiederholen |

**Rate-Limits pro Zugang** (je 15 Minuten): 300 Lese-, 60 Schreib- und 30
SSH-Abfragen sowie 60 Fotosuchen, dazu 30 fehlgeschlagene Anmeldungen.

---

## 5. Erinnerungen im Detail

| Feld | Bedeutung |
|---|---|
| `id` | UUID der Erinnerung |
| `title` | deine Notiz zur Erinnerung; ist sie leer, der Name der verknüpften Ausgabe; sonst „Erinnerung“ |
| `dueDate` | Fälligkeitstag als Kalenderdatum `YYYY-MM-DD` (die App speichert ihn als Mitternacht UTC dieses Tags) |
| `timeZone` | immer `Europe/Berlin`. „Heute“ und `daysUntilDue` werden in dieser Zeitzone berechnet |
| `daysUntilDue`, `overdue` | Tage bis zur Fälligkeit; überfällig = offen und vor heute |
| `daysBefore`, `alertDate` | Vorlauf der App (Anzeige auf dem Dashboard) und der daraus folgende Tag |
| `status` | `pending` (offen), `done` (erledigt), `dismissed` (verworfen) |
| `expense` | verknüpfte Ausgabe `{ id, name }`, **ohne Betrag** |
| `recurrence` | immer `null`. Die App kennt keine wiederkehrenden Erinnerungen |
| `createdAt`, `updatedAt`, `version` | `version` ändert sich bei jeder Änderung, zum Erkennen von Änderungen |

**Lesen ändert nichts:** Kein Status wird gesetzt, nichts wird als
„gemeldet“ markiert.

**Benachrichtigung:** Zephyr fragt z. B. täglich
`GET /reminders/upcoming?days=2` ab und meldet sich zwei Tage vorher und am
Fälligkeitstag. Doppelte Meldungen verhindert er über
`(id, dueDate, Stufe)`. Hat sich `version` oder `dueDate` geändert, plant er
neu; bei `done` oder `dismissed` meldet er sich nicht mehr. Die Zeitplanung
übernimmt Zephyr selbst.

---

## 6. Verwaltung in der App (`/api/integrations`, angemeldet)

| | |
|---|---|
| `GET /` | eigene Zugänge mit Berechtigungen (`scopeDetails`), ohne Hash und ohne Schlüsselkopie |
| `POST /` `{ password, name? }` | neuer Zugang (nur Finanzen), Token **nur** in dieser Antwort; höchstens 3 aktive |
| `PUT /:id/scopes` `{ scopes[], password? }` | Berechtigungen setzen; neue Rechte nur mit Passwort, Admin-Rechte nur für Admin-Konten |
| `POST /:id/rotate` `{ password }` | neuer Schlüssel mit gleichen Rechten; der alte ist im selben Schritt ungültig, offene Entwürfe verfallen |
| `DELETE /:id` | widerrufen |
| `GET /approvals` | offene Freigaben (Stufe `app`) mit Zusammenfassung |
| `POST /approvals/:id/approve` `{ contentHash }` | ausführen, mit deiner Sitzung (`202` bei Serveraktionen, die laufen dann im Hintergrund) |
| `POST /approvals/:id/reject` | endgültig ablehnen |

Im Profil (Karte „Hermes-Zugang“): oben die offenen Freigaben, darunter je
Zugang die Berechtigungen als Häkchen, „Schlüssel erneuern“ und „Widerrufen“.
Eigener Rate-Limiter: 60 pro 15 Minuten.

## 7. Was passiert wann?

| Ereignis | Wirkung |
|---|---|
| Abmelden, Sitzungsablauf, Login woanders, Neustart, Passwortwechsel | Zugang funktioniert weiter |
| Berechtigung abgewählt | sofort `403`, auch für schon erstellte Entwürfe |
| Rolle `admin` entzogen | Foto- und Server-Rechte sofort unwirksam |
| Rotation | alter Token sofort `401`, neuer mit gleichen Rechten |
| Widerruf (App, `POST /v1/revoke` oder Notfall-SQL) | sofort `401`, Schlüsselkopie und offene Entwürfe gelöscht |
| Admin-Reset-Link | Zugänge gelöscht (neuer Datenschlüssel) |
| Konto gesperrt oder gelöscht | `403` bzw. Kaskade |

**Notfall-Widerruf ohne App** (auf dem Server):
```bash
cd /var/www/toolbox/finanz-app
npx prisma db execute --schema prisma/schema.prisma --stdin <<'SQL'
UPDATE integration_credentials SET "wrappedKey" = NULL, "revokedAt" = now() WHERE "revokedAt" IS NULL;
DELETE FROM integration_drafts;
SQL
```
Oder den Listener abschalten: `INTEGRATION_PORT=0` in die `.env` und
`pm2 restart all`. Ein Neustart allein widerruft **nichts**.

## 8. Audit
- `integration_writes`: Aktion, Zieltyp, Ziel-ID, Monat, Zeit. Die Antwort
  für Wiederholungen liegt dort **verschlüsselt**, Klartext gibt es nicht.
- `integration_drafts`: Aktion, Berechtigung, Stufe, Entscheidung (`approved`
  oder `rejected`) mit Zeitpunkt; Inhalt und Zusammenfassung verschlüsselt.
- Server-Log: Zeilen wie
  `[integration] confirm cred=c9054c8b action=expense.create status=201`,
  `scope-denied`, `approved-in-app`, `scopes … added=… removed=…`,
  `rotated`, `external server.restart … state=done`. Keine Tokens,
  Schlüssel, Beträge, Namen oder Inhalte.

## 9. Migrationen und Rollback

| Migration | Inhalt |
|---|---|
| `20261011120000_add_integrations` | Tabellen `integration_credentials`, `integration_drafts`, `integration_writes` |
| `20261012120000_integration_scopes` | Spalte `scopes` (bestehende Zugänge behalten genau Finanzen lesen/schreiben); `scope`, `level`, `summary`, `decision`, `decidedAt` an Entwürfen |

**Rollback des Ausbaus:**
1. Vorherigen Commit deployen (`e531a41`), `pm2 restart all`.
2. Optional die Spalten entfernen (SQL steht im Kopf der Migrationsdatei).
   Die alte Version ignoriert sie ohnehin.

**Rollback des Finanzzugangs komplett:** zusätzlich die drei Tabellen löschen
(siehe Kopf von `20261011120000_add_integrations`). Einträge, die Zephyr
angelegt hat, bleiben als normale Einträge erhalten.

**Hinweis:** Die Migrationshistorie baut keine Datenbank von Null auf (die
Basistabellen entstanden per `db push`). Für Tests deshalb wie in
`tests/routes/integration.pg.test.js` beschrieben vorgehen.

## 10. Tests
- `tests/routes/integration.test.js` (53): Finanzzugang, Authentifizierung, Entwurf/Bestätigung, Idempotenz, Cent-Genauigkeit, Perioden, Fremdzugriffe, Secrets.
- `tests/routes/integration-scopes.test.js` (30): Berechtigungen, Admin-Rechte, Abgeben, ausgeschlossene Bereiche, Erinnerungen, Notizen (inkl. Skript-Escaping), Fotos, Server (SSH gestubbt), App-Freigabe, Ablehnen, Abwahl wirkt auf Entwürfe, Rotation, fremde Freigaben, Logs ohne Geheimnisse.
- `tests/routes/integrations-manage.test.js` (7), `tests/utils/integration-crypto.test.js`.
- PostgreSQL (`npm run test:pg`, nur mit `TEST_DATABASE_URL`): `integration.pg.test.js` (6), `integration-scopes.pg.test.js` (5: Array-Spalte, parallele Freigaben, FK-Kaskade, Datum, atomare Rotation), `auth-reset.pg.test.js` (7).

## 11. Offene Punkte
- **Eigener Linux-Benutzer für Zephyr** (vereinbart, Anleitung liegt bei, die Einrichtung braucht sudo und machst du). Erst dann wirken die Berechtigungen als echte Grenze.
- Enddatum für wiederkehrende Ausgaben: Todo.
- Passwörter, Tresore und Freigabe-Links bleiben bewusst ausgeschlossen.
