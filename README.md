# Stantonopoly V2 — Multiplayer-Brettspiel

Ein server-autoritatives Multiplayer-Monopoly im Stil des Star-Citizen-Universums.
Ein Spielleiter (GM) erstellt ein Spiel, Teams treten per Einladungscode ein und
wählen per Abstimmung einen Teamleiter. Der Server rechnet alle Spielregeln
(Würfeln, Mieten, Steuern, Ereignisse, Hypotheken, Handel, Auktionen, Piraten,
Vermögens-Sieg) und broadcastet den Zustand in Echtzeit an alle Spieler.

**Fan-Projekt:** Stantonopoly ist ein inoffizielles, nicht-kommerzielles Fan-Projekt
und steht in keiner Verbindung zu Cloud Imperium Rights GmbH / Roberts Space
Industries. Siehe Lizenz, Rechtliches & Community-Richtlinien.

**Erstellt mit KI-Unterstützung:** Dieses Projekt wurde maßgeblich mit Unterstützung
moderner KI-Sprachmodelle entwickelt (Architektur, Implementierung und
Testautomatisierung).

## Tech-Stapel

- **Node.js ≥ 22.5** (getestet v26.7) — kein MySQL, kein ORM, kein Build-Schritt.
- **Express** + **socket.io** für HTTP/Websockets.
- **`node:sqlite`** (eingebautes Node-Modul) für die Persistenz — keine nativen Abhängigkeiten.

## Schnellstart (lokal)

```bash
npm install        # nur runtime-Deps: express, socket.io
npm start          # → http://localhost:8000   (Port über ENV PORT änderbar)
```

Die Datenbank `data/stantonopoly.db` wird beim ersten Start automatisch angelegt.
Unter `http://localhost:8000/admin.html` erreichst du das Admin-Dashboard (beim
ersten Aufruf richtest du dort den Admin-Zugang ein).

---

## Deploy / Hosting

Stantonopoly läuft als eigenständiger Node-Prozess mit eingebauter SQLite-Persistenz.
Drei Wege — nativ, vorgebautes Docker-Image, selbst bauen.

**Grundprinzip (gilt für alle Wege):**

| Thema | Wert |
|---|---|
| Standard-Port | `8000` (`ENV PORT`) — statische UI + socket.io über denselben Port |
| Datenbank-Pfad | `data/stantonopoly.db` (auto-angelegt; überschreiben via `ENV STANTONOPOLY_DB`) |
| Admin-Zugang | Erststart: Setup-Formular auf `/admin.html`; oder per ENV vorkonfigurieren |
| Reverse-Proxy | optional, aber empfohlen für öffentlichen HTTPS-Zugang (siehe unten) |

### Weg 1 — Nativ als Node-App

```bash
git clone <repo>.git && cd stantonopoly-multiplayer
npm install --omit=dev
npm start
```

Für dauerhaften Betrieb als Dienst (Beispiel `systemd`):

```ini
# /etc/systemd/system/stantonopoly.service
[Service]
WorkingDirectory=/opt/stantonopoly-multiplayer
ExecStart=/usr/bin/node server/index.js
Environment=PORT=8000
Restart=always
[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now stantonopoly
```

### Weg 2 — Vorgebautes Docker-Image

Das Image wird bei jedem Push auf `main` und bei jedem Tag automatisch gebaut und auf
der **GitHub Container Registry** veröffentlicht (`ghcr.io/<owner>/stantonopoly-v2`;
Tags: `latest`, Semver, SHA).

```bash
docker pull ghcr.io/<owner>/stantonopoly-v2:latest
docker run -d \
  --name stantonopoly \
  --restart unless-stopped \
  -p 8000:8000 \
  -v stantonopoly-data:/app/data \
  ghcr.io/<owner>/stantonopoly-v2:latest
```

Oder mit Docker Compose (siehe `docker-compose.yml`):

```bash
docker compose up -d
```

Das Volume `/app/data` hält die SQLite-Datei (inkl. WAL) — ein `docker pull` + Neustart
übersteht so alle Spiele, Presets, Accounts und Logs.

### Weg 3 — Docker-Image selbst bauen

```bash
docker build -t stantonopoly-v2 .
docker run -d --name stantonopoly -p 8000:8000 \
  -v stantonopoly-data:/app/data stantonopoly-v2
```

Das `Dockerfile` ist minimal (`node:26-alpine`): `data/` wird nicht hineinkopiert
(der Server legt es an, ein Volume mountet die Persistenz).

### Server überprüfen

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8000/        # → 200
curl -s http://localhost:8000/health                                     # → {"ok":true,...}
curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost:8000/socket.io/?EIO=4&transport=polling'  # → 200
```

---

## Konfiguration (Umgebungsvariablen)

| ENV | Zweck | Default |
|---|---|---|
| `PORT` | HTTP/Socket-Port | `8000` |
| `STANTONOPOLY_DB` | Pfad zur SQLite-Datei | `data/stantonopoly.db` |
| `STANTONOPOLY_ADMIN_USER` | Admin-Benutzername (statt Erst-Setup) | `admin` |
| `STANTONOPOLY_ADMIN_PASS_HASH` | Admin-Passwort-Hash `salt:hash` (scryptSync) | — |

Beispiel:

```bash
PORT=8080 STANTONOPOLY_ADMIN_USER=admin \
STANTONOPOLY_ADMIN_PASS_HASH="$(node -e 'const c=require("crypto");const s=c.randomBytes(16).toString("hex");console.log(s+":"+c.scryptSync("MEIN_PASSWORT",s,64).toString("hex"))')" \
npm start
```

## Reverse-Proxy (TLS / Domain)

Für öffentlichen Zugang eine Domain + TLS auf den Port legen (Caddy, nginx, Docker-Proxy …):

- **Websocket-Unterstützung** aktivieren (`upgrade`/`connection`-Header) — socket.io nutzt Websockets.
- **Proxy-Timeout/keepalive** großzügig setzen (lange Sessions nicht abreißen).
- Intern bleibt der Port egal (Proxy auf `http://localhost:8000`).

Beispiel Caddy:

```
stantonopoly.example.com {
    reverse_proxy :8000
    header_up X-Forwarded-Proto {scheme}
}
```

## Daten & Admin

- **Datenbank:** `data/stantonopoly.db` (SQLite) — Spiele, Teams, Spieler, Stimmen, Presets, Audit-Log.
- **Admin-Dashboard** unter `/admin.html`: Spiele einsehen/löschen, Presets verwalten,
  Manager-Codes, Audit-Log und SC-Katalog (Schiffs-/Ortsnamen für die
  Autovervollständigung) — abgesichert über Session-Token (scrypt-Hash, niemals Klartext).
- **SC-Katalog-Aktualisierung (optional):** Die Schiff-/Ortsnamen für die
  Autovervollständigung werden automatisch einmal pro Woche und beim Erststart von der
  öffentlichen Star-Citizen-Wiki-API geholt. Im Admin-Bereich „SC-Daten“ kannst du sie
  manuell aktualisieren oder Einträge bearbeiten.

## Tests

```bash
npm test                  # voll (enthält 2 präexistente Teardown-Hang-Dateien → für CI besser test:ci)
npm run test:ci           # 24 Dateien ohne die Hang-Dateien → 171 Tests
```

---

## Lizenz, Rechtliches & Community-Richtlinien

### Software-Lizenz

Dieses Projekt steht unter der **PolyForm Noncommercial License 1.0.0** (`LICENSE`).
Das bedeutet: freie, nicht-kommerzielle Nutzung, Änderung und Weitergabe —
**keine kommerzielle Nutzung** (kein Verkauf, keine Paywalls, keine kommerzielle Einbettung).

### Star-Citizen / RSI-Community-Richtlinien

Stantonopoly verwendet Star-Citizen-Marken und -Begriffe als Fan-Inhalt. Gemäß dem
[RSI Fandom FAQ / Fan Kit und Fandom FAQ](https://support.robertsspaceindustries.com/hc/en-us/articles/360006895793-Star-Citizen-Fankit-and-Fandom-FAQ)
ist dies nur in nicht-kommerzieller Form ohne Bezahlung, Spenden-Druck oder
kommerzielle Verwertung zulässig. Für dieses Projekt gilt daher:

- Das Spiel ist **kostenlos** und **ohne Paywall** nutzbar (Grundlage der Lizenz oben).
- Es ist **nicht verbunden** mit RSI/CIG und erhebt keinen offiziellen Status.
- Der Quellcode ist **source-available**, aber bewusst **nicht als Open Source zur
  kommerziellen Verwertung** lizenziert — dies entspricht der RSI-/IP-Richtlinie für
  Fan-Projekte.
- Möchtest du das Projekt kommerziell verwenden oder Änderungen verkaufen, wende dich
  zuerst an den Lizenzgeber bzw. kläre dies mit den RSI-Richtlinien ab.

**Haftungs- / Rechtlicher Hinweis:** Die Namen, Schiffe und Begriffe des
Star-Citizen-Universums sind geistiges Eigentum von Cloud Imperium Rights GmbH bzw.
Roberts Space Industries. Diese Projektdokumentation ersetzt keine Rechtsberatung —
Lizenz und Hinweise dienen der Vorsicht und können keinen individuellen Rechtsrat ersetzen.

### Betrieb / Impressum / Datenschutz

- **Impressum:** `/impressum.html`
- **Datenschutz:** `/datenschutz.html`

Beide Seiten liegen im `public/`-Ordner und müssen vor öffentlicher Bereitstellung vom
Betreiber mit den eigenen Daten ausgefüllt werden (Anschrift, Kontakt,
Verantwortlicher). In der deutschen Bereitstellung gelten Impressumspflicht (§ 5 DDG)
und die Datenschutz-Grundverordnung; die beigelegten Seiten sind eine Grundlage,
kein Ersatz für Rechtsberatung.
