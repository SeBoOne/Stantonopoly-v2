/* =====================================================================
 * Stantonopoly V2 — SC-Katalog (Star-Citizen-Wiki-Namen) Tests
 * Testet die DB-Helper (sc_names/sc_meta) und die PURE Filter-Funktion
 * (locationAllowedNames) HERMETISCH — OHNE Live-API-Abruf.
 * ===================================================================== */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Eigene Wegwerf-DB für diesen Testprozess (isoliert vom Server).
const dbPath = path.join(os.tmpdir(), 'stp-scwiki-' + process.pid + '.db');
process.env.STANTONOPOLY_DB = dbPath;
const dbm = require('../server/db.js');
const scwiki = require('../server/scwiki.js');

test('SC-DB: scReplaceAll füllt Katalog + dedupliziert case-insensitiv + setzt updated_at', () => {
  const r = dbm.scReplaceAll('ship', ['Aegis Avenger', 'aegis avenger', 'Drake Corsair', '', '  ', 'Drake Corsair']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.count, 2, 'nur 2 eindeutige Namen (case-insensitiv)');
  const names = dbm.scNames('ship');
  assert.strictEqual(names.length, 2);
  assert.ok(names.every((x) => x.name && x.id > 0), 'Einträge haben id + name');
  assert.ok(dbm.scUpdatedAt('ship'), 'updated_at gesetzt');
});

test('SC-DB: scRename ändert Name / blockt Duplikat + leer', () => {
  dbm.scReplaceAll('location', ['Orison', 'New Babbage']);
  const list = dbm.scNames('location');
  const target = list.find((x) => x.name === 'New Babbage');
  assert.ok(target, 'New Babbage vorhanden');
  // Umbenennen auf neuen Namen.
  assert.strictEqual(dbm.scRename('location', target.id, 'Orison Prime').ok, true);
  const after = dbm.scNames('location').find((x) => x.id === target.id);
  assert.strictEqual(after.name, 'Orison Prime');
  // Umbenennen auf einen ANDEREN, bereits EXISTIERENDEN Namen → Duplikat blockiert.
  assert.strictEqual(dbm.scRename('location', target.id, 'Orison').ok, false, 'Duplikat blockiert');
  assert.strictEqual(dbm.scRename('location', target.id, '   ').ok, false, 'leer blockiert');
});

test('SC-DB: scDelete entfernt einen Eintrag', () => {
  dbm.scReplaceAll('ship', ['A', 'B', 'C']);
  const before = dbm.scNames('ship').length;
  const target = dbm.scNames('ship')[1];
  dbm.scDelete('ship', target.id);
  assert.strictEqual(dbm.scNames('ship').length, before - 1);
  assert.strictEqual(dbm.scNameById('ship', target.id), undefined, 'gelöschter Eintrag weg');
});

test('LOCATION-Filter (pure): erlaubt nur QT-erreichbare, sichtbare, nicht blockierte Namen', () => {
  const items = [
    { name: 'Orison', quantum_travel: { arrival_radius: 20000 }, hide_in_starmap: false, block_travel: false },
    { name: 'Kein QT', quantum_travel: null, hide_in_starmap: false, block_travel: false },          // → raus
    { name: 'Versteckt', quantum_travel: { arrival_radius: 1 }, hide_in_starmap: true, block_travel: false }, // → raus
    { name: 'Blockiert', quantum_travel: { arrival_radius: 1 }, hide_in_starmap: false, block_travel: true }, // → raus
    { name: '', quantum_travel: { arrival_radius: 1 }, hide_in_starmap: false, block_travel: false },       // → raus (leer)
    { name: 'New Babbage', quantum_travel: { arrival_radius: 5000 }, hide_in_starmap: false, block_travel: false },
    null,
  ];
  const out = scwiki.locationAllowedNames(items);
  assert.deepStrictEqual(out, ['Orison', 'New Babbage']);
});

test('LOCATION_TYPES deckt die 6 geforderten Kategorien ab', () => {
  for (const t of ['Moon', 'Planet', 'Outpost', 'Asteroid', 'Settlement', 'Manmade']) {
    assert.ok(scwiki.LOCATION_TYPES.includes(t), 'enthält ' + t);
  }
});