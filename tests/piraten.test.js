/* =====================================================================
 * Stantonopoly V2 — piraten.test.js
 * (Piratensystem) Optionale Begegnungs-/Schutzgeld-/Flucht-Mechanik.
 * Deckt Akzeptanzkriterien 1–6 gegen die Engine ab (server-authoritativ).
 * Start: node --test tests/piraten.test.js
 * ===================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const D = require('../server/engine/data.js');
const G = require('../server/engine/engine.js');

// Deterministischer Spiel-Würfel ('frei' + freeValue). Das Piraten-Team nutzt
// separat pirateDice → für dessen Bewegung stuben wir Math.random (0 → 1w6=1).
function makeGame(players, opts) {
  opts = opts || {};
  return G.createGame({
    data: D,
    players: players.map((p, i) => ({ id: i, name: p.name, ship: p.ship || '', task: p.task || '' })),
    startingCapital: (opts.capital !== undefined) ? opts.capital : D.DEFAULT_CAPITAL,
    diceConfig: { kind: 'frei', freeValue: 0 },
    armisticeEnabled: !!opts.armistice,
    settings: (opts.settings !== undefined) ? opts.settings : { piratesEnabled: true }
  });
}

function rollExact(game, value) {
  game.diceConfig.kind = 'frei';
  game.diceConfig.freeValue = value;
  return game.roll();
}

// Stubt Math.random deterministisch (Rückgabe `r`) für einen Callback.
function withRand(r, fn) {
  const orig = Math.random;
  Math.random = () => r;
  try { return fn(); } finally { Math.random = orig; }
}

function pirateOf(g) {
  return g.players.find((p) => p.isPirate || p.role === 'pirate') || null;
}

// ---------------------------------------------------------------------
// AC 1: Default (piratesEnabled=false) → KEINE Piraten, exakt altes Verhalten.
// ---------------------------------------------------------------------
test('AC1: piratesEnabled=false → keine Piraten im players[]', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { settings: null });
  assert.strictEqual(g.players.length, 2, 'nur die 2 normalen Teams');
  assert.ok(!g.players.some((p) => p.isPirate || p.role === 'pirate'), 'kein Pirat');
});

// ---------------------------------------------------------------------
// AC 2: piratesEnabled=true → 1 Pirat-Team (role pirate, budget 0, kaufunfähig),
// eigene Dice (2w6), nimmt NICHT an der Zug-Rotation teil.
// ---------------------------------------------------------------------
test('AC2: piratesEnabled=true → 1 Pirat (letzter Index, budget 0, role pirate)', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }]);
  assert.strictEqual(g.players.length, 3, '2 Teams + 1 Pirat');
  const pir = g.players[2];
  assert.strictEqual(pir.isPirate, true);
  assert.strictEqual(pir.role, 'pirate');
  assert.strictEqual(pir.budget, 0, 'kein Kapital (kaufunfähig)');
  assert.deepStrictEqual(pir.properties, {}, 'kein Eigentum');
  // Pirat wird nie aktiv (Rotation überspringt ihn).
  for (let i = 0; i < 12; i++) g.nextTurn();
  assert.ok(!pir.bankrupt, 'Pirat verbankrottet nie automatisch');
  assert.strictEqual(pir.budget, 0, 'Pirat erhält kein Geld');
  // activeIdx ist in allen 12 Turns nie der Pirat.
  assert.ok(!g.players[g.activeIdx].isPirate, 'Pirat nie am Zug');
});

test('AC2: Pirat nutzt EIGENE Würfelregel (pirateDice)', () => {
  // 2w6 → bei Math.random=0 ⇒ 1+1=2
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { settings: { piratesEnabled: true, pirateDice: '2w6' } });
  const pir = pirateOf(g);
  pir.pos = 0;
  let res = withRand(0, () => g.advancePirate());
  assert.strictEqual(res.sum, 2, '2w6 bei Zufall 0 → 1+1=2');
  assert.strictEqual(pir.pos, 2);
  // 1w6 → bei Math.random=0 ⇒ 1
  const g2 = makeGame([{ name: 'A' }, { name: 'B' }], { settings: { piratesEnabled: true, pirateDice: '1w6' } });
  const pir2 = pirateOf(g2);
  pir2.pos = 5;
  res = withRand(0, () => g2.advancePirate());
  assert.strictEqual(res.sum, 1, '1w6 bei Zufall 0 → 1');
  assert.strictEqual(pir2.pos, 6);
});

// ---------------------------------------------------------------------
// AC 3: Team landet auf Piraten-Feld → Begegnungs-Modal (engine: sauberer
// Zustand). 'pay' → Schutzgeld abgezogen, Runde geht normal weiter (Kauf
// des freien Zielfelds weiterhin möglich).
// ---------------------------------------------------------------------
test('AC3: Landung auf Piraten-Feld setzt Begegnung; pay → Schutzgeld + Runde normal', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }]);
  const pir = pirateOf(g);
  g.players[0].pos = 1; pir.pos = 2; // A rollt → Feld 2 (Shubin), Pirat steht dort
  const before = g.players[0].budget;
  const res = rollExact(g, 1);
  assert.strictEqual(res.to, 2);
  assert.ok(res.pirateEncounter, 'Begegnung ausgelöst');
  assert.strictEqual(res.turnPassed, false, 'Zug pausiert auf Entscheidung');
  assert.strictEqual(res.pirateEncounter.fee, 250000, 'Default-Schutzgeld');
  // pay
  const r = g.resolvePirateEncounter('pay');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.action, 'pay');
  assert.strictEqual(g.players[0].budget, before - 250000, 'Schutzgeld abgezogen');
  assert.ok(!g.pirateEncounter, 'Begegnung aufgelöst');
  assert.strictEqual(r.canBuy, true, 'Feld 2 ist frei → nach Zahlung kaufbar (Runde normal weiter)');
});

// ---------------------------------------------------------------------
// AC 4a: 'flee' → Runde endet, Team flieht (fleeing), Piraten-Urteil offen.
// 'Entwischt' → Team ab nächster Runde normal weiter.
// ---------------------------------------------------------------------
test('AC4: flee → Runde endet + Piraten-Urteil; escaped → Team wieder frei', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }]);
  const pir = pirateOf(g);
  g.players[0].pos = 1; pir.pos = 2;
  rollExact(g, 1);
  const r = g.resolvePirateEncounter('flee');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.action, 'flee');
  assert.strictEqual(r.caughtFee, 500000, 'Default-Multiplikator 2 × 250000');
  assert.strictEqual(g.players[0].fleeing, true, 'Team flieht');
  // Die Runde endet SERVERSEITIG (wie Aussetzen) → Zug liegt beim nächsten Team.
  assert.strictEqual(r.turnEnded, true, 'Server beendet die Runde');
  assert.strictEqual(g.activeIdx, 1, 'Zug sofort an das nächste Team (B)');
  assert.ok(g.pirateVerdict, 'Piraten-Urteil steht aus (Erwischt/Entwischt)');
  // Entwischt bestätigen → frei
  const con = g.pirateEventConfirm('escaped');
  assert.strictEqual(con.ok, true);
  assert.strictEqual(con.verdict, 'escaped');
  assert.strictEqual(g.players[0].fleeing, false, 'Team wieder frei');
  assert.ok(!g.pirateVerdict, 'Urteil erledigt');
});

// ---------------------------------------------------------------------
// AC 4a-2: Zug-SPERRE während der Flucht (Review-Korrektur Runde 1).
// Begegnung entsteht in nextTurn (Pirat zieht auf das Feld des aktiven
// Teams, game.rolled ist noch false) → 'flee' → die Runde endet sofort
// und das fliehende Team darf nicht würfeln (Engine-Guard FLEEING).
// ---------------------------------------------------------------------
test('AC4: Begegnung aus nextTurn → flee beendet Runde + roll() gesperrt (FLEEING)', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { settings: { piratesEnabled: true, pirateDice: '1w6' } });
  const pir = pirateOf(g);
  g.players[0].pos = 4;   // A steht auf Feld 4
  g.players[1].pos = 0;   // B steht auf Feld 0
  pir.pos = 3;            // Pirat direkt vor A
  g.activeIdx = 1;        // B ist am Zug
  withRand(0, () => g.nextTurn()); // Pirat zieht 3→4 (A-Feld) → Begegnung mit A
  assert.strictEqual(g.activeIdx, 0, 'A ist am Zug');
  assert.ok(g.pirateEncounter, 'Begegnung in nextTurn entstanden');
  assert.strictEqual(g.pirateEncounter.teamIdx, 0);
  assert.strictEqual(g.rolled, false, 'A hat in diesem Zug noch nicht gewürfelt');
  const r = g.resolvePirateEncounter('flee');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(g.players[0].fleeing, true);
  assert.strictEqual(r.turnEnded, true, 'Runde endet serverseitig');
  assert.strictEqual(g.activeIdx, 1, 'Zug liegt wieder bei B');
  // Solange die Flucht läuft, ist Würfeln engine-seitig gesperrt.
  g.activeIdx = 0;
  const posBefore = g.players[0].pos;
  const res = g.roll();
  assert.strictEqual(res.err, 'FLEEING', 'Würfeln auf der Flucht → FLEEING');
  assert.strictEqual(g.players[0].pos, posBefore, 'kein Positionswechsel beim abgelehnten Wurf');

  // Persistenz: fleeing überlebt serialize↔deserialize (sonst Sperre weg).
  const g2 = G.deserialize(g.serialize(), D);
  assert.strictEqual(g2.players[0].fleeing, true, 'Flucht-Status persistiert');
  g2.activeIdx = 0;
  assert.strictEqual(g2.roll().err, 'FLEEING', 'Sperre auch nach Round-Trip');
});

// ---------------------------------------------------------------------
// AC 3-SPERRE (Review-Korrektur Runde 1): Solange die Begegnung offen ist,
// darf der aktive Spieler NICHT würfeln — engine-seitig und VOR der Bewegung,
// damit der abgelehnte Wurf den Spielstand nicht anfasst (nur erreichbar,
// wenn die Begegnung in nextTurn entstand, also game.rolled noch false ist;
// nach einer eigenen Landung greift zusätzlich ALREADY_ROLLED).
// ---------------------------------------------------------------------
test('AC3: offene Begegnung aus nextTurn → roll() = PIRATE_PENDING ohne Bewegung', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { settings: { piratesEnabled: true, pirateDice: '1w6' } });
  const pir = pirateOf(g);
  g.players[0].pos = 4; g.players[1].pos = 0; pir.pos = 3; g.activeIdx = 1;
  withRand(0, () => g.nextTurn()); // Pirat zieht 3→4 (A-Feld) → Begegnung mit A
  assert.strictEqual(g.activeIdx, 0, 'A ist am Zug');
  assert.strictEqual(g.rolled, false, 'A hat in diesem Zug noch nicht gewürfelt');
  const posBefore = g.players[0].pos;
  const res = g.roll();
  assert.strictEqual(res.err, 'PIRATE_PENDING', 'Würfeln bei offener Begegnung → PIRATE_PENDING');
  assert.strictEqual(res.pirateEncounter.teamIdx, 0, 'offene Begegnung wird zurückgemeldet');
  assert.strictEqual(g.players[0].pos, posBefore, 'kein Positionswechsel beim abgelehnten Wurf');
  assert.strictEqual(g.rolled, false, 'abgelehnter Wurf zählt nicht als gewürfelt');
  // Nach 'pay' ist die Begegnung aufgelöst und der Zug läuft normal weiter.
  const r = g.resolvePirateEncounter('pay');
  assert.strictEqual(r.ok, true);
  assert.ok(!g.pirateEncounter, 'Begegnung aufgelöst');
  const after = g.roll();
  assert.ok(!after.err, 'nach der Bezahlung ist Würfeln wieder möglich (Runde normal)');
});

// ---------------------------------------------------------------------
// AC 4b: 'Erwischt' (Pirat drückt) → höheres Strafgeld wird fällig.
// ---------------------------------------------------------------------
test('AC4: flee + caught → erhöhtes Strafgeld (2×) wird abgezogen', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }]);
  const pir = pirateOf(g);
  g.players[0].pos = 1; pir.pos = 2;
  const before = g.players[0].budget;
  rollExact(g, 1);
  g.resolvePirateEncounter('flee');
  const con = g.pirateEventConfirm('caught');
  assert.strictEqual(con.ok, true);
  assert.strictEqual(con.verdict, 'caught');
  assert.strictEqual(con.fee, 500000, 'höheres Strafgeld = 2×');
  assert.strictEqual(g.players[0].budget, before - 500000, 'Strafgeld abgebucht');
  assert.strictEqual(g.players[0].fleeing, false);
});

// ---------------------------------------------------------------------
// AC 4c: Automatisch erwischt — Team erreicht seine nächste Runde ohne
// 'Entwischt' → zahlt das höhere Strafgeld automatisch.
// ---------------------------------------------------------------------
test('AC4: automatisch erwischt bei nicht-Entwischen bis zur nächsten Runde', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }]);
  const pir = pirateOf(g);
  g.players[0].pos = 1; pir.pos = 2;
  const before = g.players[0].budget;
  rollExact(g, 1);
  withRand(0, () => g.resolvePirateEncounter('flee')); // A flieht; Runde endet serverseitig
  assert.strictEqual(g.players[0].fleeing, true, 'A flieht noch');
  assert.strictEqual(g.activeIdx, 1, 'Zug liegt bei B');
  withRand(0, () => { g.nextTurn(); });  // B→A → A nicht entwichen → automatisch erwischt
  assert.strictEqual(g.players[0].fleeing, false, 'A automatisch erwischt → Flucht beendet');
  assert.strictEqual(g.players[0].budget, before - 500000, 'automatisch Strafgeld (2×) gezahlt');
});

// Nicht-zahlbar → NORMALER Insolvenz-Pfad (Review-Korrektur Runde 1): kein
// Sofort-Bankrott, sondern Zahlungsrückstand (insolvent/debt) mit Sanierungs-
// Fenster bis zum Zugende — exakt wie bei jeder anderen nicht deckbaren Zahlung.
test('AC4: Strafgeld nicht zahlbar → normaler Insolvenz-Pfad (Sanierung, sonst Bankrott am Zugende)', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { capital: 300000 });
  const pir = pirateOf(g);
  g.players[0].pos = 1; pir.pos = 2;
  rollExact(g, 1);
  withRand(0, () => g.resolvePirateEncounter('flee'));
  const con = g.pirateEventConfirm('caught'); // 500000 > 300000 → nicht deckbar
  assert.strictEqual(con.ok, true);
  assert.strictEqual(con.insolvent, true, 'Rückstand gemeldet');
  assert.strictEqual(g.players[0].bankrupt, false, 'KEIN Sofort-Bankrott');
  assert.strictEqual(g.players[0].insolvent, true, 'Zahlungsrückstand markiert');
  assert.strictEqual(g.players[0].budget, -200000, 'Konto im Überzug');
  assert.strictEqual(g.players[0].debt, 200000, 'offene Schuld = Fehlbetrag');
  // Ohne Sanierung → Bankrott am Zugende (nextTurn löst den Rückstand auf).
  withRand(0, () => { g.nextTurn(); }); // B übergibt ab → A ist am Zug
  assert.strictEqual(g.players[0].bankrupt, false, 'am Zug noch nicht bankrott (Sanierungs-Fenster)');
  withRand(0, () => { g.nextTurn(); }); // A übergibt ab → Rückstand nicht gedeckt
  assert.strictEqual(g.players[0].bankrupt, true, 'nicht saniert → Bankrott am Zugende');
  assert.strictEqual(g.over, true, 'nur noch 1 normales Team → B gewinnt');
  assert.strictEqual(g.winnerInfo.name, 'B');
});

// ---------------------------------------------------------------------
// AC 5: Pirates können nicht gewinnen/verlieren; Spiel endet, wenn nur noch
// 1 NORMALES Team übrig ist — das gewinnt (Pirat zählt nicht mit).
// ---------------------------------------------------------------------
test('AC5: 1 normales Team + Pirat → normales Team gewinnt (Pirat zählt nicht)', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }]);
  g.forfeitTeam(0); // A scheidet aus → B (normal) + Pirat übrig
  assert.strictEqual(g.over, true, 'Spiel beendet (1 normales Team verbleibt)');
  assert.strictEqual(g.winnerInfo.name, 'B', 'B gewinnt, nicht die Piraten');
  assert.ok(!pirateOf(g).winner, 'Pirat gewinnt nie');
});

test('AC5: Pirat allein (keine normalen Teams) → kein Sieg-Event', () => {
  // aliveCount (Sieg-Basis) zählt NUR normale Teams — nie die Piraten.
  const g = makeGame([{ name: 'A' }, { name: 'B' }]);
  assert.strictEqual(G.aliveCount(g), 2, 'beide normale Teams zählen');
  g.players[0].bankrupt = true;
  assert.strictEqual(G.aliveCount(g), 1, 'nach A-Bankrott zählt nur B, nicht der Pirat');
  g.players[1].bankrupt = true;
  assert.strictEqual(G.aliveCount(g), 0, '0 normale Teams → kein Sieg (Pirat zählt nicht)');
});

// ---------------------------------------------------------------------
// Persistenz: serialize↔deserialize erhält das Pirat-Team + Begegnungs-Zustand.
// ---------------------------------------------------------------------
test('Persistenz: Pirat-Marker + Encounter überleben Round-Trip', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }]);
  const pir = pirateOf(g);
  g.players[0].pos = 1; pir.pos = 2;
  rollExact(g, 1); // Begegnung offen
  const s = g.serialize();
  const g2 = G.deserialize(s, D);
  const pir2 = pirateOf(g2);
  assert.ok(pir2, 'Pirat nach Round-Trip wieder erkannt');
  assert.strictEqual(pir2.isPirate, true);
  assert.ok(g2.pirateEncounter, 'offene Begegnung persistiert');
  assert.strictEqual(g2.pirateEncounter.teamIdx, 0);
});

// ---------------------------------------------------------------------
// AC 6: Suite-Grün wird extern geprüft (hier: Default-Pfad unverändert grün).
// ---------------------------------------------------------------------
test('DEFAULT_SETTINGS: Piraten sind standardmäßig aus', () => {
  assert.strictEqual(D.DEFAULT_SETTINGS.piratesEnabled, false);
  assert.strictEqual(D.DEFAULT_SETTINGS.pirateDice, '1w6');
  assert.strictEqual(D.DEFAULT_SETTINGS.pirateProtectionFee, 250000);
  assert.strictEqual(D.DEFAULT_SETTINGS.pirateCaughtMult, 2);
});
