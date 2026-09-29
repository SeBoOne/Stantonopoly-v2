/**
 * Runde 2m — Task D: Pausiertes-Spiel-Flow (P9–P12)
 *   P9:  Öffnen eines pausierten Spiels öffnet NUR die Lobby — das Spiel wird
 *        NICHT fortgesetzt (auch nicht durch Team-Beitritt). Erst der
 *        „Fortsetzen“-Button (gm:start) lädt die Spieleansicht.
 *   P10: Abbrechen in der Lobby eines pausierten Spiels schließt nur die Lobby
 *        und lässt das Spiel pausiert — KEIN Entfernen des Spiels.
 *   P11: GM-Code im Beitrittsformular übernimmt die aktive GM-Sitzung
 *        (inkl. Name + Teamzugehörigkeit, falls vorhanden) — analog Rejoin.
 *   P12: Fortsetzen mit leeren Teams → GM wird gefragt; „trotzdem fortsetzen“
 *        lässt leere Teams automatisch aufgeben (forfeit).
 * Start: node --test tests/phase2md.test.js
 */
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const { io: ClientIO } = require('socket.io-client');
const path = require('path');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMPDIR = process.env.TMPDIR || os.tmpdir();
const DB_PATH = path.join(TMPDIR, 'p2md-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.db');
const PORT = 18209;
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
function waitError(client, code, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { client.off('error', h); reject(new Error('Timeout error ' + code)); }, timeoutMs);
    const h = (e) => { if (e && e.code === code) { clearTimeout(to); client.off('error', h); resolve(e); } };
    client.on('error', h);
  });
}

async function createGame(client, teams = 2) {
  const createdP = once(client, 'gameCreated');
  client.emit('gm:create', { config: { teams, capital: 1500000, diceConfig: '1w6', armistice: false, preset: 'Stantonopoly v1' } });
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

// ─── P9: Öffnen eines pausierten Spiels öffnet NUR die Lobby ────────────────
test('2m P9: pausiertes Spiel per GM-Code öffnen → bleibt pausiert (Lobby), erst gm:start setzt fort', async () => {
  const gm = track(await connect('p9-gm'));
  const ev = await createGame(gm, 2);
  const t0 = ev.tokens[0];
  const t1 = ev.tokens[1];

  const A = track(await connect('p9-A'));
  await joinTeam(A, ev.gameId, t0.code, 'A');
  const B = track(await connect('p9-B'));
  await joinTeam(B, ev.gameId, t1.code, 'B');

  gm.emit('gm:start', { gameId: ev.gameId, gmCode: ev.gmCode });
  await waitState(A, (s) => s && s.started === true);
  await sleep(60);

  // Pausieren.
  gm.emit('gm:pause', { gameId: ev.gameId, gmCode: ev.gmCode });
  await waitState(A, (s) => s && s.paused === true);
  await sleep(60);
  assert.equal(dbMod.getGame(ev.gameId).paused, 1, 'Spiel pausiert');

  // GM öffnet das pausierte Spiel per GM-Code (gm:resume) → Lobby, NICHT fortgesetzt.
  const gm2 = track(await connect('p9-gm2'));
  const createdP = once(gm2, 'gameCreated');
  gm2.emit('gm:resume', { gameId: ev.gameId, gmCode: ev.gmCode });
  const gc = await createdP;
  assert.equal(gc.paused, true, 'gameCreated meldet paused=true (Lobby, nicht fortgesetzt)');
  assert.equal(gc.started, true, 'Spiel ist gestartet (aber pausiert)');
  // Server: Spiel bleibt pausiert — gm:resume setzt NICHT fort.
  assert.equal(dbMod.getGame(ev.gameId).paused, 1, 'nach gm:resume weiterhin pausiert');

  // Ein Spieler tritt per Teamcode bei → das Spiel darf NICHT fortgesetzt werden.
  const C = track(await connect('p9-C'));
  const jC = await joinTeam(C, ev.gameId, t0.code, 'C');
  assert.equal(jC.paused, true, 'joined meldet paused=true (Lobby, nicht Spieleansicht)');
  assert.equal(dbMod.getGame(ev.gameId).paused, 1, 'Team-Beitritt setzt das Spiel NICHT fort');

  // Erst der „Fortsetzen“-Button (gm:start) setzt fort.
  gm2.emit('gm:start', { gameId: ev.gameId, gmCode: ev.gmCode });
  await waitState(A, (s) => s && s.started === true && s.paused === false, 6000);
  assert.equal(dbMod.getGame(ev.gameId).paused, 0, 'nach gm:start ist das Spiel fortgesetzt (nicht mehr pausiert)');
});

// ─── P10: Abbrechen in der Lobby eines pausierten Spiels ────────────────────
test('2m P10: Abbrechen in Lobby eines pausierten Spiels → Lobby zu, Spiel bleibt pausiert (nicht entfernt)', async () => {
  const gm = track(await connect('p10-gm'));
  const ev = await createGame(gm, 2);
  const t0 = ev.tokens[0];
  const t1 = ev.tokens[1];

  const A = track(await connect('p10-A'));
  await joinTeam(A, ev.gameId, t0.code, 'A');
  const B = track(await connect('p10-B'));
  await joinTeam(B, ev.gameId, t1.code, 'B');

  gm.emit('gm:start', { gameId: ev.gameId, gmCode: ev.gmCode });
  await waitState(A, (s) => s && s.started === true);
  await sleep(60);
  gm.emit('gm:pause', { gameId: ev.gameId, gmCode: ev.gmCode });
  await waitState(A, (s) => s && s.paused === true);
  await sleep(60);

  // GM öffnet das pausierte Spiel (Lobby) und drückt „Abbrechen“.
  const gm2 = track(await connect('p10-gm2'));
  const createdP = once(gm2, 'gameCreated');
  gm2.emit('gm:resume', { gameId: ev.gameId, gmCode: ev.gmCode });
  await createdP;
  await sleep(60);

  const cancelledP = once(gm2, 'cancelled');
  gm2.emit('game:cancel', { gameId: ev.gameId, gmCode: ev.gmCode });
  const canc = await cancelledP;
  assert.equal(canc.removed, false, 'Spiel wird NICHT entfernt');
  assert.equal(canc.paused, true, 'Spiel bleibt pausiert');

  // Spiel existiert weiterhin und ist pausiert.
  const g = dbMod.getGame(ev.gameId);
  assert.ok(g, 'Spiel existiert weiterhin (nicht gelöscht)');
  assert.equal(g.paused, 1, 'Spiel bleibt pausiert');
  assert.equal(g.started, 1, 'Spiel bleibt gestartet (pausiert)');
});

// ─── P11: GM-Code im Beitrittsformular übernimmt GM-Sitzung ─────────────────
test('2m P11: GM-Code im Beitrittsformular → übernimmt GM-Sitzung (Name + Teamzugehörigkeit)', async () => {
  const gm = track(await connect('p11-gm'));
  const ev = await createGame(gm, 2);
  const t0 = ev.tokens[0];
  const t1 = ev.tokens[1];

  // GM spielt selbst in Team0 mit (Name "GM").
  const gmPlay = track(await connect('p11-gmplay'));
  const jGm = await joinTeam(gmPlay, ev.gameId, t0.code, 'GM');
  assert.equal(jGm.teamId, t0.teamId, 'GM in Team0');
  const B = track(await connect('p11-B'));
  await joinTeam(B, ev.gameId, t1.code, 'B');

  gm.emit('gm:start', { gameId: ev.gameId, gmCode: ev.gmCode });
  await waitState(gmPlay, (s) => s && s.started === true);
  await sleep(60);

  // Neuer Client tippt den GM-Code in das Beitrittsformular (team:join mit GM-Code).
  const newGm = track(await connect('p11-newgm'));
  const j = once(newGm, 'joined');
  newGm.emit('team:join', { gameId: ev.gameId, code: ev.gmCode, playerName: 'GM' });
  const jd = await j;

  assert.equal(jd.isGM, true, 'GM-Sitzung übernommen (isGM)');
  assert.equal(String(jd.gmCode || '').toUpperCase(), String(ev.gmCode).toUpperCase(), 'GM-Code übernommen');
  assert.equal(jd.teamId, t0.teamId, 'Teamzugehörigkeit übernommen (Team0)');
  assert.equal(jd.replaced, true, 'alter GM-Login ersetzt (Gerätewechsel)');

  // Server: neuer Socket ist der aktive GM-Owner.
  assert.equal(dbMod.getGame(ev.gameId).gm_owner, newGm.id, 'neuer Socket ist aktiver GM');
  // Alter GM-Spieler-Login wurde übernommen (gleicher Name+Team).
  const row = dbMod.getPlayer(newGm.id);
  assert.ok(row, 'neuer GM ist Spieler');
  assert.equal(row.name, 'GM', 'Name übernommen');
  assert.equal(row.teamId, t0.teamId, 'Team übernommen');
});

// ─── P12: Fortsetzen mit leeren Teams ───────────────────────────────────────
test('2m P12: Fortsetzen mit leerem Team → GM gefragt; „trotzdem fortsetzen“ lässt leeres Team aufgeben', async () => {
  const gm = track(await connect('p12-gm'));
  const ev = await createGame(gm, 2);
  const t0 = ev.tokens[0];
  const t1 = ev.tokens[1];

  const A = track(await connect('p12-A'));
  await joinTeam(A, ev.gameId, t0.code, 'A');
  const B = track(await connect('p12-B'));
  await joinTeam(B, ev.gameId, t1.code, 'B');

  gm.emit('gm:start', { gameId: ev.gameId, gmCode: ev.gmCode });
  await waitState(A, (s) => s && s.started === true);
  await sleep(60);
  gm.emit('gm:pause', { gameId: ev.gameId, gmCode: ev.gmCode });
  await waitState(A, (s) => s && s.paused === true);
  await sleep(60);

  // Team1 wird leer (Spieler B entfernt — simuliert leeres Team beim Fortsetzen).
  dbMod.removePlayer(ev.gameId, B.id);
  const emptyTeams = (dbMod.getTeams(ev.gameId) || [])
    .filter((t) => (dbMod.getPlayers(ev.gameId) || []).filter((p) => p.teamId === t.teamId).length === 0);
  assert.equal(emptyTeams.length, 1, 'genau ein Team ist leer');

  // GM versucht zu fortsetzen OHNE Bestätigung → EMPTY_TEAMS-Frage.
  const errP = waitError(gm, 'EMPTY_TEAMS');
  gm.emit('gm:start', { gameId: ev.gameId, gmCode: ev.gmCode });
  const err = await errP;
  assert.ok(err.emptyTeams && err.emptyTeams.length === 1, 'Fehler enthält leere Teams');
  assert.equal(dbMod.getGame(ev.gameId).paused, 1, 'Spiel bleibt pausiert (GM wartet)');

  // GM wählt „trotzdem fortsetzen“ (confirmEmpty) → leeres Team gibt auf, Spiel läuft.
    gm.emit('gm:start', { gameId: ev.gameId, gmCode: ev.gmCode, confirmEmpty: true });
    // Nur noch ein aktives Team → Spiel ist beendet (Team0 gewinnt).
    await waitState(A, (s) => s && s.over === true, 6000);
    assert.equal(dbMod.getGame(ev.gameId).paused, 0, 'Spiel fortgesetzt (nicht mehr pausiert)');
    const gAfter = dbMod.getGame(ev.gameId);
    const engAfter = engine.deserialize(gAfter.state, D);
    // Team1 (leer) ist per Forfeit ausgeschieden.
    const t1Idx = engAfter.players.findIndex((p) => String(p.id) === String(t1.teamId));
    assert.ok(t1Idx >= 0, 'Team1 in Engine');
    assert.equal(engAfter.players[t1Idx].bankrupt, true, 'leeres Team1 per Forfeit ausgeschieden');
    // (t_3d729454 P7) Forfeit räumt NICHT mehr Budget — echter letzter Stand bleibt.
    assert.equal(engAfter.players[t1Idx].forfeited, true, 'forfeit-Flag gesetzt');
    assert.equal(engAfter.players[t1Idx].budget, 1500000, 'Guthaben bleibt erhalten (P7, nicht 0)');
    assert.equal(engAfter.over, true, 'Spiel beendet (nur noch ein aktives Team)');
});
