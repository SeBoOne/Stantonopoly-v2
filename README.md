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
npm test                    # node --test 'tests/*.test.js'  → 26 Tests, grün
```

Abgedeckt:
- `engine.test.js`  — Rent-Formel (4 Preisbänder exakt), Umlauf +500k, Gundo,
  Bankrott/Sieg, Kauf/Ausbau, Persistenz-Roundtrip, Setup-Constraints, Preset, formatUAEC
- `multi.test.js`   — 2 parallele Spiele: getrennte Zustände und getrennte Räume
- `socket.test.js`  — Echtzeit: Aktion von A erreicht B im Raum (nicht C im anderen Raum), < 500 ms
- `auth.test.js`    — GM-Code-Schutz, Einladungscode öffnet nur das eigene Spiel,
  Teamleiter-Mehrheit, Mitglied darf nicht handeln (server-side)

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

## Deploy: Plesk-Vhost

Voraussetzung: managed Node-App auf Plesk ist ein Vhost mit PHP? Nein — für Node
nutzt Plesk **eigene Node-Anwendungen** oder einen Reverse-Proxy auf einen laufenden
Node-Prozess. Empfehlung für diesen Stack (langläufiger Socket-Server, nicht per
PHP ausführbar):

1. Node-Stack prüfen: `node --version` muss ≥ 22.5 sein (`node:sqlite` nötig).
2. Projekt nach dem Zielverzeichnis kopieren (z. B. `~/stentonopoly-multiplayer/`).
3. `npm install --omit=dev` (nur runtime-Deps: express, socket.io).
4. Prozessmanager (systemd/pm2) auf Port 8000 starten:
   ```
   npm start
   ```
5. In Plesk: Domain- oder Subdomain-Vhost auf **Reverse-Proxy** → `http://localhost:8000`.
   - Statische Assets + Socket-Handshake laufen dann über denselben Vhost.
   - Websocket-/Long-Polling-Zeitouts des Vhosts passend erhöhen (socket.io braucht
     lang laufende Verbindungen).

Hinweis: **Plesk-Dienste nie negativ beeinflussen** — Separation wie oben über einen
eigenen Port/Prozess, nicht in den Plesk-HTTP-Stack eingreifen.

## Deploy: VPS/Docker

### Option A — Docker (empfohlen für VPS)

```dockerfile
FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 8000
ENV PORT=8000
CMD ["node", "server/index.js"]
```

```bash
docker build -t stantonopoly-v2 .
docker run -d -p 8000:8000 -v stantonopoly-data:/app/data --name stantonopoly stantonopoly-v2
```

### Option B — systemd (ohne Docker)

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

Reverser Proxy davor (Caddy/nginx) für TLS und Domain-Lookup auf Port 8000.

---

## Datei-Struktur

```
server/
  engine/data.js      Portierung V1 data.js (Werte/Formeln/Presets)
  engine/engine.js    Portierung V1 game.js  (Spielregeln, server-authoritativ)
  db.js               node:sqlite Persistenz
  rooms.js            Räume, Codes, Rollen-/Rechte-Checks, Spielfluss
  index.js            Express static+/health + socket.io Event-Routing
public/
  index.html          GM-Setup/Join/Lobby/Game (SPA-Shell)
  assets/css/stantonopoly.css
  assets/js/board.js  Rundum-Rechteck-Renderer (Monopoly-Form)
  assets/js/client.js socket.io-Client (zeigt nur an, sendet Aktionen)
tests/
  engine.test.js  multi.test.js  socket.test.js  auth.test.js
test/mock_server.js  (Vorlage aus Runde 1, wird nicht zum Laufen benötigt)
data/stantonopoly.db (SQLite, automatisch angelegt)
```

## Socket-Events-Vertrag (client ↔ server)

Raum = `room:gameId`.

client → server: `gm:create`, `team:join`, `vote:leader`, `gm:start`, `gm:deploy`,
`action:roll`, `task:complete`, `action:buy`, `action:skip`, `action:build`,
`action:nextTurn`, `spectate`.

server → client (Broadcast): `state`, `error`, `gameCreated` (nur an Ersteller),
`joined` (an betroffenen Client).

Rollen: GM (Pflege) > Teamleiter (Eingabe) > Mitglied (lesen) > Beobachter (lesen).
`node:sqlite`-eingebaute Persistenz — Server ist immer die einzige Wahrheit.