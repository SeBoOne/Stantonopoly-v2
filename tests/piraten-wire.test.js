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

// ---------------------------------------------------------------------
// (Piraten-Fix) Endauswertung: Der Pirat erscheint NICHT als reguläres Team
// in der Platzierung (kein Budget/Gewinner) — nur als Statistik der
// Gesamterbeute (loot). gameResult liefert daher nur die normalen Teams in
// `players` plus ein separates `pirateLoot`.
// ---------------------------------------------------------------------
test('gameResult: Pirat nur als loot-Statistik, nicht in der Team-Platzierung', async () => {
  const srv = startServer();
  const url = 'http://localhost:' + srv.port;
  const gm = await connect(url, 'gm');
  const created = await createGame(gm, {
    teams: 2, capital: 1500000, diceConfig: '1w6', armistice: false,
    settings: { piratesEnabled: true, pirateProtectionFee: 100000, pirateCaughtMult: 2 }
  });
  const gameId = created.gameId;
  const pirateTok = created.tokens.find((t) => t.isPirate);
  const inv0 = created.tokens.find((t) => t.ship === 'Redeemer').code;
  const inv1 = created.tokens.find((t) => t.ship === 'Hammerhead').code;
  const a = await connect(url, 'A'); const b = await connect(url, 'B');
  const d = await connect(url, 'D'); const e = await connect(url, 'E');
  const p = await connect(url, 'Pirat');
  const join = (cl, code, name) => new Promise((res) => { const pj = once(cl, 'joined'); cl.emit('team:join', { gameId, code, playerName: name }); pj.then(res); });
  await join(a, inv0, 'A'); await join(b, inv0, 'B'); await join(d, inv1, 'D'); await join(e, inv1, 'E');
  await join(p, pirateTok.code, 'Pirat');
  try {
    // Spiel starten (gm:start) — gameResult prüft auf `over`/`players`.
    const vote = (cl, pid) => cl.emit('vote:leader', { gameId, playerId: pid });
    vote(a, a.id); await sleep(30); vote(b, a.id); await sleep(30);
    vote(d, d.id); await sleep(30); vote(e, d.id); await sleep(40);
    let stA = null; a.on('state', (s) => { stA = s; });
    const gmStart = once(gm, 'state'); gm.emit('gm:start', { gameId, gmCode: created.gmCode });
    const t0 = Date.now(); while ((!stA || !stA.started) && Date.now() - t0 < 5000) await sleep(20);
    assert.ok(stA && stA.started, 'Spiel gestartet');
    assert.strictEqual(stA.game.players.length, 3, '2 normale Teams + 1 Pirat im Engine-State');

    // gameResult: Pirat gefiltert, nur 2 normale Teams, loot integriert.
    const r = srv.rooms.gameResult(gameId);
    assert.ok(r, 'gameResult vorhanden');
    assert.strictEqual(r.players.length, 2, 'Pirat nicht in der Team-Platzierung');
    const ships = (r.players || []).map((x) => String(x.ship || ''));
    assert.ok(!ships.some((s) => /pirat/i.test(s)), 'kein PIRATEN-Ship unter den Teams: ' + JSON.stringify(ships));
    assert.ok(!/pirat/i.test(r.players.map((x) => x.name).join(' ')), 'kein Piraten-Name in der Team-Tabelle');
    assert.strictEqual(r.players[0].ship, 'Redeemer', 'ship bleibt dem richtigen Team zugeordnet');
    assert.ok(r.players.every((x) => x._isPirate === undefined), 'interne _isPirate-Marker nicht nach außen');
    assert.strictEqual(r.pirateLoot, 0, 'ohne Begegnung ist loot 0');
  } finally {
    [gm, a, b, d, e, p].forEach((c_) => c_.disconnect());
    srv.stop();
  }
});

// ---------------------------------------------------------------------
// P9 (Team-Mechanik Runde): Piraten-Team braucht einen Teamleader wie normale
// Teams. 1) Erster Piraten-Join setzt leaderId, 2) Pirat-vote (auch WÄHREND des
// Spiels) setzt den Leiter, 3) der GM kann einen Piraten-Leader per gm:setleader
// ernennen.
// ---------------------------------------------------------------------
test('P9: join setzt Piraten-leader → Pirat-vote setzt leader → GM-Ernennung setzt leader', async () => {
  const srv = startServer();
  const url = 'http://localhost:' + srv.port;
  const gm = await connect(url, 'gm');
  const created = await createGame(gm, {
    teams: 2, capital: 1500000, diceConfig: '1w6', armistice: false,
    settings: { piratesEnabled: true, pirateProtectionFee: 100000, pirateCaughtMult: 2 }
  });
  const gameId = created.gameId;
  const pirateTok = created.tokens.find((t) => t.isPirate);
  const inv0 = created.tokens.find((t) => t.ship === 'Redeemer').code;
  const inv1 = created.tokens.find((t) => t.ship === 'Hammerhead').code;
  const a = await connect(url, 'A'); const d = await connect(url, 'D');
  const p1 = await connect(url, 'Pirat1'); const p2 = await connect(url, 'Pirat2');
  const join = (cl, code, name) => new Promise((res) => { const pj = once(cl, 'joined'); cl.emit('team:join', { gameId, code, playerName: name }); pj.then(res); });
  const waitState = async (getFn, pred, timeoutMs = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { const s = getFn(); if (s && pred(s)) return s; await sleep(25); }
    throw new Error('waitState-Timeout: Zustand nicht erreicht');
  };
  try {
    // Normale Teams beitreten → Spiel starten (Piraten treten später während des Spiels bei).
    await join(a, inv0, 'A'); await join(d, inv1, 'D');
    const vote = (cl, pid) => cl.emit('vote:leader', { gameId, playerId: pid });
    vote(a, a.id); await sleep(30); vote(d, d.id); await sleep(40);
    let stGm = null; gm.on('state', (s) => { stGm = s; });
    gm.emit('gm:start', { gameId, gmCode: created.gmCode });
    await waitState(() => stGm, (s) => s.started);
    assert.ok(stGm.started, 'Spiel gestartet');

    // (1) P9: Erster Piraten-Join → er ist der Piraten-Leader.
    await join(p1, pirateTok.code, 'Pirat1');
    await waitState(() => stGm, (s) => s.pirate && s.pirate.leaderId === p1.id);
    assert.strictEqual(stGm.pirate.leaderId, p1.id, 'erster Piraten-Join = Piraten-Leader');

    // (2) P9: Ein weiterer Pirat tritt bei und VOTED (während des Spiels) → Leader wechselt sofort.
    await join(p2, pirateTok.code, 'Pirat2');
    await waitState(() => stGm, (s) => s.pirate && s.pirate.players && s.pirate.players.length === 2);
    p2.emit('vote:leader', { gameId, playerId: p2.id });
    await waitState(() => stGm, (s) => s.pirate && s.pirate.leaderId === p2.id);
    assert.strictEqual(stGm.pirate.leaderId, p2.id, 'Pirat-vote (während des Spiels) setzt den Leiter');

    // (3) P9: GM ernennt den Piraten-Leader zurück zu P1 (gm:setleader).
    gm.emit('gm:setleader', { gameId, gmCode: created.gmCode, teamId: 'PIRATES', playerId: p1.id });
    await waitState(() => stGm, (s) => s.pirate && s.pirate.leaderId === p1.id);
    assert.strictEqual(stGm.pirate.leaderId, p1.id, 'GM-Ernennung setzt Piraten-Leader');
  } finally {
    [gm, a, d, p1, p2].forEach((c_) => c_.disconnect());
    srv.stop();
  }
});

// ---------------------------------------------------------------------
// P7 (Team-Mechanik Runde): Piraten können AUFGEBEN. Hier: EIN einzelnes
// Piraten-Mitglied gibt (ohne Abstimmung) sofort auf → die Piraten-Figur wird
// aus players entfernt (bankrupt), st.pirate verschwindet (st.pirate = null),
// das Spiel läuft OHNE Piraten-Mechanik weiter.
// ---------------------------------------------------------------------
test('P7: einzelnes Piraten-Team gibt auf (sofort) → Pirat entfernt, st.pirate=null', async () => {
  const srv = startServer();
  const url = 'http://localhost:' + srv.port;
  const gm = await connect(url, 'gm');
  const created = await createGame(gm, {
    teams: 2, capital: 1500000, diceConfig: '1w6', armistice: false,
    settings: { piratesEnabled: true, pirateProtectionFee: 100000, pirateCaughtMult: 2 }
  });
  const gameId = created.gameId;
  const pirateTok = created.tokens.find((t) => t.isPirate);
  const inv0 = created.tokens.find((t) => t.ship === 'Redeemer').code;
  const inv1 = created.tokens.find((t) => t.ship === 'Hammerhead').code;
  const a = await connect(url, 'A'); const d = await connect(url, 'D');
  const p = await connect(url, 'Pirat');
  const join = (cl, code, name) => new Promise((res) => { const pj = once(cl, 'joined'); cl.emit('team:join', { gameId, code, playerName: name }); pj.then(res); });
  const waitState = async (getFn, pred, timeoutMs = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { const s = getFn(); if (s && pred(s)) return s; await sleep(25); }
    throw new Error('waitState-Timeout: Zustand nicht erreicht');
  };
  try {
    await join(a, inv0, 'A'); await join(d, inv1, 'D');
    const vote = (cl, pid) => cl.emit('vote:leader', { gameId, playerId: pid });
    vote(a, a.id); await sleep(30); vote(d, d.id); await sleep(40);
    await join(p, pirateTok.code, 'Pirat');
    let stGm = null; gm.on('state', (s) => { stGm = s; });
    gm.emit('gm:start', { gameId, gmCode: created.gmCode });
    await waitState(() => stGm, (s) => s.started && s.pirate && !!s.pirate.leaderId);
    assert.ok(stGm.pirate.leaderId === p.id, 'Pirat ist Leader (einzelnes Mitglied)');

    // Einzelnen Piraten aufgeben lassen → sofort (keine Abstimmung).
    p.emit('action:forfeit', { gameId });
    await waitState(() => stGm, (s) => {
      if (s.pirate) return false;
      const pir = ((s.game && s.game.players) || []).find((pp) => pp.role === 'pirate' || pp.isPirate);
      return !!(pir && pir.bankrupt === true);
    });
    assert.strictEqual(stGm.pirate, null, 'st.pirate verschwindet nach Aufgeben (st.pirate = null)');
    // Neustarten-Gate: Das Spiel läuft OHNE Piraten weiter (normale Teams aktiv).
    const pirLive = (stGm.game.players || []).find((pp) => (pp.role === 'pirate' || pp.isPirate) && !pp.bankrupt);
    assert.ok(!pirLive, 'kein aktives Piraten-Team mehr in players[]');
    assert.strictEqual(stGm.over, false, 'Spiel läuft ohne Piraten weiter');
  } finally {
    [gm, a, d, p].forEach((c_) => c_.disconnect());
    srv.stop();
  }
});

// ---------------------------------------------------------------------
// P7 (letzter-Leave): Der LETZTE Piraten-Spieler verlässt das Team → die
// Piraten-Figur wird entfernt (forfeitPirates), die Piraten-Mechanik endet.
// ---------------------------------------------------------------------
test('P7: letzter Piraten-Spieler verlässt das Team → Pirat entfernt', async () => {
  const srv = startServer();
  const url = 'http://localhost:' + srv.port;
  const gm = await connect(url, 'gm');
  const created = await createGame(gm, {
    teams: 2, capital: 1500000, diceConfig: '1w6', armistice: false,
    settings: { piratesEnabled: true, pirateProtectionFee: 100000, pirateCaughtMult: 2 }
  });
  const gameId = created.gameId;
  const pirateTok = created.tokens.find((t) => t.isPirate);
  const inv0 = created.tokens.find((t) => t.ship === 'Redeemer').code;
  const inv1 = created.tokens.find((t) => t.ship === 'Hammerhead').code;
  const a = await connect(url, 'A'); const d = await connect(url, 'D');
  const p = await connect(url, 'Pirat');
  const join = (cl, code, name) => new Promise((res) => { const pj = once(cl, 'joined'); cl.emit('team:join', { gameId, code, playerName: name }); pj.then(res); });
  const waitState = async (getFn, pred, timeoutMs = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { const s = getFn(); if (s && pred(s)) return s; await sleep(25); }
    throw new Error('waitState-Timeout: Zustand nicht erreicht');
  };
  try {
    await join(a, inv0, 'A'); await join(d, inv1, 'D');
    const vote = (cl, pid) => cl.emit('vote:leader', { gameId, playerId: pid });
    vote(a, a.id); await sleep(30); vote(d, d.id); await sleep(40);
    await join(p, pirateTok.code, 'Pirat');
    let stGm = null; gm.on('state', (s) => { stGm = s; });
    gm.emit('gm:start', { gameId, gmCode: created.gmCode });
    await waitState(() => stGm, (s) => s.started && s.pirate && !!s.pirate.leaderId);
    assert.strictEqual(stGm.pirate.leaderId, p.id, 'Pirat ist Leader vor dem Leave');

    // Letzter Piraten-Spieler verlässt (confirm=true) → Piraten-Figur wird entfernt.
    const leftP = once(p, 'left');
    p.emit('game:leave', { gameId, confirm: true });
    await leftP;
    await waitState(() => stGm, (s) => s.started && s.pirate === null);
    const pirLive = (stGm.game.players || []).find((pp) => (pp.role === 'pirate' || pp.isPirate) && !pp.bankrupt);
    assert.ok(!pirLive, 'kein aktives Piraten-Team nach letztem Leave');
    assert.strictEqual(stGm.over, false, 'Spiel läuft für die normalen Teams weiter');
  } finally {
    [gm, a, d, p].forEach((c_) => c_.disconnect());
    srv.stop();
  }
});

// ---------------------------------------------------------------------
// P8 (Statischer Client-Check): Der Client rendert ein Piraten-Teammitglied als
// Piratenteam (🏴‍☠️, KEIN 'Beobachter') und blendet Wirtschaft/Handel/Auktion
// für Piraten aus (diese Panels rendern nur für normale Teams in st.teams).
// ---------------------------------------------------------------------
test('P8 (statisch): Client rendert Piratenteam-Panel statt Beobachter + blendet Wirtschaft/Handel/Auktion aus', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'js', 'client.js'), 'utf8');
  // (a) renderPlayerPanel hat einen Piraten-Zweig VOR dem 'Beobachter'-Fallback.
  const piratePanelIdx = src.indexOf('renderPiratePlayerPanel(panel, st)');
  const beobachterIdx = src.indexOf("panel.innerHTML = '<div>Beobachter: keine eigene Mannschaft.</div>'");
  assert.ok(piratePanelIdx >= 0, 'renderPlayerPanel ruft ein Piraten-Team-Panel auf (kein Beobachter-Fallback für PIRATES)');
  assert.ok(piratePanelIdx < beobachterIdx, 'Piraten-Zweig steht VOR dem Beobachter-Fallback');
  // (b) Das Piraten-Panel labelt als Piratenteam mit Marker 🏴‍☠️.
  assert.ok(/🏴‍☠️/.test(src), 'Piraten-Team wird mit dem Piraten-Marker 🏴‍☠️ labelt');
  // (c) Wirtschaft/Handel/Auktion-Panels rendern nur für normale Teams (idx<0 → früh return/hidden).
  assert.ok(/function renderEconBar[\s\S]{0,600}if \(idx < 0 \|\| !st\.started/.test(src), 'renderEconBar versteckt für Nicht-Team (Piraten: idx=-1 → ausgeblendet)');
  assert.ok(/function renderTradePanel[\s\S]{0,600}if \(idx < 0 \|\| !st\.started/.test(src), 'renderTradePanel (Handel/Auktion) versteckt für Nicht-Team (Piraten)');
  assert.strictEqual(/Piraten ziehen lassen/.test(src), true, 'Piraten-Aktion „Piraten ziehen lassen“ ist im Client vorhanden');
});
