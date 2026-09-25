/* =====================================================================
 * Stantonopoly V2 — phase1d.test.js
 * Tests für die Phase-1d-Fixes (reparierte Version):
 * - Trade-Bypass (Ziel-Team-Check): Zielleader KANN annehmen,
 *   fremde Leader/Mitglieder werden blockiert. Besitz wird deterministisch
 *   per DB-Setup gesetzt (buy erfordert Ziel-Besitz in der Engine).
 * - ForfeitPoll-Timeout: Poll löst nach Ablauf automatisch auf.
 *   State-Listener wird VOR dem Timeout registriert (sonst verpasst der
 *   Test den Auflösungs-Broadcast bei ~pollMs+300ms).
 * ===================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: ClientIO } = require('socket.io-client');
const { startServer, PROJ } = require('./helpers.js');

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
  const pGameCreated = once(client, 'gameCreated');
  client.emit('gm:create', { config });
  return await pGameCreated;
}

/** Besitz deterministisch per DB setzen (state-Row mutieren). */
function grantOwnership(gameId, playerIdx, fieldIdx) {
  const dbm = require(path2());
  const row = dbm.getGame(gameId);
  const g = JSON.parse(row.state);
  g.players[playerIdx].properties[String(fieldIdx)] = { level: 'ALLEIN' };
  dbm.updateState(gameId, { state: JSON.stringify(g) });
}

function path2() { return require('path').join(PROJ, 'server', 'db.js'); }

test('Trade-Bypass-Fix: Ziel-Team-Check blockiert fremde Leader', async () => {
  const srv = startServer();
  const url = 'http://localhost:' + srv.port;

  const gm = await connect(url, 'gm');
  const created = await createGame(gm, { teams: 2, capital: 1500000, diceConfig: '1w6', armistice: false });
  const gameId = created.gameId;

  const inv0 = created.tokens.find((t) => t.ship === 'Redeemer').code;
  const inv1 = created.tokens.find((t) => t.ship === 'Hammerhead').code;
  const a = await connect(url, 'A-Team0');
  const b = await connect(url, 'B-Team1');
  await new Promise((resolve) => { a.emit('team:join', { gameId, code: inv0, playerName: 'A' }); a.once('joined', resolve); });
  await new Promise((resolve) => { b.emit('team:join', { gameId, code: inv1, playerName: 'B' }); b.once('joined', resolve); });

  a.emit('vote:leader', { gameId, playerId: a.id });
  await sleep(30);
  b.emit('vote:leader', { gameId, playerId: b.id });
  await sleep(50);

  gm.emit('gm:start', { gameId, gmCode: created.gmCode });
  await once(gm, 'state');
  await sleep(50);

  // Deterministischer Besitz: B (Team1, Zielt­eam) besitzt Feld 1 und 2
  grantOwnership(gameId, 1, 1);
  grantOwnership(gameId, 1, 2);

  // A startet buy-Angebot an B (targetIdx=1) — Feld 1 gehört B
  let offerState = null;
  b.on('state', (st) => { offerState = st; });
  a.emit('trade:make', { gameId, kind: 'buy', field: 1, price: 100000, targetIdx: 1 });
  await sleep(300);

  assert.ok(offerState && offerState.game && Array.isArray(offerState.game.offers) && offerState.game.offers.length > 0, 'Angebot erstellt');
  const offerId = offerState.game.offers[0].id;

  // B (Ziel-Team) nimmt an
  let afterAccept = null;
  b.on('state', (st) => { afterAccept = st; });
  b.emit('trade:respond', { gameId, offerId, accept: 1 });
  await sleep(300);
  assert.ok(afterAccept && (!afterAccept.game.offers || afterAccept.game.offers.length === 0), 'B (Ziel) kann annehmen');

  // C (Mitglied, kein Leader) versucht anzunehmen
  const c = await connect(url, 'C-Team0-Mitglied');
  await new Promise((resolve) => { c.emit('team:join', { gameId, code: inv0, playerName: 'C' }); c.once('joined', resolve); });

  let offerState2 = null;
  c.on('state', (st) => { offerState2 = st; });
  b.emit('trade:make', { gameId, kind: 'sell', field: 2, price: 100000, targetIdx: 0 });
  await sleep(300);

  assert.ok(offerState2 && offerState2.game && Array.isArray(offerState2.game.offers) && offerState2.game.offers.length > 0, 'Angebot sichtbar');
  const offerId2 = offerState2.game.offers[0].id;

  // C ist kein Leader -> ERROR NOT_LEADER
  let cError = null;
  const cErrHandler = (d) => { if (!cError) cError = d; };
  c.on('error', cErrHandler);
  c.emit('trade:respond', { gameId, offerId: offerId2, accept: 1 });
  await sleep(2000);
  c.off('error', cErrHandler);
  assert.ok(cError, 'C bekommt einen Server-Error (tatsaechlich: ' + JSON.stringify(cError) + ')');
  assert.strictEqual(cError.code, 'NOT_LEADER', 'C bekommt NOT_LEADER');

  // B (Absender des sell-Angebots) antwortet auf sein EIGENES Angebot -> NOT_YOUR_OFFER
  let bError = null;
  const bErrHandler = (d) => { if (!bError) bError = d; };
  b.on('error', bErrHandler);
  b.emit('trade:respond', { gameId, offerId: offerId2, accept: 1 });
  await sleep(2000);
  b.off('error', bErrHandler);
  assert.ok(bError, 'B bekommt einen Server-Error (tatsaechlich: ' + JSON.stringify(bError) + ')');
  assert.strictEqual(bError.code, 'NOT_YOUR_OFFER', 'B (Absender, nicht Ziel) bekommt NOT_YOUR_OFFER');

  [gm, a, b, c].forEach((c_) => c_.disconnect());
  srv.stop();
});

test('ForfeitPoll-Timeout: Poll löst nach Ablauf automatisch auf', async () => {
  const srv = startServer();
  const url = 'http://localhost:' + srv.port;

  const gm = await connect(url, 'gm');
  const created = await createGame(gm, { teams: 2, capital: 1500000, diceConfig: '1w6', armistice: false });
  const gameId = created.gameId;

  const inv0 = created.tokens.find((t) => t.ship === 'Redeemer').code;
  const inv1 = created.tokens.find((t) => t.ship === 'Hammerhead').code;
  const a = await connect(url, 'A-Team0');
  const b = await connect(url, 'B-Team0');
  const d = await connect(url, 'D-Team1');
  await new Promise((resolve) => { a.emit('team:join', { gameId, code: inv0, playerName: 'A' }); a.once('joined', resolve); });
  await new Promise((resolve) => { b.emit('team:join', { gameId, code: inv0, playerName: 'B' }); b.once('joined', resolve); });
  await new Promise((resolve) => { d.emit('team:join', { gameId, code: inv1, playerName: 'D' }); d.once('joined', resolve); });

  a.emit('vote:leader', { gameId, playerId: a.id });
  await sleep(30);
  d.emit('vote:leader', { gameId, playerId: d.id });
  await sleep(50);

  gm.emit('gm:start', { gameId, gmCode: created.gmCode });
  await once(gm, 'state');
  await sleep(50);

  // State-Listener VOR dem Timeout registrieren (sonst wird der
  // Auflösungs-Broadcast bei ~pollMs+300 verpasst).
  let lastState = null;
  a.on('state', (st) => { lastState = st; });

  // A startet forfeitPoll
  a.emit('action:forfeit', { gameId });
  await sleep(400);

  assert.ok(lastState && lastState.game && lastState.game.forfeitPoll, 'forfeitPoll im State');
  assert.ok(lastState.game.forfeitPoll.endsAt > Date.now() - 20000, 'endsAt in Zukunft');

  // B stimmt NEIN (1:1 -> keine Mehrheit, Poll bleibt offen bis Timeout)
  b.emit('forfeit:vote', { gameId, agree: -1 });
  await sleep(200);

  // Warten auf Timeout (pollMs = 15000, setTimeout feuert bei ~15300)
  await sleep(16400);
  await sleep(600);

  assert.ok(lastState && lastState.game, 'State nach Auflösung vorhanden');
  assert.strictEqual(lastState.game.forfeitPoll, null, 'forfeitPoll nach Timeout aufgelöst');

  [gm, a, b, d].forEach((c_) => c_.disconnect());
  srv.stop();
});
