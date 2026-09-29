/* =====================================================================
 * Stantonopoly V2 — piraten-ui-wire.test.js
 * (P8/P9/P10) UI-Aktivierung des Piratensystems auf Wire-Ebene:
 *  - P8: piratesEnabled=true → players.length == cfg-teams+1, Pirat eigenes
 *        Slot (role pirate, letzter Index), PIR im Board sichtbar; false → unverändert.
 *  - P9: Join-Szenario zeigt korrekte Feldwerte (Gundo fee 125000) ohne Reload
 *        nach Spielwechsel (stale Board-Cache-Fix).
 *  - P10: Normale Team-Sockets sehen in der Lobby KEIN Pirat-Mitglied (st.pirate
 *        fehlt); der GM/Pirat-Socket sieht die normalen Teams + den Pirat.
 * Start: node --test tests/piraten-ui-wire.test.js
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

// Gundo-Feld (Ereignis) mit fee 125000 — für P9.
const GUNDO_FIELDS = [
  { type: 'los', name: 'Orison', bonus: 200000 },
  { type: 'gundo', name: 'Gundo', fee: 125000 },
  { type: 'grundstueck', name: 'Shubin', price: 300000 },
  { type: 'freiparken', name: 'Frei Parken' }
];

async function setupGame(srv, url, opts) {
  const gm = await connect(url, 'gm');
  const created = await createGame(gm, {
    teams: 2,
    capital: 1000000,
    diceConfig: '1w6',
    armistice: false,
    fields: opts.fields,
    settings: opts.settings
  });
  const inv0 = created.tokens.find((t) => t.ship === 'Redeemer').code;
  const inv1 = created.tokens.find((t) => t.ship === 'Hammerhead').code;
  const a = await connect(url, 'A');
  const d = await connect(url, 'D');
  const join = (client, code, name) => new Promise((resolve) => {
    const pj = once(client, 'joined');
    client.emit('team:join', { gameId: created.gameId, code, playerName: name });
    pj.then(resolve);
  });
  await join(a, inv0, 'A'); await join(d, inv1, 'D');
  const vote = (client, pid) => client.emit('vote:leader', { gameId: created.gameId, playerId: pid });
  vote(a, a.id); await sleep(30); vote(d, d.id); await sleep(40);
  return { gm, a, d, created };
}

async function startAndGetState(gm, a, created) {
  let stA = null;
  a.on('state', (st) => { stA = st; });
  const gmStart = once(gm, 'state');
  gm.emit('gm:start', { gameId: created.gameId, gmCode: created.gmCode });
  await gmStart;
  const t0 = Date.now();
  while ((!stA || !stA.started) && Date.now() - t0 < 5000) await sleep(20);
  assert.ok(stA && stA.started, 'Spiel gestartet');
  return stA;
}

// ---------------------------------------------------------------------
// P8: piratesEnabled=true → players.length == cfg-teams+1, Pirat eigenes Slot,
// PIR im Board sichtbar; false → unverändert.
// ---------------------------------------------------------------------
test('P8: piratesEnabled=true → players.length == teams+1, Pirat eigenes Slot, PIR im Board', async () => {
  const srv = startServer();
  const url = 'http://localhost:' + srv.port;
  try {
    const { gm, a, d, created } = await setupGame(srv, url, {
      fields: GUNDO_FIELDS,
      settings: { piratesEnabled: true }
    });
    const stA = await startAndGetState(gm, a, created);

    // players.length == cfg-teams + 1 (2 Teams + 1 Pirat)
    assert.strictEqual(stA.game.players.length, 3, 'players.length == cfg-teams + 1');
    // Pirat belegt KEINEN der normalen team-Slots: eigener, zusätzlicher Slot (letzter Index)
    const pir = stA.game.players[stA.game.players.length - 1];
    assert.strictEqual(pir.role, 'pirate', 'Pirat hat role=pirate');
    assert.ok(pir.isPirate, 'Pirat ist markiert');
    assert.strictEqual(pir.id, 'PIRATES', 'Pirat hat eigene ID (kein team-N-Slot)');
    // cfg-teams bleibt 2 (ohne Pirat) — st.teams zählt nur die normalen Teams
    assert.strictEqual(stA.teams.length, 2, 'cfg-teams bleibt 2 (Pirat zählt nicht mit)');
    // PIR im Board sichtbar: toBoardData liefert isPirate für den letzten Player
    const boardPlayers = stA.game.players.map((p) => ({ isPirate: !!(p.isPirate || p.role === 'pirate'), pos: p.pos }));
    assert.ok(boardPlayers.some((p) => p.isPirate), 'Pirat ist im Board (isPirate) sichtbar');
    // Pirat ist nie der aktive Zug
    assert.ok(stA.game.activeIdx < stA.game.players.length - 1, 'Pirat ist nicht der aktive Index');

    [gm, a, d].forEach((c) => c.disconnect());
  } finally { srv.stop(); }
});

test('P8: piratesEnabled=false → players.length == cfg-teams (unverändert, kein Pirat)', async () => {
  const srv = startServer();
  const url = 'http://localhost:' + srv.port;
  try {
    const { gm, a, d, created } = await setupGame(srv, url, {
      fields: GUNDO_FIELDS,
      settings: null
    });
    const stA = await startAndGetState(gm, a, created);
    assert.strictEqual(stA.game.players.length, 2, 'kein Pirat bei piratesEnabled=false');
    assert.ok(!stA.game.players.some((p) => p.isPirate || p.role === 'pirate'), 'kein Pirat im players[]');
    assert.strictEqual(stA.teams.length, 2, 'cfg-teams unverändert');
    [gm, a, d].forEach((c) => c.disconnect());
  } finally { srv.stop(); }
});

// ---------------------------------------------------------------------
// P9: Join-Szenario — Spiel A (fee 0) join+view, dann Spiel B (fee 125000)
// beitreten → Feldkarte B zeigt B-Werte (fee 125000), nicht A-Werte; ohne Reload.
// ---------------------------------------------------------------------
test('P9: Join-Szenario zeigt korrekte Feldwerte (Gundo fee 125000) ohne Reload nach Spielwechsel', async () => {
  const srv = startServer();
  const url = 'http://localhost:' + srv.port;
  try {
    // Spiel A: Gundo fee 0 (kein Effekt)
    const A = await setupGame(srv, url, {
      fields: [
        { type: 'los', name: 'Orison', bonus: 200000 },
        { type: 'gundo', name: 'Gundo', fee: 0 },
        { type: 'grundstueck', name: 'Shubin', price: 300000 },
        { type: 'freiparken', name: 'Frei Parken' }
      ],
      settings: null
    });
    const stA = await startAndGetState(A.gm, A.a, A.created);
    // A-Feldkarte: Gundo fee 0
    const gundoA = stA.game.fields.find((f) => f.name === 'Gundo');
    assert.strictEqual(gundoA.fee, 0, 'Spiel A: Gundo fee 0');

    // Spiel B: Gundo fee 125000
    const B = await setupGame(srv, url, {
      fields: GUNDO_FIELDS,
      settings: null
    });
    const stB = await startAndGetState(B.gm, B.a, B.created);
    // B-Feldkarte: Gundo fee 125000 (nicht A-Werte)
    const gundoB = stB.game.fields.find((f) => f.name === 'Gundo');
    assert.strictEqual(gundoB.fee, 125000, 'Spiel B: Gundo fee 125000 (nicht A-Werte)');
    assert.notStrictEqual(gundoB.fee, gundoA.fee, 'B zeigt nicht die A-Werte');

    // Der Client-Fix (P9) baut das Board bei gameId-Wechsel neu auf — hier prüfen
    // wir, dass die Felddaten im State je Spiel frisch sind (die Wire-Ebene liefert
    // die korrekten Felder; der Client rendert daraus ohne stale Cache).
    assert.strictEqual(stB.game.fields.length, 4, 'B-Felder vollständig');

    [A.gm, A.a, A.d, B.gm, B.a, B.d].forEach((c) => c.disconnect());
  } finally { srv.stop(); }
});

// ---------------------------------------------------------------------
// P10: Normale Team-Sockets sehen in der Lobby KEIN Pirat-Mitglied (st.pirate
// fehlt); der GM/Pirat-Socket sieht die normalen Teams + den Pirat.
// ---------------------------------------------------------------------
test('P10: normales Team sieht kein Pirat-Mitglied in Lobby; GM/Pirat sieht normale Teams + Pirat', async () => {
  const srv = startServer();
  const url = 'http://localhost:' + srv.port;
  try {
    const { gm, a, d, created } = await setupGame(srv, url, {
      fields: GUNDO_FIELDS,
      settings: { piratesEnabled: true }
    });

    // Lobby-Zustand (vor Spielstart): broadcast wird durch vote/join getriggert.
    // Wir sammeln die letzten States von GM und Team-Socket.
    let stGm = null; let stA = null;
    gm.on('state', (st) => { stGm = st; });
    a.on('state', (st) => { stA = st; });
    // Vote triggert keinen broadcast; ein weiterer Join triggert einen.
    const extra = await connect(url, 'extra');
    const inv0 = created.tokens.find((t) => t.ship === 'Redeemer').code;
    const pj = once(extra, 'joined');
    extra.emit('team:join', { gameId: created.gameId, code: inv0, playerName: 'X' });
    await pj;
    await sleep(80);

    assert.ok(stGm, 'GM hat einen Lobby-State');
    assert.ok(stA, 'Team-Socket hat einen Lobby-State');
    // GM/Pirat-Socket sieht den Pirat-Eintrag
    assert.ok(stGm.pirate, 'GM/Pirat-Socket sieht den Pirat-Eintrag (st.pirate)');
    assert.strictEqual(stGm.pirate.teamId, 'PIRATES', 'Pirat-Eintrag ist das Piraten-Team');
    // GM sieht auch die normalen Teams
    assert.strictEqual(stGm.teams.length, 2, 'GM sieht die normalen Teams');
    // Normales Team-Socket sieht KEINEN Pirat-Eintrag
    assert.strictEqual(stA.pirate, null, 'Normales Team sieht KEIN Pirat-Mitglied (st.pirate fehlt)');
    // Normales Team sieht die normalen Teams
    assert.strictEqual(stA.teams.length, 2, 'Normales Team sieht die normalen Teams');

    [gm, a, d, extra].forEach((c) => c.disconnect());
  } finally { srv.stop(); }
});
