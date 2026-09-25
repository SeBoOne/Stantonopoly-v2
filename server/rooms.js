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
  return {
    gameId,
    game: gameState,
    presetName,
    teams: teamViews,
    leaders: leaders || [],
    started: (game && !game.over && !!game._started) ? true : false,
    over: !!(game && game.over),
    paused: !!(gRow && gRow.paused),
    winnerInfo: (game && game.winnerInfo) || null,
    log: (game && game.log) || []
  };
}

// Prüft, ob ein Socket innerhalb des Raums als Teamleiter/aktiver angesehen wird.
// teamIdFromSocket: wird vom Aufrufer (index.js) als Socket-Daten geliefert.
class Rooms {
  constructor(broadcast) {
    // broadcast: { to(room).emit(event, data) } - zentraler io
    this.io = broadcast;
    // roomKey -> { gameId, state, teams[], game(engine), started }
    // memory-cache; Persistenz via db.js (state-json).
  }

  _roomOf(gameId) {
    return 'room:' + gameId;
  }

  _emit(room, event, data) {
    if (this.io && this.io.to) this.io.to(room).emit(event, data);
  }

  _save(gameId, game) {
    dbm.updateState(gameId, {
      state: game.serialize(),
      started: game._started ? 1 : 0,
      over: game.over ? 1 : 0
    });
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
    if (['1w6', '2w6', 'frei'].indexOf(diceKind) === -1) {
      return { error: { code: 'BAD_DICE', message: 'Unbekannter Würfelmodus.' } };
    }
    const armistice = !!config.armistice;

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
      settings: ruleSettings
    });
    engine._started = false;
    // Spielname: gewählter Preset-Name oder Default (für Spieleliste/Fortsetzen).
    const gameName = (config.gameName && String(config.gameName).trim())
      ? String(config.gameName).trim()
      : ((config.preset && (D.PRESETS[config.preset] || dbm.getPreset(config.preset))) ? config.preset : 'Crusader Cluster');
    dbm.createGame({ gameId, gmCode, state: engine.serialize(), started: 0, over: 0, name: gameName });

    sock.join(this._roomOf(gameId));

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
    if (!codeRow || codeRow.kind !== 'invite') {
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

    const name = String(playerName || 'Pilot').slice(0, 24) || 'Pilot';
    let token = null;
    const existing = dbm.getPlayer(sock.id);
    if (existing) {
      // Schon beigetreten: bestehenden Eintrag behalten (Token falls vorhanden).
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
  startGame({ gameId, gmCode, sock }) {
    const gameRow = dbm.getGame(gameId);
    if (!gameRow) return { error: { code: 'NO_GAME', message: 'Unbekanntes Spiel.' } };
    const codeRow = dbm.getCode(String(gmCode || '').toUpperCase());
    if (!codeRow || codeRow.kind !== 'gm' || codeRow.gameId !== gameId) {
      return { error: { code: 'FORBIDDEN', message: 'Nur der GM darf das Spiel starten.' } };
    }
    const teams = dbm.getTeams(gameId);
    // jedes Team braucht >=1 Mitglied
    const players = dbm.getPlayers(gameId) || [];
    const empty = teams.filter((t) => players.filter((p) => p.teamId === t.teamId).length === 0);
    if (empty.length) {
      return { error: { code: 'INCOMPLETE', message: 'Noch nicht alle Teams haben mindestens einen Spieler.' } };
    }
    // Teamleiter via resolveTeamLeader (stimmbasiert; bei keiner Stimme behält es bestehenden Leader
    // oder wählt zufällig). Danach Votes leeren, damit resumeGame nicht stale Votes auswertet.
    teams.forEach((t) => {
      const tp = players.filter((p) => p.teamId === t.teamId);
      if (tp.length) this.resolveTeamLeader(gameId, t.teamId);
    });
    teams.forEach((t) => dbm.clearVotes(gameId, t.teamId));

    const engine = G.deserialize(gameRow.state, D);
    engine._started = true;
    const alreadyStarted = !!gameRow.started;
    // Fortsetzen (bereits gestartetes Spiel): aktiven Spieler NICHT neu würfeln.
    // Nur beim ERSTEN Start den zufälligen Startspieler bestimmen.
    if (!alreadyStarted) {
      const aliveIdx = [];
      for (let i = 0; i < engine.players.length; i++) if (!engine.players[i].bankrupt) aliveIdx.push(i);
      if (aliveIdx.length) engine.activeIdx = aliveIdx[Math.floor(Math.random() * aliveIdx.length)];
    }
    dbm.setStarted(gameId, true);
    dbm.updateState(gameId, { state: engine.serialize(), started: 1, over: engine.over ? 1 : 0 });
    return { ok: true, gameId, started: true, resumed: alreadyStarted };
  }

  // ------------------------------------------------------------------
  // GM: Live-Pflege (deploy configPatch) — Gameplay bleibt konsistent
  // ------------------------------------------------------------------
  deploy({ gameId, gmCode, configPatch, sock }) {
    const gameRow = dbm.getGame(gameId);
    if (!gameRow) return { error: { code: 'NO_GAME', message: 'Unbekanntes Spiel.' } };
    const codeRow = dbm.getCode(String(gmCode || '').toUpperCase());
    if (!codeRow || codeRow.kind !== 'gm' || codeRow.gameId !== gameId) {
      return { error: { code: 'FORBIDDEN', message: 'Nur der GM darf Änderungen deployen.' } };
    }
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
    return { ok: true, gameId, state: engine.serialize() };
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
    const ret = this._persistAndReturn(gameId, req.engine, true);
    ret.built = built;
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

  actionMortgage({ gameId, field, sock }) {
    const req = this._requireLeaderOfTeam({ gameId, sock });
    if (req.error) return req;
    const fieldIdx = Number(field);
    if (!Number.isInteger(fieldIdx)) return { error: { code: 'BAD_FIELD', message: 'Ungültiges Feld.' } };
    const r = req.engine.mortgage(fieldIdx);
    if (!r.ok) return { error: { code: 'ECON', message: 'Hypothek nicht möglich (' + r.reason + ').' } };
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

  // Engine-Player-Index eines Teams ermitteln (engine.players[i].id === teamId)
  _piOf(engine, teamId) {
    for (let i = 0; i < engine.players.length; i++) if (String(engine.players[i].id) === String(teamId)) return i;
    return -1;
  }

  // ---------- Handel (Angebote: Verkauf / Kauf, mit Annehmen/Ablehnen) ----------
  offerMake({ gameId, kind, field, targetIdx, price, sock }) {
    const req = this._requireActiveLeaderForTrade({ gameId, sock });
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
  auctionStart({ gameId, field, sock }) {
    const req = this._requireActiveLeaderForTrade({ gameId, sock });
    if (req.error) return req;
    const engine = req.engine;
    const ownerIdx = this._piOf(engine, req.team.teamId);
    if (ownerIdx < 0) return { error: { code: 'NOT_IN_TEAM', message: 'Dein Team ist nicht im Spiel.' } };
    const r = engine.startAuction({ ownerIdx, fieldIdx: Number(field) });
    if (!r.ok) return { error: { code: 'AUCTION', message: 'Auktion nicht möglich (' + r.reason + ').' } };
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
    const req = this._requireLeaderOfTeam({ gameId, sock });
    if (req.error) return req;
    const fieldIdx = Number(field);
    const bidx = Number(buyerIdx);
    if (!Number.isInteger(fieldIdx) || !Number.isInteger(bidx)) {
      return { error: { code: 'BAD_FIELD', message: 'Ungültige Parameter.' } };
    }
    const r = req.engine.sellProperty(fieldIdx, bidx, price);
    if (!r.ok) return { error: { code: 'ECON', message: 'Verkauf nicht möglich (' + r.reason + ').' } };
    const ret = this._persistAndReturn(gameId, req.engine, true);
    ret.sold = r.price;
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
    sock.join(this._roomOf(gameId));
    return { ok: true, gameId, role: 'spectator' };
  }

  // Spiel verlassen (jede Rolle): aus dem Raum + aus der Spieler-Tabelle entfernen.
  leaveGame({ gameId, sock }) {
    // Prüfen, ob der Verlassende Leader seines Teams ist (VOR removePlayer)
    const me = dbm.getPlayer(sock.id);
    let isLeader = false;
    if (me) {
      const team = dbm.getTeam(gameId, me.teamId);
      isLeader = team && team.leaderId && String(team.leaderId) === String(sock.id);
    }
    // Spieler entfernen
    dbm.removePlayer(gameId, sock.id);
    // Wenn der Verlassende Leader war: neuen Leader auflösen und State broadcasten
    if (isLeader && me) {
      this.resolveTeamLeader(gameId, me.teamId);
      // Broadcast an verbleibende Clients — sie sehen sonst keine neue leaderId
      this.broadcast(gameId);
    }
    try { sock.leave(this._roomOf(gameId)); } catch (e) {}
    // Client-State bereinigen (localStorage löscht der Client selbst).
    return { ok: true, gameId, left: true };
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
    const teams = dbm.getTeams(resolvedGameId);
    return {
      ok: true,
      gameId: resolvedGameId,
      isGM: true,
      started: !!gameRow.started,
      over: !!gameRow.over,
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
    return (rows || []).map((g) => ({
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
    const gameRow = dbm.getGame(gameId);
    if (!gameRow) return { error: { code: 'NO_GAME', message: 'Unbekanntes Spiel.' } };
    const codeRow = dbm.getCode(String(gmCode || '').toUpperCase());
    if (!codeRow || codeRow.kind !== 'gm' || codeRow.gameId !== gameId) {
      return { error: { code: 'FORBIDDEN', message: 'Nur der GM darf das Spiel pausieren.' } };
    }
    dbm.setPaused(gameId, true);
    sock.join(this._roomOf(gameId));
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
    dbm.setPaused(gameId, false);
    sock.join(this._roomOf(gameId));
    // Teamleiter-Auflösung für jedes Team (behält bestehenden Leader bei, wenn gültig)
    const teams = dbm.getTeams(gameId);
    teams.forEach((t) => this.resolveTeamLeader(gameId, t.teamId));
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
    const gameRow = dbm.getGame(gameId);
    if (!gameRow) return { error: { code: 'NO_GAME', message: 'Unbekanntes Spiel.' } };
    const codeRow = dbm.getCode(String(gmCode || '').toUpperCase());
    if (!codeRow || codeRow.kind !== 'gm' || codeRow.gameId !== gameId) {
      return { error: { code: 'FORBIDDEN', message: 'Nur der GM darf Teamleiter ändern.' } };
    }
    const team = dbm.getTeam(gameId, teamId);
    if (!team) return { error: { code: 'TEAM_GONE', message: 'Team nicht gefunden.' } };
    const target = dbm.getPlayer(playerId);
    if (!target || target.gameId !== gameId || target.teamId !== teamId) {
      return { error: { code: 'BAD_CANDIDATE', message: 'Mitglied nicht in diesem Team.' } };
    }
    dbm.setLeader(gameId, teamId, target.id);
    return { ok: true, gameId, teamId, leaderId: target.id };
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