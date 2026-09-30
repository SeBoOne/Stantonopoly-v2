# Stantonopoly V2 — Multiplayer (server-authoritativ)

Server-authoritatives Multiplayer-Monopoly im Star-Citizen-/Drake-Look (Dark-Only).
Ein GM erstellt ein Spiel, Teams treten per Einladungscode ein und wählen per
Stimm-Mehrheit einen Teamleiter. Der Server rechnet (Würfel, Miete, Gundo, Bankrott,
Sieg) und broadcastet den Zustand in Echtzeit.

Stack: Node.js ≥ 22.5 (getestet v26.7.0), Express, socket.io, `node:sqlite`
(eingebaut — keine nativen Module, kein MySQL, kein ORM).

---

## Start (lokal)

```bash
npm install                 # Abhängigkeiten (express, socket.io, socket.io-client)
npm start                   # = node server/index.js   (Port 8000, ENV PORT)
```

Danach öffnen: http://localhost:8000

- UI deutsch, Dark-only, responsiv bis 390px.
- GM erstellt ein Spiel, erhält GM-Code + Einladungscodes und verteilt sie.
- Teamleiter wird von den Teammitgliedern per Mehrheit gewählt.

## Teamleiter & Würfeln (wichtig)

- **Lobby-Wahl**: Vor dem Start stimmen die Teammitglieder ab (Vote-System); der mit
  den meisten Stimmen wird beim Start/Weiterspielen Teamleiter. Gleichstand → zufällig
  unter den Stimmenstärksten, keine Stimme → zufällig aus allen Mitgliedern.
- **Start ohne Leiter**: Fehlt einem Team beim Start ein gewählter Leiter, wird
  automatisch ein zufälliges Mitglied zum Leiter bestimmt.
- **Leader-Nachfolge**: Verlässt der Teamleiter das Spiel, übernimmt automatisch ein
  verbleibendes Teammitglied; der GM kann den Teamleiter jedes Teams auch während des
  Spiels ändern.
- **Einmal würfeln pro Zug**: Nach dem Wurf ist "Würfeln" gesperrt, bis zum nächsten
  Zug (erst Kauf/Überspringen/Nächster Zug).
- **Nur der Teamleiter des aktiven Teams** sieht die Aktions-Buttons
  (Würfeln/Kaufen/Ausbauen/…). Mitglieder/Beobachter sehen keine Aktions-Buttons; der
  Server blockt zusätzlich jede Aktion durch Nicht-Leiter.
- **Reload-fest**: F5 behält GM-Ansicht bzw. Team-Mitgliedschaft. Spieler melden sich
  über ihren Rejoin-Token automatisch wieder an, der GM über seinen GM-Code.

## Tests

```bash
npm test                    # node --test 'tests/*.test.js'  (voll; enthält 2 präexistente Teardown-Hang-Dateien → nicht für CI)
npm run test:ci             # CI-sicher: 24 Testdateien ohne die Hang-Dateien → 171 Tests, Liste unten
```

Abgedeckt (Auszug):
- `engine.test.js` — Rent-Formel (4 Preisbänder exakt), Umlauf-Bonus, Ereignis/Steuer,
  Bankrott/Sieg, Kauf/Ausbau/Hypothek, Persistenz-Roundtrip, Preset, formatUAEC
- `multi.test.js` — 2 parallele Spiele: getrennte Zustände und getrennte Räume
- `socket.test.js` — Echtzeit: Aktion von A erreicht B im Raum (nicht C im anderen Raum), < 500 ms
- `auth.test.js` — GM-Code-Schutz, Einladungscode öffnet nur das eigene Spiel,
  Teamleiter-Mehrheit, Mitglied darf nicht handeln (server-side)
- `piraten*.test.js` — Piratensystem (Begegnung/Flucht/Urteil/Bot, Fahrt-Regeln, Wire)
- `phase2*.test.js` — Aufgabenregel, Team-Aufgabe/Forfeit, Preset-Editor, Admin-Parität
- `kombinationen.test.js` — Kreuzprodukte Mechaniken (Aufgaben×Piraten, Armistice×Ökonomie)
- `scwiki.test.js` — SC-Katalog (DB-Helper + Location-Filter, hermetisch ohne Live-API)

Momentan `spiltief`/`rump-paket` im vollen `npm test` hängen im Prozess-Teardown
(bekannt, unabhängig von Feature-Änderungen) — deshalb ist `test:ci` die CI-Strecke.

Einzeltests: `npm run test:engine|test:multi|test:socket|test:auth`

## Persistenz

SQLite-Datei: `data/stantonopoly.db` (wird beim Start automatisch angelegt).
Enthält Spiele, serialisierte Zustände, Teams, Spieler, Stimmen und Codes
(GM + Einladungscodes). DB-Pfad via ENV `STANTONOPOLY_DB`.

## Admin-Dashboard (2o-BONUS)

Eigenes Admin-Frontend unter `/admin.html` (REST-API unter `/admin/*`), damit
Sebo die Seite/Daten **ohne Terminal/Code-Zugriff** verwalten kann. Keine
Admin-Funktionen im normalen Spiel-GUI.

- **Auth-Gate**: genau ein Admin-Konto. Passwort wird NIE im Klartext gespeichert
  (scrypt-Hash + Salt in `admin_config`). Nach Login wird ein Session-Token
  ausgestellt; ALLE `/admin/*`-Endpoints verlangen `Authorization: Bearer <token>`
  (sonst 401). Token lebt im SessionStorage des Admin-Tabs.
- **Ersteinrichtung (ohne Terminal)**: Solange kein Admin-Konto existiert, zeigt
  `/admin.html` ein Setup-Formular (Benutzername + Passwort). Danach ist dieser
  Weg dauerhaft gesperrt. Alternativ per ENV vorkonfigurierbar:
  `STANTONOPOLY_ADMIN_USER` (default `admin`) und
  `STANTONOPOLY_ADMIN_PASS_HASH` im Format `salt:hash`
  (`crypto.scryptSync(pass, salt, 64).toString('hex')`).
- **Dashboard**: Anzahl Spiele nach Status (Lobby/Aktiv/Pausiert/Beendet),
  Preset-Count (eingebaut/eigen).
- **Spiele-Management**: alle nicht beendeten Spiele (aktiv + pausiert + Lobby)
  inkl. Game-Code; beendete Spiele im Archiv. Spiele per Admin **löschen**
  (Hard-Delete aus DB inkl. aller verketteten Daten: Teams, Spieler, Stimmen,
  Codes). Laufende Timer werden gestoppt, Sockets aus dem Raum geleitet.
- **Presets**: alle Presets auflisten, neu anlegen, bearbeiten (Feld-Editor +
  Ausbaustufen-Namen), löschen. Eingebaute Presets sind geschützt (403).
- **Audit-Log**: Logins, fehlgeschlagene Logins, Preset-Speichern/-Löschen und
  Spiel-Löschungen werden protokolliert (`/admin/log`).

Admin-Tests: `node --test tests/admin.test.js tests/admin-setup.test.js`

## E2E-Check (Server läuft)

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8000/        # → 200
curl -s http://localhost:8000/health                                     # → {"ok":true,...}
curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost:8000/socket.io/?EIO=4&transport=polling'  # → 200 (Handshake)
```

---

## Deploy / Hosting

Stantonopoly ist ein selbstständiger Node-Prozess mit eingebauter SQLite-Persistenz —
**kein MySQL, kein Docker-Zwang, kein Build-Schritt**. Du kannst ihn auf jede
Maschine mit Node ≥ 22.5 stellen, als Docker-Container laufen lassen, oder ein
vorgebautes Image von der GitHub Container Registry ziehen.

Grundprinzip (gilt für alle Wege):

- Der Server lauscht standardmäßig auf **Port 8000** (`ENV PORT`), statische
  UI + socket.io laufen über denselben Port.
- Die Datenbank liegt in `data/stantonopoly.db` (wird beim Start automatisch
  angelegt). Pfad über `ENV STANTONOPOLY_DB` änderbar.
- Ein reverse Proxy davor (Caddy/nginx) für TLS und Domainbindung ist optional,
  aber für öffentlichen Zugang empfohlen (siehe "Hinter einem Reverse Proxy").
- Admin-Zugang (`/admin.html`): Beim ersten Start zeigt es ein Setup-Formular
  (legt Benutzername + Passwort an). Alternativ per ENV vorkonfigurierbar:

  ```
  STANTONOPOLY_ADMIN_USER=admin
  STANTONOPOLY_ADMIN_PASS_HASH=salt:hash   # crypto.scryptSync(pass, salt, 64).toString('hex')
  ```

### Weg 1 — Nativ als Node-App (ohne Docker)

Voraussetzung: **Node.js ≥ 22.5** (getestet v26.7; `node:sqlite` ist ein eingebautes
Modul, es kommen keine nativen Abhängigkeiten dazu).

```bash
# 1) Klonen + Abhängigkeiten (nur runtime-Deps: express, socket.io)
git clone <dein-repo>.git && cd stantonopoly-multiplayer
npm install --omit=dev

# 2) Starten (Port 8000 bzw. ENV PORT)
npm start
# → Node.js-Prozess, nicht als PHP ausführbar → Prozessmanager nutzen:
#    systemd, pm2, launchd, einerlei — wichtig ist: Bei Container-Neustart
#    wieder hochkommen (Restart=always o.ä.).
```

Als `systemd`-Unit (Linux):

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

### Weg 2 — Vorgebautes Docker-Image (von GitHub Container Registry)

Für jeden Docker-Host. Das Image wird automatisch bei jedem Push nach `main`
und bei jedem Tag gebaut und unter `ghcr.io/<owner>/stantonopoly-multiplayer`
veröffentlicht (Tags: `latest`, Semver-Version, SHA).

```bash
# Image ziehen und starten
docker pull ghcr.io/<owner>/stantonopoly-multiplayer:latest
docker run -d \
  --name stantonopoly \
  --restart unless-stopped \
  -p 8000:8000 \
  -v stantonopoly-data:/app/data \
  ghcr.io/<owner>/stantonopoly-multiplayer:latest
```

Oder mit Docker Compose (siehe `docker-compose.yml`):

```bash
docker compose up -d
```

Das Volume `/app/data` hält die SQLite-Datei (inkl. WAL) — damit übersteht ein
`docker pull` + Neustart alle Spiele, Presets, Accounts und Logs.

### Weg 3 — Docker-Image selbst bauen

```bash
git clone <dein-repo>.git && cd stantonopoly-multiplayer
docker build -t stantonopoly-v2 .
docker run -d --name stantonopoly -p 8000:8000 \
  -v stantonopoly-data:/app/data stantonopoly-v2
```

Das `Dockerfile` ist bewusst minimal: `node:26-alpine`, nur `--omit=dev`
Abhängigkeiten, `data/` wird nicht hineinkopiert (der Server legt es an, das
Volume mountet die Persistenz). Änderst du nur `server/`/`public/`, nutzt der
Build den Layer-Cache und spart den `npm install`-Schritt.

### Verifikation, dass der Server läuft

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8000/        # → 200
curl -s http://localhost:8000/health                                     # → {"ok":true,...}
curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost:8000/socket.io/?EIO=4&transport=polling'  # → 200 (Handshake)
```

### Hinter einem Reverse Proxy (TLS / Domain)

Für öffentlichen Zugang eine Domain + TLS auf Port 8000 legen (Caddy, nginx,
Plesk-Docker-Proxy, …). Wichtig:

- **Websocket-Unterstützung** aktivieren (`upgrade`/`connection`-Header),
  socket.io nutzt Websockets (oder Long-Polling als Fallback).
- **Proxy-Timeout/keepalive** für lange Verbindungen großzügig setzen
  (sonst beendet der Proxy aktive Spiele-Sockets).
- Gegenüber dem Client bleibt der Port intern egal (Proxy auf `http://localhost:8000`).

#### Beispiel: Caddy

```
stantonopoly.example.com {
    reverse_proxy :8000
    header_up X-Forwarded-Proto {scheme}
}
```

#### Beispiel: Plesk-Docker-Proxy

In Plesk eine **Docker-Proxy-Regel** anlegen, die die externe Domain
(`stantonopoly.sebo.one`) auf den Container-Port der Stantonopoly-Instanz richtet.
Dort kannst du direkt den DNS-Eintrag + Let's-Encrypt-Zertifikat verwalten; ein
separater systemd/pm2-Prozess entfällt, weil Docker schon lauschen kann.

---

## Datei-Struktur

```
server/
  engine/data.js      Portierung V1 data.js (Werte/Formeln/Presets)
  engine/engine.js    Portierung V1 game.js  (Spielregeln, server-authoritativ)
  db.js               node:sqlite Persistenz (+ SC-Katalog sc_names/sc_meta)
  rooms.js            Räume, Codes, Rollen-/Rechte-Checks, Spielfluss
  admin.js            Admin-REST-API (Auth-gated, /admin/*)
  scwiki.js           Star-Citizen-Wiki-Katalog-Fetcher (Schiffs-/Ortsnamen)
  index.js            Express static+/health + socket.io Event-Routing
public/
  index.html          GM-Setup/Join/Lobby/Game (SPA-Shell)
  admin.html          Admin-Dashboard
  assets/css/stantonopoly.css
  assets/js/board.js  Horizontale Kartenreihe-Renderer
  assets/js/client.js socket.io-Client (zeigt an, sendet Aktionen)
  assets/js/admin.js  Admin-Dashboard-Logik
tests/                (siehe Abschnitt Tests; run `npm run test:ci` ohne Hang-Dateien)
data/stantonopoly.db  (SQLite, automatisch angelegt; Volumes in Docker)
Dockerfile            Minimales, schlankes Image (node:26-alpine)
docker-compose.yml    Compose-Beispiel (GHCR-Image + Volume)
.github/workflows/    GH-Actions: Test + GHCR-Publish bei Push/Tag
```

## Socket-Events-Vertrag (client ↔ server)

Raum = `room:gameId`.

client → server:
`gm:create`, `gm:start`, `gm:deploy`, `gm:pause`, `gm:resumegame`, `gm:setleader`,
`team:join`, `vote:leader`, `forfeit:vote`,
`action:roll`, `action:buy`, `action:skip`, `action:build`, `action:nextTurn`,
`action:sell`, `action:mortgage`, `action:unmortgage`, `action:demolish`,
`action:mortgageChoice`, `action:forfeit`,
`trade:make`, `trade:respond`, `auction:start`, `auction:bid`, `auction:resolve`,
`task:complete`, `pirate:resolve`, `pirate:confirm`, `spectate`, `preset:*`.

server → client (Broadcast): `state`, `error`, `gameCreated` (nur an Ersteller),
`joined` (an betroffenen Client), `leave:confirm`, `game:deleted`.

Rollen: GM (Pflege) > Teamleiter (Eingabe) > Mitglied (lesen) > Beobachter (lesen).
Piraten: eigenes beitretbares Team mit `st.pirate`-Eintrag (nur GM/Pirat-Sockets).
`node:sqlite`-eingebaute Persistenz — Server ist immer die einzige Wahrheit.