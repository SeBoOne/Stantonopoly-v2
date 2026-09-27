/**
 * Stantonopoly V2 — rooms.js
 * Server-seitige Spiel-/Raum-Logik: getrennte Instanzen pro Spiel (gameId),
 * GM-Codes, Einladungscodes, Team-Anmeldung, Stimm-Mehrheit für Teamleiter,
 * Rollen-/Rechte-Checks und alle Spielaktionen (server-authoritativ).
 *
 * Abhängigkeiten: ./engine/data.js (Daten), ./engine/engine.js (Spielregeln),
 *                ./db.js (Persistenz).
 *
 * Diese Datei kennt KEIN socket.io — sie arbeitet auf einem abstrakten
 * "Broadcaster { to(room).emit(event, data) }" und einem "Sock" mit .id/.join.
 * index.js verdrahtet sie mit echten socket.io-Clients.
 */
'use strict';

const D = require('./engine/data.js');
const G = require('./engine/engine.js');
const dbm = require('./db.js');

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
// Sebos Star-Citizen-Schiffe (Default-Angebot, frei überschreibbar durch config.ships)
const SHIP_NAMES = ['Redeemer', 'Hammerhead', 'Reclaimer', 'Caterpillar', 'Carrack', '890 Jump', 'Moth', 'Railen'];
const SHIP_COLORS = ['#2ecc71', '#95a5a6', '#f1c40f', '#e74c3c', '#3498db', '#e67e22', '#1abc9c', '#ecf0f1'];
// Default-Aufgabe je Schiff (frei überschreibbar durch config.tasks)
const SHIP_TASKS = {
  'Redeemer': 'ERT oder VHRT-Mission erledigen',
  'Hammerhead': 'ERT oder VHRT-Mission erledigen',
  'Reclaimer': 'Hammerhead-Salvage-Mission erledigen',
  'Moth': 'Hammerhead-Salvage-Mission erledigen',
  'Caterpillar': 'Einen Traderun erledigen',
  'Railen': 'Einen Traderun erledigen',
  'Carrack': 'Delivery-Mission (mit Begleitschiff/Kommandomodul) erledigen',
  '890 Jump': 'Mit einem Snub eine Runde bei Miners Lament, Caplan oder Yadar Valley fliegen'
};

function randCode(len) {
  let c = '';
  for (let i = 0; i < len; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}

// Persistentes, einmaliges Code-Schema in DB: Code existiert nur wenn er als
// Invite oder GM eingetragen wurde. Beim Kollisions-Fall neu würfeln.
function genUniqueCode(kind, len) {
  let code;
  do {
    code = randCode(len);
  } while (dbm.getCode(code));
  return code;
}

// Engine-Spieler (Team) aus dem State oben erzeugen — Engine nutzt 'id' intern;
// wir übergeben name="Team <Schiff>" für Anzeige in Serialisierung.
function playerFor(team, startingCapital) {
  return {
    id: team.teamId,
    name: team.teamName || ('Team ' + team.ship),
    ship: team.ship,
    task: null,
    budget: startingCapital
  };
}

// Vollständiger State-View, der an Clients broadcastet wird.
// `game` = deserialisierter Engine-Zustand.

function buildView({ gameId, game, teams, leaders }) {
  // Engine-Zustand (serialisierbar) re-expandieren: players sind Teams.
  const lmap = {};
  (leaders || []).forEach((l) => { if (l && l.teamId) lmap[l.teamId] = l.leaderId; });
  const teamViews = (teams || []).map((t, ti) => {
    const enginePlayer = (game && game.players && game.players[ti]) || {};
    // Votes pro Kandidat für dieses Team (Live-Stimmenzahlen)
    const vc = {};
    (dbm.getVotes(gameId, t.teamId) || []).forEach((v) => { vc[v.candidateId] = (vc[v.candidateId] || 0) + 1; });
    return {
      id: t.teamId,
      teamId: t.teamId,
      ship: t.ship,
      task: enginePlayer.task || t.task || '',
      teamName: t.teamName || ('Team ' + t.ship),
      color: t.color,
      leaderId: t.leaderId || null,
      players: (dbm.getPlayers(gameId) || [])
        .filter((p) => p.teamId === t.teamId)
        .map((p) => ({ playerId: p.id, id: p.id, name: p.name })),
      votes: vc
    };
  });
  const gameState = game ? {
    ...game.serialize() && JSON.parse(game.serialize()),
    // Anreicherung vom Server (client.js erwartet tensional activeIdx etc.)
    activeIdx: game.activeIdx,
    over: game.over,
    winnerInfo: game.winnerInfo,
    // fields kommen aus der Serialisierung (Preset-Felder je Spiel) — Fallback:
    fields: (game.fields && game.fields.length) ? game.fields : (G.D.PRESETS['Crusader Cluster'].fields || [])
  } : null;

  let presetName = 'Eigene Karte';
    const gRow = dbm.getGame(gameId);
    if (gRow && gRow.name) presetName = gRow.name;
    // (2m-E) Platzierung vom Sieger bis zum ersten Ausscheider (absteigend).
    // Der Server ergänzt die Reihenfolge-Liste, da die Engine nur den Sieger
    // (winnerInfo) liefert. Reihenfolge: 1. Sieger, dann aktive Teams, dann
    // ausgeschiedene (bankrotte) Teams in Team-Reihenfolge.
    const ranking = (game && Array.isArray(game.players)) ? (() => {
      const winnerId = game.winnerInfo ? game.winnerInfo.id : null;
      const alive = [];
      const out = [];
      game.players.forEach((p, i) => {
        const meta = (teams && teams[i]) || {};
        const entry = {
          name: p.name || meta.teamName || ('Team ' + (i + 1)),
          ship: meta.ship || '',
          color: meta.color || '',
          teamName: meta.teamName || p.name || ('Team ' + (i + 1)),
          bankrupt: !!p.bankrupt,
          winner: !!p.winner || (winnerId != null && String(p.id) === String(winnerId)),
          budget: (typeof p.budget === 'number') ? p.budget : 0
        };
        if (entry.winner) alive.unshift(entry);   // Sieger immer ganz oben
        else if (!p.bankrupt) alive.push(entry);  // aktive Teams danach
        else out.push(entry);                     // ausgeschiedene zuletzt
      });
      return alive.concat(out).map((e, i) => Object.assign(e, { place: i + 1 }));
    })() : [];
    return {
      gameId,
      game: gameState,
      presetName,
      gmName: (gRow && gRow.gmName) ? String(gRow.gmName) : 'GM',
      teams: teamViews,
      leaders: leaders || [],
      started: (game && !game.over && !!game._started) ? true : false,
      over: !!(game && game.over),
      paused: !!(gRow && gRow.paused),
      winnerInfo: (game && game.winnerInfo) || null,
      ranking,
      log: (game && game.log) || []
    };
  }

// Prüft, ob ein Socket innerhalb des Raums als Teamleiter/aktiver angesehen wird.
// teamIdFromSocket: wird vom Aufrufer (index.js) als Socket-Daten geliefert.
class Rooms {
  constructor(broadcast, opts = {}) {
    // broadcast: { to(room).emit(event, data) } - zentraler io
    this.io = broadcast;
    this._turnTimers = {}; // gameId -> setTimeout-Handle (2g#17 Zug-Timer)
    // GM-Sockets je Spiel (Sockets, die einen gültigen GM-Code präsentiert haben):
    // sie sind vom Auto-Remove bei Disconnect ausgenommen und können sich während
    // eines laufenden Spiels nicht selbst entfernen (Punkt 1 + 8).
    this._gmSockets = Object.create(null); // gameId -> Set(sockId)
    // Laufende Disconnect-Timeout-Timer je Socket: sockId -> { gameId, timer, name }
    this._pendingDisconnects = new Map();
    this._disconnectTimeoutMs = Number(opts.disconnectTimeoutMs) > 0
      ? Number(opts.disconnectTimeoutMs)
      : (Number(process.env.STANTONOPOLY_DISCONNECT_TIMEOUT_MS) > 0
          ? Number(process.env.STANTONOPOLY_DISCONNECT_TIMEOUT_MS)
          : 5 * 60 * 1000);
    // (2m-A) Auto-Pause nach Inaktivität / Auto-Beenden nach langer Pause.
    // Schwellen per env überschreibbar (Tests nutzen kleine Werte).
    this._inactiveMs = (opts.inactiveMs != null && Number(opts.inactiveMs) > 0)
      ? Number(opts.inactiveMs)
      : (Number(process.env.STANTONOPOLY_INACTIVE_MS) > 0
          ? Number(process.env.STANTONOPOLY_INACTIVE_MS)
          : 10 * 60 * 1000);          // default 10 min
    this._pausedEndMs = (opts.pausedEndMs != null && Number(opts.pausedEndMs) > 0)
      ? Number(opts.pausedEndMs)
      : (Number(process.env.STANTONOPOLY_PAUSED_END_MS) > 0
          ? Number(process.env.STANTONOPOLY_PAUSED_END_MS)
          : 30 * 24 * 60 * 60 * 1000); // default 30 Tage
    this._autoSweepMs = (opts.sweepMs != null && Number(opts.sweepMs) > 0)
      ? Number(opts.sweepMs)
      : (Number(process.env.STANTONOPOLY_SWEEP_MS) > 0
          ? Number(process.env.STANTONOPOLY_SWEEP_MS)
          : 60 * 1000);                // default Sweep alle 60 s
    this._startAutoSweep();
  }

  // ------------------------------------------------------------------
  // (2m-A) Auto-Pause / Auto-Beenden — periodischer Sweep über alle Spiele.
  // ------------------------------------------------------------------
  _startAutoSweep() {
    this._stopAutoSweep();
    const t = setInterval(() => this._autoSweep(), this._autoSweepMs);
    // unref: der Sweep darf den Prozess (Tests/Server-Stop) nicht wach halten.
    if (t && typeof t.unref === 'function') t.unref();
    this._autoSweepTimer = t;
  }

  _stopAutoSweep() {
    if (this._autoSweepTimer) { clearInterval(this._autoSweepTimer); this._autoSweepTimer = null; }
  }

  _autoSweep() {
    let rows = [];
    try { rows = dbm.listAllGames() || []; } catch (e) { return; }
    const now = Date.now();
    for (const g of rows) {
      if (!g || !g.started || g.over) continue;
      if (!g.paused) {
        // P1: laufendes Spiel ohne Aktivität seit _inactiveMs → Auto-Pause.
        const last = Number(g.lastActivity) || 0;
        if (last > 0 && (now - last) >= this._inactiveMs) {
          this._autoPauseGame(g.gameId);
        }
      } else {
        // P2: durchgehend pausiert seit _pausedEndMs → Auto-Beenden (Vermögenswert-Sieger).
        const pausedAt = Number(g.lastPausedAt) || 0;
        if (pausedAt > 0 && (now - pausedAt) >= this._pausedEndMs) {
          this._autoEndGame(g.gameId);
        }
      }
    }
  }

  // Interne Pause ohne GM-Code (Auto-Pause). Setzt paused + Broadcast.
  _autoPauseGame(gameId) {
    try {
      const gameRow = dbm.getGame(gameId);
      if (!gameRow || !gameRow.started || gameRow.over || gameRow.paused) return;
      dbm.setPaused(gameId, true);
      this._clearTurnTimer(gameId);
      const e2 = G.deserialize(dbm.getGame(gameId).state, D);
      e2.turnDeadline = 0;
      this._save(gameId, e2);
      const engine = this._loadEngine(gameId);
      if (engine) {
        this.logEngine(gameId, engine, 'Spiel wird nach ' + Math.round(this._inactiveMs / 60000) + ' min Inaktivität automatisch pausiert.');
        dbm.updateState(gameId, { state: engine.serialize(), started: gameRow.started ? 1 : 0, over: engine.over ? 1 : 0 });
      }
      this.broadcast(gameId);
    } catch (e) { /* ignorieren */ }
  }

  // Interne Beendigung nach langer Pause: Gewinner = reichstes Team (Vermögenswert).
  _autoEndGame(gameId) {
    try {
      const gameRow = dbm.getGame(gameId);
      if (!gameRow || !gameRow.started || gameRow.over || !gameRow.paused) return;
      const engine = this._loadEngine(gameId);
      if (!engine) return;
      const winnerIdx = engine.richestTeamIdx();
      if (winnerIdx >= 0) {
        engine.over = true;
        engine.winnerInfo = engine.players[winnerIdx];
        engine.players[winnerIdx].winner = true;
        this.logEngine(gameId, engine, 'Spiel wird nach ' + Math.round(this._pausedEndMs / (24 * 60 * 60 * 1000)) + ' Tagen Pause automatisch beendet. Sieger: ' + engine.players[winnerIdx].name + ' (höchster Vermögenswert).');
      } else {
        engine.over = true;
        this.logEngine(gameId, engine, 'Spiel wird nach langer Pause automatisch beendet (kein aktives Team).');
      }
      this._clearTurnTimer(gameId);
      dbm.setPaused(gameId, false);
      dbm.updateState(gameId, { state: engine.serialize(), started: gameRow.started ? 1 : 0, over: 1 });
      this.broadcast(gameId);
    } catch (e) { /* ignorieren */ }
  }

  // Merkt einen Socket als GM eines Spiels (hat gültigen GM-Code vorgelegt).
      _addGmSocket(gameId, sock) {
    if (!sock || !sock.id) return;
    if (!this._gmSockets[gameId]) this._gmSockets[gameId] = new Set();
    this._gmSockets[gameId].add(sock.id);
  }
  _removeGmSocket(gameId, sockId) {
    if (this._gmSockets[gameId]) {
      this._gmSockets[gameId].delete(sockId);
      if (!this._gmSockets[gameId].size) delete this._gmSockets[gameId];
    }
  }
  _isGmSocket(gameId, sockId) {
    return !!this._gmSockets[gameId] && this._gmSockets[gameId].has(sockId);
  }

  _gmNameOf(gameId) {
    const g = dbm.getGame(gameId);
    return (g && g.gmName) ? String(g.gmName) : 'GM';
  }

  _roomOf(gameId) {
      return 'room:' + gameId;
    }

    // (2h#8) GM-Rechte-Check: gültiger GM-Code UND — sobald ein gm_owner gesetzt
        // ist (nach Start/Resume/Transfer) — der anfragende Socket ist der aktive GM.
        // Da der GM-Code beim GM-Wechsel NICHT rotiert wird, verliert der alte GM seine
        // Rechte über den gm_owner-Wechsel — nicht über einen neuen Code. Vor dem Start
        // (gm_owner noch leer) reicht der Code (Legacy-Verhalten für GM-Aktionen in der
        // Lobby). resumeAsGM/resumeGame setzen gm_owner selbst.
        _requireGmOwner({ gameId, gmCode, sock, action }) {
          const gameRow = dbm.getGame(gameId);
          if (!gameRow) return { error: { code: 'NO_GAME', message: 'Unbekanntes Spiel.' } };
          const codeRow = dbm.getCode(String(gmCode || '').toUpperCase());
          if (!codeRow || codeRow.kind !== 'gm' || codeRow.gameId !== gameId) {
            return { error: { code: 'FORBIDDEN', message: 'Nur der GM darf ' + action + '.' } };
          }
          if (gameRow.gm_owner && String(gameRow.gm_owner) !== String(sock.id)) {
            return { error: { code: 'FORBIDDEN', message: 'Nur der aktive GM darf ' + action + ' — du bist nicht mehr der GM.' } };
          }
          return { gameRow, codeRow };
        }

  _emit(room, event, data) {
    if (this.io && this.io.to) this.io.to(room).emit(event, data);
  }

  // Gezielter Emit an EINEN Socket (socket.io: jede Socket-ID ist ein impliziter Raum).
  _emitTo(sid, event, data) {
    if (!sid) return;
    if (this.io && this.io.to) this.io.to(String(sid)).emit(event, data);
  }

  // ------------------------------------------------------------------
  // (2g#17) Zug-Timer (Inaktivitäts-Timeout): GM-Ablauf → Auto-Zugende.
  // Jede Aktion re-armt den Timer (via _persistAndReturn); Pause stoppt ihn.
  // ------------------------------------------------------------------
  _armTurnTimer(gameId) {
    this._clearTurnTimer(gameId);
    try {
      const gameRow = dbm.getGame(gameId);
      if (!gameRow || !gameRow.started || gameRow.over || gameRow.paused) return;
      const engine = G.deserialize(gameRow.state, D);
      const secs = Math.max(0, Math.round(Number(engine.turnSeconds) || 0));
      if (!(secs > 0) || engine.over) return;
      engine.turnDeadline = Date.now() + secs * 1000;
      this._save(gameId, engine);
      this._turnTimers[gameId] = setTimeout(() => this._expireTurnTimer(gameId), secs * 1000 + 250);
    } catch (e) { /* ignorieren */ }
  }

  _clearTurnTimer(gameId) {
    if (this._turnTimers[gameId]) {
      clearTimeout(this._turnTimers[gameId]);
      delete this._turnTimers[gameId];
    }
  }

  _expireTurnTimer(gameId) {
    delete this._turnTimers[gameId];
    try {
      const gameRow = dbm.getGame(gameId);
      if (!gameRow || !gameRow.started || gameRow.over || gameRow.paused) return;
      const engine = G.deserialize(gameRow.state, D);
      if (!(Math.round(Number(engine.turnSeconds) || 0) > 0) || engine.over) return;
      engine.nextTurn();
      this._save(gameId, engine);
      this.broadcast(gameId);
    } catch (e) { /* ignorieren */ }
  }

  _save(gameId, game) {
    // started bewusst aus der DB übernehmen: engine._started wird von
    // serialize/deserialize NICHT übertragen (started lebt in der games-Spalte),
    // sonst würde ein deserialisierter Timersave started=0 zurückschreiben.
    const cur = dbm.getGame(gameId);
    dbm.updateState(gameId, {
      state: game.serialize(),
      started: cur ? (cur.started ? 1 : 0) : (game._started ? 1 : 0),
      over: game.over ? 1 : 0
    });
    // (2m-A) Jede state-ändernde Aktion zählt als Aktivität (verhindert Auto-Pause).
    dbm.touchActivity(gameId);
  }

  // ------------------------------------------------------------------
  // GM: Spiel erstellen
  // ------------------------------------------------------------------
  createGame({ config, sock }) {
    const teams = Math.max(D.MIN_TEAMS, Math.min(D.MAX_TEAMS, Number(config.teams) || D.MIN_TEAMS));
    const capital = (Number.isFinite(Number(config.capital)) && Number(config.capital) > 0)
      ? Math.round(Number(config.capital))
      : D.DEFAULT_CAPITAL;
    const diceKind = (config.diceConfig && (config.diceConfig.kind || config.diceConfig)) || '1w6';
        // (2h#6) Nur 1W6/2W6 sind gültig — „frei“ wurde entfernt.
        if (['1w6', '2w6'].indexOf(diceKind) === -1) {
          return { error: { code: 'BAD_DICE', message: 'Unbekannter Würfelmodus.' } };
        }
    const armistice = !!config.armistice;
    const gmName = (config.gmName && String(config.gmName).trim()) ? String(config.gmName).trim().slice(0, 40) : 'GM';

    let gameId = genUniqueCode('gm', 6); // gameId
    let gmCode;
    do { gmCode = randCode(6); } while (dbm.getCode(gmCode));

    // Teams anlegen
    const teamRows = [];
    const ships = Array.isArray(config.ships) && config.ships.length
      ? config.ships
      : SHIP_NAMES.slice(0, teams);
    const tasksRaw = Array.isArray(config.tasks) ? config.tasks : [];
    for (let i = 0; i < teams; i++) {
      const ship = String(ships[i % ships.length] || SHIP_NAMES[i % SHIP_NAMES.length]).trim();
      const task = (tasksRaw[i] != null ? String(tasksRaw[i]).trim() : '') || (SHIP_TASKS[ship] || '');
      const invite = genUniqueCode('invite', 4);
      const teamId = 'team_' + i;
      const color = SHIP_COLORS[i % SHIP_COLORS.length];
      dbm.upsertTeam({ gameId, teamId, ship, color, invite_code: invite, leaderId: null });
      dbm.addCode({ code: invite, kind: 'invite', gameId, teamId });
      teamRows.push({ teamId, ship, color, invite, task, teamName: 'Team ' + ship });
    }
    dbm.addCode({ code: gmCode, kind: 'gm', gameId });

    // Engine-Spiel erzeugen (Teams = Players), State initial speichern.
    // fields: Standard-Preset ODER vom Client gesendetes (eigenes) Preset.
    let fieldsSource = null;
    if (Array.isArray(config.fields) && config.fields.length) {
      fieldsSource = config.fields;
    } else {
      let presetName = config.preset || '';
      if (presetName && D.PRESETS[presetName]) {
        fieldsSource = D.PRESETS[presetName].fields;
      } else if (presetName) {
        // Eigenes (in DB gespeichertes) Preset laden
        const dbPreset = dbm.getPreset(presetName);
        fieldsSource = dbPreset ? dbPreset.fields : null;
      }
      if (!fieldsSource) fieldsSource = D.PRESETS['Crusader Cluster'].fields;
    }
    // levelNames für die Ausbaustufen: bevorzugt vom Client (Preset-Editor),
    // sonst vom gewählten Preset (builtin oder DB), sonst Default.
    let levelNames = (config.levelNames && typeof config.levelNames === 'object' && Object.keys(config.levelNames).length)
      ? config.levelNames : null;
    if (!levelNames) {
      let presetMeta = D.PRESETS[config.preset || ''];
      if (!presetMeta && config.preset) presetMeta = dbm.getPreset(config.preset);
      if (presetMeta && presetMeta.levelNames && typeof presetMeta.levelNames === 'object') levelNames = presetMeta.levelNames;
    }
    // settings für die Spielregeln (Miete/Bau/Hypothek/Bank/Timer/Sperren):
    // bevorzugt vom Client, sonst vom Preset.
    let ruleSettings = (config.settings && typeof config.settings === 'object' && Object.keys(config.settings).length)
      ? config.settings : null;
    if (!ruleSettings) {
      let presetMeta2 = D.PRESETS[config.preset || ''];
      if (!presetMeta2 && config.preset) presetMeta2 = dbm.getPreset(config.preset);
      if (presetMeta2 && presetMeta2.settings && typeof presetMeta2.settings === 'object') ruleSettings = presetMeta2.settings;
    }
    const engine = G.createGame({
      data: D,
      fields: fieldsSource,
      players: teamRows.map((t, i) => ({ id: t.teamId, name: t.teamName, ship: t.ship, task: t.task })),
      startingCapital: capital,
      diceConfig: { kind: diceKind },
      armisticeEnabled: armistice,
      levelNames,
      settings: ruleSettings,
      turnSeconds: Math.max(0, Math.round(Number(config.turnSeconds) || 0))
    });
    engine._started = false;
    // Spielname: gewählter Preset-Name oder Default (für Spieleliste/Fortsetzen).
    const gameName = (config.gameName && String(config.gameName).trim())
      ? String(config.gameName).trim()
      : ((config.preset && (D.PRESETS[config.preset] || dbm.getPreset(config.preset))) ? config.preset : 'Crusader Cluster');
    dbm.createGame({ gameId, gmCode, state: engine.serialize(), started: 0, over: 0, name: gameName, gmName });

    sock.join(this._roomOf(gameId));
    this._addGmSocket(gameId, sock);

    return {
      ok: true,
      gameId,
      gmCode,
      // tokens: Einladungscodes je Team (Schiff + Aufgabe + Code) für den GM-Screen
      tokens: teamRows.map((t) => ({ ship: t.ship, task: t.task, teamName: t.teamName, teamId: t.teamId, code: t.invite }))
    };
  }

  // ------------------------------------------------------------------
  // Team beitreten (Einladungscode gibt nur das eigene Team frei)
  // ------------------------------------------------------------------
  joinTeam({ gameId, code, playerName, sock }) {
    // Einladungscodes sind global eindeutig (genUniqueCode) -> gameId aus dem
    // Code selbst auflösen, damit ein Spieler mit NUR dem Code beitreten kann.
    let codeValue = String(code || '').toUpperCase();
    const codeRow = dbm.getCode(codeValue);
    if (!codeRow) {
      return { error: { code: 'BAD_CODE', message: 'Ungültiger Einladungscode.' } };
    }
    const name = String(playerName || 'Pilot').slice(0, 24) || 'Pilot';

    // (2m P11) GM-Code im Beitrittsformular → übernimmt die aktive GM-Sitzung
    // inklusive Name + Teamzugehörigkeit (falls vorhanden) — analog Rejoin.
    // Wer den GM-Code eintippt, ist der GM (server-authoritativ).
    if (codeRow.kind === 'gm') {
      const resolvedGameId = codeRow.gameId;
      if (gameId && String(gameId).toUpperCase() !== resolvedGameId) {
        return { error: { code: 'BAD_CODE', message: 'GM-Code gehört nicht zu diesem Spiel.' } };
      }
      const gameRow = dbm.getGame(resolvedGameId);
      if (!gameRow) return { error: { code: 'NO_GAME', message: 'Unbekanntes Spiel.' } };
      if (gameRow.over) return { error: { code: 'OVER', message: 'Das Spiel ist bereits beendet.' } };
      this._addGmSocket(resolvedGameId, sock);
      dbm.setGmOwner(resolvedGameId, sock.id);
      sock.join(this._roomOf(resolvedGameId));
      // Falls der eintippende GM bereits ein Team-Mitglied ist (gleicher Name),
      // diese Membership übernehmen (Teamzugehörigkeit, Leader, Votes wie Rejoin).
      let teamId = null; let token = null; let role = 'gm'; let replaced = false;
      const existingMatches = (dbm.getPlayers(resolvedGameId) || [])
        .filter((p) => String(p.name).toLowerCase() === name.toLowerCase() && String(p.id) !== String(sock.id));
      const match = existingMatches[0] || null;
      if (match) {
        const team = dbm.getTeam(resolvedGameId, match.teamId);
        const taken = this._takeoverPlayer({ gameId: resolvedGameId, team, name, oldPlayer: match, sock });
        teamId = taken.teamId; token = taken.token; role = taken.role === 'leader' ? 'leader' : 'gm'; replaced = true;
        // Nach _takeoverPlayer ist der Socket zusätzlich als Team-Mitglied registriert.
      }
      return {
        ok: true,
        gameId: resolvedGameId,
        teamId,
        playerId: sock.id,
        token,
        role,
        isGM: true,
        gmCode: codeValue,
        replaced
      };
    }
    if (codeRow.kind !== 'invite') {
      return { error: { code: 'BAD_CODE', message: 'Ungültiger Einladungscode.' } };
    }
    // Wenn eine gameId mitgegeben wurde, muss sie zum Code passen; sonst vom Code ableiten.
    const resolvedGameId = codeRow.gameId;
    if (gameId && String(gameId).toUpperCase() !== resolvedGameId) {
      return { error: { code: 'BAD_CODE', message: 'Einladungscode gehört nicht zu diesem Spiel.' } };
    }
    const gameRow = dbm.getGame(resolvedGameId);
    if (!gameRow) return { error: { code: 'NO_GAME', message: 'Unbekanntes Spiel.' } };
    // Beitritt nach Spielstart ist erlaubt (Teams können spät Spieler aufnehmen),
    // solange das Spiel noch nicht beendet ist. Nach Ende ist kein Beitritt mehr möglich.
    if (gameRow.started && gameRow.over) return { error: { code: 'OVER', message: 'Das Spiel ist bereits beendet.' } };

    const team = dbm.getTeam(resolvedGameId, codeRow.teamId);
    if (!team) return { error: { code: 'TEAM_GONE', message: 'Team nicht gefunden.' } };

        // (2m P6) Gerätewechsel: Jemand tritt mit demselben Spieler-Namen UND demselben
        // Team-Code bei → er übernimmt den vorhandenen Login (alle Rollen: GM, Team,
        // Leiter, Eigentum, Guthaben). Der alte Login wird mit der Meldung
        // „Von einem anderen Standort eingeloggt“ aus dem Spiel entfernt.
        const sameName = (dbm.getPlayers(resolvedGameId) || [])
          .find((p) => p.teamId === team.teamId
            && String(p.name).toLowerCase() === String(name).toLowerCase()
            && String(p.id) !== String(sock.id));
        if (sameName) {
          return this._takeoverPlayer({ gameId: resolvedGameId, team, name, oldPlayer: sameName, sock });
        }

        let token = null;
                const existing = dbm.getPlayer(sock.id);
    // Punkt 2 (Auto-Austritt bei Wechsel): wer bereits in einer anderen Lobby/einem
    // anderen Spiel Mitglied ist und sich per Einladungscode in ein NEUES Spiel
    // begibt, wird sauber aus der alten Membership entfernt (Leader-Nachfolge,
    // Votes, Room-Leave, Broadcast an das alte Spiel), bevor er dem neuen beitritt.
    if (existing && existing.gameId !== resolvedGameId) {
      this._cleanupMembership(existing.gameId, sock);
      // Neue Identität im Ziel-Spiel: frischer Token (der alte war ans alte Spiel gebunden).
      token = genUniqueCode('token', 10);
      dbm.addPlayer({ id: sock.id, gameId: resolvedGameId, teamId: team.teamId, name, token });
    } else if (existing) {
      // Schon beigetreten (gleiches Spiel): bestehenden Eintrag behalten (Token falls vorhanden).
      token = existing.token || genUniqueCode('token', 10);
      dbm.addPlayer({ id: sock.id, gameId: resolvedGameId, teamId: team.teamId, name, token });
    } else {
      token = genUniqueCode('token', 10);
      dbm.addPlayer({ id: sock.id, gameId: resolvedGameId, teamId: team.teamId, name, token });
    }

    sock.join(this._roomOf(resolvedGameId));
        return {
          ok: true,
          gameId: resolvedGameId,
          teamId: team.teamId,
          playerId: sock.id,
          token,
          role: 'member'
        };
      }

      // ------------------------------------------------------------------
      // (2m P6) Gerätewechsel: gleicher Name + gleicher Team-Code ersetzt den
      // vorhandenen Login. Der neue Socket übernimmt die Identität des alten
      // (Rollen, Leader, Votes, GM, Token); der alte Socket wird mit der Meldung
      // „Von einem anderen Standort eingeloggt“ aus dem Spiel entfernt.
      // ------------------------------------------------------------------
      _takeoverPlayer({ gameId, team, name, oldPlayer, sock }) {
        // Falls der neue Socket bereits eine Membership in diesem Spiel hat (andere
        // Identität), sauber entfernen, damit remapPlayerSock nicht auf einen
        // PK-Konflikt (zwei Zeilen mit derselben Socket-ID) läuft.
        const existing = dbm.getPlayer(sock.id);
        if (existing && existing.gameId === gameId && String(existing.id) !== String(oldPlayer.id)) {
          this._cleanupMembership(gameId, sock);
        }
        // Alten Login auf den neuen Socket umsetzen (Votes, Leader, Spieler-ID).
        dbm.remapPlayerSock(sock.id, oldPlayer.id);
        // Namen auf den neuen (exakten) Namen setzen; Token bleibt stabil.
        const taken = dbm.getPlayer(sock.id);
        dbm.addPlayer({ id: sock.id, gameId, teamId: team.teamId, name, token: taken ? taken.token : null });
        // GM-Rolle übernehmen, NUR wenn der alte Login der aktive GM war.
        // Ein NORMALES Teammitglied (nicht GM) darf nach dem Gerätewechsel NICHT
        // hier als GM registriert werden — sonst blockiert GM_ACTIVE fälschlich sein
        // Verlassen (P6 2n). Ist der neue Socket bereits über den GM-Code registriert
        // (2m P11-Pfad ruft _addGmSocket vor _takeoverPlayer auf), bleibt das hier
        // unangetastet.
        const gameRow = dbm.getGame(gameId);
        if (gameRow && String(gameRow.gm_owner || '') === String(oldPlayer.id)) {
          dbm.setGmOwner(gameId, sock.id);
          this._addGmSocket(gameId, sock);
        }
        // Alten Socket aus dem GM-Register + Disconnect-Timeout entfernen.
        this._removeGmSocket(gameId, oldPlayer.id);
        this._cancelPendingDisconnect(oldPlayer.id);
        // Alten Socket mit der Meldung aus dem Spiel leiten.
        try { if (this.io && this.io.to) this.io.to(String(oldPlayer.id)).emit('game:redirected', { gameId, reason: 'replaced', message: 'Von einem anderen Standort eingeloggt' }); } catch (e) {}
        try {
          const os = this.io && this.io.sockets && this.io.sockets.sockets.get(oldPlayer.id);
          if (os && os.leave) os.leave(this._roomOf(gameId));
        } catch (e) {}
        sock.join(this._roomOf(gameId));
        const team2 = dbm.getTeam(gameId, team.teamId);
        const isLeader = !!team2 && team2.leaderId != null && String(team2.leaderId) === String(sock.id);
        return {
          ok: true,
          gameId,
          teamId: team.teamId,
          playerId: sock.id,
          token: taken ? taken.token : null,
          role: isLeader ? 'leader' : 'member',
          replaced: true
        };
      }

      // ------------------------------------------------------------------
      // Rejoin nach Browser-Neuladen: Token -> Spieler wiederherstellen
            // ------------------------------------------------------------------
         rejoin({ gameId, token, sock }) {
    const gameRow = dbm.getGame(gameId);
    if (!gameRow) return { error: { code: 'NO_GAME', message: 'Unbekanntes Spiel.' } };
    const pl = dbm.getPlayerByToken(String(token || ''));
    if (!pl || pl.gameId !== gameId) {
      return { error: { code: 'BAD_TOKEN', message: 'Unbekannter Rejoin-Link.' } };
    }
    // Alte Socket-ID (pl.id) auf die neue (sock.id) umsetzen, damit Leader/Votes folgen.
    dbm.remapPlayerSock(sock.id, pl.id);
    // Punkt 8: Rejoin setzt einen laufenden Disconnect-Timeout zurück.
    this._cancelPendingDisconnect(pl.id);
    sock.join(this._roomOf(gameId));
    // Rolle korrekt bestimmen: Teamleiter (nach Remap ist leaderId die neue Socket-ID).
    const team = dbm.getTeam(gameId, pl.teamId);
    const isLeader = !!team && team.leaderId != null && String(team.leaderId) === String(sock.id);
    return {
      ok: true,
      gameId,
      teamId: pl.teamId,
      playerId: sock.id,
      token,
      role: isLeader ? 'leader' : 'member'
    };
  }

  // ------------------------------------------------------------------
  // Stimm-Mehrheit für Teamleiter: Vote abgeben, Mehrheit prüfen (einfache Mehrheit)
  // ------------------------------------------------------------------
  // ------------------------------------------------------------------
  // Teamleiter per Stimm-Mehrheit wählen (NUR in der Lobby vor Spielstart).
  // Während des Spiels wird die Rolle nur aktiv vom aktuellen Leader übertragen.
  // ------------------------------------------------------------------
  voteLeader({ gameId, playerId, sock }) {
    const gameRow = dbm.getGame(gameId);
    if (!gameRow) return { error: { code: 'NO_GAME', message: 'Unbekanntes Spiel.' } };
    if (gameRow.started) {
      return { error: { code: 'GAME_STARTED', message: 'Während des Spiels bestimmt der Teamleiter seine Nachfolge selbst.' } };
    }
    const me = dbm.getPlayer(sock.id);
    if (!me || me.gameId !== gameId) return { error: { code: 'NOT_IN_TEAM', message: 'Kein Mitglied dieses Spiels.' } };

    // candidateId per playerId
    const candidate = dbm.getPlayer(playerId);
    if (!candidate || candidate.gameId !== gameId) return { error: { code: 'BAD_CANDIDATE', message: 'Kandidat nicht im Spiel.' } };
    // Nur innerhalb des eigenen Teams wählen/bestimmen
    if (candidate.teamId !== me.teamId) return { error: { code: 'CROSS_TEAM', message: 'Nur innerhalb des eigenen Teams.' } };

    // Stimme speichern, KEINE sofortige Auflösung
    dbm.addVote({ gameId, teamId: me.teamId, voterId: me.id, candidateId: candidate.id });

    // Stimmenzahlen zurückgeben (für Live-Anzeige in der UI)
    const votes = dbm.getVotes(gameId, me.teamId);
    const vc = {};
    votes.forEach((v) => { vc[v.candidateId] = (vc[v.candidateId] || 0) + 1; });
    return { ok: true, gameId, teamId: me.teamId, votes: vc };
  }

  // ------------------------------------------------------------------
  // resolveTeamLeader(gameId, teamId): Stimmen auswerten und Leader setzen.
  // Wird von startGame/resumeGame/leaveGame aufgerufen.
  // ------------------------------------------------------------------
  resolveTeamLeader(gameId, teamId) {
    const members = (dbm.getPlayers(gameId) || []).filter((p) => p.teamId === teamId);
    if (!members.length) {
      dbm.setLeader(gameId, teamId, null);
      return null;
    }
    const votes = dbm.getVotes(gameId, teamId);
    // Zähle candidateId, aber nur Stimmen, deren voterId UND candidateId noch aktuelle members sind
    const validVoteIds = new Set(members.map((m) => m.id));
    const counts = {};
    votes.forEach((v) => {
      if (validVoteIds.has(v.voterId) && validVoteIds.has(v.candidateId)) {
        counts[v.candidateId] = (counts[v.candidateId] || 0) + 1;
      }
    });
    let pick = null;
    const voteEntries = Object.entries(counts);
    if (voteEntries.length) {
      // Kandidat mit den meisten Stimmen gewinnt
      voteEntries.sort((a, b) => b[1] - a[1]);
      const maxVotes = voteEntries[0][1];
      // Gleichstand: alle mit Max-Anzahl
      const tied = voteEntries.filter((e) => e[1] === maxVotes).map((e) => e[0]);
      if (tied.length === 1) {
        pick = tied[0];
      } else {
        pick = tied[Math.floor(Math.random() * tied.length)];
      }
    } else {
      // Keine Stimmen: wenn bereits ein gültiger Leader existiert (als aktuelles Member),
      // diesen behalten; sonst zufällig wählen.
      const team = dbm.getTeam(gameId, teamId);
      const existingLeaderId = team && team.leaderId;
      if (existingLeaderId && validVoteIds.has(String(existingLeaderId))) {
        pick = existingLeaderId; // beibehalten
      } else {
        pick = members[Math.floor(Math.random() * members.length)].id;
      }
    }
    dbm.setLeader(gameId, teamId, pick);
    return pick;
  }

  // ------------------------------------------------------------------
  // Teamleiter aktiv übertragen (nur aktueller Leader; sofort, ohne Vote).
  // ------------------------------------------------------------------
  transferLeader({ gameId, playerId, sock }) {
    const gameRow = dbm.getGame(gameId);
    if (!gameRow) return { error: { code: 'NO_GAME', message: 'Unbekanntes Spiel.' } };
    const me = dbm.getPlayer(sock.id);
    if (!me || me.gameId !== gameId) return { error: { code: 'NOT_IN_TEAM', message: 'Kein Mitglied dieses Spiels.' } };
    const team = dbm.getTeam(gameId, me.teamId);
    if (!team) return { error: { code: 'TEAM_GONE', message: 'Team nicht gefunden.' } };
    // Nur der aktuelle Teamleiter darf weitergeben.
    if (!(team.leaderId && String(team.leaderId) === String(me.id))) {
      return { error: { code: 'NOT_LEADER', message: 'Nur der Teamleiter kann die Rolle abgeben.' } };
    }
    const target = dbm.getPlayer(playerId);
    if (!target || target.gameId !== gameId || target.teamId !== me.teamId) {
      return { error: { code: 'BAD_CANDIDATE', message: 'Kandidat nicht im eigenen Team.' } };
    }
    dbm.setLeader(gameId, me.teamId, target.id);
    return { ok: true, gameId, teamId: me.teamId, leaderId: target.id };
  }

  // ------------------------------------------------------------------
  // GM: Spiel starten (nur wenn jedes Team >= 1 Mitglied)
  // ------------------------------------------------------------------
  startGame({ gameId, gmCode, sock, confirmEmpty }) {
    const gameRow = dbm.getGame(gameId);
    if (!gameRow) return { error: { code: 'NO_GAME', message: 'Unbekanntes Spiel.' } };
    const codeRow = dbm.getCode(String(gmCode || '').toUpperCase());
    if (!codeRow || codeRow.kind !== 'gm' || codeRow.gameId !== gameId) {
      return { error: { code: 'FORBIDDEN', message: 'Nur der GM darf das Spiel starten.' } };
    }
    this._addGmSocket(gameId, sock);
    const teams = dbm.getTeams(gameId);
    // jedes Team braucht >=1 Mitglied
    const players = dbm.getPlayers(gameId) || [];
    const empty = teams.filter((t) => players.filter((p) => p.teamId === t.teamId).length === 0);
    const alreadyStarted = !!gameRow.started;
    // (2m P12) Fortsetzen mit leeren Teams: Beim ERSTEN Start blockieren (INCOMPLETE).
    // Beim Fortsetzen eines pausierten Spiels wird der GM gefragt: (a) warten oder
    // (b) trotzdem fortsetzen → leere Teams geben automatisch auf (forfeit).
    if (empty.length) {
      if (!alreadyStarted) {
        return { error: { code: 'INCOMPLETE', message: 'Noch nicht alle Teams haben mindestens einen Spieler.' } };
      }
      if (!confirmEmpty) {
        return {
          error: {
            code: 'EMPTY_TEAMS',
            message: 'Nicht alle Teams haben Spieler. Warten oder trotzdem fortsetzen (leere Teams geben auf)?',
            emptyTeams: empty.map((t) => ({ teamId: t.teamId, ship: t.ship, teamName: t.teamName || ('Team ' + t.ship) }))
          }
        };
      }
      // GM hat „trotzdem fortsetzen“ gewählt → leere Teams automatisch aufgeben.
      const forf = G.deserialize(gameRow.state, D);
      empty.forEach((t) => {
        const pi = this._piOf(forf, t.teamId);
        if (pi >= 0 && !forf.players[pi].bankrupt) {
          forf.forfeitTeam(pi);
          this.logEngine(gameId, forf, (t.ship || t.teamId) + ' hat keine Spieler mehr — gibt beim Fortsetzen automatisch auf.');
        }
      });
      dbm.updateState(gameId, { state: forf.serialize(), started: 1, over: forf.over ? 1 : 0 });
    }
    // Teamleiter via resolveTeamLeader (stimmbasiert; bei keiner Stimme behält es bestehenden Leader
    // oder wählt zufällig). Danach Votes leeren, damit resumeGame nicht stale Votes auswertet.
    teams.forEach((t) => {
      const tp = players.filter((p) => p.teamId === t.teamId);
      if (tp.length) this.resolveTeamLeader(gameId, t.teamId);
    });
    teams.forEach((t) => dbm.clearVotes(gameId, t.teamId));

    const engine = G.deserialize(dbm.getGame(gameId).state, D);
    engine._started = true;
    // Fortsetzen (bereits gestartetes Spiel): aktiven Spieler NICHT neu würfeln.
    // Nur beim ERSTEN Start den zufälligen Startspieler bestimmen.
    if (!alreadyStarted) {
      const aliveIdx = [];
      for (let i = 0; i < engine.players.length; i++) if (!engine.players[i].bankrupt) aliveIdx.push(i);
      if (aliveIdx.length) engine.activeIdx = aliveIdx[Math.floor(Math.random() * aliveIdx.length)];
    }
    dbm.setStarted(gameId, true);
    // (2m P9) Fortsetzen über den „Fortsetzen“-Button beendet die Pause explizit.
    // Das bloße Öffnen der Lobby (gm:resume) pausiert NICHT fort — nur dieser Button.
    if (alreadyStarted && dbm.getGame(gameId).paused) dbm.setPaused(gameId, false);
    this.logEngine(gameId, engine, this._gmNameOf(gameId) + (alreadyStarted ? ' setzt das Spiel fort.' : ' startet das Spiel.'));
    dbm.updateState(gameId, { state: engine.serialize(), started: 1, over: engine.over ? 1 : 0 });
    // (2m-A) Start zählt als Aktivität (verhindert sofortige Auto-Pause).
    dbm.touchActivity(gameId);
    // (2g#8) Der startende GM ist der aktive GM (für Übergabe-/Verlass-Wächter).
    dbm.setGmOwner(gameId, sock.id);
    // (2i #1) Socket als GM registrieren — Grundlage für das harte Verlass-Gate.
    this._addGmSocket(gameId, sock);
    // (2g#17) Zug-Timer beim Start armieren.
    this._armTurnTimer(gameId);
    return { ok: true, gameId, started: true, resumed: alreadyStarted };
  }

  // ------------------------------------------------------------------
  // GM: Live-Pflege (deploy configPatch) — Gameplay bleibt konsistent
  // ------------------------------------------------------------------
  deploy({ gameId, gmCode, configPatch, sock }) {
    const req = this._requireGmOwner({ gameId, gmCode, sock, action: 'Änderungen deployen' });
    if (req.error) return req;
    const gameRow = req.gameRow;
    const engine = G.deserialize(gameRow.state, D);
    if (configPatch && configPatch.diceConfig) engine.diceConfig = configPatch.diceConfig;
    if (configPatch && typeof configPatch.armistice === 'boolean') engine.armisticeEnabled = configPatch.armistice;
    dbm.updateState(gameId, { state: engine.serialize(), started: engine._started });
    return { ok: true, gameId };
  }

  // ------------------------------------------------------------------
  // Spielaktionen — Rechte: nur das jeweils aktive Team (und nur Teamleiter)
  // ------------------------------------------------------------------
  _requireActiveLeader({ gameId, sock }) {
    const gameRow = dbm.getGame(gameId);
    if (!gameRow) return { error: { code: 'NO_GAME', message: 'Unbekanntes Spiel.' } };
    if (!gameRow.started) return { error: { code: 'NOT_STARTED', message: 'Spiel nicht gestartet.' } };
    const me = dbm.getPlayer(sock.id);
    if (!me || me.gameId !== gameId) return { error: { code: 'NOT_IN_TEAM', message: 'Kein Mitglied.' } };

    const engine = G.deserialize(gameRow.state, D);
    const active = engine.current();
    const team = dbm.getTeam(gameId, me.teamId);
    // nur aktives Team
    if (team.teamId !== active.id) return { error: { code: 'NOT_YOUR_TURN', message: 'Das ist nicht dein Zug.' } };
    // nur Teamleiter (Mitglied nur lesen)
    const isLeader = team.leaderId && String(team.leaderId) === String(me.id);
    if (!isLeader) return { error: { code: 'NOT_LEADER', message: 'Nur der Teamleiter darf Aktionen ausführen.' } };
    return { engine, team, me };
  }

  _persistAndReturn(gameId, engine, started) {
    dbm.updateState(gameId, { state: engine.serialize(), started, over: engine.over ? 1 : 0 });
    dbm.touchGame(gameId);
    // (2m-A) Jede Spieleraktion zählt als Aktivität (verhindert Auto-Pause).
    dbm.touchActivity(gameId);
    // (2g#17) Jede Aktion re-armt den Zug-Timer (Inaktivitäts-Timeout-Modell).
    this._armTurnTimer(gameId);
    // Frisch persistierten State (inkl. turnDeadline des soeben armierten Timers) zurückgeben.
    const fresh = dbm.getGame(gameId);
    let retState = engine.serialize();
    if (fresh && fresh.state) retState = fresh.state;
    return { ok: true, gameId, state: retState };
  }

  actionRoll({ gameId, sock }) {
    const req = this._requireActiveLeader({ gameId, sock });
    if (req.error) return req;
    const res = req.engine.roll();
    if (res && res.err) {
      return { error: { code: res.err, message: 'Es wurde in diesem Zug bereits gewürfelt.' } };
    }
    const ret = this._persistAndReturn(gameId, req.engine, true);
    ret.roll = res;
    return ret;
  }

  actionBuy({ gameId, sock }) {
    const req = this._requireActiveLeader({ gameId, sock });
    if (req.error) return req;
    const bought = req.engine.buy();
    const ret = this._persistAndReturn(gameId, req.engine, true);
    ret.bought = bought;
    return ret;
  }

  actionSkip({ gameId, sock }) {
    const req = this._requireActiveLeader({ gameId, sock });
    if (req.error) return req;
    req.engine.skip();
    const ret = this._persistAndReturn(gameId, req.engine, true);
    ret.skipped = true;
    return ret;
  }

  actionBuild({ gameId, field, sock }) {
    const req = this._requireActiveLeader({ gameId, sock });
    if (req.error) return req;
    const fieldIdx = Number(field);
    if (!Number.isInteger(fieldIdx)) return { error: { code: 'BAD_FIELD', message: 'Ungültiges Feld.' } };
    const built = req.engine.build(fieldIdx);
    // (2o-A) Strukturierte Ablehnung (z.B. GROUP_MORTGAGED) mit notify-Satz.
    if (built && typeof built === 'object' && built.ok === false) {
      const msg = built.notify || ('Ausbau nicht möglich (' + built.reason + ').');
      return { error: { code: 'ECON', reason: built.reason, message: msg, notify: built.notify } };
    }
    const ret = this._persistAndReturn(gameId, req.engine, true);
    ret.built = !!built;
    return ret;
  }

  // Aufgabe erledigt — Confirmation-Step nach Würfeln (Leader/GM darf bestätigen)
  taskComplete({ gameId, sock }) {
    const req = this._requireActiveLeader({ gameId, sock });
    if (req.error) return req;
    const ret = this._persistAndReturn(gameId, req.engine, true);
    ret.taskDone = true;
    return ret;
  }

  actionNextTurn({ gameId, sock }) {
    const req = this._requireActiveLeader({ gameId, sock });
    if (req.error) return req;
    req.engine.nextTurn();
    const ret = this._persistAndReturn(gameId, req.engine, true);
    ret.next = true;
    return ret;
  }

  // Gefängnis-Wahl: freikaufen oder absitzen
  actionBail({ gameId, sock }) {
    const req = this._requireActiveLeader({ gameId, sock });
    if (req.error) return req;
    const r = req.engine.bail();
    if (!r.ok) return { error: { code: 'JAIL', message: 'Freikauf nicht möglich (' + r.reason + ').' } };
    return this._persistAndReturn(gameId, req.engine, true);
  }

  actionJailStay({ gameId, sock }) {
    const req = this._requireActiveLeader({ gameId, sock });
    if (req.error) return req;
    const r = req.engine.jailStay();
    if (!r.ok) return { error: { code: 'JAIL', message: 'Nicht möglich (' + r.reason + ').' } };
    return this._persistAndReturn(gameId, req.engine, true);
  }

  // ------------------------------------------------------------------
  // Economy-Aktionen (Hypothek, Abbau, Aufgeben, Verkauf)
  // Leader seines Teams reicht; NICHT zwingend am Zug (Notverkauf erlaubt).
  // ------------------------------------------------------------------
  _requireLeaderOfTeam({ gameId, sock }) {
    const gameRow = dbm.getGame(gameId);
    if (!gameRow) return { error: { code: 'NO_GAME', message: 'Unbekanntes Spiel.' } };
    if (!gameRow.started) return { error: { code: 'NOT_STARTED', message: 'Spiel nicht gestartet.' } };
    const me = dbm.getPlayer(sock.id);
    if (!me || me.gameId !== gameId) return { error: { code: 'NOT_IN_TEAM', message: 'Kein Mitglied.' } };
    const team = dbm.getTeam(gameId, me.teamId);
    if (!(team.leaderId && String(team.leaderId) === String(me.id))) {
      return { error: { code: 'NOT_LEADER', message: 'Nur der Teamleiter darf das.' } };
    }
    const engine = G.deserialize(gameRow.state, D);
    return { engine, team, me };
  }

  // (2g#18) Hypothek nur am EIGENEN Zug (aktiver Teamleiter).
  actionMortgage({ gameId, field, sock }) {
    const req = this._requireActiveLeader({ gameId, sock });
    if (req.error) return req;
    const fieldIdx = Number(field);
    if (!Number.isInteger(fieldIdx)) return { error: { code: 'BAD_FIELD', message: 'Ungültiges Feld.' } };
    const r = req.engine.mortgage(fieldIdx);
    if (!r.ok) {
      // (2o-A) Strukturierte Ablehnung inkl. notify (P5/P6: BUILT_NOT_MORTGAGEABLE, GROUP_NOT_DEMOLISHED).
      const msg = r.notify || ('Hypothek nicht möglich (' + r.reason + ').');
      return { error: { code: 'ECON', reason: r.reason, message: msg, notify: r.notify } };
    }
    const ret = this._persistAndReturn(gameId, req.engine, true);
    ret.mortgaged = r.loan;
    return ret;
  }

  actionUnmortgage({ gameId, field, sock }) {
    const req = this._requireLeaderOfTeam({ gameId, sock });
    if (req.error) return req;
    const fieldIdx = Number(field);
    if (!Number.isInteger(fieldIdx)) return { error: { code: 'BAD_FIELD', message: 'Ungültiges Feld.' } };
    const r = req.engine.unmortgage(fieldIdx);
    if (!r.ok) return { error: { code: 'ECON', message: 'Hypothek kann nicht getilgt werden (' + r.reason + ').' } };
    const ret = this._persistAndReturn(gameId, req.engine, true);
    ret.unmortgaged = r.pay;
    return ret;
  }

  actionDemolish({ gameId, field, sock }) {
    const req = this._requireLeaderOfTeam({ gameId, sock });
    if (req.error) return req;
    const fieldIdx = Number(field);
    if (!Number.isInteger(fieldIdx)) return { error: { code: 'BAD_FIELD', message: 'Ungültiges Feld.' } };
    const r = req.engine.demolish(fieldIdx);
    if (!r.ok) return { error: { code: 'ECON', message: 'Rückbau nicht möglich (' + r.reason + ').' } };
    const ret = this._persistAndReturn(gameId, req.engine, true);
    ret.demolished = r.refund;
    return ret;
  }

  // (2o-A P3) Käufer löst die Hypotheken-Übernahme-Wahl (nach Kauf/Ersteigerung
  // eines beliehenen Feldes): 'keep' = 10 % Zins zahlen und beliehen lassen,
  // 'clear' = sofort voll entlasten. Nur der Leader des Käufer-Teams.
  actionMortgageChoice({ gameId, choice, sock }) {
    const req = this._requireLeaderOfTeam({ gameId, sock });
    if (req.error) return req;
    const myIdx = this._piOf(req.engine, req.team.teamId);
    const mc = req.engine.mortgageChoice;
    if (!mc || mc.buyerIdx !== myIdx) {
      return { error: { code: 'TRADE', message: 'Keine offene Hypotheken-Übernahme für dein Team.' } };
    }
    const r = req.engine.resolveMortgageChoice(myIdx, choice);
    if (!r.ok) {
      const msg = r.notify || ('Wahl nicht möglich (' + r.reason + ').');
      return { error: { code: 'ECON', reason: r.reason, message: msg, notify: r.notify } };
    }
    const ret = this._persistAndReturn(gameId, req.engine, true);
    ret.mortgageChoiceResolved = r;
    return ret;
  }

  // Engine-Player-Index eines Teams ermitteln (engine.players[i].id === teamId)
  _piOf(engine, teamId) {
    for (let i = 0; i < engine.players.length; i++) if (String(engine.players[i].id) === String(teamId)) return i;
    return -1;
  }

  // ---------- Handel (Angebote: Verkauf / Kauf, mit Annehmen/Ablehnen) ----------
  // (2g#18) Kauf-Angebot SENDEN nur am EIGENEN Zug; Verkaufs-Angebote bleiben
  // zwischendurch erlaubt (Zielteam antwortet dann aufs eigene Tempo).
  offerMake({ gameId, kind, field, targetIdx, price, sock }) {
    const req = (kind === 'buy')
      ? this._requireActiveLeader({ gameId, sock })
      : this._requireActiveLeaderForTrade({ gameId, sock });
    if (req.error) return req;
    const engine = req.engine;
    const targetIdxN = Number(targetIdx);
    if (!Number.isInteger(targetIdxN) || targetIdxN < 0 || targetIdxN >= engine.players.length) {
      return { error: { code: 'BAD_TARGET', message: 'Ungültiges Ziel-Team.' } };
    }
    const fromIdx = this._piOf(engine, req.team.teamId);
    if (fromIdx < 0) return { error: { code: 'NOT_IN_TEAM', message: 'Dein Team ist nicht im Spiel.' } };
    const r = engine.makeOffer({ kind: kind === 'buy' ? 'buy' : 'sell', fromIdx, targetIdx: targetIdxN, fieldIdx: Number(field), price });
    if (!r.ok) return { error: { code: 'TRADE', message: 'Angebot nicht möglich (' + r.reason + ').' } };
    return this._persistAndReturn(gameId, engine, true);
  }

  offerRespond({ gameId, offerId, accept, sock }) {
    const req = this._requireActiveLeaderForTrade({ gameId, sock });
    if (req.error) return req;
    const engine = req.engine;
    // Ziel-Team-Check: nur der Leader des Ziels darf das Angebot annehmen/ablehnen.
    // WICHTIG: NICHT per respondOffer(offerId, 0) "peeken" — respondOffer entfernt das
    // Angebot IMMER aus engine.offers (auch bei accept=0) und würde den echten Aufruf
    // auf derselben Engine-Instanz ins Leere laufen lassen. Angebot nur LESEN:
    const offer = (engine.offers || []).find((o) => String(o.id) === String(offerId));
    if (!offer) return { error: { code: 'TRADE', message: 'Angebot nicht gefunden.' } };
    // In beiden Angebot-Arten ist targetIdx das Team, das antworten darf.
    const targetIdx = Number(offer.targetIdx);
    const meIdx = this._piOf(engine, req.team.teamId);
    if (meIdx !== targetIdx) {
      return { error: { code: 'NOT_YOUR_OFFER', message: 'Du bist nicht das Ziel-Team dieses Angebots.' } };
    }
    // accept kommt von getAttribute -> String "1"/"0"; streng Zahl, sonst "1"===1 false → fälschlich Ablehnung.
    const acceptVal = (String(accept).trim() === '1') ? 1 : 0;
    const r = engine.respondOffer(offerId, acceptVal);
    if (!r.ok) return { error: { code: 'TRADE', message: 'Angebot nicht gefunden.' } };
    return this._persistAndReturn(gameId, engine, true);
  }

  // ---------- Versteigerung eigener Felder ----------
  // (2g#18) Eigenes Feld versteigern (Auktion starten) nur am EIGENEN Zug.
  auctionStart({ gameId, field, sock }) {
    const req = this._requireActiveLeader({ gameId, sock });
    if (req.error) return req;
    const engine = req.engine;
    const ownerIdx = this._piOf(engine, req.team.teamId);
    if (ownerIdx < 0) return { error: { code: 'NOT_IN_TEAM', message: 'Dein Team ist nicht im Spiel.' } };
    const r = engine.startAuction({ ownerIdx, fieldIdx: Number(field) });
    if (!r.ok) {
      // (2o-A) Strukturierte Ablehnung inkl. notify (P8: BUILT_NOT_SELLABLE).
      const msg = r.notify || ('Auktion nicht möglich (' + r.reason + ').');
      return { error: { code: 'AUCTION', reason: r.reason, message: msg, notify: r.notify } };
    }
    const ret = this._persistAndReturn(gameId, engine, true);
    // Nach Ablauf automatisch auflösen (höchstes Gebot gewinnt).
    const durationMs = r.auction ? r.auction.durationMs : 15000;
    setTimeout(() => this._resolveAuctionOnServer(gameId), durationMs + 300);
    return ret;
  }

  auctionBid({ gameId, amount, sock }) {
    const req = this._requireActiveLeaderForTrade({ gameId, sock });
    if (req.error) return req;
    const engine = req.engine;
    const bidderIdx = this._piOf(engine, req.team.teamId);
    if (bidderIdx < 0) return { error: { code: 'NOT_IN_TEAM', message: 'Dein Team ist nicht im Spiel.' } };
    const r = engine.bidAuction(bidderIdx, Number(amount));
    if (!r.ok) return { error: { code: 'AUCTION', message: 'Gebot abgelehnt (' + r.reason + ').' } };
    return this._persistAndReturn(gameId, engine, true);
  }

  auctionResolve({ gameId, accept, sock }) {
    const req = this._requireActiveLeaderForTrade({ gameId, sock });
    if (req.error) return req;
    const engine = req.engine;
    // Nur der Auktions-Besitzer darf entscheiden.
    const au = engine.auction;
    const ownerIdx = au ? au.ownerIdx : -1;
    if (ownerIdx < 0) return { error: { code: 'AUCTION', message: 'Keine laufende Auktion.' } };
    const myIdx = this._piOf(engine, req.team.teamId);
    if (myIdx !== ownerIdx) return { error: { code: 'AUCTION', message: 'Nur der Versteigerer darf die Auktion beenden.' } };
    const r = engine.resolveAuction(accept === 1 ? 1 : 0);
    // (2o-A) Strukturierte Ablehnung (P8: BUILT_NOT_SELLABLE bei bebautem Feld).
    if (!r.ok) {
      const msg = r.notify || ('Auktion nicht möglich (' + r.reason + ').');
      return { error: { code: 'AUCTION', reason: r.reason, message: msg, notify: r.notify } };
    }
    return this._persistAndReturn(gameId, engine, true);
  }

  _resolveAuctionOnServer(gameId) {
    try {
      const gameRow = dbm.getGame(gameId);
      if (!gameRow) return;
      const engine = G.deserialize(gameRow.state, D);
      if (engine.auction) {
        engine.resolveAuction(1);
        this._persistAndReturn(gameId, engine, true);
        this.broadcast(gameId);
      }
    } catch (e) { /* ignore */ }
  }

  // Handels-Leader-Check (startet jedes Spiel, auch wenn nicht an der Reihe)
  _requireActiveLeaderForTrade({ gameId, sock }) {
    const gameRow = dbm.getGame(gameId);
    if (!gameRow) return { error: { code: 'NO_GAME', message: 'Unbekanntes Spiel.' } };
    if (!gameRow.started || gameRow.over) return { error: { code: 'NOT_STARTED', message: 'Spiel nicht aktiv.' } };
    const me = dbm.getPlayer(sock.id);
    if (!me || me.gameId !== gameId) return { error: { code: 'NOT_IN_TEAM', message: 'Kein Mitglied.' } };
    const team = dbm.getTeam(gameId, me.teamId);
    if (!(team.leaderId && String(team.leaderId) === String(me.id))) {
      return { error: { code: 'NOT_LEADER', message: 'Nur der Teamleiter darf das.' } };
    }
    const engine = G.deserialize(gameRow.state, D);
    return { engine, team, me };
  }

  actionForfeit({ gameId, sock }) {
    // Aufgeben ist jetzt eine Team-Abstimmung (fest statt Leader-Zwang):
    // Jedes Mitglied des Teams kann starten; Starter stimmt automatisch JA.
    // Wer nicht abstimmt, enthält sich (zählt nicht). Mehrheit entscheidet.
    const gameRow = dbm.getGame(gameId);
    if (!gameRow || !gameRow.started || gameRow.over) return { error: { code: 'NOT_STARTED', message: 'Spiel nicht aktiv.' } };
    const me = dbm.getPlayer(sock.id);
    if (!me || me.gameId !== gameId) return { error: { code: 'NOT_IN_TEAM', message: 'Kein Mitglied.' } };
    const engine = G.deserialize(gameRow.state, D);
    if (engine.over) return { error: { code: 'OVER', message: 'Spiel beendet.' } };
    if (engine.forfeitPoll) return { error: { code: 'POLL', message: 'Eine Abstimmung läuft bereits.' } };
    const teamIdx = this._piOf(engine, me.teamId);
    if (teamIdx < 0 || engine.players[teamIdx].bankrupt) return { error: { code: 'INACTIVE', message: 'Dein Team ist nicht mehr aktiv.' } };
    const memberCount = (dbm.getPlayers(gameId) || []).filter((p) => p.teamId === me.teamId).length;
    const pollMs = (engine.settings && engine.settings.pollMs != null) ? engine.settings.pollMs : 15000;
    engine.forfeitPoll = {
      type: 'forfeit',
      teamId: me.teamId,
      teamIdx,
      startedBy: sock.id,
      startedName: me.name || 'Spieler',
      started: Date.now(),
      endsAt: Date.now() + pollMs,
      durationMs: pollMs,
      memberCount: Math.max(1, memberCount),
      votes: {}            // playerId/sockId -> 1 (ja) / -1 (nein)
    };
    engine.forfeitPoll.votes[sock.id] = 1; // Starter stimmt automatisch JA
    this.logEngine(gameId, engine, me.name + ' startet eine Abstimmung: Team aufgeben? (15 s) — Starter stimmt JA, Enthaltung zählt nicht.');
    // Nach Ablauf automatisch auflösen (analog zur Auktion, Z.675).
    setTimeout(() => this._resolveForfeitPollOnServer(gameId), pollMs + 300);
    return this._persistAndReturn(gameId, engine, true);
  }

  // Mitglied stimmt in der laufenden Aufgeben-Abstimmung ab (1 = ja, -1 = nein).
  forfeitVote({ gameId, agree, sock }) {
    const gameRow = dbm.getGame(gameId);
    if (!gameRow || !gameRow.started || gameRow.over) return { error: { code: 'NOT_STARTED', message: 'Spiel nicht aktiv.' } };
    const me = dbm.getPlayer(sock.id);
    if (!me || me.gameId !== gameId) return { error: { code: 'NOT_IN_TEAM', message: 'Kein Mitglied.' } };
    const engine = G.deserialize(gameRow.state, D);
    if (!engine.forfeitPoll) return { error: { code: 'NOPOLL', message: 'Keine laufende Abstimmung.' } };
    if (engine.forfeitPoll.teamId !== me.teamId) return { error: { code: 'NOPOLL', message: 'Diese Abstimmung betrifft dein Team nicht.' } };
    if (Date.now() > engine.forfeitPoll.endsAt) {
      // Abgelaufen → auflösen, dann melden.
      const res = this._resolveForfeitPoll(gameId, engine);
      return { error: { code: 'LATE', message: 'Abstimmung abgelaufen — Ergebnis: ' + res } };
    }
    if (engine.forfeitPoll.votes[me.id] != null) return { error: { code: 'VOTED', message: 'Du hast bereits abgestimmt.' } };
    engine.forfeitPoll.votes[me.id] = agree === 1 ? 1 : -1;
    this.logEngine(gameId, engine, me.name + ' stimmt ' + (agree === 1 ? 'FÜR aufgeben' : 'GEGEN aufgeben') + '.');
    // Sofort auflösen, wenn alle Mitglieder abgestimmt haben.
    const memberCount = engine.forfeitPoll.memberCount;
    let voted = Object.keys(engine.forfeitPoll.votes).length;
    if (voted >= memberCount) {
      this._resolveForfeitPoll(gameId, engine);
    }
    return this._persistAndReturn(gameId, engine, true);
  }

  // Löst eine abgelaufene/komplette Aufgeben-Abstimmung auf und übernimmt das Team.
  _resolveForfeitPoll(gameId, engine) {
    const poll = engine.forfeitPoll;
    if (!poll) return 'keine';
    let yes = 0, no = 0;
    for (const k in poll.votes) { if (poll.votes[k] === 1) yes++; else if (poll.votes[k] === -1) no++; }
    const accepted = yes > no;
    engine.forfeitPoll = null;
    let resultMsg = accepted ? 'AUFGEGEBEN' : 'nicht aufgegeben';
    if (accepted) {
      engine.forfeitTeam(poll.teamIdx);
    }
    this.logEngine(gameId, engine, 'Abstimmung „Team aufgeben“ beendet: ' + yes + ' FÜR, ' + no + ' GEGEN → ' + resultMsg + '.');
    this._persistAndReturn(gameId, engine, true);
    return resultMsg;
  }

  // Abgelaufene Abstimmung serverseitig auflösen (Timer wie bei der Auktion).
  _resolveForfeitPollOnServer(gameId) {
    try {
      const gameRow = dbm.getGame(gameId);
      if (!gameRow) return;
      const engine = G.deserialize(gameRow.state, D);
      if (engine.forfeitPoll && Date.now() > engine.forfeitPoll.endsAt) {
        this._resolveForfeitPoll(gameId, engine);
        this.broadcast(gameId);
      }
    } catch (e) { /* ignore */ }
  }

  // Handler-Helfer: log + speichern in einem (für Engine-Zugriffe ohne own persistence)
  logEngine(gameId, engine, msg) {
    // Engine-Log selbst ist ein Array; wir hängen die Meldung direkt an.
    if (Array.isArray(engine.log)) {
      engine.log.push(msg);
    }
  }

  actionSell({ gameId, field, buyerIdx, price, sock }) {
    const bidx = Number(buyerIdx);
    // (2g#18) Bankverkauf nur am EIGENEN Zug; Verkauf an Mitspieler bleibt
    // zwischendurch erlaubt (übertragene Hypotheken laufen beim Käufer weiter).
    const req = (bidx == null || bidx < 0)
      ? this._requireActiveLeader({ gameId, sock })
      : this._requireLeaderOfTeam({ gameId, sock });
    if (req.error) return req;
    const fieldIdx = Number(field);
    if (!Number.isInteger(fieldIdx) || !Number.isInteger(bidx)) {
      return { error: { code: 'BAD_FIELD', message: 'Ungültige Parameter.' } };
    }
    const r = req.engine.sellProperty(fieldIdx, bidx, price);
    if (!r.ok) {
      // (2o-A) Strukturierte Ablehnung inkl. notify (P8: BANK_BUY_BUILT / BUILT_NOT_SELLABLE).
      const msg = r.notify || ('Verkauf nicht möglich (' + r.reason + ').');
      return { error: { code: 'ECON', reason: r.reason, message: msg, notify: r.notify } };
    }
    const ret = this._persistAndReturn(gameId, req.engine, true);
    ret.sold = r.price;
    if (r.mortgageChoice) ret.mortgageChoice = r.mortgageChoice;
    return ret;
  }

  actionAuction({ gameId, field, sock }) {
    // Leader startet eine Bank-Versteigerung eines herrenlosen Feldes
    // (Monopoly: Feld, das beim Landen nicht gekauft wurde, geht in die Auktion).
    const req = this._requireLeaderOfTeam({ gameId, sock });
    if (req.error) return req;
    const fieldIdx = Number(field);
    if (!Number.isInteger(fieldIdx)) return { error: { code: 'BAD_FIELD', message: 'Ungültiges Feld.' } };
    const f = req.engine.fields[fieldIdx];
    if (!f) return { error: { code: 'BAD_FIELD', message: 'Ungültiges Feld.' } };
    // Automatische Reservegebote: jedes aktive Team bietet 50% des Feldwerts.
    const base = (typeof f.price === 'number') ? Math.round(f.price / 2) : 1000;
    const bids = req.engine.players.map((p, i) => {
      if (p.bankrupt) return null;
      return [i, Math.min(base, p.budget)];
    }).filter((b) => b && b[1] > 0);
    const r = req.engine.auctionField(fieldIdx, bids);
    if (!r.ok) return { error: { code: 'ECON', message: 'Versteigerung nicht möglich (' + r.reason + ').' } };
    const ret = this._persistAndReturn(gameId, req.engine, true);
    ret.auction = r;
    return ret;
  }

  // ------------------------------------------------------------------
  // Beobachter (nur lesen, Raum-Join)
  // ------------------------------------------------------------------
  spectate({ gameId, sock }) {
    const gameRow = dbm.getGame(gameId);
    if (!gameRow) return { error: { code: 'NO_GAME', message: 'Unbekanntes Spiel.' } };
    // (2k #1) Ein NOCH NICHT GESTARTETES Spiel (Lobby) kann man nicht zuschauen —
    // es gibt nichts zu sehen und der Zuschauer würde sonst die Lobby-Codes sehen.
    // Zuschauen ist nur für gestartete (aktiv/pausiert) oder beendete Spiele erlaubt.
    if (!gameRow.started) return { error: { code: 'NOT_STARTED', message: 'Dieses Spiel wurde noch nicht gestartet.' } };
    sock.join(this._roomOf(gameId));
    return { ok: true, gameId, role: 'spectator' };
  }

  // Entfernt eine Membership sauber (Leader-Nachfolge, Votes, Room-Leave, Broadcast).
  // Wird genutzt für: Verlassen (leaveGame), Wechsel (joinTeam in anderes Spiel),
  // Disconnect-Timeout. `sock` optional (beim Timeout ist der Socket bereits weg).
  _cleanupMembership(gameId, sock) {
    const sockId = sock && sock.id;
    let wasLeader = false;
    let me = null;
    if (sockId != null && sockId !== '') {
      me = dbm.getPlayer(sockId);
      if (me) {
        const team = dbm.getTeam(gameId, me.teamId);
        wasLeader = team && team.leaderId && String(team.leaderId) === String(sockId);
      }
    } else {
      // Timeout-Pfad: Socket nicht mehr verfügbar — nur der Name steckt im pending-Entry.
    }
    dbm.removePlayer(gameId, sockId);
    if (wasLeader && me) {
      this.resolveTeamLeader(gameId, me.teamId);
    }
    // Pending-Disconnect für diesen Socket verwerfen (falls vorhanden).
    if (sockId != null) this._cancelPendingDisconnect(sockId);
    try { if (sock && sock.leave) sock.leave(this._roomOf(gameId)); } catch (e) {}
  }

  // GM: Spiel verlassen (jede Rolle): aus dem Raum + aus der Spieler-Tabelle entfernen.
    // (2m P7) Ist der Verlassende der LETZTE aktive Spieler seines Teams, wird zuerst
    // eine Bestätigungs-Abfrage an den Client gesendet; erst nach Bestätigung
    // (confirm=true) wird das Team per Forfeit-Logik ausgeschieden und verlassen.
    leaveGame({ gameId, sock, confirm }) {
      const gameRow = dbm.getGame(gameId);
      // Punkte 1 (+8): Ein aktiver GM (ohne Nachfolger) kann sich während eines laufenden
      // Spiels NICHT selbst entfernen — Verlassen wäre für das Spiel fatal (kein GM mehr,
      // der das Spiel starten/pausieren/fortsetzen kann). HART blockieren.
      if (gameRow && gameRow.started && !gameRow.over && !gameRow.paused &&
          (this._isGmSocket(gameId, sock.id) || String(gameRow.gm_owner || '') === String(sock.id))) {
        return { error: { code: 'GM_ACTIVE', message: 'Du bist der GM dieses laufenden Spiels und kannst es nicht verlassen, solange kein Nachfolge-GM existiert.' } };
      }
      const me = dbm.getPlayer(sock.id);
      // (2m P7) Letzter aktiver Spieler seines Teams (nur in einem laufenden Spiel).
      if (me && me.gameId === gameId && gameRow && gameRow.started && !gameRow.over) {
        const teamMembers = (dbm.getPlayers(gameId) || []).filter((p) => p.teamId === me.teamId);
        const isLast = teamMembers.length === 1 && String(teamMembers[0].id) === String(sock.id);
        if (isLast && !confirm) {
          // Bestätigungs-Abfrage an den Client senden — noch NICHT verlassen.
          this._emitTo(sock.id, 'leave:confirm', {
            gameId,
            message: 'Wenn du das Spiel verlässt, gibt dein Team auf.'
          });
          return { ok: false, confirmRequired: true, gameId };
        }
        if (isLast && confirm) {
          // Team per Forfeit-Logik ausscheiden (wie Bankrott: Eigentum/Guthaben aufgeben).
          const engine = this._loadEngine(gameId);
          if (engine) {
            const teamIdx = this._piOf(engine, me.teamId);
            if (teamIdx >= 0 && !engine.players[teamIdx].bankrupt) {
              engine.forfeitTeam(teamIdx);
              this.logEngine(gameId, engine, me.name + ' verlässt als letzter Spieler — Team gibt auf (Forfeit).');
              dbm.updateState(gameId, { state: engine.serialize(), started: gameRow.started ? 1 : 0, over: engine.over ? 1 : 0 });
            }
          }
        }
      }
      this._cleanupMembership(gameId, sock);
      // GM-Socket bei gestattetem Verlassen (Lobby/Wurf/beendet) als GM abmelden.
      this._removeGmSocket(gameId, sock.id);
      // Client-State bereinigen (localStorage löscht der Client selbst).
      return { ok: true, gameId, left: true };
    }

  // (2k #2) Spiel abbrechen (GM): NEU ERSTELLTES Spiel (noch nicht gestartet) wird
  // komplett entfernt; ein PAUSIERTES Spiel wird nur vom Fortsetzen zurückgeführt
  // (bleibt pausiert — wird NICHT gelöscht, damit man es später fortsetzen kann).
  cancelGame({ gameId, gmCode, sock }) {
    const gameRow = dbm.getGame(gameId);
    if (!gameRow) return { error: { code: 'NO_GAME', message: 'Unbekanntes Spiel.' } };
    if (gameRow.over) return { error: { code: 'GAME_OVER', message: 'Beendete Spiele können nicht abgebrochen werden.' } };
    // Nur der aktive GM darf abbrechen.
    const req = this._requireGmOwner({ gameId, gmCode, sock, action: 'das Spiel abbrechen' });
    if (req.error) return req;

    const beforePaused = !!gameRow.paused;
    if (!gameRow.started) {
      // Neue Lobby: komplett entfernen (keine Liste, keine Codes mehr).
      this._clearTurnTimer(gameId);
      this._removeGmSocket(gameId, sock.id);
      // Alle im Raum informieren, dass das Spiel abgebrochen/entfernt wurde.
      if (this.io && this.io.to) this.io.to(this._roomOf(gameId)).emit('game:cancelled', { gameId, removed: true });
      dbm.deleteGame(gameId);
      return { ok: true, gameId, removed: true };
    }
    if (beforePaused) {
      // Pausiertes Spiel: Fortsetzen abbrechen → weiter pausiert lassen. Spieler, die
      // wieder beigetreten sind, werden entfernt (Wiederaufnahme verworfen).
      const players = dbm.getPlayers(gameId) || [];
      players.forEach((p) => {
        const ps = this.io && this.io.sockets && this.io.sockets.sockets.get(p.id);
        this._cleanupMembership(gameId, ps || { id: p.id });
      });
      // GM-Socket bleibt, aber er ist raus aus der aktiven Teilnahme.
      dbm.setPaused(gameId, true);
      if (this.io && this.io.to) this.io.to(this._roomOf(gameId)).emit('game:cancelled', { gameId, removed: false, paused: true });
      // Gäste des Raums entfernen, damit niemand mehr im Room hängt.
      try { if (this.io && this.io.in) this.io.in(this._roomOf(gameId)).socketsLeave(this._roomOf(gameId)); } catch (e) {}
      return { ok: true, gameId, removed: false, paused: true };
    }
    return { error: { code: 'NO_CANCEL', message: 'Ein laufendes Spiel kann nur pausiert, nicht abgebrochen werden.' } };
  }

  // ------------------------------------------------------------------
  // Punkt 8 — Disconnect-Timeout (Auto-Remove bei Inaktivität)
  // ------------------------------------------------------------------
  _cancelPendingDisconnect(sockId) {
    const pending = this._pendingDisconnects.get(sockId);
    if (pending) {
      clearTimeout(pending.timer);
      this._pendingDisconnects.delete(sockId);
    }
  }

  // Wird von index.js beim Socket-Disconnect gerufen. Startet (falls der Socket ein
  // aktiver Spieler ist) einen Timer; verstreicht er ohne Rejoin, wird der Spieler
  // entfernt (Broadcast + Log). Der GM ist ausgenommen (Punkt 1).
  playerDisconnected(sockId) {
    const me = dbm.getPlayer(sockId);
    if (!me) return;
    const gameRow = dbm.getGame(me.gameId);
    if (!gameRow || gameRow.over) return;
    if (this._isGmSocket(me.gameId, sockId)) return; // GM nicht automatisch entfernen
    this._cancelPendingDisconnect(sockId);
    const timer = setTimeout(() => {
      this._applyTimeoutRemove(me.gameId, sockId, me.name || 'Spieler');
    }, this._disconnectTimeoutMs);
    // unref: ein offener Disconnect-Timer darf den Prozess (Tests/Server-Stop) nicht wach halten,
    // solange der Socket bereits weg ist. Während das Spiel läuft, hält die IO den Loop am Leben.
    if (timer && typeof timer.unref === 'function') timer.unref();
    this._pendingDisconnects.set(sockId, { gameId: me.gameId, timer, name: me.name || 'Spieler' });
  }

  _applyTimeoutRemove(gameId, sockId, name) {
    this._pendingDisconnects.delete(sockId);
    const me = dbm.getPlayer(sockId);
    // Verlassen/Rejoin inzwischen passiert → nichts zu tun.
    if (!me || me.gameId !== gameId) return;
    const wasLeader = (() => {
      const team = dbm.getTeam(gameId, me.teamId);
      return team && team.leaderId && String(team.leaderId) === String(sockId);
    })();
    dbm.removePlayer(gameId, sockId);
    if (wasLeader) this.resolveTeamLeader(gameId, me.teamId);
    // Log-Eintrag + Broadcast für die verbleibenden Spieler.
    const engine = this._loadEngine(gameId);
    if (engine) {
      this.logEngine(gameId, engine, (name || 'Spieler') + ' wurde nach Inaktivität (Disconnect) aus dem Spiel entfernt.');
      dbm.updateState(gameId, { state: engine.serialize(), started: true, over: engine.over ? 1 : 0 });
    }
    this.broadcast(gameId);
  }

  _loadEngine(gameId) {
    try {
      const gameRow = dbm.getGame(gameId);
      if (!gameRow) return null;
      return G.deserialize(gameRow.state, D);
    } catch (e) { return null; }
  }

  // ------------------------------------------------------------------
  // GM-Reconnect nach Browser-Neuladen: gmCode -> GM-Ansicht wiederherstellen
  // ------------------------------------------------------------------
  resumeAsGM({ gameId, gmCode, sock }) {
    // GM kann das Spiel NUR über seinen (gemerkten) GM-Code öffnen — gameId ist
    // optional: falls fehlend, wird das Spiel über den Code aufgelöst.
    const codeRow = dbm.getCode(String(gmCode || '').toUpperCase());
    if (!codeRow || codeRow.kind !== 'gm') {
      return { error: { code: 'FORBIDDEN', message: 'Ungültiger GM-Code.' } };
    }
    const resolvedGameId = (gameId && String(gameId).trim()) ? String(gameId).trim() : codeRow.gameId;
    if (!resolvedGameId || codeRow.gameId !== resolvedGameId) {
      return { error: { code: 'FORBIDDEN', message: 'GM-Code gehört nicht zu diesem Spiel.' } };
    }
    const gameRow = dbm.getGame(resolvedGameId);
    if (!gameRow) return { error: { code: 'NO_GAME', message: 'Unbekanntes Spiel.' } };
    sock.join(this._roomOf(resolvedGameId));
    // (2g#8 + 2i#8) GM-Code-Vorlage = aktiver GM: DB-Owner (Transfer-Gates) UND Socket-Registrierung (Disconnect-Ausnahme).
    dbm.setGmOwner(resolvedGameId, sock.id);
    this._addGmSocket(resolvedGameId, sock);
    const teams = dbm.getTeams(resolvedGameId);
    return {
      ok: true,
      gameId: resolvedGameId,
      isGM: true,
      started: !!gameRow.started,
      over: !!gameRow.over,
      paused: !!gameRow.paused,
      tokens: teams.map((t) => ({ ship: t.ship, teamId: t.teamId, code: t.invite_code }))
    };
  }

  // ------------------------------------------------------------------
  // Build der Broadcast-Ansicht
  // ------------------------------------------------------------------
  viewFor(gameId) {
    const gameRow = dbm.getGame(gameId);
    if (!gameRow) return null;
    const teams = dbm.getTeams(gameId);
    const leaders = dbm.getPlayers(gameId)
      .map((p) => ({ playerId: p.id, teamId: p.teamId, leaderId: dbm.getTeam(gameId, p.teamId) ?
        (dbm.getTeam(gameId, p.teamId).leaderId) : null }))
      .filter((l) => l.leaderId);
    let game = null;
    let started = !!gameRow.started;
    try {
      game = G.deserialize(gameRow.state, D);
    } catch (e) { game = null; }
    const view = buildView({ gameId, game, teams, leaders });
    view.started = started && !(game && game.over);
    return view;
  }

  // Broadcast eines frischen State in den Raum.
  broadcast(gameId) {
    const view = this.viewFor(gameId);
    if (view) this._emit(this._roomOf(gameId), 'state', view);
    return view;
  }

  // ------------------------------------------------------------------
  // Spieleliste: alle Spiele mit Status (aktiv/abgeschlossen). gmCode wird
  // NICHT exponiert — nur Kennung, Name, Status, Start-, Endzeit.
  // ------------------------------------------------------------------
  listGames() {
    const rows = dbm.listAllGames();
    // (2k #1) Spiele erst in der Liste zeigen, wenn sie GESTARTET wurden. Spiele in der
    // Lobby (noch nicht gestartet) werden nicht gelistet. Pausierte Spiele bleiben
    // sichtbar (started bleibt 1) — sonst könnte man sie nicht fortsetzen.
    return (rows || []).filter((g) => !!g.started).map((g) => ({
      gameId: g.gameId,
      name: g.name || 'Ohne Namen',
      started: !!g.started,
      over: !!g.over,
      paused: !!g.paused,
      created_at: g.created_at,
      updated_at: g.updated_at,
      // Anzahl Besitz/Gewinner ohne Volllast:
      teams: (dbm.getTeams(g.gameId) || []).map((t) => ({ teamId: t.teamId, ship: t.ship }))
    }));
  }

  // GM pausiert ein laufendes Spiel (nur GM). Alle Teilnehmer sehen die Meldung.
  pauseGame({ gameId, gmCode, sock }) {
    // (2h#8/2i #1) Nur der AKTIVE GM darf pausieren (gm_owner-Check) — nicht jeder
    // Socket, der den (unveränderten) GM-Code besitzt.
    const req = this._requireGmOwner({ gameId, gmCode, sock, action: 'das Spiel pausieren' });
    if (req.error) return req;
    const gameRow = req.gameRow;
    dbm.setPaused(gameId, true);
    // (2g#17) Pause stoppt den Zug-Timer + blendet die Restzeit aus.
    this._clearTurnTimer(gameId);
    try {
      const e2 = G.deserialize(dbm.getGame(gameId).state, D);
      e2.turnDeadline = 0;
      this._save(gameId, e2);
    } catch (e) {}
    sock.join(this._roomOf(gameId));
    const engine = this._loadEngine(gameId);
    if (engine) {
      this.logEngine(gameId, engine, this._gmNameOf(gameId) + ' pausiert das Spiel.');
      dbm.updateState(gameId, { state: engine.serialize(), started: gameRow.started ? 1 : 0, over: engine.over ? 1 : 0 });
    }
    this.broadcast(gameId);
    return { ok: true, gameId, paused: true, gmCode: (gmCode || '').toUpperCase() };
  }

  // GM setzt ein pausiertes Spiel fort (nur GM). GM-Code verifiziert.
  resumeGame({ gameId, gmCode, sock }) {
    const gameRow = dbm.getGame(gameId);
    if (!gameRow) return { error: { code: 'NO_GAME', message: 'Unbekanntes Spiel.' } };
    const codeRow = dbm.getCode(String(gmCode || '').toUpperCase());
    if (!codeRow || codeRow.kind !== 'gm' || codeRow.gameId !== gameId) {
      return { error: { code: 'FORBIDDEN', message: 'Nur der GM darf das Spiel fortsetzen.' } };
    }
    this._addGmSocket(gameId, sock);
    dbm.setPaused(gameId, false);
    sock.join(this._roomOf(gameId));
    // (2g#8) Der fortsetzende GM ist der aktive GM; (2g#17) Timer neu armieren.
    dbm.setGmOwner(gameId, sock.id);
    this._armTurnTimer(gameId);
    // Teamleiter-Auflösung für jedes Team (behält bestehenden Leader bei, wenn gültig)
    const teams = dbm.getTeams(gameId);
    teams.forEach((t) => this.resolveTeamLeader(gameId, t.teamId));
    const engine = this._loadEngine(gameId);
    if (engine) {
      this.logEngine(gameId, engine, this._gmNameOf(gameId) + ' setzt das Spiel fort.');
      dbm.updateState(gameId, { state: engine.serialize(), started: 1, over: engine.over ? 1 : 0 });
    }
    this.broadcast(gameId);
    return {
      ok: true,
      gameId,
      paused: false,
      gmCode: (gmCode || '').toUpperCase(),
      tokens: teams.map((t) => ({ ship: t.ship, teamId: t.teamId, code: t.invite_code }))
    };
  }

  // ------------------------------------------------------------------
  // GM: Teamleiter manuell ändern (spielweit). Nur der berechtigte GM.
  // ------------------------------------------------------------------
  gmSetLeader({ gameId, gmCode, teamId, playerId, sock }) {
    const req = this._requireGmOwner({ gameId, gmCode, sock, action: 'Teamleiter ändern' });
    if (req.error) return req;
    const gameRow = req.gameRow;
    const team = dbm.getTeam(gameId, teamId);
    if (!team) return { error: { code: 'TEAM_GONE', message: 'Team nicht gefunden.' } };
    const target = dbm.getPlayer(playerId);
    if (!target || target.gameId !== gameId || target.teamId !== teamId) {
      return { error: { code: 'BAD_CANDIDATE', message: 'Mitglied nicht in diesem Team.' } };
    }
    dbm.setLeader(gameId, teamId, target.id);
    const leg = this._loadEngine(gameId);
    if (leg) {
      const tname = team.ship || teamId;
      this.logEngine(gameId, leg, this._gmNameOf(gameId) + ' setzt ' + (target.name || 'Spieler') + ' als Leiter von ' + tname + '.');
      dbm.updateState(gameId, { state: leg.serialize(), started: gameRow.started ? 1 : 0, over: leg.over ? 1 : 0 });
    }
    return { ok: true, gameId, teamId, leaderId: target.id };
  }

  // ------------------------------------------------------------------
    // (2h#8) GM-Übergabe: aktiver GM überträgt seine Rolle an einen Teilnehmer
    // (kein Beobachter). Der GM-Code bleibt an das SPIEL gebunden und ändert sich
    // beim GM-Wechsel NICHT (2h#8b) — nur der neue GM erhält ihn privat. Der alte
    // GM verliert seine GM-Rechte (gm_owner wechselt). Kein Waisen-Spiel.
    // ------------------------------------------------------------------
    gmTransfer({ gameId, gmCode, playerId, sock }) {
        const req = this._requireGmOwner({ gameId, gmCode, sock, action: 'die GM-Rolle übertragen' });
        if (req.error) return req;
        const gameRow = req.gameRow;
        const target = dbm.getPlayer(String(playerId || ''));
      if (!target || target.gameId !== gameId) {
        return { error: { code: 'BAD_TARGET', message: 'Gewähltes Mitglied ist nicht Teilnehmer dieses Spiels.' } };
      }
      if (!target.teamId) {
        return { error: { code: 'BAD_TARGET', message: 'Die GM-Rolle kann nur an einen Teilnehmer (nicht an Beobachter) übergehen.' } };
      }
      if (target.id === sock.id && String(gameRow.gm_owner || '') === String(sock.id)) {
        return { error: { code: 'SAME_GM', message: 'Dieses Mitglied ist bereits der aktive GM.' } };
      }
      // (2h#8b) GM-Code bleibt unverändert am Spiel gebunden — NICHT rotieren.
      const gmCodeValue = String(req.codeRow.code);
      // Aktiven GM setzen + Ziel privat über den (unveränderten) Code benachrichtigen.
      dbm.setGmOwner(gameId, target.id);
      // (2k #4) Alten GM aus dem GM-Socket-Register entfernen — sonst bleibt sein
      // Verlassen dauerhaft durch GM_ACTIVE blockiert, obwohl er die Rolle abgegeben hat.
      this._removeGmSocket(gameId, sock.id);
      this._emitTo(target.id, 'gm:owner', { gameId, gmCode: gmCodeValue });
      // (2h#8a) Den ALTEN GM informieren, dass er die GM-Rolle abgegeben hat —
      // er verliert seine GM-Rechte und bekommt eine informative Meldung.
      this._emitTo(sock.id, 'gm:revoked', { gameId, newOwnerId: target.id, newOwnerName: target.name || 'Spieler' });
      this.broadcast(gameId);
      return { ok: true, gameId, transferredTo: target.id, transferredToName: target.name || 'Spieler', gmCode: gmCodeValue };
    }

  // GM-Name (Punkt 3): GM legt seinen Anzeigenamen fest; erscheint in
  // Lobby/Log/Broadcasts. Nur der GM (mit gültigem GM-Code) darf ihn ändern.
  // ------------------------------------------------------------------
  setGmName({ gameId, gmCode, gmName, sock }) {
    const gameRow = dbm.getGame(gameId);
    if (!gameRow) return { error: { code: 'NO_GAME', message: 'Unbekanntes Spiel.' } };
    const codeRow = dbm.getCode(String(gmCode || '').toUpperCase());
    if (!codeRow || codeRow.kind !== 'gm' || codeRow.gameId !== gameId) {
      return { error: { code: 'FORBIDDEN', message: 'Nur der GM darf seinen Namen ändern.' } };
    }
    this._addGmSocket(gameId, sock);
    const name = (gmName && String(gmName).trim()) ? String(gmName).trim().slice(0, 40) : 'GM';
    const old = this._gmNameOf(gameId);
    dbm.setGmName(gameId, name);
    const leg = this._loadEngine(gameId);
    if (leg) {
      this.logEngine(gameId, leg, 'GM-Name geändert: ' + old + ' → ' + name);
      dbm.updateState(gameId, { state: leg.serialize(), started: gameRow.started ? 1 : 0, over: leg.over ? 1 : 0 });
    }
    this.broadcast(gameId);
    return { ok: true, gameId, gmName: name };
  }

  // ------------------------------------------------------------------
  // Endresultat eines Spiels (abgeschlossen): Gewinner + Budget je Team.
  // ------------------------------------------------------------------
  gameResult(gameId) {
    const gameRow = dbm.getGame(gameId);
    if (!gameRow) return null;
    let game = null;
    try { game = G.deserialize(gameRow.state, D); } catch (e) { game = null; }
    if (!game) return null;
    const teams = dbm.getTeams(gameId) || [];
    return {
      gameId,
      name: gameRow.name || 'Ohne Namen',
      over: !!game.over,
      winner: game.winnerInfo ? { name: game.winnerInfo.name, ship: game.winnerInfo.ship } : null,
      players: (game.players || []).map((p, i) => {
        const t = teams[i] || {};
        return {
          name: p.name,
          ship: t.ship || '',
          budget: p.budget,
          bankrupt: !!p.bankrupt,
          winner: !!p.winner,
          fieldValue: Object.keys(p.properties || {}).reduce((sum, fid) => {
            const f = game.fields[Number(fid)];
            return sum + (f && typeof f.price === 'number' ? f.price : 0);
          }, 0)
        };
      })
    };
  }
}

module.exports = { Rooms, D, G, buildView };