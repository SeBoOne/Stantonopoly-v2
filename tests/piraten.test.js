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
    fields: opts.fields, // optional: eigene Feld-Karten (für Feldtyp-Tests)
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
  return g.players.find((p) => (p.isPirate || p.role === 'pirate') && !p.bankrupt) || null;
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
// P8 (Bestätigung): Wenn die Piraten sich bewegen und auf ein Feld landen,
// auf dem bereits ein normales Team steht, passiert NICHTS (advancePirate
// löst KEINE Begegnung aus — Begegnungen entstehen nur, wenn ein Team per
// roll() AUF das Piratenfeld zieht).
// ---------------------------------------------------------------------
test('P8: advancePirate landet auf belegtem Feld → KEINE Begegnung (Begegnung nur via roll())', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { settings: { piratesEnabled: true, pirateDice: '1w6', pirateWaitTurns: 1 } });
  const pir = pirateOf(g);
  g.players[0].pos = 4;   // A steht auf Feld 4
  g.players[1].pos = 0;   // B steht auf Feld 0
  pir.pos = 3;            // Pirat direkt vor A (auf Feld 3)
  g.activeIdx = 1;        // B ist am Zug
  withRand(0, () => g.nextTurn()); // Pirat zieht 3→4 (A-Feld) — NUR Bewegung, keine Begegnung
  assert.strictEqual(pir.pos, 4, 'Pirat zieht auf das belegte Feld 4');
  assert.ok(!g.pirateEncounter, 'advancePirate auf belegtes Feld löst KEINE Begegnung aus (P8)');
  // Erst wenn ein Team per roll() auf das Piratenfeld ZIEHT, entsteht die Begegnung.
  // A steht jetzt AUF dem Piratenfeld (4): ein späterer Wurf von hier begegnet NICHT
  // augenblicklich — die Begegnung entsteht nur beim LANDEN auf dem Piraten-Feld.
  g.players[0].pos = 8; pir.pos = 9; // A zieht 8→9 (Pirat auf 9)
  const res = rollExact(g, 1);
  assert.strictEqual(res.to, 9);
  assert.ok(res.pirateEncounter, 'Team, das per roll() auf das Piratenfeld zieht → normale Begegnung');
});

// ---------------------------------------------------------------------
// P7: Die Piraten bleiben pirateWaitTurns (Zugwechsel der NORMALEN Teams)
// auf ihrem Feld stehen und ziehen erst dann automatisch weiter (advancePirate).
// Der Zähler läuft NUR über die normalen Team-Zugwechsel (Pirat selbst nie aktiv).
// ---------------------------------------------------------------------
test('P7: Piraten bleiben pirateWaitTurns normale Zugwechsel, dann advancePirate', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }, { name: 'C' }], {
    settings: { piratesEnabled: true, pirateDice: '1w6', pirateWaitTurns: 3 }
  });
  const pir = pirateOf(g);
  g.players[0].pos = 4; g.players[1].pos = 8; g.players[2].pos = 12;
  pir.pos = 5; g.activeIdx = 0;
  const before = pir.pos;
  // 2 normale Zugwechsel: noch nicht erreicht → Pirat bleibt stehen.
  withRand(0, () => { g.nextTurn(); }); // A → B (Zähler 1)
  withRand(0, () => { g.nextTurn(); }); // B → C (Zähler 2)
  assert.strictEqual(pir.pos, before, 'nach 2 von 3 Zugwechseln rückt der Pirat NOCH nicht vor');
  assert.strictEqual(g.pirateWaitCounter, 2, 'Zähler läuft über die normalen Zugwechsel');
  // 3. Zugwechsel → Zähler erreicht, Pirat zieht mit eigener Dice (1w6, Zufall 0 → 1).
  withRand(0, () => { g.nextTurn(); }); // C → A (Zähler 3 → advance)
  assert.strictEqual(pir.pos, (before + 1) % g.fields.length, 'nach 3 Zugwechseln zieht der Pirat (advancePirate)');
  assert.strictEqual(g.pirateWaitCounter, 0, 'Zähler nach dem Zug zurückgesetzt');
});

test('P7: Pirat zieht NICHT, solange Piraten beschäftigt sind (offene Begegnung/Urteil/Flucht)', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], {
    settings: { piratesEnabled: true, pirateDice: '1w6', pirateWaitTurns: 1 }
  });
  const pir = pirateOf(g);
  g.players[0].pos = 1; g.players[1].pos = 8;
  pir.pos = 2; g.activeIdx = 0;
  // Begegnung öffnen (A zieht aufs Piratenfeld) → piratesBusy=true.
  rollExact(g, 1); // A landet auf 2 (Pirat) → Begegnung
  assert.ok(g.pirateEncounter, 'Begegnung offen (P5: Piraten beschäftigt)');
  const before = pir.pos;
  // nextTurn (Aupflösung via skip) — auch wenn der Zähler 1 erreichen würde,
  // bleibt der Pirat stehen, solange die Begegnung offen ist.
  withRand(0, () => { g.nextTurn(); });
  assert.strictEqual(pir.pos, before, 'bei offener Begegnung bewegen sich die Piraten NICHT weiter (P5)');
});

// ---------------------------------------------------------------------
// P9: Optional pro Durchgang nur 1 Piraten-Interaktion je Team.
// (Flag wird beim Los-Pass zurückgesetzt; vor dem Umrunden keine 2. Begegnung.)
// ---------------------------------------------------------------------
test('P9: pirateOncePerLap → nur 1 Interaktion/Durchgang/Team; Reset beim Los-Pass', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], {
    settings: { piratesEnabled: true, pirateOncePerLap: true, pirateWaitTurns: 6 }
  });
  const pir = pirateOf(g);
  const A = g.players[0];
  // Begegnung 1: A zieht AUF das Piratenfeld → Interaktion setzt das Lap-Flag.
  A.pos = 3; pir.pos = 5; g.activeIdx = 0;
  const res1 = rollExact(g, 2); // A 3→5 (Pirat)
  assert.strictEqual(res1.to, 5);
  assert.ok(res1.pirateEncounter, 'Begegnung 1 im Durchgang');
  g.resolvePirateEncounter('pay');
  assert.strictEqual(A.pirateInteractedThisLap, true, 'Lap-Flag nach Interaktion gesetzt');
  // A bewegt sich weg, kommt im SELBEN Durchgang wieder aufs Piratenfeld → KEINE 2. Begegnung.
  A.pos = 4; pir.pos = 5; g.rolled = false;
  const res2 = rollExact(g, 1); // A 4→5 (Pirat) — gleicher Durchgang, Flag noch gesetzt
  assert.strictEqual(res2.to, 5);
  assert.ok(!res2.pirateEncounter, '2. Landung im selben Durchgang (ohne Los-Pass) → KEINE Begegnung (P9)');
  assert.strictEqual(g.pirateEncounter, null, 'keine 2. Begegnung vor Umrunden');
  // Los-Pass: A umrundet die Tafel → Flag wird zurückgesetzt, nächste Begegnung möglich.
  A.pos = 13; pir.pos = 2; g.rolled = false;
  const res3 = rollExact(g, 5); // 13+5=18 → lap (Über Los), landet auf 2 (Pirat)
  assert.ok(res3.lapBonus > 0 || res3.to === 2, 'A überquert Los (lap)');
  // Der Los-Pass hat das alte Interaktion-Flag zurückgesetzt, sodass die neue
  // Landung auf dem Piratenfeld wieder eine Begegnung auslösen darf. (Die Begegnung
  // setzt das Flag danach erneut auf true — entscheidend ist die NEUE Begegnung.)
  assert.ok(res3.pirateEncounter, 'nach Los-Pass wieder eine Interaktion möglich (P9)');
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

// ---------------------------------------------------------------------
// P1-4: Piraten-Interaktion nach FELDTYP (Punkte 1-4 der User-Meldung).
// Benutzerdefiniertes Feld-Arrangement, damit jede Feldtyp-Kombination
// deterministisch angetriggert werden kann:
//   0 los, 1 gefaengnis, 2 freiparken, 3 steuer, 4 ereignis, 5/6 grundstueck
// ---------------------------------------------------------------------
const TYPE_BOARD = [
  { type: 'los', name: 'Orison' },
  { type: 'gefangnis', name: 'Klescher', fee: 50000, turns: 2 },
  { type: 'freiparken', name: 'Frei Parken' },
  { type: 'steuer', name: 'Steuer', fee: 30000 },
  { type: 'ereignis', name: 'Ereignis', fee: 40000 },
  { type: 'grundstueck', name: 'Grundstueck A', price: 100000 },
  { type: 'grundstueck', name: 'Grundstueck B', price: 100000 }
];

// Team A (idx 0) landet deterministisch auf einem Zielfeld, auf dem die
// Piraten stehen. Übergebe das Zielfeld-Index.
function landOnPirateField(fieldIdx, opts) {
  opts = opts || {};
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { fields: TYPE_BOARD, settings: Object.assign({}, { piratesEnabled: true }, opts.settings) });
  const pir = pirateOf(g);
  g.players[0].pos = fieldIdx - 1; // genau 1 Feld vor dem Zielfeld
  pir.pos = fieldIdx;
  const before = g.players[0].budget;
  const res = rollExact(g, 1); // A zieht 1 → landet auf fieldIdx
  return { g, res, pir, before };
}

// P1 — Gefängnis-Feld: Piraten dort INAKTIV → KEINE Begegnung (nur Gefängnis-Feld-Effekt).
test('P1: Pirat auf gefaengnis → Landung löst KEINE Begegnung (nur Gefängnis-Logik)', () => {
  const { g, res, pir } = landOnPirateField(1);
  assert.strictEqual(res.to, 1, 'Team landet auf dem Gefängnis-Feld');
  assert.strictEqual(pir.pos, 1, 'Piraten stehen auf dem Gefängnis-Feld');
  assert.ok(!res.pirateEncounter, 'KEINE Piraten-Interaktion auf Gefängnis-Feld (P1)');
  assert.ok(!g.pirateEncounter, 'keine Begegnung gesetzt');
  assert.strictEqual(g.players[0].jailed, true, 'normale Gefängnis-Logik greift (Team ist im Gefängnis)');
});

// P4 — Frei-Parken-Feld: Piraten dort INAKTIV → KEINE Begegnung (Frei-Parken-Effekt).
test('P4: Pirat auf freiparken → Landung löst KEINE Begegnung (Frei-Parken normal)', () => {
  const { g, res, pir } = landOnPirateField(2);
  assert.strictEqual(res.to, 2, 'Team landet auf dem Frei-Parken-Feld');
  assert.strictEqual(pir.pos, 2, 'Piraten stehen auf dem Frei-Parken-Feld');
  assert.ok(!res.pirateEncounter, 'KEINE Piraten-Interaktion auf Frei-Parken-Feld (P4)');
  assert.ok(!g.pirateEncounter, 'keine Begegnung gesetzt');
  assert.deepStrictEqual(res.events, ['Frei Parken'], 'Frei-Parken-Effekt normal');
});

// P2a — Ereignis-Feld: Begegnung VERDRÄNGT das Ereignis (kein Ereignis-Feld-Effekt).
test('P2: Pirat auf ereignis → Begegnung statt Ereignis (Ereignis verdrängt)', () => {
  const { g, res, pir, before } = landOnPirateField(4);
  assert.strictEqual(res.to, 4, 'Team landet auf dem Ereignis-Feld');
  assert.strictEqual(pir.pos, 4, 'Piraten stehen auf dem Ereignis-Feld');
  assert.ok(res.pirateEncounter, 'Begegnung ausgelöst (verdrängt das Ereignis) (P2)');
  assert.strictEqual(res.turnPassed, false, 'Zug pausiert auf Schutzgeld-Entscheidung');
  // pay → Schutzgeld abgezogen, ABER KEIN Ereignis-Feld-Effekt (fee 40000 NICHT abgebucht).
  const r = g.resolvePirateEncounter('pay');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(g.players[0].budget, before - 250000, 'nur Schutzgeld (250000), keine Ereignis-Gebühr (40000)');
  assert.strictEqual(r.turnPassed, true, 'Zug nach der bezahlten Begegnung beendet');
  assert.ok(!g.pirateEncounter, 'Begegnung aufgelöst');
});

// P2b — Ereignis-Feld bei piratesBusy: Ereignis wird GANZ NORMAL getriggert (keine Begegnung).
test('P2: Pirat auf ereignis + piratesBusy → Ereignis normal (keine Begegnung)', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { fields: TYPE_BOARD, settings: { piratesEnabled: true } });
  const pir = pirateOf(g);
  g.players[0].pos = 3; pir.pos = 4;
  // Piraten beschäftigt machen: offener Verdict (oder offene Begegnung eines anderen Teams).
  g.pirateVerdict = { teamIdx: 1, fee: 250000, caughtFee: 500000 };
  const before = g.players[0].budget;
  const res = rollExact(g, 1); // A 3→4 (Ereignis-Feld, Pirat steht dort)
  assert.strictEqual(res.to, 4);
  assert.ok(!res.pirateEncounter, 'bei piratesBusy KEINE Begegnung (P2)');
  assert.ok(!g.pirateEncounter, 'keine Begegnung gesetzt');
  // Ereignis-Feld-Effekt (fee 40000) läuft NORMAL.
  assert.strictEqual(g.players[0].budget, before - 40000, 'Ereignis-Gebühr normal abgebucht');
});

// P3a — Steuer-Feld: BEIDES — Steuer erheben UND Begegnung.
test('P3: Pirat auf steuer → Steuer + Begegnung BEIDES', () => {
  const { g, res, pir, before } = landOnPirateField(3);
  assert.strictEqual(res.to, 3, 'Team landet auf dem Steuer-Feld');
  assert.strictEqual(pir.pos, 3, 'Piraten stehen auf dem Steuer-Feld');
  assert.ok(res.pirateEncounter, 'Begegnung ausgelöst (P3)');
  // pay → Schutzgeld + Steuer werden beide erhoben (250000 + 30000).
  const r = g.resolvePirateEncounter('pay');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(g.players[0].budget, before - 250000 - 30000, 'Schutzgeld (250000) + Steuer (30000) beide abgebucht');
  assert.ok(!g.pirateEncounter, 'Begegnung aufgelöst');
});

// P3b — Steuer-Feld bei piratesBusy: NUR Steuer, KEINE Begegnung.
test('P3: Pirat auf steuer + piratesBusy → nur Steuer (keine Begegnung)', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { fields: TYPE_BOARD, settings: { piratesEnabled: true } });
  const pir = pirateOf(g);
  g.players[0].pos = 2; pir.pos = 3;
  g.pirateVerdict = { teamIdx: 1, fee: 250000, caughtFee: 500000 };
  const before = g.players[0].budget;
  const res = rollExact(g, 1); // A 2→3 (Steuer-Feld, Pirat steht dort)
  assert.strictEqual(res.to, 3);
  assert.ok(!res.pirateEncounter, 'bei piratesBusy keine Begegnung auf Steuer-Feld (P3)');
  assert.strictEqual(g.players[0].budget, before - 30000, 'nur die Steuer (30000) wird erhoben');
});

// ---------------------------------------------------------------------
// P7 (Team-Mechanik Runde): Piraten-Können-AUFGEBEN. forfeitPirates entfernt
// die Piraten-Figur (als tote/entfernte Entität = bankrupt), löst alle offenen
// Piraten-Zustände auf, und das Spiel läuft OHNE Piraten-Mechanik weiter:
// keine Begegnungen mehr, keine Piraten-Bewegung; der Sieg-Pfad bleibt konsistent.
// ---------------------------------------------------------------------
test('P7: forfeitPirates entfernt Pirat (bankrupt), beendet Begegnung/Bewegung, Spiel läuft weiter', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { settings: { piratesEnabled: true, pirateWaitTurns: 1 } });
  const pir = pirateOf(g);
  g.players[0].pos = 1; pir.pos = 2;
  const res = rollExact(g, 1); // A 1→2 (Pirat) → Begegnung
  assert.ok(res.pirateEncounter, 'Begegnung ausgelöst');

  const r = g.forfeitPirates();
  assert.strictEqual(r.ok, true, 'Aufgeben erfolgreich');
  assert.strictEqual(pir.bankrupt, true, 'Pirat als entfernte/tote Entität markiert');
  assert.strictEqual(g.pirateEncounter, null, 'offene Begegnung aufgelöst');
  assert.strictEqual(g.pirateVerdict, null, 'kein offenes Urteil');
  assert.strictEqual(g.pirateWaitCounter, 0, 'Warte-Zähler zurückgesetzt');
  assert.strictEqual(pirateOf(g), null, 'kein aktives Piraten-Team mehr');
  assert.ok(!g.players.find((p) => (p.role === 'pirate' || p.isPirate) && !p.bankrupt), 'kein lebender Pirat');

  // Spiel geht OHNE Piraten weiter: A zieht erneut AUF das ehemalige Piraten-Feld → KEINE Begegnung.
  g.players[0].pos = 1; g.rolled = false; g.activeIdx = 0;
  const res2 = rollExact(g, 1); // 1→2 (ehemaliges Piraten-Feld)
  assert.strictEqual(res2.to, 2);
  assert.ok(!res2.pirateEncounter, 'nach Aufgeben KEINE neue Begegnung (Mechanik beendet)');
  assert.strictEqual(g.pirateEncounter, null, 'kein sync pirateEncounter');

  // advancePirate bewegt nichts mehr (kein aktiver Pirat).
  const adv = g.advancePirate();
  assert.strictEqual(adv.moved, false, 'Piraten-Bewegung deaktiviert');

  // Sieg-Pfad bleibt konsistent: 1 normales Team + (totes) Piraten-Team → normales Team gewinnt.
  g.forfeitTeam(0);
  assert.strictEqual(g.over, true, 'Spiel endet bei nur noch 1 normalem Team (Pirat zählt nicht)');
  assert.strictEqual(g.winnerInfo.name, 'B');
});

test('P7: forfeitPirates ohne aktiven Piraten → ok:false (nicht doppel-aufgebbar)', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { settings: { piratesEnabled: true } });
  const r1 = g.forfeitPirates();
  assert.strictEqual(r1.ok, true);
  const r2 = g.forfeitPirates();
  assert.strictEqual(r2.ok, false, 'zweimal Aufgeben wird abgelehnt');
  assert.strictEqual(r2.reason, 'no_pirates');
});

// ---------------------------------------------------------------------
// P7 Wire-Persistenz: Nach einem Piraten-Aufgeben überlebt der ent-Referenz
// state (bankrupt Pirat) den serialize↔deserialize-Round-Trip; pirateOf bleibt
// null nach dem Reload — die Piraten-Mechanik ist dauerhaft beendet.
// ---------------------------------------------------------------------
test('P7: Piraten-Aufgeben persistiert über Round-Trip (kein neues aktives Piraten-Team)', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { settings: { piratesEnabled: true } });
  g.forfeitPirates();
  const s = g.serialize();
  const g2 = G.deserialize(s, D);
  assert.strictEqual(pirateOf(g2), null, 'nach Reload weiterhin kein aktiver Pirat');
  assert.ok(g2.players.some((p) => p.role === 'pirate' && p.bankrupt), 'entfernte Piraten-Entität persistiert');
});

// =====================================================================
// Bot-Pirat: Erwischt/Entwischt-Wahrscheinlichkeit nach Team-Besitzanteil.
// Basis 40% Erwischt, steigt mit Besitzanteil an allen kaufbaren Feldern bis 65%.
// =====================================================================
// Begegnung auf einem Grundstück auslösen: Pirat an Feld 1, Team 0 auf 0, Wurf 1.
function landEncounter(g) {
  const pir = pirateOf(g);
  g.players[0].pos = 0; pir.pos = 1; g.activeIdx = 0; g.rolled = false; g.canBuy = false;
  return rollExact(g, 1); // Team 0 zieht 1 → Feld 1 (Pirat dort)
}

test('BOT: Flucht ohne Piraten-Mitglied → Bot-Urtel setzt fleeing zurück (caught bei rng 0)', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { settings: { piratesEnabled: true, pirateProtectionFee: 100000, pirateCaughtMult: 2 } });
  const roll = landEncounter(g);
  assert.ok(roll.pirateEncounter, 'Begegnung');
  const fr = g.resolvePirateEncounter('flee');
  assert.strictEqual(fr.action, 'flee');
  const vdIdx = g.pirateVerdict.teamIdx;
  const r = g.pirateBotVerdict(vdIdx, () => 0); // r=0 < 40% → caught
  assert.strictEqual(r.verdict, 'caught', 'rng 0 → erwischt');
  assert.strictEqual(g.players[vdIdx].fleeing, false, 'Flucht beendet');
});

test('BOT: rng=0.99 → escaped (fleeing aufgehoben)', () => {
  const g = makeGame([{ name: 'A' }, { name: 'B' }], { settings: { piratesEnabled: true } });
  landEncounter(g); g.resolvePirateEncounter('flee');
  const vdIdx = g.pirateVerdict.teamIdx;
  const r = g.pirateBotVerdict(vdIdx, () => 0.99);
  assert.strictEqual(r.verdict, 'escaped', 'rng 0.99 → entwischt');
  assert.strictEqual(g.players[vdIdx].fleeing, false);
});

test('BOT: 0% Besitz → 40% Erwischt; 100% Besitz → 65% (Wahrscheinlichkeitsgrenzen)', () => {
  // Helfer: Spiel mit Flee-Verdict (teamIdx 0), optionaler Besitzzuweisung.
  function flight(assignAll) {
    const g = makeGame([{ name: 'A' }, { name: 'B' }], { settings: { piratesEnabled: true } });
    if (assignAll) g.fields.forEach((f, i) => { if (f.type === 'grundstueck') g.players[0].properties[i] = { level: 'ALLEIN' }; });
    landEncounter(g);
    const fr = g.resolvePirateEncounter('flee');
    assert.strictEqual(fr.action, 'flee');
    const v = g.pirateVerdict;
    assert.ok(v && v.teamIdx === 0, 'Verdict teamIdx 0');
    return g;
  }
  // 0% Besitz (nichts assigniert) → prob 0.40: 0.399 < 0.40 → caught
  let g = flight(false);
  assert.strictEqual(g.pirateBotVerdict(0, () => 0.399).verdict, 'caught', '40% Grenze unten: 0.399 < 0.40 → caught');
  g = flight(false);
  assert.strictEqual(g.pirateBotVerdict(0, () => 0.401).verdict, 'escaped', '0.401 >= 0.40 → escaped');
  // 100% Besitz (alle Grundstücke) → prob 0.65: 0.64 < 0.65 → caught
  g = flight(true);
  assert.strictEqual(g.pirateBotVerdict(0, () => 0.64).verdict, 'caught', '65% Grenze unten: 0.64 < 0.65 → caught');
  g = flight(true);
  assert.strictEqual(g.pirateBotVerdict(0, () => 0.66).verdict, 'escaped', '0.66 >= 0.65 → escaped trotz Volllbesitz');
  assert.ok(g.fields.filter((f) => f.type === 'grundstueck').length > 0, 'Karte hat kaufbare Felder');
});
