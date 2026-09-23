/* =====================================================================
 * Stantonopoly V2 — auth.test.js
 * Akzeptanz 4 + 5: server-seitige Rechte-Checks.
 *  - Teamleiter wird per Stimm-Mehrheit gewählt; Mitglied (kein Leiter) darf
 *    KEINE Aktion ausführen (nur lesen).
 *  - GM-Code-Schutz: ohne korrekten GM-Code kein Start / keine Änderung.
 *  - Einladungscode öffnet NUR das eigene Spiel (fremder Code -> abgelehnt).
 * Start: node --test tests/auth.test.js
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

function waitError(client, timeoutMs = 6000, pred = () => true) {
  return new Promise((resolve) => {
    const h = (e) => { if (pred(e)) { client.off('error', h); resolve(e); } };
    client.on('error', h);
    setTimeout(() => { client.off('error', h); resolve(null); }, timeoutMs);
  });
}

function waitState(client, pred, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const h = (st) => { if (pred(st)) { client.off('state', h); resolve(st); } };
    client.on('state', h);
    setTimeout(() => { client.off('state', h); resolve(null); }, timeoutMs);
  });
}

async function createGame(config) {
  const gm = track(await connect('gm'));
  const p = new Promise((res) => gm.once('gameCreated', res));
  gm.emit('gm:create', { config: config || { teams: 2, capital: 1500000, diceConfig: '1w6', armistice: false } });
  const ev = await p;
  return { gm, ev };
}

async function join(gameId, code, name) {
  const cl = track(await connect(name));
  const jp = once(cl, 'joined');
  cl.emit('team:join', { gameId, code, playerName: name });
  await jp;
  return cl;
}

// ---------- Akzeptanz 5: GM-Code-Schutz ----------

test('GM-Code-Schutz: falscher GM-Code -> kein Start (FORBIDDEN)', async () => {
  const { gm, ev } = await createGame();
  const errP = waitError(gm, 6000, (e) => true);
  gm.emit('gm:start', { gameId: ev.gameId, gmCode: 'FALSCH' });
  const err = await errP;
  assert.ok(err && (err.code === 'FORBIDDEN' || err.code === 'BAD_CODE'), 'Error erwartet, bekam: ' + JSON.stringify(err));
  gm.disconnect();
});

test('GM-Code-Schutz: ohne GM-Code kein Deploy (FORBIDDEN)', async () => {
  const { gm, ev } = await createGame();
  const errP = waitError(gm, 6000, (e) => true);
  gm.emit('gm:deploy', { gameId: ev.gameId, gmCode: 'X1234', configPatch: { diceConfig: { kind: '2w6' } } });
  const err = await errP;
  assert.ok(err && (err.code === 'FORBIDDEN' || err.code === 'BAD_CODE'), 'Error erwartet, bekam: ' + JSON.stringify(err));
  gm.disconnect();
});

// ---------- Akzeptanz 5: Einladungscode nur eigenes Spiel ----------

test('Einladungscode: fremder Code (aus anderem Spiel) -> abgelehnt', async () => {
  const { gm: gm1, ev: ev1 } = await createGame();
  const { ev: ev2 } = await createGame();
  const inv0 = ev1.tokens.find((t) => t.ship === 'Redeemer').code;
  // Player versucht mit Code von ev2 in ev1 zu joinen
  const foreignCode = ev2.tokens[0].code;
  const cl = track(await connect('atomic'));
  const errP = waitError(cl, 6000, (e) => true);
  cl.emit('team:join', { gameId: ev1.gameId, code: foreignCode, playerName: 'Eindringling' });
  const err = await errP;
  assert.ok(err && err.code === 'BAD_CODE', 'fremder Code abgelehnt, bekam: ' + JSON.stringify(err));
  // Korrekter Code klappt
  const jp = once(cl, 'joined');
  cl.emit('team:join', { gameId: ev1.gameId, code: inv0, playerName: 'Eindringling' });
  const joined = await jp;
  assert.ok(joined && joined.teamId === ev1.tokens[0].teamId, 'eigener Einladungscode öffnet das eigene Team');
  gm1.disconnect();
});

// ---------- Akzeptanz 4: Teamleiter-Mehrheit + Mitglied-nur-lesen ----------

test('Teamleiter per Mehrheit gewählt; Mitglied darf nicht handeln', async () => {
  const { gm, ev } = await createGame();
  const inv0 = ev.tokens.find((t) => t.ship === 'Redeemer').code;
  const inv1 = ev.tokens.find((t) => t.ship === 'Hammerhead').code;

  // Team0: A + B. Team1: D + E.
  const a = await join(ev.gameId, inv0, 'A');
  const b = await join(ev.gameId, inv0, 'B');
  const d = await join(ev.gameId, inv1, 'D');
  const e = await join(ev.gameId, inv1, 'E');

  // Mehrheit in Team0: A und B stimmen beide für A -> A wird Leiter
  a.emit('vote:leader', { gameId: ev.gameId, playerId: a.id });
  await sleep(30);
  b.emit('vote:leader', { gameId: ev.gameId, playerId: a.id });
  await sleep(60);
  // Mehrheit in Team1: D + E -> D Leiter
  d.emit('vote:leader', { gameId: ev.gameId, playerId: d.id });
  await sleep(30);
  e.emit('vote:leader', { gameId: ev.gameId, playerId: d.id });
  await sleep(60);

  // Leiter wird NICHT sofort gesetzt (Votes werden gesammelt, erst startGame löst auf)
  let view = srv.rooms.viewFor(ev.gameId);
  const t0pre = view.teams.find((t) => t.teamId === ev.tokens[0].teamId);
  const t1pre = view.teams.find((t) => t.teamId === ev.tokens[1].teamId);
  assert.strictEqual(t0pre.leaderId, null, 'vor startGame ist Team0-Leader noch nicht gesetzt (Vote-Collection)');
  assert.strictEqual(t1pre.leaderId, null, 'vor startGame ist Team1-Leader noch nicht gesetzt (Vote-Collection)');

  // GM startet (jedes Team >=1 Mitglied). Event-Listener VOR emit registrieren.
  const gmStartP = once(gm, 'state');
  gm.emit('gm:start', { gameId: ev.gameId, gmCode: ev.gmCode });
  const startState = await gmStartP;
  await sleep(150);

  // NACH startGame ist der Leader per Vote aufgelöst: A (Team0, 2 Stimmen), D (Team1, 2 Stimmen)
  view = srv.rooms.viewFor(ev.gameId);
  const t0 = view.teams.find((t) => t.teamId === ev.tokens[0].teamId);
  const t1 = view.teams.find((t) => t.teamId === ev.tokens[1].teamId);
  assert.strictEqual(t0.leaderId, a.id, 'A == Leiter Team0 (nach startGame)');
  assert.strictEqual(t1.leaderId, d.id, 'D == Leiter Team1 (nach startGame)');

  // B ist MITGLIED (kein Leiter) -> action:roll muss abgelehnt werden
  const errP = waitError(b, 6000, (e) => true);
  b.emit('action:roll', { gameId: ev.gameId });
  const err = await errP;
  assert.ok(err && (err.code === 'NOT_LEADER' || err.code === 'NOT_YOUR_TURN'),
    'Mitglied blockiert, bekam: ' + JSON.stringify(err));

  // Teamleiter des (zufällig) startenden Teams darf würfeln. activeIdx ist zufällig
  // und steht bereits im GM-Start-State.
  const activeIdx = (startState && startState.game && startState.game.activeIdx != null) ? startState.game.activeIdx : 0;
  const activeLeader = activeIdx === 0 ? a : activeIdx === 1 ? d : null;
  assert.ok(activeLeader, 'aktiver Leiter gefunden');
  const waitActive = waitState(activeLeader, (st) => st && st.game && st.game.players[activeIdx].pos !== 0, 4000);
  activeLeader.emit('action:roll', { gameId: ev.gameId });
  const st = await waitActive;
  assert.ok(st, 'Teamleiter des aktiven Teams kann handeln (Roll ausgeführt)');
  gm.disconnect();
});