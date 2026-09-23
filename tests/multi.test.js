/* =====================================================================
 * Stantonopoly V2 — multi.test.js
 * Akzeptanz 2: 2 parallele Spiele/Instanzen -> getrennte Zustände
 * und getrennte Räume. Aktions-Isolation zwischen Spiel A und Spiel B.
 * Start: node --test tests/multi.test.js
 * ===================================================================== */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { io: ClientIO } = require('socket.io-client');
const { startServer } = require('./helpers.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let srv = null, url = null;
const allClients = [];
function track(c) { allClients.push(c); return c; }
before(() => { srv = startServer(); url = 'http://localhost:' + srv.port; assert.ok(srv.ready); });
after(() => { allClients.forEach((c) => { try { c.disconnect(); } catch (e) {} }); if (srv) srv.stop(); });

function connect(name) {
  const c = ClientIO(url, { transports: ['websocket'], reconnection: false, forceNew: true, timeout: 8000 });
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('Connect-Timeout ' + name)), 8000);
    c.on('connect', () => { clearTimeout(to); resolve(c); });
    c.on('connect_error', (e) => { clearTimeout(to); reject(new Error('connect_error ' + name + ': ' + e.message)); });
  });
}

function once(client, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { client.off(event); reject(new Error('Timeout auf ' + event)); }, timeoutMs);
    client.once(event, (d) => { clearTimeout(to); resolve(d); });
  });
}

// Wartet auf einen state, der das Prädikat pred() erfüllt.
function waitState(client, pred, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { client.off('state', h); reject(new Error('waitState-Timeout')); }, timeoutMs);
    const h = (st) => { if (pred(st)) { clearTimeout(to); client.off('state', h); resolve(st); } };
    client.on('state', h);
  });
}

// Spinnt ein komplettes Spiel hoch und wartet, bis A den Start-State hat.
async function spinUpGame(prefix) {
  const gm = track(await connect(prefix + '-gm'));
  const p = new Promise((res) => gm.once('gameCreated', res));
  gm.emit('gm:create', { config: { teams: 2, capital: 1500000, diceConfig: '1w6', armistice: false } });
  const ev = await p;

  const inv0 = ev.tokens.find((t) => t.ship === 'Redeemer').code;
  const inv1 = ev.tokens.find((t) => t.ship === 'Hammerhead').code;

  const a = track(await connect(prefix + '-a'));
  const b = track(await connect(prefix + '-b'));
  const d = track(await connect(prefix + '-d'));
  const e = track(await connect(prefix + '-e'));

  const join = (cl, code, nm) => new Promise((res) => { const j = once(cl, 'joined'); cl.emit('team:join', { gameId: ev.gameId, code, playerName: nm }); j.then(res); });
  await Promise.all([
    join(a, inv0, 'A'), join(b, inv0, 'B'),
    join(d, inv1, 'D'), join(e, inv1, 'E')
  ]);

  a.emit('vote:leader', { gameId: ev.gameId, playerId: a.id });
  await sleep(30);
  b.emit('vote:leader', { gameId: ev.gameId, playerId: a.id });
  await sleep(60);
  // team1 (d/e) braucht ebenfalls einen Leader (startGame-Pflicht, sonst NEED_LEADER)
  d.emit('vote:leader', { gameId: ev.gameId, playerId: d.id });
  await sleep(30);
  e.emit('vote:leader', { gameId: ev.gameId, playerId: d.id });
  await sleep(60);

  // Handler VOR gm:start, damit die Baseline nicht verpasst wird
  let latestA = null, latestB = null;
  a.on('state', (st) => { latestA = st; });
  b.on('state', (st) => { latestB = st; });

  const startP = once(gm, 'state');
  gm.emit('gm:start', { gameId: ev.gameId, gmCode: ev.gmCode });
  await startP;

  const start = Date.now();
  while ((!latestA || !latestA.started) && Date.now() - start < 4000) await sleep(15);

  return { gameId: ev.gameId, gmCode: ev.gmCode, gm, a, b, d, e, latestA, latestB };
}

test('2 parallele Spiele: getrennte Zustände (Roll in G1 bewegt nur G1)', async () => {
  const G1 = await spinUpGame('g1');
  const G2 = await spinUpGame('g2');
  assert.notStrictEqual(G1.gameId, G2.gameId, 'verschiedene gameIds');

  const g1Pos0 = G1.latestA.game.players[0].pos;
  const g2Pos0 = G2.latestA.game.players[0].pos;

  // Aktiver (zufälliger) Startspieler — der zugehörige Leader würfelt.
  const activeIdx1 = G1.latestA.game.activeIdx != null ? G1.latestA.game.activeIdx : 0;
  const leader1 = activeIdx1 === 0 ? G1.a : activeIdx1 === 1 ? G1.d : null;
  assert.ok(leader1, 'G1 aktiver Leader gefunden');

  // G1 würfelt → bewegt sich der aktive Spieler
  const ap1 = G1.latestA.game.players[activeIdx1].pos;
  const g1Moved = waitState(G1.a, (st) => st.game.players[activeIdx1].pos !== ap1);
  // G2 darf sich NICHT bewegen (800ms Fenster ab Action)
  const g2MovedSeen = new Promise((resolve) => {
    const h = (st) => { if (st.game.players[0].pos !== g2Pos0) { G2.a.off('state', h); resolve(true); } };
    G2.a.on('state', h);
    setTimeout(() => { G2.a.off('state', h); resolve(false); }, 2000);
  });

  leader1.emit('action:roll', { gameId: G1.gameId });
  await g1Moved;

  const g2Moved = await g2MovedSeen;
  assert.strictEqual(g2Moved, false, 'G2-Team0 bleibt unbewegt durch G1-Aktion (Zustands-Isolation)');

  [G1.gm, G1.a, G1.b, G1.d, G1.e, G2.gm, G2.a].forEach(c => c.disconnect());
});

test('2 parallele Spiele: Räume getrennt (B in G2 bekommt NICHT G1-State)', async () => {
  const G1 = await spinUpGame('r1');
  const G2 = await spinUpGame('r2');
  assert.ok(G1.latestA && G2.latestA, 'Baselines da');
  const g2Pos0 = G2.latestA.game.players[0].pos;

  let g2SawMove = false;
  G2.b.on('state', (st) => { if (st.game.players[0].pos !== g2Pos0) g2SawMove = true; });

  G1.a.emit('action:roll', { gameId: G1.gameId });
  await sleep(800);

  assert.strictEqual(g2SawMove, false, 'G2-B sieht keine G1-Aktion (Raum-Isolation)');

  [G1.gm, G1.a, G2.gm, G2.a, G2.b].forEach(c => c.disconnect());
});