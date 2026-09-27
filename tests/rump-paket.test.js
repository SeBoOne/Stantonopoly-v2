/* =====================================================================
 * Stantonopoly V2 — Rumpf-Paket (Runde 4) E2E-Tests
 * Deckt die maschinenprüfbaren Akzeptanzkriterien des Rumpf-Paket-Briefs:
 *  - P1: Vote-System (Votes sammeln, erst bei startGame auflösen;
 *        Mehrheit / Gleichstand-zufällig / Enthaltung -> zufällig)
 *  - P4: Leader-Nachfolge bei game:leave (Leader verlässt -> neuer Leader;
 *        nur-1-Mitglied -> leaderId null)
 *  - P5: gm:setleader (GM setzt Leader in fremdem Team; ohne GM-Code abgelehnt)
 * Start: node --test tests/rump-paket.test.js
 * ===================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: ClientIO } = require('socket.io-client');
const { startServer } = require('./helpers.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(url, name) {
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

async function createGame(client, config) {
  const p = once(client, 'gameCreated');
  client.emit('gm:create', { config });
  return await p;
}

const join = (client, code, playerName) => new Promise((resolve) => {
  const pj = once(client, 'joined');
  client.emit('team:join', { gameId: client.gameId, code, playerName });
  pj.then(resolve);
});

/* ---------- P1: Vote-Auflösung bei startGame ---------- */

// Legt ein Spiel mit 2 Teams an; Team0 wird mit den gegebenen Stimmen bestückt.
// Gibt {srv, gm, a, b, c, d, gameId, tokens, team0} zurück (a,b,c in Team0, d in Team1).
async function twoTeamGame() {
  const srv = startServer();
  const url = 'http://localhost:' + srv.port;
  const gm = await connect(url, 'gm-rp');
  gm.url = url;
  const ev = await createGame(gm, { teams: 2, capital: 1500000, diceConfig: '1w6', armistice: false });
  gm.gameId = ev.gameId;
  gm.gmCode = ev.gmCode;
  const inv0 = ev.tokens.find((t) => t.ship === 'Redeemer').code;
  const inv1 = ev.tokens.find((t) => t.ship === 'Hammerhead').code;
  const a = await connect(url, 'A-rp'); a.gameId = ev.gameId;
  const b = await connect(url, 'B-rp'); b.gameId = ev.gameId;
  const c = await connect(url, 'C-rp'); c.gameId = ev.gameId;
  const d = await connect(url, 'D-rp'); d.gameId = ev.gameId;
  await join(a, inv0, 'A');
  await join(b, inv0, 'B');
  await join(c, inv0, 'C');
  await join(d, inv1, 'D');
  return { srv, url, gm, a, b, c, d, gameId: ev.gameId, inv1, team0: inv0, team0Id: ev.tokens[0].teamId, team1Id: ev.tokens[1].teamId };
}

// startet das Spiel und liefert die view (Leader je Team)
async function doStart(gm) {
  const p = once(gm, 'state');
  gm.emit('gm:start', { gameId: gm.gameId, gmCode: gm.gmCode });
  await p;
  await sleep(120);
}

// Leader des Teams per rooms.viewFor
function leaderOf(srv, gameId, teamId) {
  const view = srv.rooms.viewFor(gameId);
  const t = view.teams.find((x) => x.teamId === teamId);
  return t ? t.leaderId : null;
}

test('P1a: Vote sammelt NUR, Leader wird erst bei startGame gesetzt', async () => {
  const { srv, gm, a, b, c, d, gameId, team0Id, team1Id } = await twoTeamGame();
  // a+b stimmen für a, c enthält sich
  a.emit('vote:leader', { gameId, playerId: a.id });
  await sleep(30);
  b.emit('vote:leader', { gameId, playerId: a.id });
  await sleep(60);
  d.emit('vote:leader', { gameId, playerId: d.id });
  await sleep(60);
  // Vor startGame: noch KEIN Leader (Vote-Collection)
  assert.strictEqual(leaderOf(srv, gameId, team0Id), null, 'Team0 vor startGame: kein Leader');
  assert.strictEqual(leaderOf(srv, gameId, team1Id), null, 'Team1 vor startGame: kein Leader');
  // startGame löst auf: a gewinnt (2 Stimmen, Enthaltung von c zählt nicht)
  await doStart(gm);
  assert.strictEqual(leaderOf(srv, gameId, team0Id), a.id, 'Mehrheit: A wird Leader (2 Stimmen, 1 Enthaltung)');
  assert.strictEqual(leaderOf(srv, gameId, team1Id), d.id, 'Einstimmig: D wird Leader');
  [gm, a, b, c, d].forEach((x) => x.disconnect());
});

test('P1b: Gleichstand -> zufällig unter den Top-Stimmigen (Verteilung über >1)', async () => {
  const winners = new Set();
  // Mehrere Spiele, Team0: A stimmt A, B stimmt B (Gleichstand 1:1), C enthält sich
  for (let i = 0; i < 12; i++) {
    const { srv, gm, a, b, c, d, gameId, team0Id } = await twoTeamGame();
    a.emit('vote:leader', { gameId, playerId: a.id });
    await sleep(25);
    b.emit('vote:leader', { gameId, playerId: b.id });
    await sleep(25);
    d.emit('vote:leader', { gameId, playerId: d.id });
    await sleep(40);
    await doStart(gm);
    const w = leaderOf(srv, gameId, team0Id);
    assert.ok(w === a.id || w === b.id, 'Gleichstand: Gewinner ist A oder B (' + w + ')');
    winners.add(w);
    [gm, a, b, c, d].forEach((x) => x.disconnect());
  }
  assert.ok(winners.size > 1, 'Zufalls-Verteilung über beide Kandidaten (hatte: ' + [...winners].join(',') + ')');
});

test('P1c: Keine Stimme -> zufällig aus allen Teammitgliedern', async () => {
  const { srv, gm, a, b, c, d, gameId, team0Id } = await twoTeamGame();
  // NIEMAND stimmt in Team0 ab; D stimmt (Team1 braucht keinen Vote, nur Resolution)
  await doStart(gm);
  const w = leaderOf(srv, gameId, team0Id);
  assert.ok([a.id, b.id, c.id].includes(w), 'Ohne Stimmen: zufällig aus allen Teammitgliedern (' + w + ')');
  [gm, a, b, c, d].forEach((x) => x.disconnect());
});

/* ---------- P4: Leader-Nachfolge bei game:leave ---------- */

test('P4: Leader verlässt -> anderes Mitglied wird neuer Leader', async () => {
  const srv = startServer();
  const url = 'http://localhost:' + srv.port;
  const gm = await connect(url, 'gm-p4');
  const ev = await createGame(gm, { teams: 2, capital: 1500000, diceConfig: '1w6', armistice: false });
  const inv0 = ev.tokens.find((t) => t.ship === 'Redeemer').code;
  const inv1 = ev.tokens.find((t) => t.ship === 'Hammerhead').code;
  const a = await connect(url, 'A-p4'); a.gameId = ev.gameId;
  const b = await connect(url, 'B-p4'); b.gameId = ev.gameId;
  const d = await connect(url, 'D-p4'); d.gameId = ev.gameId;
  await join(a, inv0, 'A');
  await join(b, inv0, 'B');
  await join(d, inv1, 'D');
  // a wird Leader (Self-Vote), d Leader (self)
  a.emit('vote:leader', { gameId: ev.gameId, playerId: a.id });
  await sleep(30);
  d.emit('vote:leader', { gameId: ev.gameId, playerId: d.id });
  await sleep(60);
  const gmStartP = once(gm, 'state');
  gm.emit('gm:start', { gameId: ev.gameId, gmCode: ev.gmCode });
  await gmStartP; await sleep(120);
  const team0Id = ev.tokens[0].teamId;
  assert.strictEqual(leaderOf(srv, ev.gameId, team0Id), a.id, 'A ist Leader vor dem Verlassen');
  // A verlässt das Spiel -> B muss neuer Leader werden
  const leftP = once(a, 'left');
  a.emit('game:leave', { gameId: ev.gameId });
  await leftP; await sleep(100);
  assert.strictEqual(leaderOf(srv, ev.gameId, team0Id), b.id, 'B wurde neuer Leiter nachdem A ging');
  [gm, a, b, d].forEach((x) => x.disconnect());
});

test('P4b: Nur-1-Mitglied-Team: Leader verlässt -> leaderId null', async () => {
  const srv = startServer();
  const url = 'http://localhost:' + srv.port;
  const gm = await connect(url, 'gm-p4b');
  const ev = await createGame(gm, { teams: 2, capital: 1500000, diceConfig: '1w6', armistice: false });
  const inv0 = ev.tokens.find((t) => t.ship === 'Redeemer').code;
  const inv1 = ev.tokens.find((t) => t.ship === 'Hammerhead').code;
  // Team0: NUR a. Team1: d.
  const a = await connect(url, 'A-p4b'); a.gameId = ev.gameId;
  const d = await connect(url, 'D-p4b'); d.gameId = ev.gameId;
  await join(a, inv0, 'A'); await join(d, inv1, 'D');
  a.emit('vote:leader', { gameId: ev.gameId, playerId: a.id });
  await sleep(30); d.emit('vote:leader', { gameId: ev.gameId, playerId: d.id }); await sleep(60);
  const gmStartP = once(gm, 'state');
  gm.emit('gm:start', { gameId: ev.gameId, gmCode: ev.gmCode });
  await gmStartP; await sleep(120);
  const team0Id = ev.tokens[0].teamId;
  assert.strictEqual(leaderOf(srv, ev.gameId, team0Id), a.id, 'A ist Leader (Einzel-Team)');
  // (2m P7) A ist der LETZTE Spieler seines Teams in einem laufenden Spiel:
  // der Server fragt zuerst nach Bestätigung (leave:confirm), erst nach
  // Bestätigung (confirm:true) folgt Forfeit + leave.
  const confirmP = once(a, 'leave:confirm');
  a.emit('game:leave', { gameId: ev.gameId });
  await confirmP; await sleep(60);
  const leftP = once(a, 'left');
  a.emit('game:leave', { gameId: ev.gameId, confirm: true });
  await leftP; await sleep(100);
  assert.strictEqual(leaderOf(srv, ev.gameId, team0Id), null, 'Nur-Leader-Team: leaderId null nach Verlassen');
  [gm, a, d].forEach((x) => x.disconnect());
});

/* ---------- P5: gm:setleader ---------- */

test('P5: GM setzt Leader in fremdem Team (mit GM-Code) / abgelehnt ohne', async () => {
  const srv = startServer();
  const url = 'http://localhost:' + srv.port;
  const gm = await connect(url, 'gm-p5');
  const ev = await createGame(gm, { teams: 2, capital: 1500000, diceConfig: '1w6', armistice: false });
  const inv0 = ev.tokens.find((t) => t.ship === 'Redeemer').code;
  const inv1 = ev.tokens.find((t) => t.ship === 'Hammerhead').code;
  const a = await connect(url, 'A-p5'); a.gameId = ev.gameId;
  const b = await connect(url, 'B-p5'); b.gameId = ev.gameId;
  const d = await connect(url, 'D-p5'); d.gameId = ev.gameId;
  await join(a, inv0, 'A'); await join(b, inv0, 'B'); await join(d, inv1, 'D');
  const team1Id = ev.tokens[1].teamId;

  // Ohne GM-Code: abgelehnt
  const bad = once(gm, 'error');
  gm.emit('gm:setleader', { gameId: ev.gameId, gmCode: 'FALSCH', teamId: team1Id, playerId: d.id });
  const err = await bad;
  assert.strictEqual(err.code, 'FORBIDDEN', 'ohne korrekten GM-Code abgelehnt');

  // Mit korrektem GM-Code: akzeptiert (setzt d in Team1)
  const okP = once(gm, 'state');
  gm.emit('gm:setleader', { gameId: ev.gameId, gmCode: ev.gmCode, teamId: team1Id, playerId: d.id });
  await okP; await sleep(120);
  assert.strictEqual(leaderOf(srv, ev.gameId, team1Id), d.id, 'GM setzt D als Leader in Team1');

  // Falsches Mitglied (Player gehört nicht zu Team1): abgelehnt
  const bad2 = once(gm, 'error');
  gm.emit('gm:setleader', { gameId: ev.gameId, gmCode: ev.gmCode, teamId: team1Id, playerId: a.id });
  const err2 = await bad2;
  assert.strictEqual(err2.code, 'BAD_CANDIDATE', 'Mitglied nicht im Team -> abgelehnt');

    [gm, a, b, d].forEach((x) => x.disconnect());
    // Server am Datei-Ende stoppen, damit der Test-Prozess beendet (helpers.js cached EINEN Serverer).
    srv.stop();
  });
