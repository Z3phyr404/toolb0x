# Zephyr als eigener Linux-Benutzer (Trennung von toolb0x)

Stand: 2026-10-12 · **Noch nicht umgesetzt.** Die Schritte brauchen sudo,
deshalb führt Michael sie selbst aus.

## Warum
Zephyr (Hermes) läuft derzeit als `michael`, also als derselbe Benutzer wie
toolb0x. Damit kann er `.env`, Datenbank, App-Code und Fotodateien direkt
lesen und ändern. Die API-Berechtigungen sind dann nur eine Vereinbarung.
Als eigener Benutzer **ohne** diese Zugriffe bleibt ihm nur die lokale API
mit den Rechten, die du im Profil erteilst.

## Ziel
| | `michael` | `zephyr` |
|---|---|---|
| `/var/www/toolbox/finanz-app` (Code, `.env`) | ✓ | ✗ |
| PostgreSQL | ✓ (über `DATABASE_URL`) | ✗ (keine DB-Rolle, kein Passwort) |
| `/var/www/fotos*` | ✓ | ✗ |
| `/home/michael` | ✓ | ✗ |
| `http://127.0.0.1:3001` (Integration) | – | ✓ (mit eigenem Token) |
| sudo | Passwort | **nein** |

## Schritte (als `michael`, mit sudo)

**0. Vorher sichern**
```bash
systemctl --user stop hermes-gateway
tar czf ~/hermes-backup-$(date +%F).tgz -C ~ .hermes
```

**1. Benutzer anlegen** (ohne sudo-Rechte, ohne Passwort-Login)
```bash
sudo adduser --disabled-password --gecos "Zephyr (Hermes Agent)" zephyr
```

**2. Hermes übernehmen.** Installation und Konfiguration samt Telegram,
ChatGPT-Anmeldung und dem Token unter `.hermes/secrets` wandern mit:
```bash
sudo cp -a ~/.hermes /home/zephyr/.hermes
sudo mkdir -p /home/zephyr/.local/bin
sudo cp -a ~/.local/bin/hermes /home/zephyr/.local/bin/ 2>/dev/null || true
sudo chown -R zephyr:zephyr /home/zephyr/.hermes /home/zephyr/.local
```
Je nach Installationsart liegen weitere Hermes-Dateien unter `~/.local`.
Vorher mit `ls -la ~/.local/bin/hermes` und `head -1 ~/.local/bin/hermes`
prüfen, worauf der Befehl zeigt, und den Ordner ebenfalls kopieren.

**3. Rechte von toolb0x und Fotos dicht machen**
```bash
sudo chmod 750 /home/michael
sudo chmod 750 /var/www/toolbox
sudo chmod 600 /var/www/toolbox/finanz-app/.env
sudo chmod -R o-rwx /var/www/fotos-privat /var/www/fotos-inbox
# /var/www/fotos bleibt lesbar: das sind die öffentlichen Galerien (nginx)
```
Danach prüfen, dass nginx noch funktioniert: `sudo nginx -t`, dann
https://toolb0x.eu/portal und einen Galerie-Link aufrufen.
nginx braucht keinen Zugriff auf `finanz-app` oder `fotos-privat`, nur auf
`deploy/nginx-fotos.conf` (per `include`) und `/var/www/fotos`. Schlägt
`nginx -t` wegen des `include` fehl: `sudo chmod 755 /var/www/toolbox` und
stattdessen nur `finanz-app/.env` (600) und `finanz-app` (750) einschränken.

**4. Dienst für zephyr einrichten**
```bash
sudo loginctl enable-linger zephyr
sudo -iu zephyr bash -c 'XDG_RUNTIME_DIR=/run/user/$(id -u) hermes gateway install'   # bzw. wie bei der Ersteinrichtung
sudo -iu zephyr bash -c 'XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user enable --now hermes-gateway'
systemctl --user disable hermes-gateway    # alter Dienst von michael
```
Den API-Server (`127.0.0.1:8642`, für `/app/hermes`) startet Hermes wie
bisher. `HERMES_API_KEY` in der toolb0x-`.env` bleibt gleich.

**5. Prüfen** (als `zephyr`)
```bash
sudo -iu zephyr bash -c '
  cat /var/www/toolbox/finanz-app/.env       >/dev/null 2>&1 && echo "FEHLER: .env lesbar"   || echo "ok: .env gesperrt"
  ls /var/www/fotos-privat                   >/dev/null 2>&1 && echo "FEHLER: Fotos lesbar"  || echo "ok: Fotos gesperrt"
  psql -h 127.0.0.1 -c "select 1" postgres   >/dev/null 2>&1 && echo "FEHLER: DB erreichbar" || echo "ok: keine DB"
  sudo -n true                               2>/dev/null    && echo "FEHLER: sudo"           || echo "ok: kein sudo"
  curl -s -o /dev/null -w "Integration: %{http_code}\n" -H @$HOME/.hermes/secrets/toolb0x-finanzen.header http://127.0.0.1:3001/v1/status
'
```
Erwartet: viermal „ok“ und `Integration: 200`. Danach Zephyr in Telegram
testen. Ist die ChatGPT-Anmeldung nicht übernommen worden, als `zephyr`
`hermes model` ausführen.

**6. Schlüssel erneuern:** Profil → Hermes-Zugang → „Schlüssel erneuern“
und den neuen Schlüssel in `/home/zephyr/.hermes/secrets/toolb0x-finanzen.header`
eintragen (Befehl wie bei der Ersteinrichtung, als `zephyr`). Der alte
Schlüssel lag lesbar beim Benutzer `michael`.

## Zurück
`systemctl --user enable --now hermes-gateway` als `michael`, den Dienst von
`zephyr` stoppen (`sudo -iu zephyr systemctl --user disable --now hermes-gateway`),
Rechte zurücksetzen (`chmod 755` auf die geänderten Ordner).

## Was danach weiter gilt
- Root und `michael` können alles. Ein kompromittiertes `michael`-Konto bleibt ein Risiko.
- Zephyr kann weiterhin Befehle als `zephyr` ausführen und ins Internet. Die API-Grenzen gelten nur für toolb0x-Daten.
- Der Token in Zephyrs Home erlaubt das Entschlüsseln deiner Daten nur noch **über die API** und nur in den freigeschalteten Bereichen.
