/* =====================================================================
 * Stantonopoly V2 — piraten-wire.test.js
 * (Piratensystem) Wire-Schicht: Socket-Routen pirate:resolve / pirate:confirm
 * und Persistenz der Piraten-Settings über gm:create. Echte socket.io-Clients
 * gegen den In-Process-Server (Wegwerf-DB). AC7 (Settings persistierbar) + Teile
 * von AC2/AC3 auf Wire-Ebene.
 * Start: node --test tests/piraten-wire.test.js
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

test('AC2/AC7: gm:create mit piratesEnabled → 1 Pirat (role pirate, letzter Index) im State', async () => {
  const srv = startServer();
  const url = 'http://localhost:' + srv.port;
  const gm = await connect(url, 'gm');

  const created = await createGame(gm, {
    teams: 2,
    capital: 1500000,
    diceConfig: '1w6',
    armistice: false,
    settings: { piratesEnabled: true, pirateDice: '2w6', pirateProtectionFee: 123000, pirateCaughtMult: 3 }
  });
  const gameId = created.gameId;

  const inv0 = created.tokens.find((t) => t.ship === 'Redeemer').code;
  const inv1 = created.tokens.find((t) => t.ship === 'Hammerhead').code;
  const a = await connect(url, 'A');
  const b = await connect(url, 'B');
  const d = await connect(url, 'D');
  const e = await connect(url, 'E');
  const join = (client, code, name) => new Promise((resolve) => {
    const pj = once(client, 'joined');
    client.emit('team:join', { gameId, code, playerName: name });
    pj.then(resolve);
  });
  await join(a, inv0, 'A'); await join(b, inv0, 'B');
  await join(d, inv1, 'D'); await join(e, inv1, 'E');
  const vote = (client, pid) => client.emit('vote:leader', { gameId, playerId: pid });
  vote(a, a.id); await sleep(30); vote(b, a.id); await sleep(40);
  vote(d, d.id); await sleep(30); vote(e, d.id); await sleep(40);

  let stA = null;
  a.on('state', (st) => { stA = st; });
  const gmStart = once(gm, 'state');
  gm.emit('gm:start', { gameId, gmCode: created.gmCode });
  await gmStart;
  const t0 = Date.now();
  while ((!stA || !stA.started) && Date.now() - t0 < 5000) await sleep(20);
  assert.ok(stA && stA.started, 'Spiel gestartet');

  const players = stA.game.players;
  const pir = players[players.length - 1];
  assert.strictEqual(pir.role, 'pirate', 'Pirat-Team hat role=pirate');
  assert.ok(pir.isPirate, 'Pirat-Team ist markiert');
  assert.strictEqual(pir.budget, 0, 'Pirat ohne Kapital (kaufunfähig)');
  assert.strictEqual(stA.game.settings.piratesEnabled, true, 'Piraten-Setting persistiert im State');
  assert.strictEqual(stA.game.settings.pirateDice, '2w6', 'Piraten-Würfel persistiert');

  // AC2: Pirat ist NIE aktiver Zug (activeIdx nur über normale Teams).
  assert.ok(stA.game.activeIdx < players.length - 1, 'Pirat ist nicht der aktive Index');

  [gm, a, b, d, e].forEach((c_) => c_.disconnect());
  srv.stop();
});

test('P4: team:join mit Piraten-Code → Mitglied von PIRATES; Pirat fällt Urteil, GM hat keinen Sonder-Pfad', async () => {
  const srv = startServer();
  const url = 'http://localhost:' + srv.port;
  const gm = await connect(url, 'gm');
  const created = await createGame(gm, {
    teams: 2,
    capital: 1500000,
    diceConfig: '1w6',
    armistice: false,
    settings: { piratesEnabled: true, pirateProtectionFee: 100000, pirateCaughtMult: 2 }
  });
  const gameId = created.gameId;
  // (P4) Der GM bekommt den Piraten-Einladungs-Code und verteilt ihn (eigener Token-Eintrag).
  const pirateTok = created.tokens.find((t) => t.isPirate);
  assert.ok(pirateTok, 'GM erhält den Piraten-Einladungs-Code im tokens-Array');
  assert.strictEqual(pirateTok.teamId, 'PIRATES');
  assert.ok(pirateTok.code && pirateTok.code.length, 'Piraten-Code ist gesetzt');

  const inv0 = created.tokens.find((t) => t.ship === 'Redeemer').code;
  const inv1 = created.tokens.find((t) => t.ship === 'Hammerhead').code;
  const a = await connect(url, 'A'); const b = await connect(url, 'B');
  const d = await connect(url, 'D'); const e = await connect(url, 'E');
  const p = await connect(url, 'Pirat');
  const join = (client, code, name) => new Promise((resolve) => {
    const pj = once(client, 'joined');
    client.emit('team:join', { gameId, code, playerName: name });
    pj.then(resolve);
  });
  // Normale Teams + EIN Spieler tritt mit dem Piraten-Code bei.
  await join(a, inv0, 'A'); await join(b, inv0, 'B');
  await join(d, inv1, 'D'); await join(e, inv1, 'E');
  const joinedPirate = await join(p, pirateTok.code, 'Pirat');
  assert.strictEqual(joinedPirate.teamId, 'PIRATES', 'Pirat-Spieler wird Mitglied von PIRATES via team:join');
  const vote = (client, pid) => client.emit('vote:leader', { gameId, playerId: pid });
  vote(a, a.id); await sleep(30); vote(b, a.id); await sleep(40);
  vote(d, d.id); await sleep(30); vote(e, d.id); await sleep(40);

  let stA = null;
  a.on('state', (st) => { stA = st; });
  const gmStart = once(gm, 'state');
  gm.emit('gm:start', { gameId, gmCode: created.gmCode });
  await gmStart;
  const t0 = Date.now();
  while ((!stA || !stA.started) && Date.now() - t0 < 5000) await sleep(20);
  assert.ok(stA && stA.started, 'Spiel gestartet');

  // try/finally: Assert-Fehler dürfen die Suite nicht hängen lassen.
  try {
    const players = stA.game.players;
    const fieldsLen = stA.game.fields.length;
    const actIdx = stA.game.activeIdx;
    const actor = (actIdx === 0) ? a : d;   // Leiter des aktiven Teams
    const pirPos = players[players.length - 1].pos;
    const delta = ((pirPos - players[actIdx].pos) % fieldsLen + fieldsLen) % fieldsLen;
    // Determinismus: freier Würfel exakt bis zum Piraten-Feld.
    gm.emit('gm:deploy', { gameId, gmCode: created.gmCode, configPatch: { diceConfig: { kind: 'frei', freeValue: delta } } });
    await sleep(80);

    // (1) Team landet auf dem Piraten-Feld → Begegnung → Flucht → Urteil offen.
    const stRollP = once(actor, 'state');
    actor.emit('action:roll', { gameId });
    const stRoll = await stRollP;
    assert.ok(stRoll.game.pirateEncounter, 'Begegnung ausgelöst');
    const stFleeP = once(actor, 'state');
    actor.emit('pirate:resolve', { gameId, choice: 'flee' });
    const stFlee = await stFleeP;
    assert.ok(stFlee.game.pirateVerdict, 'Piraten-Urteil (Erwischt/Entwischt) steht offen');
    // Das fliehende Team ist serverseitig per pirateVerdict.teamIdx verankert
    // (nicht per Anfangszahl-`actIdx`, der je Vote-Randomisierung variiert).
    const fleeTeamIdx = stFlee.game.pirateVerdict.teamIdx;

    // (2) P4-Kern: Das PIRATES-MITGLIED fällt das Urteil (kein gmCode mehr nötig).
    // Race-sicher: p's eingehende States in einer Variable sammeln und auf Zustands-
    // Übergänge WARTEN (statt `once` zu registrieren, das den noch unterwegs
    // befindlichen flee-Broadcast abfangen könnte). Erst wenn p das offene Urteil
    // sieht, wird das Confirm gesendet; dann bis zur Auflösung warten.
    let pst = null;
    p.on('state', (s) => { pst = s; });
    const tD = Date.now();
    while ((!pst || !pst.game.pirateVerdict) && Date.now() - tD < 5000) await sleep(20);
    assert.ok(pst && pst.game.pirateVerdict, 'p (Pirat) sieht das offene Urteil');
    p.emit('pirate:confirm', { gameId, verdict: 'escaped' });
    const tE = Date.now();
    while ((!pst || pst.game.pirateVerdict || pst.game.players[fleeTeamIdx] === undefined) && Date.now() - tE < 5000) await sleep(20);
    assert.ok(pst && !pst.game.pirateVerdict, 'Urteil erledigt (p sah die Auflösung)');
    // Das Feld `fleeing` wird vom Serialisierer bei false als "default" gedroppt
    // (undefined === gleichbedeutend "nicht fliehend"). Prüfe daher auf NICHT-fliehend.
    assert.ok(!pst.game.players[fleeTeamIdx].fleeing, 'Pirat-Mitglied bestätigt Entwischt → Team frei');

    // (3) GM hat KEINEN Sonder-Pfad mehr: Der GM-Code allein rechtfertigt KEIN Urteil.
    const plain = await connect(url, 'plain');
    const errGm = once(plain, 'error', 5000);
    plain.emit('pirate:confirm', { gameId, verdict: 'caught' });
    let cerrGm = null;
    try { cerrGm = await errGm; } catch (_) {}
    assert.ok(cerrGm, 'Nicht-Pirat-Socket darf kein Urteil fällen');
    assert.ok(['NOT_IN_TEAM', 'FORBIDDEN'].includes(cerrGm.code), 'GM-Pfad entfernt: Ablehnung (got ' + (cerrGm && cerrGm.code) + ')');
    plain.disconnect();
  } finally {
    [gm, a, b, d, e, p].forEach((c_) => c_.disconnect());
    srv.stop();
  }
});

// ---------------------------------------------------------------------
// AC3/AC4 auf Wire-Ebene (Review-Korrektur Runde 1): echte Landung auf dem
// Piraten-Feld → Begegnung → 'flee' beendet die Runde SERVERSEITIG, der
// fliehende Leiter darf nicht würfeln, und beim Erreichen der nächsten Runde
// ohne „Entwischt“ greift automatisch das erhöhte Strafgeld.
// Der Wurf wird über gm:deploy deterministisch gemacht (freier Würfel = Abstand
// zum Piraten-Feld), damit die Landung reproduzierbar ist.
// ---------------------------------------------------------------------
test('Wire/AC4: Piraten-Begegnung → flee beendet Runde (Würfeln gesperrt) → automatisch erwischt', async () => {
  const srv = startServer();
  const url = 'http://localhost:' + srv.port;
  const gm = await connect(url, 'gm');
  const created = await createGame(gm, {
    teams: 2,
    capital: 1500000,
    diceConfig: '1w6',
    armistice: false,
    settings: { piratesEnabled: true, pirateDice: '1w6', pirateProtectionFee: 100000, pirateCaughtMult: 2 }
  });
  const gameId = created.gameId;
  const inv0 = created.tokens.find((t) => t.ship === 'Redeemer').code;
  const inv1 = created.tokens.find((t) => t.ship === 'Hammerhead').code;
  const a = await connect(url, 'A'); const b = await connect(url, 'B');
  const d = await connect(url, 'D'); const e = await connect(url, 'E');
  const join = (client, code, name) => new Promise((resolve) => {
    const pj = once(client, 'joined');
    client.emit('team:join', { gameId, code, playerName: name });
    pj.then(resolve);
  });
  await join(a, inv0, 'A'); await join(b, inv0, 'B');
  await join(d, inv1, 'D'); await join(e, inv1, 'E');
  const vote = (client, pid) => client.emit('vote:leader', { gameId, playerId: pid });
  vote(a, a.id); await sleep(30); vote(b, a.id); await sleep(40);
  vote(d, d.id); await sleep(30); vote(e, d.id); await sleep(40);

  let stA = null;
  a.on('state', (st) => { stA = st; });
  const gmStart = once(gm, 'state');
  gm.emit('gm:start', { gameId, gmCode: created.gmCode });
  await gmStart;
  const t0 = Date.now();
  while ((!stA || !stA.started) && Date.now() - t0 < 5000) await sleep(20);
  assert.ok(stA && stA.started, 'Spiel gestartet');

  // try/finally: ein fehlgeschlagener Assert darf die Suite nicht hängen lassen
  // (offene Sockets würden den Test-Runner sonst am Ende blockieren).
  try {
  const players = stA.game.players;
  const fieldsLen = stA.game.fields.length;
  const actIdx = stA.game.activeIdx;
  assert.ok(actIdx < players.length - 1, 'aktives Team ist ein normales Team');
  const actor = (actIdx === 0) ? a : d;   // Leiter des aktiven Teams (Team 0 = a, Team 1 = d)
  const other = (actIdx === 0) ? d : a;
  const pirPos = players[players.length - 1].pos;
  const delta = ((pirPos - players[actIdx].pos) % fieldsLen + fieldsLen) % fieldsLen;
  // Determinismus: freier Würfel mit exakt dieser Augenzahl → Landung auf dem Piraten-Feld.
  gm.emit('gm:deploy', { gameId, gmCode: created.gmCode, configPatch: { diceConfig: { kind: 'frei', freeValue: delta } } });
  await sleep(80);

  // (1) Wurf → Landung auf dem Piraten-Feld → Begegnung.
  const stRollP = once(actor, 'state');
  actor.emit('action:roll', { gameId });
  const stRoll = await stRollP;
  assert.ok(stRoll.game.pirateEncounter, 'Begegnung nach Landung auf dem Piraten-Feld');
  assert.strictEqual(stRoll.game.pirateEncounter.teamIdx, actIdx, 'Begegnung trifft das aktive Team');
  assert.strictEqual(stRoll.game.pirateEncounter.fee, 100000, 'Schutzgeld aus den Settings');

  // (2) Fliehen → die Runde endet serverseitig, Zug geht an das andere Team.
  const stFleeP = once(actor, 'state');
  actor.emit('pirate:resolve', { gameId, choice: 'flee' });
  const stFlee = await stFleeP;
  assert.strictEqual(stFlee.game.players[actIdx].fleeing, true, 'Team ist auf der Flucht');
  assert.notStrictEqual(stFlee.game.activeIdx, actIdx, 'Runde sofort beendet → Zug beim anderen Team');
  assert.ok(stFlee.game.pirateVerdict, 'Piraten-Urteil (Erwischt/Entwischt) steht offen');

  // (3) Der fliehende Leiter darf NICHT würfeln (nicht mehr am Zug / gesperrt).
  const errP = once(actor, 'error', 5000);
  actor.emit('action:roll', { gameId });
  let err = null;
  try { err = await errP; } catch (_) {}
  assert.ok(err, 'Würfeln während der Flucht wird abgelehnt');
  assert.ok(['FLEEING', 'NOT_YOUR_TURN'].includes(err.code), 'Ablehnung (got ' + (err && err.code) + ')');
  const posAfterErr = stFlee.game.players[actIdx].pos;

  // (4) Nächste Runde des fliehenden Teams ohne „Entwischt“ → automatisch erwischt.
  const stAutoP = once(other, 'state');
  other.emit('action:nextTurn', { gameId });
  const stAuto = await stAutoP;
  assert.ok(!stAuto.game.players[actIdx].fleeing, 'automatisch erwischt → Flucht beendet');
  assert.strictEqual(stAuto.game.activeIdx, actIdx, 'Zug liegt wieder beim freien Team');
  assert.strictEqual(stAuto.game.players[actIdx].budget, 1500000 - 200000, 'Strafgeld 2×100000 automatisch gezahlt');
  assert.strictEqual(stAuto.game.players[actIdx].pos, posAfterErr, 'abgelehnter Wurf hat die Position nicht verändert');
  } finally {
    [gm, a, b, d, e].forEach((c_) => c_.disconnect());
    srv.stop();
  }
});
