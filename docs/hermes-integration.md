# Hermes-Zugang zur Finanz-App

Stand: 2026-10-11 · Branch `feature/hermes-erfassung`

Mit diesem Zugang kann der Hermes-Agent auf dem toolb0x-Server deine Finanzen
**lesen** und **nach deiner Bestätigung** Ausgaben, Buchungen auf Sammelposten
und Einnahmen **anlegen, ändern und löschen**. Er funktioniert immer: auch wenn
du abgemeldet bist, nach Neustarts und nach einem Passwortwechsel.

---

## 1. Sicherheitsmodell in einem Satz

In der DB liegt eine Kopie deines Datenschlüssels. Sie ist mit einem Schlüssel
verschlüsselt, der aus dem Hermes-Token abgeleitet wird. Den Token selbst
speichert der Server nicht, nur dessen Hash. Wer den Token hat, kann deine
**Finanzdaten** entschlüsseln. Widerrufen löscht die Kopie, danach ist der
Token wertlos.

| | |
|---|---|
| Token-Format | `tbxi_<id>.<secret>`, Secret = 256 Bit Zufall |
| In der DB | `secretHash` (SHA-256) und `wrappedKey` (AES-256-GCM, Schlüssel = HKDF-SHA256(secret, id)) |
| Erreichbar | nur `http://127.0.0.1:3001/v1` (eigener Listener, nicht über nginx) |
| Rechte | nur Finanz-App: Kategorien (nur lesen), Ausgaben, Buchungen, Einnahmen, Übersicht, Verlauf |
| Nicht erreichbar | Passwörter, Tresore, Notizen, Server, Exporte, Admin, Konto/Profil, andere Nutzer |
| Schreiben | immer zweistufig: Entwurf → Bestätigung mit `contentHash` und `Idempotency-Key` |

### Was technisch garantiert ist und was nur eine Hermes-Regel ist

**Technisch garantiert (Server):**
- Ohne gültigen, nicht widerrufenen Token geht nichts (`401`), gesperrte Konten bekommen `403`.
- Konto und Rechte bestimmt der Server aus dem Token. Eine `userId` lässt sich nicht übergeben (unbekannte Felder führen zu `400`). Fremde Kategorien, Posten und Einträge sind nicht sichtbar (`404`).
- Jede Schreibaktion braucht einen Entwurf. Die Bestätigung ist an genau diesen Inhalt gebunden (`contentHash`), läuft nach **10 Minuten** ab und lässt sich **einmal** verwenden.
- Ändern und Löschen sind an den Zustand des Eintrags beim Entwurf gebunden. Wurde er zwischendurch in der App geändert, gibt es `409 TARGET_CHANGED` statt einer Überschreibung.
- Idempotenz: Derselbe `Idempotency-Key` erzeugt höchstens einen Eintrag. Mit anderem Inhalt gibt es `409 IDEMPOTENCY_CONFLICT`. Gesichert ist das durch einen Unique-Index in PostgreSQL.
- Speichern, Monats-Initialisierung, Sammelposten-Summe und Idempotenz-Eintrag laufen in **einer Transaktion** (mit Zeilen- und Advisory-Sperren). Danach wird der Eintrag zurückgelesen und verglichen; bei einer Abweichung wird alles zurückgerollt.
- Beträge nur in eindeutiger Cent-Form (`12`, `12,5`, `12.50`). Datum (Ausgaben, Buchungen) bzw. Monat (Einnahmen, Sammelposten) sind Pflicht; der Finanzmonat ergibt sich aus dem Datum und dem Monatsbeginn.
- Neue Ausgaben und Einnahmen sind **einmalig**, außer bei ausdrücklichem `isRecurring: true`.
- Lesen hat keine Nebenwirkungen; insbesondere wird kein Monat initialisiert.
- Rate-Limits pro Zugang: 300 Lese- und 60 Schreibanfragen pro 15 Minuten, dazu 30 fehlgeschlagene Anmeldungen pro 15 Minuten.

**Nur Hermes-Regel (nicht technisch erzwingbar):**
- *Dass du in Telegram wirklich „ja“ gesagt hast.* Der Server kann nicht unterscheiden, ob die Bestätigung von dir kommt oder von Hermes selbst, etwa nach einer präparierten Webseite (Prompt-Injection).
- *Dass Hermes nichts rät.* Der Server lehnt fehlende Pflichtangaben ab, aber Hermes könnte ein Datum oder eine Kategorie selbst wählen.

### API-Rechte schränken die Shell nicht ein
Hermes läuft als Unix-Nutzer `michael`, also als derselbe Nutzer wie die App.
Damit kann Hermes unabhängig von diesem Zugang die `.env` lesen
(`DATABASE_URL`, `JWT_SECRET`), direkt auf die Datenbank zugreifen, den App-Code
ändern und den Token aus seiner eigenen Konfiguration lesen. Die API-Grenzen
schützen vor Fehlern im normalen Betrieb, **nicht** vor einem kompromittierten
Agenten. Echte Trennung brächte nur ein eigener Unix-Nutzer für Hermes ohne
Zugriff auf `/var/www/toolbox` (siehe offene Punkte).

### Datenfluss
Alles, was Hermes liest oder was du Hermes schreibst (Kategorienamen,
Beträge, Händler), geht über **Telegram** (Bot-Chats sind nicht
Ende-zu-Ende verschlüsselt) und an **OpenAI**, weil Hermes über das
ChatGPT-Abo läuft.

---

## 2. Was passiert wann?

| Ereignis | Hermes-Zugang |
|---|---|
| Browser-Sitzung läuft ab / Abmelden | funktioniert weiter |
| Login auf anderem Gerät | funktioniert weiter |
| pm2-Neustart / Deploy | funktioniert weiter (offene Entwürfe bleiben gültig, bis sie ablaufen) |
| Passwort ändern / Reset per Recovery-Code | funktioniert weiter (der Datenschlüssel ändert sich nicht) |
| Admin-Reset-Link (löscht alle Daten, neuer Schlüssel) | Zugang wird gelöscht |
| Konto gesperrt | `403`, bis entsperrt |
| Konto gelöscht | Zugang wird mitgelöscht (Kaskade) |
| Widerruf in der App oder per Telegram | sofort `401`, Schlüsselkopie gelöscht, offene Entwürfe gelöscht |

---

## 3. Inbetriebnahme (jeder Schritt braucht deine Freigabe)

1. **Deploy** wie in `CLAUDE.md` beschrieben (`git pull`, `npm install`,
   `npx prisma migrate deploy`, `npx prisma generate`, `pm2 restart all`).
   Die Migration `20261011120000_add_integrations` legt drei neue Tabellen an
   und ändert keine bestehenden.
2. **Prüfen, dass Port 3001 nur lokal lauscht:**
   ```bash
   ss -ltnp | grep 3001          # erwartet: 127.0.0.1:3001
   grep -rn proxy_pass /etc/nginx/sites-enabled/ deploy/   # nur :3000
   curl -s -o /dev/null -w '%{http_code}\n' https://toolb0x.eu/v1/status   # erwartet: 404
   ```
   Der Listener bindet hart an `127.0.0.1`, unabhängig von `HOST`.
   `INTEGRATION_PORT=0` in der `.env` schaltet ihn ab, ein anderer Wert
   verlegt ihn.
3. **Zugang erzeugen:** Portal → Profil → „Hermes-Zugang“ → Passwort eingeben
   → „Hermes-Zugang erzeugen“. Der Schlüssel erscheint **einmal**.
4. **In Hermes eintragen** (du selbst, im Terminal auf dem Server, nicht über
   Telegram):
   ```bash
   install -m 700 -d ~/.hermes/secrets
   read -rs T    # Schlüssel einfügen, Enter — erscheint weder am Bildschirm noch in der History
   ( umask 077; printf 'Authorization: Bearer %s\n' "$T" > ~/.hermes/secrets/toolb0x-finanzen.header ); unset T
   curl -s -H @$HOME/.hermes/secrets/toolb0x-finanzen.header http://127.0.0.1:3001/v1/status   # Test
   ```
   Die Header-Datei hält den Token aus Kommandozeilen und Logs heraus: curl
   liest ihn mit `-H @datei`.
5. **Hermes die Übergabe geben:** Den Text aus `docs/hermes-uebergabe.md` als
   Skill oder Memory in Hermes hinterlegen. Das machst du selbst; ich ändere die
   Hermes-Konfiguration nicht.
6. **Test:** Schreib Hermes in Telegram „Was habe ich diesen Monat für
   Lebensmittel ausgegeben?“ und danach „Bäcker 3,40 heute“. Hermes sollte
   einen Entwurf zeigen und erst nach deinem „ja“ speichern.

## 4. Widerruf

- **App:** Profil → „Hermes-Zugang“ → „Widerrufen“ (zweimal klicken).
- **Telegram:** „Hermes, sperr den Finanz-Zugang.“ → Hermes ruft `POST /v1/revoke` auf.
- **Notfall ohne App** (auf dem Server):
  ```bash
  cd /var/www/toolbox/finanz-app
  npx prisma db execute --schema prisma/schema.prisma --stdin <<'SQL'
  UPDATE integration_credentials SET "wrappedKey" = NULL, "revokedAt" = now() WHERE "revokedAt" IS NULL;
  DELETE FROM integration_drafts;
  SQL
  ```
  Oder den Listener abschalten: `INTEGRATION_PORT=0` in die `.env` und
  `pm2 restart all`. **Achtung:** Ein Neustart allein widerruft nichts, der
  Zugang überlebt Neustarts absichtlich.

---

## 5. API (lokal: `http://127.0.0.1:3001/v1`)

Alle Anfragen brauchen `Authorization: Bearer tbxi_…`. Antworten sind JSON,
Fehler haben die Form `{ "error": "CODE", "message": "…", "errors"?: [...] }`.
Die Beispiele verwenden synthetische Werte.

### Lesen

| Methode und Pfad | Inhalt |
|---|---|
| `GET /status` | Monatsbeginn, aktuelle Periode, erlaubte Aktionen |
| `GET /categories` | `[{ id, name }]` |
| `GET /expenses?month=YYYY-MM` | Ausgaben inkl. Buchungen; `initialized: false` heißt, der Monat wurde noch nie geöffnet |
| `GET /income?month=YYYY-MM` | Einnahmen |
| `GET /summary?month=YYYY-MM` | wie das Dashboard (Summen, Kategorien, Sammelposten) |
| `GET /history?months=12&month=YYYY-MM` | Monatssummen (3–24 Monate) |
| `GET /writes` | die letzten 50 Schreibaktionen dieses Zugangs (nur Metadaten) |

```bash
H=~/.hermes/secrets/toolb0x-finanzen.header
curl -s -H @$H http://127.0.0.1:3001/v1/categories
# {"categories":[{"id":"8db1eef6-…","name":"Lebensmittel"}, …]}
```

### Schreiben: Entwurf

`POST /drafts` mit `{ "action": "<aktion>", "params": { … } }` liefert
`201 { draftId, action, contentHash, expiresAt, summary }`. Gespeichert wird
dabei noch **nichts**.

| Aktion | Pflicht | Optional |
|---|---|---|
| `expense.create` | `name`, `amount`, `categoryId`, `date` | `tags[]`, `isRecurring` (Standard `false`), `month` (nur zur Kontrolle) |
| `expense.create` (Sammelposten) | `name`, `amount` (= Budget), `categoryId`, `isCollector: true`, `month` | `isRecurring` |
| `expense.update` | `id` | `name`, `amount`, `categoryId`, `date` (`null` entfernt es; nur innerhalb des Monats), `tags[]`, `isRecurring` |
| `expense.delete` | `id` | – (löscht wie in der App auch Auto-Kopien in Folgemonaten bzw. Buchungen des Postens) |
| `booking.create` | `expenseId` (Sammelposten), `amount`, `date` | `note` |
| `booking.update` | `expenseId`, `bookingId` | `amount`, `date`, `note` |
| `booking.delete` | `expenseId`, `bookingId` | – |
| `income.create` | `name`, `amount`, `month` | `isRecurring` (Standard `false`) |
| `income.update` | `id` | `name`, `amount`, `isRecurring` |
| `income.delete` | `id` | – |

Monat verschieben und Sammelposten umschalten gehen nur in der App.

```bash
curl -s -H @$H -H 'Content-Type: application/json' http://127.0.0.1:3001/v1/drafts \
  -d '{"action":"booking.create","params":{"expenseId":"57f7c7a8-…","amount":"23,85","date":"2026-10-11","note":"Wocheneinkauf"}}'
# {"draftId":"9042…","action":"booking.create","contentHash":"3f1c…(64 hex)",
#  "expiresAt":"2026-10-11T10:10:00.000Z",
#  "summary":{"collector":{"id":"57f7…","name":"Rewe","month":"2026-10"},"amount":"23.85","note":"Wocheneinkauf","date":"2026-10-11"}}
```

### Schreiben: Bestätigung

`POST /drafts/<draftId>/confirm` mit Header `Idempotency-Key` (16–128 Zeichen
`[A-Za-z0-9_-]`, empfohlen: `hermes-<draftId>`) und Body
`{ "contentHash": "…" }`.

```bash
curl -s -H @$H -H 'Content-Type: application/json' -H "Idempotency-Key: hermes-$DRAFT" \
  http://127.0.0.1:3001/v1/drafts/$DRAFT/confirm -d "{\"contentHash\":\"$HASH\"}"
# 201 {"ok":true,"draftId":"9042…","action":"booking.create","targetType":"booking",
#      "targetId":"3f86…","month":"2026-10","entry":{…},"total":187.35}
```

Wiederholung mit gleichem Key liefert `200` mit gleichem Inhalt und
`"replayed": true`.

### Fehlercodes

| Code | Status | Bedeutung und Reaktion |
|---|---|---|
| `UNAUTHORIZED` | 401 | Token fehlt, ist falsch oder widerrufen; nicht wiederholen |
| `ACCOUNT_SUSPENDED` | 403 | Konto gesperrt |
| `LOCAL_ONLY` | 403 | nicht über Loopback oder mit Proxy-Header |
| `VALIDATION` | 400 | Angaben fehlen oder sind ungültig, siehe `errors`; nachfragen, nicht raten |
| `UNKNOWN_ACTION` | 400 | Aktion gibt es nicht |
| `NOT_A_COLLECTOR` | 400 | Buchung auf eine normale Ausgabe |
| `NOT_FOUND` / `DRAFT_NOT_FOUND` | 404 | Eintrag oder Entwurf existiert nicht (oder gehört jemand anderem) |
| `HASH_MISMATCH` | 409 | Bestätigung passt nicht zum Entwurf |
| `DRAFT_USED` | 409 | Entwurf schon verwendet |
| `TARGET_CHANGED` | 409 | Eintrag hat sich geändert; neuen Entwurf erstellen und erneut fragen |
| `IDEMPOTENCY_CONFLICT` | 409 | Key schon für etwas anderes benutzt |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Header fehlt |
| `DRAFT_EXPIRED` | 410 | älter als 10 Minuten; neu erstellen und erneut fragen |
| `CORRUPT_ENTRY` | 422 | Eintrag nicht entschlüsselbar, wird nicht angefasst |
| `TOO_MANY_DRAFTS` / `RATE_LIMITED` | 429 | warten |
| `BUSY` | 503 | ausgelastet, nichts gespeichert; mit **demselben** Key wiederholen |
| `VERIFY_FAILED` / `INTERNAL` | 500 | nichts gespeichert; melden |

---

## 6. Verwaltung in der App (`/api/integrations`, angemeldet)

| | |
|---|---|
| `GET /api/integrations` | eigene Zugänge (ohne Hash und ohne Schlüsselkopie) |
| `POST /api/integrations` `{ password, name? }` | neuer Zugang, Token **nur** in dieser Antwort; höchstens 3 aktive |
| `DELETE /api/integrations/:id` | widerrufen |

Eigener Rate-Limiter: 10 Anfragen pro 15 Minuten.

## 7. Audit
- Tabelle `integration_writes`: pro Schreibaktion Aktion, Zieltyp, Ziel-ID,
  Monat und Zeitpunkt. Die Antwort für Wiederholungen liegt dort
  **verschlüsselt**; Klartext-Beträge oder -Namen gibt es nicht.
- Server-Log (`pm2 logs`): Zeilen wie
  `[integration] confirm cred=c9054c8b action=expense.create status=201`.
  Keine Tokens, Schlüssel, Beträge oder Namen.
- `lastUsedAt` des Zugangs (höchstens minütlich aktualisiert) steht im Profil.

## 8. Migration und Rollback

**Migration:** `prisma/migrations/20261011120000_add_integrations/`. Sie legt
`integration_credentials`, `integration_drafts` und `integration_writes` an
und ändert nichts an bestehenden Tabellen.

**Rollback:**
1. Zugänge widerrufen (Abschnitt 4).
2. Code zurücknehmen (vorherigen Commit deployen, `pm2 restart all`).
3. Tabellen entfernen (optional, die alte Version ignoriert sie):
   ```sql
   DROP TABLE "integration_writes";
   DROP TABLE "integration_drafts";
   DROP TABLE "integration_credentials";
   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261011120000_add_integrations';
   ```
Einträge, die Hermes angelegt hat, bleiben als normale Ausgaben, Buchungen
und Einnahmen erhalten.

## 9. Tests
- `tests/routes/integration.test.js`: 53 Tests gegen Mock-Prisma (Auth, Lesen ohne Nebenwirkungen, Entwurf/Bestätigung, Cent-Genauigkeit, Perioden, Fremdzugriffe, Idempotenz, Ändern/Löschen, Secrets in Antworten und Logs).
- `tests/routes/integrations-manage.test.js`: Verwaltung in der App.
- `tests/utils/integration-crypto.test.js`: Schlüsselkopie, `parseCents`.
- `tests/routes/integration.pg.test.js`: echtes PostgreSQL (parallele Bestätigungen, Unique-Index, parallele Buchungen, Monats-Initialisierung unter Last, Rollback, Kaskade). Läuft nur mit `TEST_DATABASE_URL`, Anleitung im Dateikopf.

## 10. Offene Punkte
- **Isolation:** Hermes als eigener Unix-Nutzer ohne Zugriff auf `/var/www/toolbox` und `.env`. Erst dann haben die API-Grenzen echte Wirkung gegen einen kompromittierten Agenten.
- **Bestätigung in der App** als optionaler, technisch beweisbarer Modus (z. B. für Löschungen), falls die Telegram-Bestätigung nicht reicht.
- **Kategorien** kann Hermes nur lesen, nicht anlegen oder löschen.
- **Erinnerungen** (Kündigungsfristen) sind nicht Teil des Zugangs.
