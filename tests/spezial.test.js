/* =====================================================================
 * Stantonopoly V2 — spezial.test.js
 * Spezial-Grundstück (type:'spezial'): sofortiger Besitz beim Landen,
 * LOS-Strafe/Bonus für den Besitzer, keine Wirtschafts-Aktionen.
 * ===================================================================== */
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const D = require('../server/engine/data.js');
const G = require('../server/engine/engine.js');

// Feld 1 = Spezial (fee>0 → Strafgebühr), Feld 2 = Spezial (fee<0 → Bonus), Los bonus 0.
const FIELDS = [
  { type: 'los', name: 'Orison', bonus: 0 },
  { type: 'spezial', name: 'Covalex Hub Gundo', fee: 125000 },
  { type: 'spezial', name: 'Prospektor-Fund', fee: -50000 },
  { type: 'grundstueck', name: 'Seraphim', price: 400000, group: 'pink' },
  { type: 'grundstueck', name: 'Grim Hex', price: 500000, group: 'rot' }
];

function makeGame(players, opts) {
  opts = opts || {};
  return G.createGame({
    data: D,
    players: players.map((p, i) => ({ id: p.id, name: p.name, ship: '100i' })),
    fields: FIELDS,
    startingCapital: opts.capital !== undefined ? opts.capital : 1500000,
    diceConfig: { kind: 'frei', freeValue: 0 },
    settings: opts.settings || null
  });
}
function rollExact(game, value) {
  game.diceConfig.kind = 'frei';
  game.diceConfig.freeValue = value;
  return game.roll();
}

// ---------------------------------------------------------------------
test('normalizeField akzeptiert spezial inkl. fee', () => {
  const g = makeGame([{ id: 0, name: 'A' }]);
  assert.strictEqual(g.fields[1].type, 'spezial');
  assert.strictEqual(g.fields[1].fee, 125000);
  assert.strictEqual(g.fields[2].fee, -50000);
});

// ---------------------------------------------------------------------
test('Landung auf freies spezial → sofortiger Besitz ohne Kauf/Bedingung', () => {
  const g = makeGame([{ id: 0, name: 'A' }, { id: 1, name: 'B' }]);
  // Spieler A am Zug, pos 0, würfelt 1 → Feld 1 (spezial, unbesetzt).
  const r = rollExact(g, 1);
  assert.strictEqual(r.landing.type, 'spezial');
  assert.ok(g.players[0].properties[1], 'A besitzt das Spezial-Feld sofort');
  assert.strictEqual(g.players[0].properties[1].level, 'STANDARD');
  assert.strictEqual(g.players[0].budget, 1500000, 'kein Kaufpreis abgebucht');
  assert.strictEqual(r.canBuy, false, 'kein Kauftrigger');
  assert.strictEqual(r.turnPassed, true, 'Zug geht sofort weiter');
});

// ---------------------------------------------------------------------
test('Landung auf fremdes spezial → Übertragung an den Landenden', () => {
  const g = makeGame([{ id: 0, name: 'A' }, { id: 1, name: 'B' }]);
  g.players[1].properties[1] = { level: 'STANDARD' }; // B besitzt
  const r = rollExact(g, 1); // A landet
  assert.ok(!g.players[1].properties[1], 'B hat das Feld verloren');
  assert.ok(g.players[0].properties[1], 'A hat es übernommen');
  assert.strictEqual(g.players[1].budget, 1500000, 'B zahlt keine Miete');
  assert.strictEqual(g.players[0].budget, 1500000, 'A zahlt keinen Kaufpreis');
  assert.strictEqual(r.turnPassed, true);
});

// ---------------------------------------------------------------------
test('LOS-Pass: Besitzer zahlt Strafgebühr (fee > 0)', () => {
  const g = makeGame([{ id: 0, name: 'A' }], { capital: 1000000 });
  g.players[0].properties[1] = { level: 'STANDARD' }; // besitzt Covalex (fee 125000)
  g.players[0].pos = 4; // direkt vor LOS (Feldende), würfelt 1 → Lap auf Feld 0
  const r = rollExact(g, 1);
  assert.ok(r.lapBonus === 0, 'LOS-Bonus 0 (bonus:0)');
  assert.strictEqual(g.players[0].budget, 1000000 - 125000, 'Strafgebühr 125k abgezogen');
});

// ---------------------------------------------------------------------
test('LOS-Pass: Besitzer erhält Bonus (fee < 0)', () => {
  const g = makeGame([{ id: 0, name: 'A' }], { capital: 1000000 });
  g.players[0].properties[2] = { level: 'STANDARD' }; // besitzt Prospektor-Fund (fee -50000)
  g.players[0].pos = 4;
  const r = rollExact(g, 1);
  assert.strictEqual(g.players[0].budget, 1000000 + 50000, 'Bonus +50k gutgeschrieben');
});

// ---------------------------------------------------------------------
test('LOS-Pass: Mehrere spezial-Felder summiert', () => {
  const g = makeGame([{ id: 0, name: 'A' }], { capital: 1000000 });
  g.players[0].properties[1] = { level: 'STANDARD' }; // +125000
  g.players[0].properties[2] = { level: 'STANDARD' }; // -50000 → Summe +75000
  g.players[0].pos = 4;
  rollExact(g, 1);
  assert.strictEqual(g.players[0].budget, 1000000 - 75000, 'Strafgebühr 75k (125k-50k)');
});

// ---------------------------------------------------------------------
test('Kein Handel/Auktion/Bankverkauf/Ausbau/Hypothek (Server-Guards)', () => {
  const g = makeGame([{ id: 0, name: 'A' }, { id: 1, name: 'B' }]);
  g.players[0].properties[1] = { level: 'STANDARD' };
  // Trade-Offers (sell + buy) blocken.
  let r = G.makeOffer(g, { kind: 'sell', fromIdx: 0, targetIdx: 1, fieldIdx: 1, price: 100 });
  assert.strictEqual(r.reason, 'SPECIAL_NOT_TRADEABLE');
  r = G.makeOffer(g, { kind: 'buy', fromIdx: 1, targetIdx: 0, fieldIdx: 1, price: 100 });
  assert.strictEqual(r.reason, 'SPECIAL_NOT_TRADEABLE');
  // Auktion blocken.
  r = g.startAuction({ ownerIdx: 0, fieldIdx: 1, durationMs: 15000 });
  assert.strictEqual(r.reason, 'SPECIAL_NOT_AUCTIONABLE');
  // Bankverkauf blocken (buyerIdx -1).
  r = g.sellProperty(1, -1, 0);
  assert.strictEqual(r.reason, 'SPECIAL_NOT_SELLABLE');
  // Ausbau blocken (f.type !== grundstueck → build lehnt ab).
  const b = g.build(1);
  assert.strictEqual(b, false, 'Ausbau auf Spezial-Grundstück abgelehnt');
});