/**
 * Runde 2m — Task A: Auto-Pause (10 min Inaktiv) + Auto-Beenden (30 Tage) mit
 * Vermögenswert-Sieger.
 *
 *  - Unit-Tests: Vermögenswert-Berechnung (Hypothek = 10 %, Ausbauwert enthalten,
 *    reichstes Team).
 *  - Wire-Test: Auto-Pause nach Inaktivität (Timeout via env STANTONOPOLY_INACTIVE_MS
 *    klein konfiguriert; Sweep via STANTONOPOLY_SWEEP_MS).
 *
 * Start: node --test tests/phase2m.test.js
 */
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------
// Unit-Tests: Vermögenswert (reine Engine-Helper)
// ---------------------------------------------------------------------
const D = require(path.join(__dirname, '..', 'server', 'engine', 'data.js'));
const G = require(path.join(__dirname, '..', 'server', 'engine', 'engine.js'));

function makeGame(players, opts) {
  opts = opts || {};
  return G.createGame({
    data: D,
    players: players.map((p, i) => ({ id: i, name: p.name, ship: p.ship || '', task: p.task || '' })),
    startingCapital: (opts.capital !== undefined) ? opts.capital : D.DEFAULT_CAPITAL,
    diceConfig: { kind: 'frei', freeValue: 0 },
    armisticeEnabled: !!opts.armistice,
    settings: opts.settings || null
  });
}

test('2m-A Unit: Vermögenswert = Guthaben + Grundstückswert + Ausbauwert', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { capital: 1000000 });
  // A besitzt Feld 1 (Seraphim, 400000) auf CYCLONE (Baukosten 0.25 × 400000 = 100000).
  g.players[0].budget = 500000;
  g.players[0].properties[1] = { level: 'CYCLONE' };
  // B besitzt Feld 2 (500000) auf ALLEIN.
  g.players[1].budget = 200000;
  g.players[1].properties[2] = { level: 'ALLEIN' };

  // A: 500000 + (400000 + 100000) = 1.000.000
  assert.strictEqual(G.teamWealth(g, 0), 1000000, 'A: Guthaben + Feldwert + Ausbauwert');
  // B: 200000 + 500000 = 700.000
  assert.strictEqual(G.teamWealth(g, 1), 700000, 'B: Guthaben + Feldwert');
  // Reichstes Team = A
  assert.strictEqual(G.richestTeamIdx(g), 0, 'A ist reichstes Team');
});

test('2m-A Unit: Hypothek-belastetes Feld zählt nur 10 % seines Werts', () => {
  const g = makeGame([{ name: 'A' }], { capital: 1000000 });
  g.players[0].budget = 0;
  // Feld 1 (400000) auf CYCLONE (Ausbau 100000) → Wert 500000, aber hypothekiert → 10 % = 50000.
  g.players[0].properties[1] = { level: 'CYCLONE', mortgaged: true, mortgagedValue: 300000 };
  assert.strictEqual(G.teamWealth(g, 0), 50000, 'Hypothek: nur 10 % des Feldwerts (inkl. Ausbau)');
  // Ohne Hypothek wäre es 500000.
  g.players[0].properties[1].mortgaged = false;
  assert.strictEqual(G.teamWealth(g, 0), 500000, 'ohne Hypothek: voller Wert');
});

test('2m-A Unit: Ausbauwert ist kumulativ über alle erreichten Stufen', () => {
  const g = makeGame([{ name: 'A' }], { capital: 1000000 });
  g.players[0].budget = 0;
  // Feld 1 (400000) auf STORM: Baukosten CYCLONE (100000) + STORM (200000) = 300000.
  g.players[0].properties[1] = { level: 'STORM' };
  assert.strictEqual(G.teamWealth(g, 0), 400000 + 300000, 'STORM: Feld + kumulierte Baukosten');
});

test('2m-A Unit: Bankrotte Teams werden beim reichsten Team übersprungen', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }, { name: 'C' }], { capital: 1000000 });
  g.players[0].budget = 1000000; // reich, aber bankrott
  g.players[0].bankrupt = true;
  g.players[1].budget = 500000;
  g.players[2].budget = 300000;
  assert.strictEqual(G.richestTeamIdx(g), 1, 'bankrottes A wird übersprungen → B');
});

// ---------------------------------------------------------------------
// Wire-Test: Auto-Pause nach Inaktivität (env-konfigurierbar)
// ---------------------------------------------------------------------
const { io: ClientIO } = require('socket.io-client');

const TMPDIR = process.env.TMPDIR || os.tmpdir();
const DB_PATH = path.join(TMPDIR, 'p2m-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.db');
const PORT = 18117;
// Kleine Schwellen für den Test: Inaktivität 400 ms, Sweep alle 100 ms.
process.env.STANTONOPOLY_DB = DB_PATH;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'test';
process.env.STANTONOPOLY_INACTIVE_MS = '400';
process.env.STANTONOPOLY_SWEEP_MS = '100';
process.env.STANTONOPOLY_PAUSED_END_MS = '60000';

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

after(() => {
  try { rooms._stopAutoSweep && rooms._stopAutoSweep(); } catch (e) {}
  try { srv.close && srv.close(); } catch (e) {}
  ALL.forEach((c) => { try { c.disconnect(true); } catch (e) {} });
});

test('2m-A Wire: laufendes Spiel wird nach Inaktivität automatisch pausiert', async () => {
  const gm = track(await connect('p2m-gm'));
  const createdP = once(gm, 'gameCreated');
  gm.emit('gm:create', { config: { teams: 2, capital: 1500000, diceConfig: '1w6', armistice: false, preset: 'Stantonopoly v1' } });
  const ev = await createdP;

  // Je Team ein Spieler beitreten, damit gm:start möglich ist.
  const teamSocks = [];
  for (const token of (ev.tokens || [])) {
    const cs = track(await connect('p2m-t-' + token.teamId));
    const j = once(cs, 'joined');
    cs.emit('team:join', { gameId: ev.gameId, code: token.code, playerName: 'P-' + token.teamId });
    await j; await sleep(40);
    teamSocks.push(cs);
  }

  // Starten → Spiel läuft (paused=false).
  const startedP = waitState(teamSocks[0], (s) => s && s.started === true);
  gm.emit('gm:start', { gameId: ev.gameId, gmCode: ev.gmCode });
  const st = await startedP;
  assert.ok(st && st.started === true, 'Spiel gestartet');
  assert.equal(st.paused, false, 'anfangs nicht pausiert');

  // Keine Aktion → nach Inaktivität (400 ms) + Sweep (100 ms) muss Auto-Pause greifen.
  const pausedP = waitState(teamSocks[0], (s) => s && s.paused === true, 8000);
  const ps = await pausedP;
  assert.ok(ps && ps.paused === true, 'Spiel wurde automatisch pausiert');

  // DB-Flag bestätigen.
  const dbMod = require(path.join(__dirname, '..', 'server', 'db.js'));
  const gRow = dbMod.getGame(ev.gameId);
  assert.equal(gRow.paused, 1, 'DB: paused=1');
  assert.equal(gRow.over, 0, 'DB: nicht beendet (nur pausiert)');
});

test('2m-A Wire: lange pausiertes Spiel wird automatisch beendet, Sieger = reichstes Team', async () => {
  const gm = track(await connect('p2m-end-gm'));
  const createdP = once(gm, 'gameCreated');
  gm.emit('gm:create', { config: { teams: 2, capital: 1500000, diceConfig: '1w6', armistice: false, preset: 'Stantonopoly v1' } });
  const ev = await createdP;

  const teamSocks = [];
  for (const token of (ev.tokens || [])) {
    const cs = track(await connect('p2m-end-t-' + token.teamId));
    const j = once(cs, 'joined');
    cs.emit('team:join', { gameId: ev.gameId, code: token.code, playerName: 'E-' + token.teamId });
    await j; await sleep(40);
    teamSocks.push(cs);
  }
  const startedP = waitState(teamSocks[0], (s) => s && s.started === true);
  gm.emit('gm:start', { gameId: ev.gameId, gmCode: ev.gmCode });
  await startedP; await sleep(80);

  // GM pausiert das Spiel.
  gm.emit('gm:pause', { gameId: ev.gameId, gmCode: ev.gmCode });
  await sleep(120);
  const dbMod = require(path.join(__dirname, '..', 'server', 'db.js'));
  assert.equal(dbMod.getGame(ev.gameId).paused, 1, 'Spiel pausiert');

  // Vermögenswert manipulieren: Team0 reicher machen (Feld 1 + CYCLONE-Ausbau).
  const engine = G.deserialize(dbMod.getGame(ev.gameId).state, D);
  engine.players[0].properties[1] = { level: 'CYCLONE' };
  dbMod.updateState(ev.gameId, { state: engine.serialize(), started: 1, over: 0 });

  // lastPausedAt in der Vergangenheit setzen (älter als PAUSED_END_MS=60000).
  dbMod.db.prepare('UPDATE games SET lastPausedAt = ? WHERE gameId = ?').run(Date.now() - 120000, ev.gameId);

  // Sweep muss das Spiel beenden (over=true) mit Sieger = Team0.
  const overP = waitState(teamSocks[0], (s) => s && s.over === true, 8000);
  const os = await overP;
  assert.ok(os && os.over === true, 'Spiel automatisch beendet');
  assert.ok(os.winnerInfo, 'winnerInfo gesetzt');
  assert.equal(os.winnerInfo.name, engine.players[0].name, 'Sieger = reichstes Team (Team0)');

  const gRow = dbMod.getGame(ev.gameId);
    assert.equal(gRow.over, 1, 'DB: over=1');
  });

  // ---------------------------------------------------------------------
  // (2m-E) Sieger-Modal: Server ergänzt die Platzierung (Sieger → erster
  // Ausscheider) in buildView.ranking.
  // ---------------------------------------------------------------------
  test('2m-E Unit: buildView.ranking listet Sieger zuerst, dann ausgeschiedene Teams', () => {
    const { buildView } = require(path.join(__dirname, '..', 'server', 'rooms.js'));
    const g = makeGame([
      { name: 'Team A', ship: 'Redeemer' },
      { name: 'Team B', ship: 'Hammerhead' },
      { name: 'Team C', ship: 'Reclaimer' },
      { name: 'Team D', ship: 'Caterpillar' }
    ], { capital: 1000000 });
    // D gewinnt (letzter Aktiver); A, B, C sind ausgeschieden.
    g.players[0].bankrupt = true;
    g.players[1].bankrupt = true;
    g.players[2].bankrupt = true;
    g.over = true;
    g.winnerInfo = g.players[3];
    g.players[3].winner = true;
    const teams = g.players.map((p, i) => ({
      teamId: 'team_' + i, ship: p.ship, color: '#fff', teamName: p.name
    }));
    const view = buildView({ gameId: 'G1', game: g, teams, leaders: [] });
    assert.ok(Array.isArray(view.ranking), 'ranking ist ein Array');
    assert.equal(view.ranking.length, 4, 'alle 4 Teams gelistet');
    assert.equal(view.ranking[0].place, 1, 'Platz 1 = Sieger');
    assert.equal(view.ranking[0].winner, true, 'Platz 1 ist der Sieger');
    assert.equal(view.ranking[0].name, 'Team D', 'Sieger = Team D');
    // Ausgeschiedene folgen in Team-Reihenfolge (A, B, C).
    assert.deepStrictEqual(view.ranking.slice(1).map((r) => r.name), ['Team A', 'Team B', 'Team C'],
      'Reihenfolge nach dem Sieger: A, B, C');
    assert.equal(view.ranking[3].bankrupt, true, 'Letzter Platz ist ausgeschieden');
    assert.equal(view.ranking[3].place, 4, 'Letzter Platz = 4.');
  });
