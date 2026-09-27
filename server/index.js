/**
 * Stantonopoly V2 — Server-Einstieg (server-authoritativ)
 * Express static + /health + socket.io mit Event-Routing an rooms.js.
 * Start: node server/index.js   (Port 8000, ENV PORT)
 */
'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');

const { Rooms } = require('./rooms.js');
const dbm = require('./db.js');
// Eingebaute Presets beim Start seeden (falls DB frisch).
dbm.seedBuiltinPresets();

const PORT = Number(process.env.PORT) || 8000;
const PUBLIC = path.join(__dirname, '..', 'public');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const rooms = new Rooms({
  to: (room) => ({
    emit: (event, data) => io.to(room).emit(event, data)
  })
});

// ---- Static + health ----
app.use(express.static(PUBLIC));
app.use(express.json());

app.get('/health', (req, res) => {
  res.set('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, service: 'stantonopoly-v2', time: new Date().toISOString() }));
});

if (process.env.NODE_ENV !== 'test') {
  app.get('/', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
}

// ---- Socket.io: ein Raum pro Spiel (room:gameId) ----
io.on('connection', (socket) => {
  const emit = (event, data) => socket.emit(event, data);
  const error = (code, message) => emit('error', { code, message });

  const handleResult = (ret) => {
    if (!ret) return;
    if (ret.error) {
      error(ret.error.code, ret.error.message);
      return;
    }
    if (ret.gameId) {
      // Broadcast in den Raum des betroffenen Spiels
      rooms.broadcast(ret.gameId);
    }
    return ret;
  };

  // ---------- GM: Spiel erstellen ----------
  socket.on('gm:create', (data) => {
    try {
      const ret = rooms.createGame({ config: (data && data.config) || {}, sock: socket });
      if (ret.error) { error(ret.error.code, ret.error.message); return; }
      // gameCreated nur an Ersteller, mit GM-Code + Tokens
      socket.join('room:' + ret.gameId);
      socket.emit('gameCreated', {
        gameId: ret.gameId,
        gmCode: ret.gmCode,
        tokens: ret.tokens
      });
    } catch (e) {
      error('SERVER', String((e && e.message) || e));
    }
  });

  // ---------- GM-Reconnect (nach Browser-Neuladen) ----------
  socket.on('gm:resume', (data) => {
    try {
      const ret = rooms.resumeAsGM({
        gameId: (data && data.gameId) || '',
        gmCode: (data && data.gmCode) || '',
        sock: socket
      });
      if (ret.error) { error(ret.error.code, ret.error.message); return; }
      // GM-Codes + Lobby wieder aufbauen
      socket.join('room:' + ret.gameId);
      socket.emit('gameCreated', { gameId: ret.gameId, gmCode: (data.gmCode || '').toUpperCase(), tokens: ret.tokens, resumed: true, started: !!ret.started, over: !!ret.over });
      // Aktuellen Spielstand an den Raum broadcasten (GM sieht Lobby/Spiel wieder)
      rooms.broadcast(ret.gameId);
    } catch (e) { error('SERVER', String((e && e.message) || e)); }
  });

  // ---------- Preset-Verwaltung (Setup: eigene Karten) ----------
  socket.on('preset:list', () => {
    try {
      socket.emit('presets', { presets: dbm.listPresets() });
    } catch (e) { error('SERVER', String((e && e.message) || e)); }
  });

  socket.on('preset:save', (data) => {
    try {
      if (!data || !data.name || !Array.isArray(data.fields)) {
        error('BAD_PRESET', 'Preset braucht einen Namen und ein Felder-Array.');
        return;
      }
      const name = String(data.name).trim().slice(0, 40);
      if (!name) { error('BAD_PRESET', 'Ungültiger Preset-Name.'); return; }
      // Eingebaute Presets nicht überschreiben
      const existing = dbm.getPreset(name);
      if (existing && existing.builtin) {
        error('FORBIDDEN', 'Eingebautes Preset kann nicht überschrieben werden.');
        return;
      }
      // levelNames optional: übernommene Stufenbezeichnungen ({ALLEIN, CYCLONE, ...})
      const levelNames = (data && data.levelNames && typeof data.levelNames === 'object')
        ? data.levelNames : null;
      // settings optional: Spielregeln (Miet-/Bau-Multiplikatoren, Hypothek, Bank, Timer, Sperren)
      let settings = (data && data.settings && typeof data.settings === 'object')
        ? data.settings : null;
      if (settings && typeof settings === 'object') {
        // leere Einstellungsobjekte herausfiltern (nur etwas-füllende speichern)
        const hasContent = Object.keys(settings).some((k) => {
          const v = settings[k];
          if (typeof v === 'object' && v !== null) return Object.keys(v).length > 0;
          return v !== undefined && v !== '';
        });
        if (!hasContent) settings = null;
      }
      dbm.upsertPreset({ name, fields: data.fields, builtin: 0, levelNames, settings });
      socket.emit('presets', { presets: dbm.listPresets() });
    } catch (e) { error('SERVER', String((e && e.message) || e)); }
  });

  socket.on('preset:delete', (data) => {
    try {
      if (!data || !data.name) return;
      const existing = dbm.getPreset(String(data.name));
      if (existing && existing.builtin) {
        error('FORBIDDEN', 'Eingebaute Presets können nicht gelöscht werden.');
        return;
      }
      dbm.deletePreset(String(data.name));
      socket.emit('presets', { presets: dbm.listPresets() });
    } catch (e) { error('SERVER', String((e && e.message) || e)); }
  });

  // ---------- Team beitreten ----------
  socket.on('team:join', (data) => {
    try {
      const ret = rooms.joinTeam({
        gameId: (data && data.gameId) || '',
        code: (data && data.code) || '',
        playerName: (data && data.playerName) || '',
        sock: socket
      });
      handleResult(ret);
      if (ret && ret.ok) {
        const g = dbm.getGame(ret.gameId);
        emit('joined', { gameId: ret.gameId, teamId: ret.teamId, playerId: ret.playerId, token: ret.token, role: ret.role, started: !!(g && g.started), over: !!(g && g.over) });
      }
    } catch (e) { error('SERVER', String((e && e.message) || e)); }
  });

  // ---------- Rejoin nach Browser-Neuladen ----------
  socket.on('team:rejoin', (data) => {
    try {
      const ret = rooms.rejoin({
        gameId: (data && data.gameId) || '',
        token: (data && data.token) || '',
        sock: socket
      });
      handleResult(ret);
      if (ret && ret.ok) {
        const g = dbm.getGame(ret.gameId);
        emit('joined', { gameId: ret.gameId, teamId: ret.teamId, playerId: ret.playerId, token: ret.token, role: ret.role, rejoined: true, started: !!(g && g.started), over: !!(g && g.over) });
        // Sofort frischen Spielstand an den Raum — sonst bleibt das Panel beim Rejoin
        // auf dem Default (Spieler sähe „Beobachter“, bis der nächste Zug ein state triggert).
        rooms.broadcast(ret.gameId);
      }
    } catch (e) { error('SERVER', String((e && e.message) || e)); }
  });

  // ---------- Stimm-Mehrheit Teamleiter ----------
  socket.on('vote:leader', (data) => {
    try {
      const ret = rooms.voteLeader({
        gameId: (data && data.gameId) || '',
        playerId: (data && data.playerId) || '',
        sock: socket
      });
      handleResult(ret);
    } catch (e) { error('SERVER', String((e && e.message) || e)); }
  });

  // ---------- GM: Start ----------
  socket.on('gm:start', (data) => {
    try {
      const ret = rooms.startGame({
        gameId: (data && data.gameId) || '',
        gmCode: (data && data.gmCode) || '',
        sock: socket
      });
      handleResult(ret);
    } catch (e) { error('SERVER', String((e && e.message) || e)); }
  });

  // GM pausiert ein laufendes Spiel.
  socket.on('gm:pause', (data) => {
    try {
      const ret = rooms.pauseGame({ gameId: (data && data.gameId) || '', gmCode: (data && data.gmCode) || '', sock: socket });
      handleResult(ret);
      // GM-Code nur an den anfragenden GM-Socket zurückgeben (NICHT broadcasten)
      if (ret && ret.ok) {
        socket.emit('gm:paused', { gameId: ret.gameId, gmCode: ret.gmCode });
      }
    } catch (e) { error('SERVER', String((e && e.message) || e)); }
  });

  // GM ändert einen Teamleiter manuell.
  socket.on('gm:setleader', (data) => {
    try {
      const ret = rooms.gmSetLeader({
        gameId: (data && data.gameId) || '',
        gmCode: (data && data.gmCode) || '',
        teamId: (data && data.teamId) || '',
        playerId: (data && data.playerId) || '',
        sock: socket
      });
      handleResult(ret);
    } catch (e) { error('SERVER', String((e && e.message) || e)); }
  });

  // (2g#8) GM-Übergabe an einen Teilnehmer (Code wird rotiert; neuer GM wird privat benachrichtigt).
  socket.on('gm:transfer', (data) => {
    try {
      const ret = rooms.gmTransfer({
        gameId: (data && data.gameId) || '',
        gmCode: (data && data.gmCode) || '',
        playerId: (data && data.playerId) || '',
        sock: socket
      });
      handleResult(ret);
    } catch (e) { error('SERVER', String((e && e.message) || e)); }
  });

  // GM setzt ein pausiertes Spiel fort (GM-Code erforderlich → Lobby mit Codes).
  socket.on('gm:resumegame', (data) => {
    try {
      const ret = rooms.resumeGame({ gameId: (data && data.gameId) || '', gmCode: (data && data.gmCode) || '', sock: socket });
      handleResult(ret);
      if (ret && ret.ok) {
        socket.emit('gameCreated', { gameId: ret.gameId, gmCode: ret.gmCode, tokens: ret.tokens, resumed: true, started: true, over: false });
      }
    } catch (e) { error('SERVER', String((e && e.message) || e)); }
  });

  // ---------- GM: Deploy (Pflege) ----------
  socket.on('gm:deploy', (data) => {
    try {
      const ret = rooms.deploy({
        gameId: (data && data.gameId) || '',
        gmCode: (data && data.gmCode) || '',
        configPatch: (data && data.configPatch) || {},
        sock: socket
      });
      handleResult(ret);
    } catch (e) { error('SERVER', String((e && e.message) || e)); }
  });

  // ---------- Spielaktionen ----------
  const ACTION = {
    'action:roll': 'actionRoll',
    'action:buy': 'actionBuy',
    'action:skip': 'actionSkip',
    'action:build': 'actionBuild',
    'task:complete': 'taskComplete',
    'action:nextTurn': 'actionNextTurn',
    'action:bail': 'actionBail',
    'action:jailstay': 'actionJailStay',
    'action:transferLeader': 'transferLeader',
    'action:mortgage': 'actionMortgage',
    'action:unmortgage': 'actionUnmortgage',
    'action:demolish': 'actionDemolish',
    'action:forfeit': 'actionForfeit',
    'forfeit:vote': 'forfeitVote',
    'action:sell': 'actionSell',
    'action:auction': 'actionAuction',
    'trade:make': 'offerMake',
    'trade:respond': 'offerRespond',
    'auction:start': 'auctionStart',
    'auction:bid': 'auctionBid',
    'auction:resolve': 'auctionResolve'
  };
  Object.keys(ACTION).forEach((eventName) => {
    const method = ACTION[eventName];
    socket.on(eventName, (data) => {
      try {
        const gameId = (data && data.gameId) || '';
        const field = (data && data.field != null && data.field !== '') ? data.field : undefined;
        const playerId = (data && data.playerId) || '';
        const buyerIdx = (data && data.buyerIdx != null && data.buyerIdx !== '') ? data.buyerIdx : undefined;
        const price = (data && data.price != null && data.price !== '') ? data.price : undefined;
        const kind = (data && data.kind) || '';
        const targetIdx = (data && data.targetIdx != null && data.targetIdx !== '') ? data.targetIdx : undefined;
        const offerId = (data && data.offerId) || '';
        const amount = (data && data.amount != null && data.amount !== '') ? data.amount : undefined;
        const accept = (data && data.accept != null && data.accept !== '') ? data.accept : undefined;
        const agree = (data && data.agree != null && data.agree !== '') ? data.agree : undefined;
        const ret = rooms[method]({ gameId, field, playerId, buyerIdx, price, kind, targetIdx, offerId, amount, accept, agree, sock: socket });
        handleResult(ret);
      } catch (e) { error('SERVER', String((e && e.message) || e)); }
    });
  });

  // ---------- Beobachter ----------
  socket.on('spectate', (data) => {
    try {
      const ret = rooms.spectate({ gameId: (data && data.gameId) || '', sock: socket });
      handleResult(ret);
      if (ret && ret.ok) {
        const g = dbm.getGame(ret.gameId);
        emit('joined', { teamId: null, playerId: socket.id, role: 'spectator', spectator: true, started: !!(g && g.started), over: !!(g && g.over) });
        // Sofort frischen Spielstand senden, damit die Beobachter-UI (Brett/Panels) rendert.
        rooms.broadcast(ret.gameId);
      }
    } catch (e) { error('SERVER', String((e && e.message) || e)); }
  });

  // ---------- Spiel verlassen (jede Rolle) ----------
  socket.on('game:leave', (data) => {
    try {
      const ret = rooms.leaveGame({ gameId: (data && data.gameId) || '', sock: socket });
      handleResult(ret);
      if (ret && ret.ok) emit('left', { gameId: ret.gameId, ok: true });
    } catch (e) { error('SERVER', String((e && e.message) || e)); }
  });

  // ---------- Spiel abbrechen (GM): neues Spiel entfernen / Fortsetzen abbrechen ----------
  socket.on('game:cancel', (data) => {
    try {
      const ret = rooms.cancelGame({
        gameId: (data && data.gameId) || '',
        gmCode: (data && data.gmCode) || '',
        sock: socket
      });
      handleResult(ret);
      if (ret && ret.ok) emit('cancelled', { gameId: ret.gameId, removed: !!ret.removed, paused: !!ret.paused });
    } catch (e) { error('SERVER', String((e && e.message) || e)); }
  });

  // ---------- Spieleliste & Endresultate (öffentlich, kein Code) ----------
  socket.on('lobby:list', () => {
    try { emit('lobby:games', { games: rooms.listGames() }); }
    catch (e) { error('SERVER', String((e && e.message) || e)); }
  });

  socket.on('lobby:result', (data) => {
    try {
      const r = rooms.gameResult((data && data.gameId) || '');
      if (!r) { error('NO_GAME', 'Spiel nicht gefunden.'); return; }
      emit('lobby:result', r);
    } catch (e) { error('SERVER', String((e && e.message) || e)); }
  });

  // Direkt zuschauen (ohne Beobachter-Code): Meldet sich in den Raum ein.
  socket.on('lobby:spectate', (data) => {
    try {
      const ret = rooms.spectate({ gameId: (data && data.gameId) || '', sock: socket });
      handleResult(ret);
      if (ret && ret.ok) {
        const g = dbm.getGame(ret.gameId);
        emit('joined', { teamId: null, playerId: socket.id, role: 'spectator', spectator: true, started: !!(g && g.started), over: !!(g && g.over) });
        rooms.broadcast(ret.gameId);
      }
    } catch (e) { error('SERVER', String((e && e.message) || e)); }
  });

  // GM setzt seinen Anzeigenamen (Punkt 3).
  socket.on('gm:setname', (data) => {
    try {
      const ret = rooms.setGmName({
        gameId: (data && data.gameId) || '',
        gmCode: (data && data.gmCode) || '',
        gmName: (data && data.gmName) || '',
        sock: socket
      });
      handleResult(ret);
    } catch (e) { error('SERVER', String((e && e.message) || e)); }
  });

  // ---------- Disconnect ----------
  socket.on('disconnect', () => {
    // Spieler bleiben im Team registriert (Reconnect mit derselben socketId möglich);
    // Punkt 8: nach Ablauf eines Timeouts (Inaktivität) werden sie serverseitig entfernt.
    try { rooms.playerDisconnected(socket.id); } catch (e) { /* ignore */ }
  });
});

// Für Tests: Server exportieren, damit socket.test.js einen echten Handshake nutzen kann.
server.on('listening', () => {
  console.log('[stantonopoly-v2] läuft auf Port ' + PORT + '  (DB: ' + dbm.DB_PATH + ')');
});

if (require.main === module) {
  server.listen(PORT);
} else {
  // Beim Einbinden in Tests nicht automatisch lauschen; exports.listen(n) zum Starten.
  module.exports = { server, io, app, rooms, start: (port) => server.listen(port) };
}