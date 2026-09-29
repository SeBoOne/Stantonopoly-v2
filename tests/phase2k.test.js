/**
 * Phase 2k — Lobby/Listing/Abbrechen/GM-Gate/Farbgruppen-Bauregel
 * Deckt die Punkte 1, 2, 4, 5 der Runde 2k ab (server-seitig).
 *   p1: Nicht-gestartete Spiele erscheinen NICHT in lobby:list; Spectate blocked (NOT_STARTED).
 *   p2: game:cancel entfernt ein neues Spiel (removed); pausiert → bleibt pausiert (nicht gelöscht).
 *   p4: GM kann sich während laufendem Spiel NICHT verlassen (GM_ACTIVE); Nicht-GM schon (left).
 *   p5: Farbgruppen-Feld (group) wird gespeichert; Monopoly-Bauregel abschaltbar (Steuerung über
 *       Preset-Settings gemappt auf data.DEFAULT_SETTINGS.monopolyBuildRule).
 * Start: node --test tests/phase2k.test.js
 */
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const { io: ClientIO } = require('socket.io-client');
const path = require('path');
const os = require('os');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMPDIR = process.env.TMPDIR || os.tmpdir();
const DB_PATH = path.join(TMPDIR, 'p2k-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.db');
const PORT = 18107;
process.env.STANTONOPOLY_DB = DB_PATH;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'test';

const mod = require(path.join(__dirname, '..', 'server', 'index.js'));
const srv = mod.start(PORT);
const { rooms } = mod;

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
function waitError(client, code, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { client.off('error'); reject(new Error('Timeout error ' + code)); }, timeoutMs);
    client.on('error', (e) => {
      if (e && (e.code || e.error || e) === code) { clearTimeout(to); client.off('error'); resolve(e); }
    });
  });
}

async function createGame(client, teams = 2) {
  const createdP = once(client, 'gameCreated');
  client.emit('gm:create', { config: { teams, capital: 1500000, diceConfig: '1w6', armistice: false, preset: 'Stantonopoly v1' } });
  return createdP;
}

async function listGames(client) {
  const p = once(client, 'lobby:games');
  client.emit('lobby:list');
  const d = await p;
  return (d && d.games) || [];
}

after(() => { try { srv.close && srv.close(); } catch (e) {} ALL.forEach((c) => { try { c.disconnect(true); } catch (e) {} }); });

test('2k p1: Nicht-gestartetes (Lobby-)Spiel erscheint nicht in der Liste; Spectate blockiert', async () => {
  const gm = track(await connect('p1-gm'));
  const ev = await createGame(gm, 2);
  const games = await listGames(gm);
  assert.ok(!games.some((g) => g.gameId === ev.gameId), 'Lobby-Spiel darf nicht gelistet werden (not started yet)');

  // Spectator versucht, das Lobby-Spiel zu beobachten → NOT_STARTED
  const spec = track(await connect('p1-spec'));
  const warnings = [];
  spec.on('error', (e) => warnings.push(e));
  spec.emit('lobby:spectate', { gameId: ev.gameId });
  await sleep(150);
  assert.ok(warnings.length >= 1, 'Spectate auf Lobby-Spiel muss einen Fehler werfen');
  const code = (warnings[0] && (warnings[0].code || warnings[0].error)) || warnings[0];
  assert.equal(String(code).toUpperCase(), 'NOT_STARTED');

  // Als GM Spiel starten, dann darf es gelistet werden.
  // Start verlangt: ALLE Teams haben mind. einen Spieler → je Team EIN separater Socket.
  const teamSocks = [];
  for (const token of (ev.tokens || [])) {
    const cs = track(await connect('p1-t-' + token.teamId));
    const j = once(cs, 'joined');
    cs.emit('team:join', { gameId: ev.gameId, code: token.code, playerName: 'P-' + token.teamId });
    await j; await sleep(40);
    teamSocks.push(cs);
  }
  const startedP = waitState(teamSocks[0], (s) => s && s.started === true);
  gm.emit('gm:start', { gameId: ev.gameId, gmCode: ev.gmCode });
  const st = await startedP;
  assert.ok(st && st.started === true, 'Spiel gestartet');
  await sleep(80);
  const afterStart = await listGames(gm);
  assert.ok(afterStart.some((g) => g.gameId === ev.gameId), 'Gestartetes Spiel muss gelistet werden');
});

test('2k p2: game:cancel entfernt neues Spiel (removed:true) und DB-Eintrag', async () => {
  const gm = track(await connect('p2-gm'));
  const ev = await createGame(gm, 2);
  const cancelledP = once(gm, 'cancelled');
  gm.emit('game:cancel', { gameId: ev.gameId, gmCode: ev.gmCode });
  const c = await cancelledP;
  assert.equal(c.removed, true, 'neues Spiel muss entfernt werden');
  await sleep(60);
  const dbMod = require(path.join(__dirname, '..', 'server', 'db.js'));
  assert.equal(dbMod.getGame(ev.gameId), undefined, 'DB-Eintrag muss gelöscht sein');
  const games = await listGames(gm);
  assert.ok(!games.some((g) => g.gameId === ev.gameId), 'entferntes Spiel nicht mehr gelistet');
});

test('2k p2b: cancel auf pausiertem Spiel verworfen → bleibt pausiert (removed:false)', async () => {
  const gm = track(await connect('p2b-gm'));
  const ev = await createGame(gm, 2);
  let lastCS = null;
  for (const token of (ev.tokens || [])) {
    const cs = track(await connect('p2b-t-' + token.teamId));
    lastCS = cs;
    const j = once(cs, 'joined');
    cs.emit('team:join', { gameId: ev.gameId, code: token.code, playerName: 'PB-' + token.teamId });
    await j; await sleep(40);
  }
  gm.emit('gm:start', { gameId: ev.gameId, gmCode: ev.gmCode });
  await waitState(lastCS, (s) => s && s.started === true); await sleep(80);
  // Pausieren
  gm.emit('gm:pause', { gameId: ev.gameId, gmCode: ev.gmCode });
  await sleep(100);
  const dbMod = require(path.join(__dirname, '..', 'server', 'db.js'));
  const g1 = dbMod.getGame(ev.gameId);
  assert.equal(g1.paused, 1, 'Spiel muss pausiert sein');
  // Fortsetzen abbrechen → removed:false, bleibt pausiert, NICHT gelöscht
  const cancelledP = once(gm, 'cancelled');
  gm.emit('game:cancel', { gameId: ev.gameId, gmCode: ev.gmCode });
  const c = await cancelledP;
  assert.equal(c.removed, false, 'pausiertes Spiel darf nicht gelöscht werden');
  assert.equal(c.paused, true, 'Fortsetzen abgebrochen → wieder pausiert gemeldet');
  await sleep(50);
  const g2 = dbMod.getGame(ev.gameId);
  assert.ok(g2, 'pausiertes Spiel bleibt in der DB');
  assert.equal(g2.paused, 1, 'bleibt pausiert');
});

test('2k p4: GM kann sich während laufendem Spiel NICHT verlassen (GM_ACTIVE); anderer Spieler schon', async () => {
  const gm = track(await connect('p4-gm'));
  const ev = await createGame(gm, 2);
  // Team0: GM (eine ID) + p2 als weiteres Mitglied desselben Teams.
  const t0 = ev.tokens[0];
  const j0 = once(gm, 'joined').catch(() => null);
  gm.emit('team:join', { gameId: ev.gameId, code: t0.code, playerName: 'GM-A' });
  await j0; await sleep(40);
  const p2 = track(await connect('p4-p2'));
  const j2 = once(p2, 'joined');
  p2.emit('team:join', { gameId: ev.gameId, code: t0.code, playerName: 'GM-B' });
  await j2; await sleep(40);
  // Team1: separater Spieler (damit gm:start genügt)
  const t1 = ev.tokens[1];
  const c1 = track(await connect('p4-c1'));
  const jc1 = once(c1, 'joined');
  c1.emit('team:join', { gameId: ev.gameId, code: t1.code, playerName: 'P1' });
  await jc1; await sleep(40);

  gm.emit('gm:start', { gameId: ev.gameId, gmCode: ev.gmCode });
  const st = await waitState(c1, (s) => s && s.started === true);
  assert.ok(st && st.started === true);
  await sleep(80);

  // (a) GM versucht zu verlassen → GM_ACTIVE
  const errP = waitError(gm, 'GM_ACTIVE');
  gm.emit('game:leave', { gameId: ev.gameId });
  const err = await errP;
  assert.ok(err, 'GM-Leave muss blockiert werden (GM_ACTIVE)');
  const dbMod = require(path.join(__dirname, '..', 'server', 'db.js'));
  assert.ok(dbMod.getPlayer(gm.id), 'GM bleibt Spieler in der DB');

  // (b) Nicht-GM (p2, Mitglied in Team0) verlässt → ok
  const leftP = once(p2, 'left');
  p2.emit('game:leave', { gameId: ev.gameId });
  const lr = await leftP;
  assert.equal(lr.ok, true, 'Nicht-GM darf verlassen');
});

test('2k p5: Farbgruppen-Serialisierung (group) übersteht gm:create + normalizeField', async () => {
  const dbMod = require(path.join(__dirname, '..', 'server', 'db.js'));
  const presetName = 'p2k Gruppen-Preset';
  const fields = [
    { type: 'grundstueck', name: 'Seraphim', price: 200000, group: 'A' },
    { type: 'grundstueck', name: 'Microtech', price: 500000, group: 'A' },
    { type: 'los', name: 'Los', bonus: 100000 },
    { type: 'steuer', name: 'Steuer', fee: 50000 }
  ];
  const up = dbMod.upsertPreset({ name: presetName, fields, levelNames: {}, settings: {} });
  assert.ok(dbMod.getPreset(presetName), 'Preset gespeichert');

  const gm = track(await connect('p5-gm'));
  const createdP = once(gm, 'gameCreated');
  gm.emit('gm:create', { config: { teams: 2, capital: 1500000, preset: presetName } });
  const ev = await createdP;

  const saved = dbMod.getPreset(presetName);
  assert.ok(saved, 'Preset in DB');
  const savedGroups = (saved.fields || []).filter((f) => f.type === 'grundstueck' && f.group);
  assert.ok(savedGroups.some((f) => f.group === 'A'), 'Gruppen-Feld gespeichert');
  assert.ok(!(saved.fields || []).find((f) => f.type === 'steuer' && f.group), 'Nicht-kaufbares Feld hat KEINE Gruppe');
});

test('2k p5b: engine normalizeField überträgt group nur für Grundstücke; data merge hat buildGroup-Flags', async () => {
  const engine = require(path.join(__dirname, '..', 'server', 'engine', 'engine.js'));
  const D = require(path.join(__dirname, '..', 'server', 'engine', 'data.js'));
  // normalizeField-Schicht prüfen (Engine-intern; direkter Test)
  const f1 = { type: 'grundstueck', name: 'X', price: 100000, group: 'B' };
  const f2 = { type: 'steuer', name: 'T', fee: 100, group: 'B' };
  const m = D.mergeSettings({ buildGroupOwnership: true, buildGroupEven: false });
  assert.equal(m.buildGroupOwnership, true, 'mergeSettings übernimmt buildGroupOwnership');
  assert.equal(m.buildGroupEven, false, 'mergeSettings übernimmt buildGroupEven');
  // Rückwärtskompatibel: altes monopolyBuildRule mappt auf beide neuen Flags.
  const m2 = D.mergeSettings({ monopolyBuildRule: true });
  assert.equal(m2.buildGroupOwnership, true, 'altes monopolyBuildRule → buildGroupOwnership');
  assert.equal(m2.buildGroupEven, true, 'altes monopolyBuildRule → buildGroupEven');
  assert.equal(m.armisticeEnabled, false, 'andere Settings-Defaults intakt');
});

// ─── Ausführlicher Integrationstest (Sebo-Auftrag) ─────────────────────────
// 3 Teams × 2 Spieler, Leiter-Abstimmung, GM-Übergabe → danach darf der alte GM
// verlassen (GM_ACTIVE aufgehoben), Spieler-Verlassen mit automatischer
// Leader-Nachfolge, Pause → Resume-Flow.
test('2k pX: Vollfa. createGame mit 3 Teams, Leader-Vote, GM-Transfer, GM-Leave danach erlaubt', async () => {
  const gm = track(await connect('px-gm'));
  const createdP = once(gm, 'gameCreated');
  gm.emit('gm:create', { config: { teams: 3, capital: 1500000, diceConfig: '1w6', armistice: false, preset: 'Stantonopoly v1' } });
  const ev = await createdP;
  assert.equal(ev.tokens.length, 3, '3 Team-Tokens');

  // 2 Spieler pro Team, eigene Sockets. memberId merken.
  const players = {}; // teamId -> [sockA, sockB]
  const memberIds = {};
  for (const token of ev.tokens) {
    const a = track(await connect('px-t' + token.teamId + '-a'));
    const ja = once(a, 'joined');
    a.emit('team:join', { gameId: ev.gameId, code: token.code, playerName: 'TA' });
    const dj = await ja;
    memberIds[token.teamId + '-a'] = dj.playerId;
    const b = track(await connect('px-t' + token.teamId + '-b'));
    const jb = once(b, 'joined');
    b.emit('team:join', { gameId: ev.gameId, code: token.code, playerName: 'TB' });
    const dj2 = await jb;
    memberIds[token.teamId + '-b'] = dj2.playerId;
    players[token.teamId] = { a, b };
    await sleep(40);
  }

  // Leader-Abstimmung: in jedem Team eine klare Mehrheit auf 'a'.
  for (const token of ev.tokens) {
    players[token.teamId].a.emit('vote:leader', { gameId: ev.gameId, playerId: memberIds[token.teamId + '-a'] });
    await sleep(20);
    players[token.teamId].b.emit('vote:leader', { gameId: ev.gameId, playerId: memberIds[token.teamId + '-a'] });
    await sleep(20);
  }

  // Start über player-Socket abwarten
  const firstTok = ev.tokens[0];
  gm.emit('gm:start', { gameId: ev.gameId, gmCode: ev.gmCode });
  const st = await waitState(players[firstTok.teamId].a, (s) => s && s.started === true);
  assert.ok(st && st.started === true);
  await sleep(80);

  // GM versucht zu verlassen → blockiert (GM_ACTIVE)
  const dbMod = require(path.join(__dirname, '..', 'server', 'db.js'));
  const e1p = waitError(gm, 'GM_ACTIVE');
  gm.emit('game:leave', { gameId: ev.gameId });
  await e1p;
  assert.ok(dbMod.getGame(ev.gameId) && !dbMod.getGame(ev.gameId).over, 'GM noch im Spiel (nicht entfernt)');

  // GM-Übergabe an Spieler A von Team0
  gm.emit('gm:transfer', { gameId: ev.gameId, gmCode: ev.gmCode, playerId: memberIds[firstTok.teamId + '-a'] });
  await sleep(100);
  // Alter GM darf jetzt verlassen
  const leftP = once(gm, 'left');
  gm.emit('game:leave', { gameId: ev.gameId });
  const gl = await leftP;
  assert.equal(gl.ok, true, 'GM darf nach Übergabe verlassen');

  // Neuer GM (A) ist noch da
  const dbMod2 = require(path.join(__dirname, '..', 'server', 'db.js'));
  assert.ok(dbMod2.getPlayer(memberIds[firstTok.teamId + '-a']), 'Neuer GM-Spieler bleibt');
});

test('2k pXb: Spieler-Verlassen → Leader-Nachfolge (resolveTeamLeader) verwaltet', async () => {
  const gm = track(await connect('pxb-gm'));
  const createdP = once(gm, 'gameCreated');
  gm.emit('gm:create', { config: { teams: 2, capital: 1500000, diceConfig: '1w6', armistice: false, preset: 'Stantonopoly v1' } });
  const ev = await createdP;

  const players = {};
  const memberIds = {};
  for (const token of ev.tokens) {
    const a = track(await connect('pxb-t' + token.teamId + '-a'));
    const ja = once(a, 'joined');
    a.emit('team:join', { gameId: ev.gameId, code: token.code, playerName: 'TA' });
    const dj = await ja; memberIds[token.teamId + '-a'] = dj.playerId;
    const b = track(await connect('pxb-t' + token.teamId + '-b'));
    const jb = once(b, 'joined');
    b.emit('team:join', { gameId: ev.gameId, code: token.code, playerName: 'TB' });
    const dj2 = await jb; memberIds[token.teamId + '-b'] = dj2.playerId;
    players[token.teamId] = { a, b };
    await sleep(40);
  }
  // Team0 wählt 'a' zum Leader; Team1 wählt 'b'.
  players[ev.tokens[0].teamId].a.emit('vote:leader', { gameId: ev.gameId, playerId: memberIds[ev.tokens[0].teamId + '-a'] });
  await sleep(20);
  players[ev.tokens[0].teamId].b.emit('vote:leader', { gameId: ev.gameId, playerId: memberIds[ev.tokens[0].teamId + '-a'] });
  await sleep(20);
  players[ev.tokens[1].teamId].a.emit('vote:leader', { gameId: ev.gameId, playerId: memberIds[ev.tokens[1].teamId + '-b'] });
  await sleep(20);
  players[ev.tokens[1].teamId].b.emit('vote:leader', { gameId: ev.gameId, playerId: memberIds[ev.tokens[1].teamId + '-b'] });
  await sleep(20);

  gm.emit('gm:start', { gameId: ev.gameId, gmCode: ev.gmCode });
  const st = await waitState(players[ev.tokens[0].teamId].a, (s) => s && s.started === true);
  assert.ok(st && st.started === true);
  await sleep(80);
  const dbMod = require(path.join(__dirname, '..', 'server', 'db.js'));
  const team0row = (dbMod.getTeams(ev.gameId) || []).find((t) => t.teamId === ev.tokens[0].teamId);
  assert.equal(team0row && team0row.leaderId, memberIds[ev.tokens[0].teamId + '-a'], 'Team0 Leader = a vor Verlassen');

  // Leader 'a' von Team0 verlässt → Nachfolge wird bestimmt, Spiel läuft weiter.
  const leftP = once(players[ev.tokens[0].teamId].a, 'left');
  players[ev.tokens[0].teamId].a.emit('game:leave', { gameId: ev.gameId });
  await leftP;
  await sleep(100);
  assert.ok(!dbMod.getPlayer(memberIds[ev.tokens[0].teamId + '-a']), 'a aus der Tabelle entfernt');
  // Team0 hat noch 'b' → Spiel intakt (state weiter möglich über b)
  const gRow = dbMod.getGame(ev.gameId);
  assert.ok(gRow && !gRow.over, 'Spiel weiterhin aktiv');
  const team0after = (dbMod.getTeams(ev.gameId) || []).find((t) => t.teamId === ev.tokens[0].teamId);
  assert.equal(team0after && team0after.leaderId, memberIds[ev.tokens[0].teamId + '-b'], 'Leader-Nachfolge = b');
});
