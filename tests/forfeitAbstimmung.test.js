/* =====================================================================
 * Stantonopoly V2 — t_3d729454: Aufgaben-Abstimmung
 * P5  Einzel-Team (1 Mitglied) → Abstimmung übersprungen, SOFORT aufgeben
 *     (kein Poll/Timer/Modal, server-authoritativ).
 * P6  Abstimmungs-Starter zählt automatisch JA (kein eigenes Modal; die
 *     Modal-Ausblendung selbst ist clientseitig in renderForfeitPollUI).
 * P7  Durch Aufgabe ausgeschieden → Endresultat/Ranking zeigt „durch
 *     Aufgabe verloren“ + echten Rest-Budget + echte Liegenschaften
 *     (nicht 0/leer gesetzt).
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

const path = require('path');
// db.js liest STANTONOPOLY_DB beim Modul-Load — daher NUR lazy laden,
// NACHDEM startServer() die Wegwerf-DB gesetzt hat (sonst öffnet sich die echte DB).
function dbm() { return require(path.join(PROJ, 'server', 'db.js')); }

/** Spieler-Zustand deterministisch per DB mutieren (wirkt bei der NÄCHSTEN
 *  Aktion, da rooms beim Handle neu deserialisiert). */
function setPlayer(gameId, idx, patch) {
  const row = dbm().getGame(gameId);
  const g = JSON.parse(row.state);
  Object.assign(g.players[idx], patch);
  dbm().updateState(gameId, { state: JSON.stringify(g) });
}

/** Standard-Start: gm erzeugt Spiel, A(+B) in Team0, D in Team1, Leiter, Start. */
async function bootGame({ team0Players = ['A'], team1Players = ['D'] } = {}) {
  const srv = startServer();
  const url = 'http://localhost:' + srv.port;
  const gm = await connect(url, 'gm');
  const created = await createGame(gm, { teams: 2, capital: 1500000, diceConfig: '1w6', armistice: false });
  const gameId = created.gameId;

  const inv0 = created.tokens.find((t) => t.ship === 'Redeemer').code;
  const inv1 = created.tokens.find((t) => t.ship === 'Hammerhead').code;

  const members0 = {}, members1 = {};
  for (const name of team0Players) {
    const c = await connect(url, name + '-T0');
    await new Promise((res) => { c.emit('team:join', { gameId, code: inv0, playerName: name }); c.once('joined', res); });
    members0[name] = c;
  }
  for (const name of team1Players) {
    const c = await connect(url, name + '-T1');
    await new Promise((res) => { c.emit('team:join', { gameId, code: inv1, playerName: name }); c.once('joined', res); });
    members1[name] = c;
  }

  // Leiter wählen
  members0[team0Players[0]].emit('vote:leader', { gameId, playerId: members0[team0Players[0]].id });
  await sleep(30);
  members1[team1Players[0]].emit('vote:leader', { gameId, playerId: members1[team1Players[0]].id });
  await sleep(50);

  gm.emit('gm:start', { gameId, gmCode: created.gmCode });
  await once(gm, 'state');
  await sleep(80);

  return { srv, url, gm, gameId, members0, members1, created };
}

function startListener(client) {
  const state = { last: null };
  client.on('state', (st) => { state.last = st; });
  return state;
}

async function grantTeam(gameId, idx, budget, props) {
  const row = dbm().getGame(gameId);
  const g = JSON.parse(row.state);
  g.players[idx].budget = budget;
  g.players[idx].properties = props;
  dbm().updateState(gameId, { state: JSON.stringify(g) });
}

// ---------------------------------------------------------------------
// P5 + P7: Einzel-Team gibt SOFORT auf (kein Poll/Timer), Endresultat
// zeigt „durch Aufgabe verloren“ + echten Stand.
// ---------------------------------------------------------------------
test('P5/P7: Einzel-Team (1 Mitglied) gibt sofort auf — kein Poll, echte Werte im Endresultat', async () => {
  const { srv, gm, gameId, members0, members1 } = await bootGame({ team0Players: ['A'], team1Players: ['D'] });
  const a = members0['A'];

  // Echten Wirtschaftsstand prägen: Budget + 2 Liegenschaften.
  await grantTeam(gameId, 0, 777000, { '1': { level: 'ALLEIN' }, '2': { level: 'ALLEIN' } });

  const st = startListener(a);

  // SOFORT aufgeben messen (kein Timer/kein Modal → synchron).
  const t0 = Date.now();
  let detected = null;
  const done = new Promise((res) => {
    const iv = setInterval(() => {
      if (st.last && st.last.game && st.last.game.players && st.last.game.players[0].bankrupt) {
        detected = Date.now() - t0;
        clearInterval(iv); res();
      }
    }, 5);
    setTimeout(() => { if (detected == null) { clearInterval(iv); res(); } }, 3000);
  });
  a.emit('action:forfeit', { gameId });
  await done;

  assert.ok(detected != null, 'Forfeit wurde propagiert (tatsaechlich: ' + detected + ')');
  assert.ok(detected < 200, 'Einzel-Team gibt SOFORT auf (<200ms, got ' + detected + 'ms)');
  assert.ok(st.last.game.forfeitPoll == null, 'kein Poll erzeugt (forfeitPoll == null)');

  const p0 = st.last.game.players[0];
  assert.strictEqual(p0.bankrupt, true, 'Einzel-Team ist aufgegeben');
  assert.strictEqual(p0.forfeited, true, 'forfeit-Flag gesetzt');
  assert.strictEqual(p0.budget, 777000, 'Rest-Budget echt erhalten (nicht 0)');
  assert.deepStrictEqual(p0.properties, { '1': { level: 'ALLEIN' }, '2': { level: 'ALLEIN' } }, 'Liegenschaften echt erhalten');

  // Spiel beendet (nur Team1 übrig) → Endresultat/Ranking verfügbar.
  assert.strictEqual(st.last.over, true, 'Spiel beendet');
  const forfeited = st.last.ranking.find((r) => r.forfeited);
  assert.ok(forfeited, 'forfeit-Team in Ranking');
  assert.strictEqual(forfeited.budget, 777000, 'Ranking zeigt echten Rest-Budget');
  assert.deepStrictEqual(forfeited.properties, { '1': { level: 'ALLEIN' }, '2': { level: 'ALLEIN' } }, 'Ranking zeigt echte Liegenschaften');
  assert.strictEqual(forfeited.place, 2, 'forfeit-Team landet hinter dem Sieger');

  [gm, a, members1['D']].forEach((c_) => { try { c_.disconnect(); } catch (e) {} });
  srv.stop();
});

// ---------------------------------------------------------------------
// P6 + P7: Starter zählt automatisch JA; andere Mitglieder dürfen stimmen;
// nach Mehrheits-Aufgabe bleiben Budget + Liegenschaften erhalten.
// ---------------------------------------------------------------------
test('P6/P7: Mehrspieler-Poll — Starter zählt Auto-JA, B stimmt, Forfeit erhält echten Stand', async () => {
  const { srv, gm, gameId, members0, members1 } = await bootGame({ team0Players: ['A', 'B'], team1Players: ['D'] });
  const a = members0['A'];
  const b = members0['B'];

  // Echten Stand für Team0 prägen.
  await grantTeam(gameId, 0, 555000, { '3': { level: 'ALLEIN' } });

  const st = startListener(b);

  // A startet die Abstimmung → Poll entsteht (Mehrspieler), Starter = Auto-JA.
  a.emit('action:forfeit', { gameId });
  await sleep(250);

  const poll = st.last.game.forfeitPoll;
  assert.ok(poll, 'Poll erzeugt (Mehrspieler-Team); got ' + JSON.stringify(st.last.game.forfeitPoll));
  assert.strictEqual(poll.memberCount, 2, '2 Mitglieder zählen');
  assert.strictEqual(poll.votes[String(a.id)], 1, 'Starter zählt automatisch als JA');
  assert.strictEqual(Object.keys(poll.votes).length, 1, 'nur der Starter hat (automatisch) gestimmt');
  assert.strictEqual(String(poll.startedBy), String(a.id), 'Starter ist a');

  // B stimmt JA → 2/2 → sofort auflösen → Team gibt auf.
  b.emit('forfeit:vote', { gameId, agree: 1 });
  await sleep(250);

  assert.ok(st.last.game.forfeitPoll == null, 'Poll nach kompletter Abstimmung aufgelöst');
  const p0 = st.last.game.players[0];
  assert.strictEqual(p0.bankrupt, true, 'Team hat per Mehrheit aufgegeben');
  assert.strictEqual(p0.forfeited, true, 'forfeit-Flag gesetzt');
  assert.strictEqual(p0.budget, 555000, 'Rest-Budget echt erhalten (nicht 0)');
  assert.deepStrictEqual(p0.properties, { '3': { level: 'ALLEIN' } }, 'Liegenschaften echt erhalten');
  assert.strictEqual(st.last.over, true, 'Spiel beendet (Team1 gewinnt)');

  const forfeited = st.last.ranking.find((r) => r.forfeited);
  assert.ok(forfeited && forfeited.budget === 555000, 'Ranking führt forfeit-Team mit echtem Budget');
  assert.deepStrictEqual(forfeited.properties, { '3': { level: 'ALLEIN' } }, 'Ranking zeigt echte Liegenschaften');

  [gm, a, b, members1['D']].forEach((c_) => { try { c_.disconnect(); } catch (e) {} });
  srv.stop();
});
