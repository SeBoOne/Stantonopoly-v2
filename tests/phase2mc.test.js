/**
 * Runde 2m — Task C: Rejoin-Gerätewechsel (P6) + Letzter-Spieler-Teamaufgeben (P7)
 *   P6: Gleicher Name + gleicher Team-Code ersetzt den alten Login (Gerätewechsel):
 *       neuer Client übernimmt Rollen (Leader/Votes/GM), alter Socket wird mit
 *       „Von einem anderen Standort eingeloggt“ entfernt.
 *   P7: Letzter aktiver Spieler seines Teams verlässt → erst Bestätigungs-Abfrage
 *       (leave:confirm), nach Bestätigung → Team-Forfeit + leave.
 * Start: node --test tests/phase2mc.test.js
 */
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const { io: ClientIO } = require('socket.io-client');
const path = require('path');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMPDIR = process.env.TMPDIR || os.tmpdir();
const DB_PATH = path.join(TMPDIR, 'p2m-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.db');
const PORT = 18207;
process.env.STANTONOPOLY_DB = DB_PATH;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'test';

const mod = require(path.join(__dirname, '..', 'server', 'index.js'));
const srv = mod.start(PORT);
const { rooms } = mod;
const dbMod = require(path.join(__dirname, '..', 'server', 'db.js'));
const engine = require(path.join(__dirname, '..', 'server', 'engine', 'engine.js'));
const D = require(path.join(__dirname, '..', 'server', 'engine', 'data.js'));

const ALL = [];
const track = (c) => { ALL.push(c); return c; };

function connect(name) {
  const c = ClientIO(`http://localhost:${PORT}`, { transports: ['websocket'], reconnection: false, forceNew: true, timeout: 3000 });
  if (c.io && c.io.engine) c.io.engine.on('open', () => { c.io.engine.pingInterval = 0; c.io.engine.pingTimeout = 0; });
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { c.disconnect(true); reject(new Error('Connect ' + name)); }, 5000);
    c.on('connect', () => { clearTimeout(to); resolve(c); });
    c.on('connect_error', (e) => { clearTimeout(to); c.disconnect(true); reject(new Error(name + ': ' + e.message)); });
  });
}

function once(client, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { client.off(event); reject(new Error('Timeout ' + event)); }, timeoutMs);
    client.once(event, (d) => { clearTimeout(to); resolve(d); });
  });
}
function waitState(client, predicate, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const to = setTimeout(() => { client.off('state', h); if (!done) reject(new Error('waitState timeout')); }, timeoutMs);
    const h = (st) => { if (done) return; if (predicate(st)) { done = true; clearTimeout(to); client.off('state', h); resolve(st); } };
    client.on('state', h);
  });
}

async function createGame(client, teams = 2) {
  const createdP = once(client, 'gameCreated');
  client.emit('gm:create', { config: { teams, capital: 1500000, diceConfig: '1w6', armistice: false, preset: 'Crusader Cluster' } });
  return createdP;
}

async function joinTeam(client, gameId, code, name) {
  const j = once(client, 'joined');
  client.emit('team:join', { gameId, code, playerName: name });
  const d = await j;
  await sleep(40);
  return d;
}

after(() => { try { srv.close && srv.close(); } catch (e) {} ALL.forEach((c) => { try { c.disconnect(true); } catch (e) {} }); });

// ─── P6: Rejoin gleicher Name+Code ersetzt alten Login (Gerätewechsel) ─────────
test('2m P6: gleicher Name + gleicher Team-Code → alter Login entfernt, Rollen übernommen', async () => {
  const gm = track(await connect('p6-gm'));
  const ev = await createGame(gm, 2);
  const t0 = ev.tokens[0];
  const t1 = ev.tokens[1];

  // Team0: Spieler A (Name "Pilot") — wird durch Start zum Leader (einziges Mitglied).
  const A = track(await connect('p6-A'));
  const jA = await joinTeam(A, ev.gameId, t0.code, 'Pilot');
  assert.equal(jA.teamId, t0.teamId, 'A in Team0');
  const oldToken = jA.token;
  const oldId = jA.playerId;

  // Team1: ein Spieler, damit gm:start genügt.
  const B = track(await connect('p6-B'));
  await joinTeam(B, ev.gameId, t1.code, 'B');

  gm.emit('gm:start', { gameId: ev.gameId, gmCode: ev.gmCode });
  await waitState(A, (s) => s && s.started === true);
  await sleep(80);
  // A ist Leader (einziges Mitglied von Team0).
  const team0row = (dbMod.getTeams(ev.gameId) || []).find((t) => t.teamId === t0.teamId);
  assert.equal(team0row && team0row.leaderId, oldId, 'A ist Leader von Team0');

  // Gerätewechsel: neuer Socket C tritt mit demselben Namen + Code bei.
  const C = track(await connect('p6-C'));
  const redirectedP = once(A, 'game:redirected');
  const jC = await joinTeam(C, ev.gameId, t0.code, 'Pilot');
  const redir = await redirectedP;

  // Alter Login A wurde entfernt (Meldung).
  assert.ok(redir, 'alter Socket A erhält game:redirected');
  assert.match(String(redir.message || ''), /anderen Standort/, 'Meldung „Von einem anderen Standort eingeloggt“');

  // Neuer Client C hat übernommen (replaced:true, gleicher Token, gleiches Team).
  assert.equal(jC.replaced, true, 'C meldet replaced');
  assert.equal(jC.teamId, t0.teamId, 'C in Team0');
  assert.equal(jC.token, oldToken, 'Token bleibt stabil (Login übernommen)');

  // A ist aus der Spieler-Tabelle entfernt; C ist der Spieler.
  assert.equal(dbMod.getPlayer(oldId), null, 'alter Login A entfernt');
  const cRow = dbMod.getPlayer(C.id);
  assert.ok(cRow, 'C ist Spieler');
  assert.equal(cRow.name, 'Pilot', 'Name übernommen');
  assert.equal(cRow.teamId, t0.teamId, 'Team übernommen');

  // Rollen übernommen: C ist jetzt Leader von Team0.
  const team0after = (dbMod.getTeams(ev.gameId) || []).find((t) => t.teamId === t0.teamId);
  assert.equal(team0after && team0after.leaderId, C.id, 'Leader-Rolle auf C übergegangen');
});

// ─── P7: Letzter Spieler seines Teams verlässt → Warnung + Auto-Forfeit ─────────
test('2m P7: letzter Spieler verlässt → erst leave:confirm, nach Bestätigung Team-Forfeit', async () => {
  const gm = track(await connect('p7-gm'));
  const ev = await createGame(gm, 2);
  const t0 = ev.tokens[0];
  const t1 = ev.tokens[1];

  // Team0: EIN Spieler A. Team1: EIN Spieler B.
  const A = track(await connect('p7-A'));
  await joinTeam(A, ev.gameId, t0.code, 'A');
  const B = track(await connect('p7-B'));
  await joinTeam(B, ev.gameId, t1.code, 'B');

  gm.emit('gm:start', { gameId: ev.gameId, gmCode: ev.gmCode });
  await waitState(A, (s) => s && s.started === true);
  await sleep(80);

  // (a) A (letzter Spieler von Team0) versucht zu verlassen → Bestätigungs-Abfrage.
  const confirmP = once(A, 'leave:confirm');
  A.emit('game:leave', { gameId: ev.gameId });
  const cf = await confirmP;
  assert.ok(cf, 'Server sendet leave:confirm');
  assert.match(String(cf.message || ''), /Team auf/, 'Warnung „gibt dein Team auf“');
  // Noch NICHT verlassen / kein Forfeit.
  assert.ok(dbMod.getPlayer(A.id), 'A noch im Spiel (wartet auf Bestätigung)');
  const gBefore = dbMod.getGame(ev.gameId);
  const engBefore = engine.deserialize(gBefore.state, D);
  assert.equal(engBefore.players[0].bankrupt, false, 'Team0 noch nicht ausgeschieden');

  // (b) A bestätigt → Team-Forfeit + leave.
  const leftP = once(A, 'left');
  A.emit('game:leave', { gameId: ev.gameId, confirm: true });
  const lr = await leftP;
  assert.equal(lr.ok, true, 'A verlässt nach Bestätigung');

  // A aus der Tabelle entfernt; Team0 per Forfeit ausgeschieden (bankrupt).
  assert.equal(dbMod.getPlayer(A.id), null, 'A entfernt');
  const gAfter = dbMod.getGame(ev.gameId);
  const engAfter = engine.deserialize(gAfter.state, D);
  assert.equal(engAfter.players[0].bankrupt, true, 'Team0 per Forfeit ausgeschieden');
  assert.equal(engAfter.players[0].budget, 0, 'Guthaben aufgegeben');
  assert.deepEqual(engAfter.players[0].properties, {}, 'Eigentum aufgegeben');
});

// ─── 2n P6: Nach Rejoin-Gerätewechsel kann ein Normalspieler wieder verlassen ─
// Regressionstest: X (normales Teammitglied) macht einen Gerätewechsel (gleicher
// Name + Team-Code → _takeoverPlayer). DANACH muss X das Spiel verlassen können
// ('left'), statt fälschlich als aktiver GM blockiert zu werden (GM_ACTIVE).
// Der WIRKLICHE GM bleibt weiterhin blockiert (GM_ACTIVE).
test('2n P6: Normalspieler darf nach Rejoin-Gerätewechsel verlassen; echter GM bleibt blockiert', async () => {
  const gm = track(await connect('p6x-gm'));
  const ev = await createGame(gm, 2);
  const t0 = ev.tokens[0];
  const t1 = ev.tokens[1];

  // Team0: ZWEI Spieler X + Y (damit X nach Rejoin nicht der letzte ist → P7
  // leave:confirm greift hier nicht). Team1: ein Spieler erreicht gm:start.
  const X = track(await connect('p6x-X'));
  const jX = await joinTeam(X, ev.gameId, t0.code, 'X');
  const Y = track(await connect('p6x-Y'));
  await joinTeam(Y, ev.gameId, t0.code, 'Y');
  const Z = track(await connect('p6x-Z'));
  await joinTeam(Z, ev.gameId, t1.code, 'Z');

  gm.emit('gm:start', { gameId: ev.gameId, gmCode: ev.gmCode });
  await waitState(X, (s) => s && s.started === true);
  await sleep(80);

  // GM ist der aktive GM (gm_owner + GM-Socket-Registrierung → Verlassen blockiert).
  assert.equal(dbMod.getGame(ev.gameId).gm_owner, gm.id, 'gm_owner = GM-Socket');

  // Gerätewechsel: neuer Socket X2 tritt mit demselben Namen + Team-Code bei.
  const X2 = track(await connect('p6x-X2'));
  const redirectedP = once(X, 'game:redirected');
  const jX2 = await joinTeam(X2, ev.gameId, t0.code, 'X');
  await redirectedP;
  assert.equal(jX2.replaced, true, 'X2 übernimmt den Login (Gerätewechsel)');

  // X2 ist ein NORMALES Teammitglied — darf nach dem Wechsel verlassen.
  const leftP = once(X2, 'left');
  X2.emit('game:leave', { gameId: ev.gameId });
  const lr = await leftP;
  assert.equal(lr.ok, true, 'X2 verlässt nach Rejoin (erhält left) — nicht GM_ACTIVE');
  assert.equal(dbMod.getPlayer(X2.id), null, 'X2 nach Verlassen aus dem Spiel entfernt');

  // Der echte GM G bleibt weiterhin blockiert (GM_ACTIVE), kein 'left'.
  let gmLeft = false;
  gm.once('left', () => { gmLeft = true; });
  const gmErrP = once(gm, 'error');
  gm.emit('game:leave', { gameId: ev.gameId });
  const gmErr = await gmErrP;
  assert.equal(gmErr.code, 'GM_ACTIVE', 'echter GM weiterhin blockiert (GM_ACTIVE)');
  assert.equal(gmLeft, false, 'GM erhält kein left');
});
