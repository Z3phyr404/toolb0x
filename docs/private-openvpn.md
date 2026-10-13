# Privates zusätzliches OpenVPN für den VPS

## Stand und Grenzen

Der Code ist vorbereitet und synthetisch getestet. **Das ist noch kein eingerichtetes oder extern geprüftes VPN.** Die folgenden Root-Schritte führt Michael selbst in seiner SSH-Sitzung aus; das sudo-Passwort gehört ausschließlich in sein Terminal. Keine zusätzliche `NOPASSWD`-Regel.

Dieser Listener ist ein reguläres privates VPN in einem dafür erlaubten Netzwerk. Keine Tarnung, kein HTTPS-Port-Sharing, keine Proxy- oder Umgehungstechnik. Falls TCP1194 im verwendeten Netzwerk nicht erlaubt ist, bleibt die Verbindung aus; nicht auf den produktiven HTTPS-Port ausweichen.

- Endpunkt: **46.225.140.44, TCP1194**, IPv4-Transport.
- Eigenes Interface: `tunovpn`, IPv4 `10.78.78.0/24`, IPv6 `fd78:78:78::/64`.
- Volltunnel für IPv4 und IPv6: `redirect-gateway def1 ipv6`, DNS-Push `1.1.1.1`.
- IPv4- und IPv6-MASQUERADE ausschließlich für diese Quellnetze auf `eth0`.
- Eigenständiger Dienst `private-toolbox-openvpn.service`, kein Start/Stop anderer Dienste.
- WireGuard auf `wg0`/UDP51820, SSH, nginx und TCP80/443 bleiben unverändert. Keine Bearbeitung des Produktions-Checkouts, kein App-Neustart, keine globale FORWARD-ACCEPT-Regel, kein Abschalten der Firewall.
- UFW bleibt aktiv, IPv6 bleibt aktiv, eingehend und geroutet weiterhin standardmäßig gesperrt. Erlaubt wird nur TCP1194 auf der IPv4-Adresse sowie gerouteter Verkehr vom neuen Interface mit den exakten Quellnetzen nach `eth0`. Private, Loopback-, Link-local- und Multicast-Ziele werden davor ausdrücklich gesperrt. Zugriffe zum Server selbst unterliegen weiterhin UFWs INPUT-Regeln.

**Keine pauschale Leak-Garantie:** Routen/DNS-Push ersetzen keinen clientseitigen Kill-Switch. Ausnahmen für lokale Netze, iOS-/macOS-Verhalten, andere aktive VPNs und ein Tunnelabbruch müssen am jeweiligen Gerät geprüft werden. IPv6 wird nicht einfach ignoriert; ein fehlender IPv6-Internetzugang ist ein Fehler der Inbetriebnahme, kein Anlass für einen ungeschützten Fallback. TCP im TCP-Tunnel kann langsamer sein als WireGuard.

## Feste Ressourcen und Schutzmaßnahmen

| Ressource | Zweck |
|---|---|
| `/etc/openvpn/private-toolbox-pki/` | Neue CA, Server-/Geräteschlüssel, CRL, private Profile, Installationsinventar; Verzeichnis 0700, Dateien 0600 |
| `/etc/openvpn/server/private-toolbox.conf` | Eigene Serverkonfiguration |
| `/etc/openvpn/private-toolbox-network.py` | Root-eigener, unveränderlich kopierter NAT-Lifecycle-Helfer |
| `/etc/systemd/system/private-toolbox-openvpn.service` | Eigene Unit mit `ExecStartPre`/`ExecStopPost`, Python `-I` |
| `/root/private-toolbox-openvpn-backup-*` | Private Sicherung der bisherigen UFW-Konfigurationsdateien und des Zustands vor Änderungen |
| `/run/private-toolbox-openvpn-setup.lock` | Root-eigene Sperrdatei gegen parallele Aufrufe; bleibt bestehen |
| `/home/michael/.local/share/private-vpn/` | Optionale private Exportkopie für authentifizierten Download; 0700, Profile 0600 |

Der Preflight bricht bei belegtem TCP1194, vorhandenen eigenen Konfigurationen/PKI/Unit/Interface/Regeln oder überschneidenden Routen ab. Er prüft beide IP-Familien über **alle Routingtabellen**, die erwarteten öffentlichen Adressen/Default-Gateways, aktives/enabled WireGuard, bestehendes Forwarding (beide Familien `1`, `eth0.accept_ra=2`) und UFW-Defaults. Er setzt diese Werte nicht selbst um.

Die Programme nutzen feste Argumentlisten ohne Shell, begrenzte Laufzeiten und eine kleine, bereinigte Unterprozess-Umgebung. Root-Dateien werden exklusiv erstellt; fehlgeschlagene Schreib-/flush-/fsync-Vorgänge räumen nur den eigenen Inode auf. Exportpfade verwenden zusätzlich verankerte Verzeichnis-Deskriptoren mit `O_NOFOLLOW`, keine frei wählbaren Root-Zielpfade. Profile werden nie ausgegeben.

Der Setup-Code im Entwicklungs-Checkout ist Michaels vertrauenswürdiger, vorab zu prüfender Operator-Code, **keine Sicherheitsgrenze gegenüber Prozessen desselben Benutzers**. Ein `sudo python -I` macht einen benutzerschreibbaren Checkout nicht automatisch sicher. Vor der Ausführung muss die unabhängige Codeprüfung abgeschlossen sein; währenddessen keine fremden Änderungen am Checkout.

## 1. Pakete und Prüfung (Michael)

Ubuntu-Pakete: `openvpn` und `easy-rsa`; geprüft wird OpenVPN **2.5.11** mit OpenSSL **3.0.2**. Falls noch nicht vorhanden:

```bash
sudo apt-get install openvpn easy-rsa
```

Das Setup erzeugt die PKI direkt mit OpenSSL; Easy-RSA ist nicht Voraussetzung für diese konkrete Signierlogik. Es werden keine kostenpflichtigen Dienste hinzugefügt.

Nur Prüfung; bis auf die private Sperrdatei keine Konfiguration/Regeln/Keys:

```bash
sudo /usr/bin/python3 -I /home/michael/development/toolb0x/scripts/private-openvpn-setup.py preflight
```

Bei Fehlern nicht die Schutzprüfung entfernen oder die Firewall lockern. Ursache lokal prüfen und mit der erwarteten VPS-Konfiguration abgleichen.

## 2. Einrichten und serverseitig aktivieren (Michael)

**Dieser Schritt erzeugt Schlüssel, schreibt Konfiguration, fügt Regeln hinzu und startet/aktiviert den neuen Dienst:**

```bash
sudo /usr/bin/python3 -I /home/michael/development/toolb0x/scripts/private-openvpn-setup.py install
```

Vor der ersten Firewallmutation wird UFW privat unter `/root` gesichert. Nach dem Start prüft das Setup eigenen Listener, beide Tunneladressen und unveränderte UFW-Regeln/-Defaults, Forwarding sowie WireGuard-/SSH-/nginx-/bestehende OpenVPN-Dienstzustände. Erst danach wird Boot-Autostart eingerichtet.

Bei Fehlern werden **versuchte** Änderungen berücksichtigt, auch teilweise fehlgeschlagene UFW-Aufrufe. Eigene nummerierte IPv4-/IPv6-Regeln werden absteigend gelöscht und erneut gelesen. Die eigene Unit wird nur gestoppt, wenn ihr Start versucht wurde. NAT wird zusätzlich gezielt aufgeräumt. Scheitert das Stoppen, bleiben die privaten Konfigurationsdateien erhalten. Unlesbare Zustände, fremde Ersatzdateien oder Restregeln werden ausdrücklich als unvollständiger Rollback gemeldet. Keine automatische Rückkopie kompletter UFW-Dateien, die zwischenzeitliche fremde Änderungen überschreiben könnte.

Normale OpenVPN-Neustarts laufen durch dieselben idempotenten, quellengebundenen NAT-Hooks; ein teilweise fehlgeschlagener Start räumt frühe NAT-Regeln auf. Es gibt keinen globalen Firewall-Reset.

## 3. Profile privat übernehmen

Für iPhone und Mac existieren **verschiedene Zertifikate und Schlüssel**. Jedes `.ovpn` enthält den privaten Geräteschlüssel und `tls-crypt`-Material. Nicht in Telegram, Git, öffentliche Links, Webroot, Screenshots, Chat oder E-Mails kopieren; insbesondere keine MEDIA-Anhänge.

Michael exportiert nur die festen Gerätenamen, ohne Überschreiben:

```bash
sudo /usr/bin/python3 -I /home/michael/development/toolb0x/scripts/private-openvpn-setup.py export iphone
sudo /usr/bin/python3 -I /home/michael/development/toolb0x/scripts/private-openvpn-setup.py export mac
```

Der Export prüft das echte Unix-Konto `michael` einschließlich Home-Verzeichnis und ermittelt UID/GID, statt Zahlen zu raten. Unsichere vorhandene Verzeichnisse oder Symlinks führen zum Abbruch; ihre Rechte werden nicht ungefragt verändert.

Auf dem Mac per bereits authentifiziertem SSH/SFTP-Zugang herunterladen. Bei SCP zuerst ein privates lokales Ziel anlegen:

```bash
mkdir -m 700 "$HOME/private-vpn"
scp michael@46.225.140.44:/home/michael/.local/share/private-vpn/mac.ovpn "$HOME/private-vpn/"
scp michael@46.225.140.44:/home/michael/.local/share/private-vpn/iphone.ovpn "$HOME/private-vpn/"
chmod 600 "$HOME/private-vpn/"*.ovpn
```

Bekannte SSH-Hostschlüssel prüfen; nicht `StrictHostKeyChecking=no` verwenden. Wenn das Ziel bereits existiert, nicht blind überschreiben. Alternativ vorhandenen authentifizierten SFTP-Client benutzen. Kein HTTP-Download-Endpunkt.

- **Mac:** offizielles [OpenVPN Connect](https://openvpn.net/client/) installieren → **Import Profile → File** → `mac.ovpn` importieren.
- **iPhone:** offizielles [OpenVPN Connect im App Store](https://apps.apple.com/app/openvpn-connect/id590379981) installieren. `iphone.ovpn` vom Mac per AirDrop ausschließlich an das eigene iPhone senden → in OpenVPN Connect öffnen/importieren → iOS-VPN-Erlaubnis bestätigen.
- In beiden Apps verbinden und den richtigen Gerätenamen verwenden. Keine gemeinsam verwendete Clientidentität, kein Benutzername/Passwort erforderlich.
- Private Export-/Downloadkopien nach erfolgreichem Import bewusst entfernen, wenn sie nicht für einen erneuten Import benötigt werden. Das Setup löscht Benutzerkopien nicht automatisch.

## 4. Abnahme: noch erforderlich

Mit einer zweiten SSH-Sitzung und getrennt von einem produktiven WireGuard-Tunnel prüfen:

1. `sudo systemctl is-active private-toolbox-openvpn.service` und `sudo systemctl is-enabled private-toolbox-openvpn.service`.
2. `sudo ss -lntp` lokal: eigener Listener auf `46.225.140.44:1194`; TCP443 weiterhin nginx. Keine vollständigen Profil- oder Schlüsseldateien anzeigen.
3. `ip -br address show tunovpn`: beide Tunneladressen. `sudo systemctl is-active wg-quick@wg0.service`: WireGuard weiterhin aktiv; dessen Clientverbindung ebenfalls testen, ohne Keys anzuzeigen.
4. Beide OpenVPN-Geräte einzeln und gleichzeitig verbinden: erfolgreicher Zertifikat-Handshake, IPv4-Ausgangsadresse des VPS und IPv6-Ausgangsadresse `2a01:4f8:1c19:3ea5::1` an einem externen IP-Test prüfen.
5. DNS-Auflösung und DNS-Leak-Test prüfen: DNS soll über den Tunnel zur konfigurierten Auflösung gehen. Private/Link-local-Ziele dürfen über den Server nicht erreichbar sein; allgemeines Internet schon.
6. OpenVPN absichtlich trennen: Verhalten von IPv4, IPv6 und DNS beobachten. Falls das Gerät bei Abbruch normal direkt ins Internet geht, ist das **kein Kill-Switch**. OpenVPN-Connect-Einstellungen und OS-Verhalten getrennt prüfen, bevor vertrauliche Nutzung beginnt.
7. SSH und `https://toolb0x.eu/` weiterhin erreichbar (normaler Login-Redirect), WireGuard unverändert. OpenVPN-Neustart ausschließlich der eigenen Unit testen; danach beide NAT-Regeln und Clientverkehr erneut prüfen.

Erst nach diesen Prüfungen ist das VPN wirklich betriebsbereit. Paketinstallation, Parserprüfung und synthetische Tests beweisen keine externe Verbindung und keine Leak-Freiheit.

## Zertifikate und Widerruf

Neue private CA, EC P-256-Schlüssel, SHA-256-Signaturen, Server-EKU `serverAuth`, getrennte Client-EKU `clientAuth`, gegenseitige Zertifikatsprüfung, serverseitig `remote-cert-tls client`, clientseitig `remote-cert-tls server` und CN-Pinning auf `toolbox-openvpn-server`. TLS mindestens 1.2, ECDH (`dh none`), `tls-crypt`, Datenkanal ausschließlich `AES-256-GCM:AES-128-GCM`. Keine Kompression oder Legacy-Cipher-Fallbacks.

**Lokale Root-Grenze:** Die CA-Schlüsseldatei ist 0600 in einem Root-Verzeichnis 0700, aber für automatisches Setup nicht passwortverschlüsselt. Ein kompromittierter Root-Zugang kann diese CA und alle Geräteidentitäten verwenden. Das ist keine Offline-CA und kein Schutz vor Root. Nicht mit der bestehenden WireGuard-PKI vermischen.

Die anfängliche CRL ist 180 Tage gültig; Zertifikate sind 825 Tage gültig. CRL mindestens alle drei Monate erneuern, bevor sie abläuft. Es wird absichtlich kein ungeprüfter Cronjob installiert. Abgelaufene CRL blockiert neue Authentifizierung.

Bei verlorenem iPhone: **nur `iphone.crt` widerrufen**, Mac nicht widerrufen. Für den Mac stattdessen ausschließlich `mac.crt` einsetzen. Michael führt diese festen Befehle in seiner eigenen Root-Sitzung aus (keine Ausgabe privater Schlüssel):

```bash
sudo -i
umask 077
openssl ca -batch -config /etc/openvpn/private-toolbox-pki/ca.cnf -revoke /etc/openvpn/private-toolbox-pki/iphone.crt
# Vorhandene temporäre Datei NICHT überschreiben:
test ! -e /etc/openvpn/private-toolbox-pki/crl.next.pem && test ! -L /etc/openvpn/private-toolbox-pki/crl.next.pem && openssl ca -config /etc/openvpn/private-toolbox-pki/ca.cnf -gencrl -out /etc/openvpn/private-toolbox-pki/crl.next.pem
openssl crl -in /etc/openvpn/private-toolbox-pki/crl.next.pem -noout -verify -CAfile /etc/openvpn/private-toolbox-pki/ca.crt
# Nur nach erfolgreicher Erzeugung UND Prüfung ausführen:
install -m 600 /etc/openvpn/private-toolbox-pki/crl.next.pem /etc/openvpn/private-toolbox-pki/crl.pem
rm -- /etc/openvpn/private-toolbox-pki/crl.next.pem
systemctl restart private-toolbox-openvpn.service
exit
```

Für reine CRL-Erneuerung die `-revoke`-Zeile weglassen. Den eigenen Dienst neu starten, damit auch eine bestehende Verbindung eines widerrufenen Geräts beendet wird; anschließend Mac-Verbindung erneut prüfen. Widerrufene Profile nicht erneut verteilen. Ein Ersatzgerät braucht ein neu ausgestelltes Zertifikat, nicht die Wiederverwendung eines kompromittierten Keys.

**Wichtig:** Manuelle CRL-/PKI-Änderungen ersetzen ggf. Dateien/Inodes. Der automatische vollständige Rollback verweigert dann absichtlich das Löschen veränderter Dateien; eine überprüfte lokale Nachpflege ist nötig. Nicht das Inventar blind auf neue Inodes umschreiben.

## Eigene Installation entfernen

Nur für eine unveränderte, erfolgreich installierte eigene Konfiguration:

```bash
sudo /usr/bin/python3 -I /home/michael/development/toolb0x/scripts/private-openvpn-setup.py rollback
```

Root-eigenes Installationsinventar mit enger Pfad-Whitelist und gespeicherten Inodes schützt vor Übernahme fremder Dateien. Rollback deaktiviert/stoppt nur die eigene Unit, prüft Rest-NAT/UFW/Tunnel und den geschützten Ausgangszustand, löscht nur eigene unveränderte Dateien und lädt systemd neu. UFW-Sicherung und private Benutzer-Exportkopien bleiben erhalten. Geänderte/fremde Dateien oder inzwischen geänderte Firewall-Baselines bleiben erhalten und benötigen lokale Prüfung; keine pauschale Erfolgsmeldung.

## Tests und Kosten

```bash
cd /home/michael/development/toolb0x
python -m unittest discover -s tests/dev -p test_openvpn.py -v
python -m unittest discover -s tests/dev -v
python scripts/zephyr-test.py all
```

Root-/Netzwerkgrenzen sind in den VPN-Tests synthetisch gemockt; kein privilegierter Entrypoint wird ausgeführt. Reale OpenSSL-Tests erzeugen und entfernen ausschließlich synthetische Scratch-PKIs: gültige Chains, EKU-Grenzen, falsche CA, gültige CRL und selektiver Widerruf. OpenVPN 2.5.11 erzeugt synthetisches `tls-crypt`-Material und liest Server-/Clientkonfigurationen mit `--show-ciphers`; das ist **Parserprüfung, kein realer Serverstart/Handshake**. Keine Test-Schlüssel im Repo.

Michael hat 20 TB ausgehendes Monatsvolumen bestätigt. Der vorhandene Gesamt-Trafficmonitor über `eth0` TX erfasst auch OpenVPN; seine WireGuard-spezifische Ansicht (`wg0`) enthält OpenVPN nicht. Monitoring wird hier nicht verändert. Anbieterlimits/Mehrverbrauch beachten, keine zusätzlichen bezahlten VPN-Anbieter.

## Offizielle Grundlagen

- [Ubuntu Server: OpenVPN installieren](https://documentation.ubuntu.com/server/how-to/security/install-openvpn/)
- [OpenVPN 2.5 Manual](https://openvpn.net/community-docs/community-articles/openvpn-2-5-manual.html): `tcp-server`, `server-ipv6`, `redirect-gateway ipv6`, `remote-cert-tls`, `verify-x509-name`, `data-ciphers`, `tls-crypt`, `dh none`, `crl-verify`, `--genkey secret`.
