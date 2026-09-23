#!/usr/bin/env node
/* Mock-Server für Integrationstest: static public/ + socket.io-Proxy-Simulation */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { io } = require('/home/sebo/Projects/stantonopoly-multiplayer/node_modules/socket.io');

const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  let p = path.join(PUB, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
  if (fs.existsSync(p) && fs.statSync(p).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(fs.readFileSync(p));
  } else { res.writeHead(404); res.end('nf'); }
});

const sio = io(server, { allowEIO3: true });

// ---- Mini-Server-State (repliziert server.js-Kontrakt) ----
const GUNDO_FEE = 125000, LOS_PASS_BONUS = 500000;
const RENT_MULT = { ALLEIN: 0.1, CYCLONE: 0.5, STORM: 1.0, BALLISTA: 2.0, ARMISTICE: 3.0 };
const BUILD_ORDER = ['ALLEIN', 'CYCLONE', 'STORM', 'BALLISTA', 'ARMISTICE'];
const FIELD_ORDER = ['ALLEIN', 'CYCLONE', 'STORM', 'BALLISTA', 'ARMISTICE'];
const SHIP_NAMES = ['Crusader', 'Drake', 'Idris', 'Mantis', 'Reliant', 'Aegis', 'Vindicator', 'Manticore'];
const SHIP_COLORS = ['#e74c3c', '#f1c40f', '#3498db', '#2ecc71', '#9b59b6', '#e67e22', '#1abc9c', '#ecf0f1'];

function fieldsData() {
  return [
    { type: 'los', name: 'Orison', price: 0 },
    { type: 'grundstueck', name: 'Seraphim', price: 400000 },
    { type: 'grundstueck', name: 'Shubin Mining SCD-1', price: 500000 },
    { type: 'grundstueck', name: 'Kudre Ore', price: 500000 },
    { type: 'grundstueck', name: 'Brios Breaker Yard', price: 400000 },
    { type: 'grundstueck', name: 'Arc Mining 141', price: 500000 },
    { type: 'gundo', name: 'Covalex Hub Gundo', price: 0 },
    { type: 'grundstueck', name: 'Miner Lament', price: 300000 },
    { type: 'grundstueck', name: 'Grim Hex', price: 500000 },
    { type: 'grundstueck', name: 'NT-999-XX', price: 600000 },
    { type: 'grundstueck', name: 'Deakins Research', price: 500000 },
    { type: 'grundstueck', name: 'Terra Mills HydroFarm', price: 300000 },
    { type: 'grundstueck', name: 'Gallete Family Farms', price: 300000 },
    { type: 'grundstueck', name: 'Hickes Research', price: 500000 },
    { type: 'grundstueck', name: 'Security Post Kareah', price: 600000 },
    { type: 'grundstueck', name: 'Comm Array ST2-55', price: 600000 }
  ];
}

let games = new Map();
const codeChars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genCode() {
  let c = '';
  for (let i = 0; i < 6; i++) c += codeChars[Math.floor(Math.random() * codeChars.length)];
  return c;
}
function genCodeShort() {
  let c = '';
  for (let i = 0; i < 4; i++) c += codeChars[Math.floor(Math.random() * codeChars.length)];
  return c;
}

function createGame(data, socket) {
  const gameId = genCode();
  const gmCode = genCode();
  const teamCount = Math.max(2, Math.min(8, data.teamCount || 4));
  const capital = Math.max(100000, Number(data.startCapital) || 1000000);
  const teams = [];
  const inviteCodes = {};
  for (let i = 0; i < teamCount; i++) {
    const name = SHIP_NAMES[i % SHIP_NAMES.length];
    const team = {
      id: 'team_' + i,
      ship: name,
      color: SHIP_COLORS[i % SHIP_COLORS.length],
      members: [],
      leaderId: null,
      budget: capital,
      pos: 0,
      properties: {},
      tasks: 0,
      tasksDone: 0,
      surrendered: false,
      inDebt: false
    };
    teams.push(team);
    inviteCodes[name] = genCodeShort();
  }
  const game = {
    id: gameId,
    gmCode: gmCode,
    phase: 'lobby',
    diceMode: data.diceMode || '2w6',
    enableArmistice: !!data.enableArmistice,
    fields: fieldsData(),
    teams: teams,
    activeIdx: 0,
    round: 1,
    log: ['Spiel erstellt'],
    inviteCodes: inviteCodes
  };
  games.set(gameId, game);
  games.set(gmCode, game);
  for (const ic of Object.values(inviteCodes)) games.set(ic, game);
  socket.join(gameId);
  const view = gameView(game, socket);
  sio.to(gameId).emit('state', view);
  console.log('GM-CREATE', gameId, gmCode, JSON.stringify(view.inviteCodes));
  return view;
}

function teamView(t) {
  return {
    id: t.id, ship: t.ship, color: t.color,
    members: t.members.map(m => m.name),
    leaderId: t.leaderId, budget: t.budget,
    pos: t.pos, properties: t.properties,
    tasks: t.tasks, tasksDone: t.tasksDone,
    surrendered: t.surrendered
  };
}

function gameView(game, socket) {
  const myTeam = game.teams.find(t => t.members.some(m => m.socketId === socket.id));
  return {
    gameId: game.id,
    gmCode: game.gmCode,
    phase: game.phase,
    diceMode: game.diceMode,
    enableArmistice: game.enableArmistice,
    fields: game.fields,
    teams: game.teams.map(teamView),
    myTeamId: myTeam ? myTeam.id : null,
    inviteCodes: game.inviteCodes,
    activeIdx: game.activeIdx,
    round: game.round,
    log: game.log.slice(-100),
    rentMult: RENT_MULT,
    gundoFee: GUNDO_FEE,
    losPassBonus: LOS_PASS_BONUS,
    fieldOrder: FIELD_ORDER
  };
}

function broadcast(game) {
  sio.to(game.id).emit('state', { _all: true });
}

sio.on('connection', (socket) => {
  socket.on('gm-create', (data) => {
    const view = createGame(data, socket);
    socket.emit('created', { gameId: view.gameId, gmCode: view.gmCode, inviteCodes: view.inviteCodes });
    // State senden (view oben bereits broadcast)
  });

  socket.on('join', (data) => {
    const code = (data.code || '').toUpperCase();
    const name = String(data.name || 'Pilot').slice(0, 24) || 'Pilot';
    const game = games.get(code);
    if (!game) { socket.emit('error', 'Unbekannter Code'); return; }
    if (game.phase !== 'lobby') { socket.emit('error', 'Spiel bereits gestartet'); return; }
    let team = game.teams.find(t => t.members.some(m => m.name === name));
    let teamName = null;
    if (!team) {
      team = game.teams.find(t => t.members.length === 0) || game.teams[0];
      team.members.push({ name, socketId: socket.id });
      teamName = team.ship;
    } else {
      team.members.push({ name, socketId: socket.id });
      teamName = team.ship;
    }
    if (!team.leaderId) team.leaderId = socket.id;
    socket.join(game.id);
    socket.data.gameId = game.id;
    socket.emit('joined', { teamName: teamName, teamId: team.id, isLeader: team.leaderId === socket.id });
    broadcastState(game, socket);
  });

  socket.on('set-leader', () => {
    const game = games.get(socket.data.gameId);
    if (!game) return;
    const team = game.teams.find(t => t.members.some(m => m.socketId === socket.id));
    if (team) { team.leaderId = socket.id; broadcastState(game); }
  });

  socket.on('gm-start', () => {
    const game = games.get(socket.data.gameId);
    if (!game || game.phase !== 'lobby') return;
    // GM = Mitglied ohne Team (nur im Spiel) — vereinfacht: erster Socket im Raum
    game.phase = 'playing';
    game.log.push('Spiel gestartet');
    // Start-Tasks
    for (const t of game.teams) {
      t.pos = 0;
      t.tasks = 2 + Math.floor(Math.random() * 2);
    }
    broadcastState(game);
  });

  socket.on('roll', (data) => {
    const game = games.get(socket.data.gameId);
    if (!game || game.phase !== 'playing') return;
    const team = game.teams[game.activeIdx];
    let roll;
    if (game.diceMode === '1w6') roll = 1 + Math.floor(Math.random() * 6);
    else if (game.diceMode === '2w6') roll = 2 + Math.floor(Math.random() * 6) + Math.floor(Math.random() * 6);
    else roll = Math.min(6, 1 + Math.floor(Math.random() * (Number(data) - 1 || 1)));
    game.log.push(team.ship + ' würfelt: ' + roll);
    applyMove(game, team, roll);
    advanceIfDone(game);
    broadcastState(game);
  });

  socket.on('buy', () => {
    const game = games.get(socket.data.gameId);
    if (!game || game.phase !== 'playing') return;
    const team = game.teams[game.activeIdx];
    const field = game.fields[team.pos];
    if (!field || field.type !== 'grundstueck') return;
    if (field.owner) { game.log.push(team.ship + ' kann nicht kaufen (bereits vergeben)'); broadcastState(game); return; }
    if (team.budget < field.price) { game.log.push(team.ship + ': Nicht genug Budget'); broadcastState(game); return; }
    field.owner = team.id;
    field.level = 'ALLEIN';
    team.budget -= field.price;
    team.properties[team.pos] = 'ALLEIN';
    game.log.push(team.ship + ' kauft ' + field.name + ' für ' + field.price);
    advanceIfDone(game);
    broadcastState(game);
  });

  socket.on('build', () => {
    const game = games.get(socket.data.gameId);
    if (!game || game.phase !== 'playing') return;
    const team = game.teams[game.activeIdx];
    const field = game.fields[team.pos];
    if (!field || field.owner !== team.id) return;
    const cur = BUILD_ORDER.indexOf(field.level);
    if (cur >= 3) return;
    const cost = Math.round(field.price * 0.5);
    if (team.budget < cost) return;
    team.budget -= cost;
    field.level = BUILD_ORDER[cur + 1];
    team.properties[team.pos] = field.level;
    game.log.push(team.ship + ' baut ' + field.name + ' aus: ' + field.level);
    advanceIfDone(game);
    broadcastState(game);
  });

  socket.on('skip', () => {
    const game = games.get(socket.data.gameId);
    if (!game || game.phase !== 'playing') return;
    const team = game.teams[game.activeIdx];
    game.log.push(team.ship + ' überspringt Zug');
    advanceIfDone(game);
    broadcastState(game);
  });

  socket.on('task-complete', () => {
    const game = games.get(socket.data.gameId);
    if (!game || game.phase !== 'playing') return;
    const team = game.teams[game.activeIdx];
    if (team.tasks > 0) {
      team.tasks--;
      team.tasksDone++;
      game.log.push(team.ship + ' erledigt Aufgabe (' + team.tasks + ' übrig)');
    }
    broadcastState(game);
  });

  socket.on('surrender', () => {
    const game = games.get(socket.data.gameId);
    if (!game || game.phase !== 'playing') return;
    const team = game.teams[game.activeIdx];
    team.surrendered = true;
    game.log.push(team.ship + ' gibt auf');
    broadcastState(game);
  });

  socket.on('next-turn', () => {
    const game = games.get(socket.data.gameId);
    if (!game || game.phase !== 'playing') return;
    advanceTurn(game);
    broadcastState(game);
  });

  socket.on('disconnect', () => {
    // Vereinfacht: kein Member-Remove
  });
});

function applyMove(game, team, roll) {
  const oldPos = team.pos;
  team.pos = (team.pos + roll) % 16;
  if (oldPos === 0 && team.pos !== 0 && oldPos < team.pos) {
    team.budget += LOS_PASS_BONUS;
    game.log.push(team.ship + ' überquert LOS: +' + LOS_PASS_BONUS);
  } else if (oldPos === 0 && team.pos < oldPos + roll) {
    // Wrapped
    team.budget += LOS_PASS_BONUS;
    game.log.push(team.ship + ' überquert LOS: +' + LOS_PASS_BONUS);
  }
  if (team.pos === 6) {
    team.budget -= GUNDO_FEE;
    game.log.push(team.ship + ' zahlt Gundo-Gebühr: -' + GUNDO_FEE);
  }
  // Rent check
  const field = game.fields[team.pos];
  if (field && field.type === 'grundstueck' && field.owner && field.owner !== team.id) {
    const ownerTeam = game.teams.find(t => t.id === field.owner);
    if (ownerTeam) {
      const rent = Math.round(field.price * RENT_MULT[field.level]);
      team.budget -= rent;
      ownerTeam.budget += rent;
      game.log.push(team.ship + ' zahlt Miete ' + rent + ' an ' + ownerTeam.ship);
    }
  }
  // Debt check
  if (team.budget < 0) {
    // 1 Runde Kredit
    const credit = Math.abs(team.budget);
    team.budget += credit;
    game.log.push(team.ship + ' in Debat: Kredit ' + credit);
    // Nächste Runde -20%? Vereinfacht: inDebt flag
    team.inDebt = true;
  }
}

function advanceIfDone(game) {
  // Nach Aktion: wenn Team fertig (skip/buy/build roll), weiter
}

function advanceTurn(game) {
  game.activeIdx = (game.activeIdx + 1) % game.teams.length;
  // Runde zählen wenn zurück bei 0
  if (game.activeIdx === 0) game.round++;
}

function broadcastState(game) {
  // An alle Sockets im Raum State senden
  const s = sio.sockets.sockets;
  for (const [id, sock] of s) {
    if (sock.data.gameId === game.id || sock.rooms.has(game.id)) {
      sock.emit('state', gameView(game, sock));
    }
  }
}

server.listen(3901, () => console.log('MOCK-UP on 3901'));
