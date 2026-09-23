/* =====================================================================
 * Stantonopoly V2 — socket.test.js
 * Echtzeit-Vertrag: Aktion von Client A erreicht B im selben Raum, NICHT C
 * in einem anderen Raum, < 500 ms. Echte socket.io-Clients gegen den
 * In-Process-Server (eigene Wegwerf-DB). Async/Promises.
 * Start: node --test tests/socket.test.js
 * ===================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: ClientIO } = require('socket.io-client');
const { startServer } = require('./helpers.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Verbindet einen Client (websocket, ohne Reconnect).
function connect(url, name) {
  const c = ClientIO(url, { transports: ['websocket'], reconnection: false, forceNew: true, timeout: 8000 });
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('Connect-Timeout ' + name)), 8000);
    c.on('connect', () => { clearTimeout(to); resolve(c); });
    c.on('connect_error', (e) => { clearTimeout(to); reject(new Error('connect_error ' + name + ': ' + e.message)); });
  });
}

// Wartet auf ein Event; registriert Handler einmalig.
function once(client, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { client.off(event); reject(new Error('Timeout auf ' + event)); }, timeoutMs);
    client.once(event, (d) => { clearTimeout(to); resolve(d); });
  });
}

// Erstellt ein Spiel via GM-Client und wartet auf gameCreated.
async function createGame(client, config) {
  const pGameCreated = once(client, 'gameCreated');
  client.emit('gm:create', { config });
  return await pGameCreated;
}

test('Echtzeit: Raum-Isolation + <500ms (A→B im Raum, C bleibt außen)', async () => {
  const srv = startServer();
  const url = 'http://localhost:' + srv.port;

  const gm = await connect(url, 'gm');
  const created = await createGame(gm, { teams: 2, capital: 1500000, diceConfig: '1w6', armistice: false });
  const gameId = created.gameId;

  // Tokens (Einladungscodes): Team0 (Redeemer), Team1 (Hammerhead)
  const inv0 = created.tokens.find((t) => t.ship === 'Redeemer').code;
  const inv1 = created.tokens.find((t) => t.ship === 'Hammerhead').code;

  // A, B -> Team0; D, E -> Team1. C gehört K E I N E M Spiel an (anderer Raum).
  const a = await connect(url, 'A');
  const b = await connect(url, 'B');
  const d = await connect(url, 'D');
  const e = await connect(url, 'E');
  const c = await connect(url, 'C-außen');

  const join = (client, code, playerName) => new Promise((resolve) => {
    const pj = once(client, 'joined');
    client.emit('team:join', { gameId, code, playerName });
    pj.then(resolve);
  });
  await join(a, inv0, 'A');
  await join(b, inv0, 'B');
  await join(d, inv1, 'D');
  await join(e, inv1, 'E');

  // A soll Teamleiter von Team0 werden (Mehrheit 2: unter A+B).
  // Server wählt Leiter per Mehrheit über votes; hier stimmen A+B beide für A.
  const voteFor = (client, playerId) => { client.emit('vote:leader', { gameId, playerId }); };
  voteFor(a, a.id);
  await sleep(30);
  voteFor(b, a.id);
  await sleep(50);
  // Team1 (D+E) braucht ebenfalls einen Leader (startGame-Pflicht, sonst NEED_LEADER)
  voteFor(d, d.id);
  await sleep(30);
  voteFor(e, d.id);
  await sleep(50);

  // State-Fang für A, B und C MUSS VOR gm:start registriert sein (Initial-State sonst verpasst)
  let stateA = null, stateB = null, cGotState = false;
  a.on('state', (st) => { stateA = st; });
  b.on('state', (st) => { stateB = st; });
  c.on('state', () => { cGotState = true; });

  // GM startet (jedes Team >=1 Mitglied).
  const gmStart = once(gm, 'state');
  gm.emit('gm:start', { gameId, gmCode: created.gmCode });
  await gmStart;

  // warten bis beide initialen States da sind
  const start = Date.now();
  while ((!stateA || !stateA.started) && Date.now() - start < 5000) await sleep(20);
  assert.ok(stateA && stateA.started, 'Spiel gestartet (A sieht started)');

  const logLenB = stateB ? (stateB.log || []).length : 0;
  // Aktiver (zufällig startender) Leader würfelt; B im selben Raum muss es sehen.
  const activeIdx = (stateA && stateA.game && stateA.game.activeIdx != null) ? stateA.game.activeIdx : 0;
  // Welcher Client ist Leader des aktiven Teams? A,B → Team0 (idx0); D,E → Team1 (idx1).
  const activeLeader = activeIdx === 1 ? d : a;
  const t0 = Date.now();
  activeLeader.emit('action:roll', { gameId });
  let seen = false;
  while (Date.now() - t0 < 500 && !seen) {
    await sleep(10);
    seen = !!(stateB && (stateB.log || []).length > logLenB);
  }
  const ms = Date.now() - t0;
  assert.ok(seen, `B sieht Roll des aktiven Leiters < 500ms (war ${ms}ms)`);
  assert.ok(ms < 500, `Upper bound eingehalten (${ms}ms)`);

  // C (anderes/unbekanntes Spiel) darf KEINE relevanten States aus gameId sehen.
  assert.strictEqual(cGotState, false, 'C im fremden Raum empfängt nicht den State von gameId');

  [gm, a, b, d, e, c].forEach((c_) => c_.disconnect());
  srv.stop();
});