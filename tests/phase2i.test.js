/* =====================================================================
 * Stantonopoly V2 — phase2i.test.js  (Phase 2i, Sichtcheck-Block 3)
 * Neue Tests für die Punkte 1, 2, 8 (+ state-driven Basis für 9/11):
 *  - 1  GM-Gate-Hardblock: GM eines laufenden Spiels kann sich NICHT selbst
 *       entfernen (Server reject GM_ACTIVE, kein 'left'). In der Lobby (nicht
 *       gestartet) und für Teammitglieder bleibt Verlassen erlaubt.
 *  - 2  Auto-Austritt bei Wechsel: Wer per Code einem anderen Spiel beitritt,
 *       wird automatisch aus der alten Membership entfernt (Leader-Nachfolge,
 *       Votes, Room-Leave), Broadcast an das alte Spiel.
 *  - 8  Disconnect-Timeout: Teilnehmer wird nach konfigurierbarer Inaktivität
 *       automatisch entfernt (Broadcast + Log); Rejoin setzt den Timer zurück;
 *       der GM ist vom Auto-Remove ausgenommen.
 *  - 9/11 state-driven Basis: nach Kauf/Handel trägt der State properties bzw.
 *       offers/auction — daraus leiten board.js (Preis ausblenden) und das
 *       Trade-Panel (Highlight) ab. (DOM-Rendering wird via CDP-Screens verifiziert.)
 * ===================================================================== */
'use strict';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { io: ClientIO } = require('socket.io-client');
const { startServer, PROJ } = require('./helpers.js');

// Disconnect-Timeout im Test verkürzbar konfigurieren (Punkt 8) — VOR startServer.
if (!process.env.STANTONOPOLY_DISCONNECT_TIMEOUT_MS) {
  process.env.STANTONOPOLY_DISCONNECT_TIMEOUT_MS = '1200';
}
const TIMEOUT = Number(process.env.STANTONOPOLY_DISCONNECT_TIMEOUT_MS);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// db.js NUR lazy laden (NACH startServer, das STANTONOPOLY_DB auf eine Wegwerf-DB
// setzt). require() ist gecacht — der erste Ladezeitpunkt bestimmt den DB-Pfad.
const dbm = () => require(path.join(PROJ, 'server', 'db.js'));

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

const join = (client, code, playerName) => new Promise((resolve, reject) => {
  const pj = once(client, 'joined').then(resolve, reject);
  client.emit('team:join', { gameId: client.gameId || '', code, playerName });
});

function leaderOf(srv, gameId, teamId) {
  const view = srv.rooms.viewFor(gameId);
  if (!view) return '?';
  const t = view.teams.find((x) => x.teamId === teamId);
  return t ? t.leaderId : null;
}
function playerIn(srv, gameId, sockId) {
  const view = srv.rooms.viewFor(gameId);
  if (!view) return false;
  return view.teams.some((t) => (t.players || []).some((p) => String(p.playerId) === String(sockId) || String(p.id) === String(sockId)));
}

/* ---------- Punkt 1: GM-Gate-Hardblock ---------- */
test('Punkt 1: GM eines laufenden Spiels kann das Spiel NICHT verlassen (GM_ACTIVE)', async () => {
  const srv = startServer();
  const url = 'http://localhost:' + srv.port;
  const gm = await connect(url, 'gm1');
  const ev = await createGame(gm, { teams: 2, capital: 1500000, diceConfig: '1w6', armistice: false });
  const gameId = ev.gameId;
  const inv0 = ev.tokens.find((t) => t.ship === 'Redeemer').code;
  const inv1 = ev.tokens.find((t) => t.ship === 'Hammerhead').code;

  const a = await connect(url, 'a1'); a.gameId = gameId;
  const b = await connect(url, 'b1'); b.gameId = gameId;
  const d = await connect(url, 'd1'); d.gameId = gameId;
  await join(a, inv0, 'A');
  await join(b, inv0, 'B');
  await join(d, inv1, 'D');
  a.emit('vote:leader', { gameId, playerId: a.id }); await sleep(30);
  b.emit('vote:leader', { gameId, playerId: a.id }); await sleep(40);
  d.emit('vote:leader', { gameId, playerId: d.id }); await sleep(40);

  gm.emit('gm:start', { gameId, gmCode: ev.gmCode });
  await once(gm, 'state'); await sleep(60);

  // GM versucht zu verlassen → Server lehnt HART ab (GM_ACTIVE), kein 'left'.
  let gmLeft = false;
  gm.once('left', () => { gmLeft = true; });
  const errP = once(gm, 'error');
  gm.emit('game:leave', { gameId });
  const err = await errP;
  await sleep(80);
  assert.strictEqual(err.code, 'GM_ACTIVE', 'Server reject: GM_ACTIVE');
  assert.strictEqual(gmLeft, false, 'GM bekommt KEIN left-Event');

  // Teammitglied (Spieler) darf weiterhin verlassen. d ist der EINZIGE Hammerhead-Spieler,
  // daher greift P7 (Letzter-Spieler-Regel): Server fragt erst 'leave:confirm', erst nach
  // Bestätigung wird verlassen (Team gibt auf). (2i#1 Kern GM_ACTIVE bleibt unangetastet.)
  const dConfirm = once(d, 'leave:confirm');
  d.emit('game:leave', { gameId });
  await dConfirm;
  const dLeft = once(d, 'left');
  d.emit('game:leave', { gameId, confirm: true });
  await dLeft;

  [gm, a, b, d].forEach((c) => c.disconnect());
  srv.stop();
});

test('Punkt 1b: GM kann ein noch NICHT gestartetes Spiel (Lobby) verlassen', async () => {
  const srv = startServer();
  const url = 'http://localhost:' + srv.port;
  const gm = await connect(url, 'gm1b');
  const ev = await createGame(gm, { teams: 2, capital: 1000000, diceConfig: '1w6', armistice: false });
  const leftP = once(gm, 'left');
  gm.emit('game:leave', { gameId: ev.gameId });
  const left = await leftP;
  assert.ok(left && left.ok, 'GM kann in der Lobby verlassen');
  gm.disconnect();
  srv.stop();
});

/* ---------- Punkt 2: Auto-Austritt bei Spielwechsel ---------- */
test('Punkt 2: Bewegen in ein anderes Spiel entfernt die alte Membership (Broadcast + Leader-Nachfolge)', async () => {
  const srv = startServer();
  const url = 'http://localhost:' + srv.port;

  // Spiel A
  const gmA = await connect(url, 'gmA2');
  const evA = await createGame(gmA, { teams: 2, capital: 1500000, diceConfig: '1w6', armistice: false });
  const invA0 = evA.tokens.find((t) => t.ship === 'Redeemer').code;
  const invA1 = evA.tokens.find((t) => t.ship === 'Hammerhead').code;
  const a = await connect(url, 'a2'); a.gameId = evA.gameId;
  const b = await connect(url, 'b2'); b.gameId = evA.gameId;
  const d = await connect(url, 'd2'); d.gameId = evA.gameId;
  await join(a, invA0, 'A');
  await join(b, invA0, 'B');
  await join(d, invA1, 'D');
  a.emit('vote:leader', { gameId: evA.gameId, playerId: a.id }); await sleep(30);
  b.emit('vote:leader', { gameId: evA.gameId, playerId: a.id }); await sleep(40);
  d.emit('vote:leader', { gameId: evA.gameId, playerId: d.id }); await sleep(40);
  gmA.emit('gm:start', { gameId: evA.gameId, gmCode: evA.gmCode });
  await once(gmA, 'state'); await sleep(80);
  const teamA0 = evA.tokens[0].teamId;
  assert.strictEqual(leaderOf(srv, evA.gameId, teamA0), a.id, 'A ist Leader in Spiel A');

  // Spiel B (zweite Instanz, gleicher Server)
  const gmB = await connect(url, 'gmB2');
  const evB = await createGame(gmB, { teams: 2, capital: 1500000, diceConfig: '1w6', armistice: false });
  const invB0 = evB.tokens.find((t) => t.ship === 'Redeemer').code;

  // A (gleicher Socket) tritt Spiel B bei → wird automatisch aus A entfernt.
  const joinedB = once(a, 'joined');
  a.gameId = evB.gameId;
  a.emit('team:join', { gameId: evB.gameId, code: invB0, playerName: 'A' });
  await joinedB;
  await sleep(200);

  // A ist nicht mehr in Spiel A, Leadership ging an B.
  assert.strictEqual(playerIn(srv, evA.gameId, a.id), false, 'A aus Spiel A entfernt');
  assert.strictEqual(leaderOf(srv, evA.gameId, teamA0), b.id, 'Leader-Nachfolge in Spiel A: B wird neuer Leader');
  // A ist jetzt in Spiel B drin.
  assert.strictEqual(playerIn(srv, evB.gameId, a.id), true, 'A in Spiel B eingetreten');

  [gmA, b, d, gmB].forEach((c) => c.disconnect());
  a.disconnect();
  srv.stop();
});

/* ---------- Punkt 8: Disconnect-Timeout ---------- */
test('Punkt 8a: Teilnehmer wird nach Inaktivität (Disconnect) automatisch entfernt', async () => {
  const srv = startServer();
  const url = 'http://localhost:' + srv.port;
  const gm = await connect(url, 'gm8a');
  const ev = await createGame(gm, { teams: 2, capital: 1500000, diceConfig: '1w6', armistice: false });
  const gameId = ev.gameId;
  const inv0 = ev.tokens.find((t) => t.ship === 'Redeemer').code;
  const inv1 = ev.tokens.find((t) => t.ship === 'Hammerhead').code;
  const a = await connect(url, 'a8a'); a.gameId = gameId;
  const b = await connect(url, 'b8a'); b.gameId = gameId;
  const d = await connect(url, 'd8a'); d.gameId = gameId;
  await join(a, inv0, 'A');
  await join(b, inv0, 'B');
  await join(d, inv1, 'D');
  a.emit('vote:leader', { gameId, playerId: a.id }); await sleep(30);
  b.emit('vote:leader', { gameId, playerId: a.id }); await sleep(40);
  d.emit('vote:leader', { gameId, playerId: d.id }); await sleep(40);
  gm.emit('gm:start', { gameId, gmCode: ev.gmCode });
  await once(gm, 'state'); await sleep(80);
  const team0Id = ev.tokens[0].teamId;

  assert.strictEqual(playerIn(srv, gameId, a.id), true, 'A ist vor Disconnect im Spiel');
  // Log-Handler auf dem GM: der Auto-Remove-Broadcast soll einen Log-Eintrag tragen.
  let sawRemoveLog = false;
  gm.on('state', (st) => {
    if (st.gameId === gameId && Array.isArray(st.log) && st.log.some((l) => typeof l === 'string' && l.indexOf('nach Inaktivität') !== -1)) sawRemoveLog = true;
  });

  a.disconnect();                      // Seite verlassen → Timer startet
  await sleep(TIMEOUT + 700);          // länger als der (verkürzte) Timeout

  assert.strictEqual(playerIn(srv, gameId, a.id), false, 'A nach Timeout entfernt');
  assert.strictEqual(leaderOf(srv, gameId, team0Id), b.id, 'Leader-Nachfolge: B nach A-Disconnect');
  assert.strictEqual(sawRemoveLog, true, 'Broadcast mit Log-Eintrag über die Entfernung');

  // Verbleibende Spieler (B, D) sind weiter aktiv.
  assert.strictEqual(playerIn(srv, gameId, b.id), true, 'B bleibt im Spiel');
  assert.strictEqual(playerIn(srv, gameId, d.id), true, 'D bleibt im Spiel');

  [gm, b, d].forEach((c) => c.disconnect());
  srv.stop();
});

test('Punkt 8b: Rejoin vor Ablauf des Timeouts setzt den Timer zurück (kein Remove)', async () => {
  const srv = startServer();
  const url = 'http://localhost:' + srv.port;
  const gm = await connect(url, 'gm8b');
  const ev = await createGame(gm, { teams: 2, capital: 1500000, diceConfig: '1w6', armistice: false });
  const gameId = ev.gameId;
  const inv0 = ev.tokens.find((t) => t.ship === 'Redeemer').code;
  const inv1 = ev.tokens.find((t) => t.ship === 'Hammerhead').code;
  const aSrc = await connect(url, 'a8b'); aSrc.gameId = gameId;
  const d = await connect(url, 'd8b'); d.gameId = gameId;
  const joinedP = once(aSrc, 'joined');
  aSrc.emit('team:join', { gameId, code: inv0, playerName: 'A' });
  const joined = await joinedP;
  const token = joined.token;
  await join(d, inv1, 'D');
  aSrc.emit('vote:leader', { gameId, playerId: aSrc.id }); await sleep(30);
  d.emit('vote:leader', { gameId, playerId: d.id }); await sleep(40);
  gm.emit('gm:start', { gameId, gmCode: ev.gmCode });
  await once(gm, 'state'); await sleep(80);

  const oldSock = aSrc.id;
  aSrc.disconnect();  // Disconnect → Timer startet

  // Schnell mit NEUEM Socket per Token rejoinen (vor Ablauf des Timeouts).
  const aNew = await connect(url, 'a8b-new');
  const rejoinP = once(aNew, 'joined');
  aNew.emit('team:rejoin', { gameId, token });
  await rejoinP;
  await sleep(TIMEOUT + 700);  // länger als Timeout — darf trotzdem NICHT entfernt werden

  assert.strictEqual(playerIn(srv, gameId, aNew.id), true, 'A nach Rejoin nicht auto-entfernt (Timer zurückgesetzt)');
  assert.strictEqual(playerIn(srv, gameId, oldSock), false, 'alte Socket-ID ist weg (Remap auf neue)');

  [gm, d, aNew].forEach((c) => c.disconnect());
  srv.stop();
});

test('Punkt 8c: GM wird bei Disconnect NICHT automatisch entfernt', async () => {
  const srv = startServer();
  const url = 'http://localhost:' + srv.port;
  const gm = await connect(url, 'gm8c');
  const ev = await createGame(gm, { teams: 2, capital: 1500000, diceConfig: '1w6', armistice: false });
  const gameId = ev.gameId;
  const inv1 = ev.tokens.find((t) => t.ship === 'Hammerhead').code;
  const d = await connect(url, 'd8c'); d.gameId = gameId;
  await join(d, inv1, 'D');
  d.emit('vote:leader', { gameId, playerId: d.id }); await sleep(40);

  // GM tritt per Code mitspielend in das eigene Spiel ein (Team0) → ist Spieler UND GM.
  const gmJoin = once(gm, 'joined');
  gm.emit('team:join', { gameId, code: ev.tokens.find((t) => t.ship === 'Redeemer').code, playerName: 'GM' });
  await gmJoin;
  gm.emit('gm:start', { gameId, gmCode: ev.gmCode });
  await once(gm, 'state'); await sleep(80);
  const gmSock = gm.id;

  assert.strictEqual(playerIn(srv, gameId, gmSock), true, 'GM ist als Spieler im Spiel');
  gm.disconnect();                       // Seite zu — Timer würde starten, aber GM ist ausgenommen
  await sleep(TIMEOUT + 700);

  assert.strictEqual(playerIn(srv, gameId, gmSock), true, 'GM wird trotz Timeout NICHT entfernt (Punkt 1)');

  d.disconnect();
  srv.stop();
});

/* ---------- Punkte 9/11: state-driven Basis (was der Client rendert) ---------- */
function grantOwnership(gameId, playerIdx, fieldIdx) {
  const d = dbm();
  const row = d.getGame(gameId);
  const g = JSON.parse(row.state);
  g.players[playerIdx].properties[String(fieldIdx)] = { level: 'ALLEIN' };
  d.updateState(gameId, { state: JSON.stringify(g) });
}

test('Punkte 9/11: State trägt Besitz (Preis ausblenden) und offers/auction (Trade-Highlight)', async () => {
  const srv = startServer();
  const url = 'http://localhost:' + srv.port;
  const gm = await connect(url, 'gm9');
  const ev = await createGame(gm, { teams: 2, capital: 2000000, diceConfig: '1w6', armistice: false });
  const gameId = ev.gameId;
  const inv0 = ev.tokens.find((t) => t.ship === 'Redeemer').code;
  const inv1 = ev.tokens.find((t) => t.ship === 'Hammerhead').code;
  const a = await connect(url, 'a9'); a.gameId = gameId;
  const d = await connect(url, 'd9'); d.gameId = gameId;
  await join(a, inv0, 'A');
  await join(d, inv1, 'D');
  a.emit('vote:leader', { gameId, playerId: a.id }); await sleep(30);
  d.emit('vote:leader', { gameId, playerId: d.id }); await sleep(40);
  gm.emit('gm:start', { gameId, gmCode: ev.gmCode });
  await once(gm, 'state'); await sleep(80);

  // Punkt 9: Besitz setzen → State.properties enthält das Feld (Client blendet
  // den Preis über .field.is-owned .f-price aus; nach Bankverkauf wäre es wieder da).
  // Punkt 11: AKTIVES Team macht Kaufangebot für ein Feld des ANDEREN Teams
  // → offers im State. (Zug-Timer kann activeIdx verschieben — dynamisch ermitteln.)
  const activeIdx0 = Number(srv.rooms.viewFor(gameId).game.activeIdx) || 0;
  const from = activeIdx0 === 0 ? a : d;
  const to = activeIdx0 === 0 ? d : a;
  const targetTeam = activeIdx0 === 0 ? 1 : 0;
  grantOwnership(gameId, targetTeam, 1);   // Ziel-Team besitzt Feld 1
  let view = srv.rooms.viewFor(gameId);
  assert.ok(view.game.players[targetTeam].properties['1'], 'state.game.players[' + targetTeam + '].properties[1] gesetzt (→ Preis-Hide derivable)');

  let offerState = null;
  a.on('state', (st) => { offerState = st; });
  from.emit('trade:make', { gameId, kind: 'buy', field: 1, price: 100000, targetIdx: targetTeam });
  await sleep(400);
  view = srv.rooms.viewFor(gameId);
  assert.ok(Array.isArray(view.game.offers) && view.game.offers.length > 0, 'offer im State (Highlight-Kandidat für Sender+Empfänger)');
  const o = view.game.offers[0];
  assert.strictEqual(Number(o.fromIdx), activeIdx0, 'fromIdx = aktives Team');
  assert.strictEqual(Number(o.targetIdx), targetTeam, 'targetIdx = anderes Team');

  // Punkt 11: Versteigerung — das AKTIVE Team besitzt Feld 8 und startet die
  // Auktion (nur am eigenen Zug erlaubt) → auction im State (Highlight für ALLE).
  grantOwnership(gameId, activeIdx0, 8);
  from.emit('auction:start', { gameId, field: 8 });
  await sleep(300);
  view = srv.rooms.viewFor(gameId);
  assert.ok(view.game.auction, 'auction im State (Highlight für ALLE Teams)');
  assert.strictEqual(view.game.auction.ownerIdx, activeIdx0, 'Auktionär = aktives Team');

  [gm, a, d].forEach((c) => c.disconnect());
  srv.stop();
});
