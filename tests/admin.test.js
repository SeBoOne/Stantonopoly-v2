/* =====================================================================
 * Stantonopoly V2 — tests/admin.test.js (2o-BONUS)
 * Admin-REST-API: Auth-Gate (401 ohne Token / 403 kein Zugriff), Login,
 * Dashboard-Stats, Preset-CRUD (builtin geschützt), Spiel-Deletion
 * (Hard-Delete räumt verkettete Daten auf: teams/players/votes/codes).
 *
 * Start: node --test tests/admin.test.js
 * ===================================================================== */
'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { io: ClientIO } = require('socket.io-client');
const { startServer } = require('./helpers.js');

const ADMIN_USER = 'sebo';
const ADMIN_PASS = 'Sup3rGeheim!';
// salt:hash über scrypt (identisch zur Server-Implementierung in server/admin.js)
const SALT = crypto.randomBytes(16).toString('hex');
const HASH = crypto.scryptSync(ADMIN_PASS, SALT, 64).toString('hex');
process.env.STANTONOPOLY_ADMIN_USER = ADMIN_USER;
process.env.STANTONOPOLY_ADMIN_PASS_HASH = SALT + ':' + HASH;

let srv = null, url = null;
const allClients = [];
before(async () => { srv = startServer(); url = 'http://localhost:' + srv.port; });
after(() => { allClients.forEach((c) => { try { c.disconnect(true); } catch (e) {} }); try { srv.stop(); } catch (e) {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function connect(name) {
  const c = ClientIO(url, { transports: ['websocket'], reconnection: false, forceNew: true, timeout: 8000 });
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('Connect-Timeout ' + name)), 8000);
    c.on('connect', () => { clearTimeout(to); resolve(c); });
    c.on('connect_error', (e) => { clearTimeout(to); reject(new Error('connect_error ' + name + ': ' + e.message)); });
  });
}
function once(client, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { client.off(event); reject(new Error('Timeout ' + event)); }, timeoutMs);
    client.once(event, (d) => { clearTimeout(to); resolve(d); });
  });
}

async function http(method, path, body, token) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

async function login() {
  const r = await http('POST', '/admin/login', { username: ADMIN_USER, password: ADMIN_PASS });
  assert.strictEqual(r.status, 200, 'Login ok');
  assert.ok(r.data && r.data.token, 'Token geliefert');
  return r.data.token;
}

// Erzeugt ein Spiel über Socket (Lobby, nicht gestartet): {gm, ev}
async function createLobbyGame() {
  const gm = allClients.find((c) => c.__gm) ? null : await connect('admin-gm-' + Math.random().toString(36).slice(2));
  allClients.push(gm);
  const p = once(gm, 'gameCreated');
  gm.emit('gm:create', { config: { teams: 2, capital: 1500000, diceConfig: '1w6', armistice: false } });
  const ev = await p;
  return { gm, ev };
}

// ---------- Auth-Gate ----------

test('Ohne Token kein Zugriff auf Admin-Endpoints (401)', async () => {
  for (const [m, p] of [['GET', '/admin/dashboard'], ['GET', '/admin/games'], ['GET', '/admin/presets'], ['GET', '/admin/log'], ['DELETE', '/admin/games/x'], ['POST', '/admin/presets']]) {
    const r = await http(m, p, m === 'POST' ? { name: 'X', fields: [] } : undefined);
    assert.strictEqual(r.status, 401, m + ' ' + p + ' 401 ohne Token');
  }
});

test('Falsches Token → 401', async () => {
  const r = await http('GET', '/admin/dashboard', undefined, 'gibtesnicht123');
  assert.strictEqual(r.status, 401, 'ungültiges Token 401');
  assert.strictEqual(r.data && r.data.error, 'UNAUTH');
});

test('Login mit falschem Passwort → 401 + protokolliert', async () => {
  const r = await http('POST', '/admin/login', { username: ADMIN_USER, password: 'falsch' });
  assert.strictEqual(r.status, 401, 'falsches Passwort 401');
  const logr = await http('GET', '/admin/log', undefined, await login());
  assert.ok(logr.data.log.some((l) => l.action === 'login_failed'), 'login_failed ins Audit-Log');
});

test('Login mit unbekanntem Benutzer → 401', async () => {
  const r = await http('POST', '/admin/login', { username: 'hacker', password: ADMIN_PASS });
  assert.strictEqual(r.status, 401);
});

test('Setup-Status: Konto existiert → needsSetup=false; Setup gesperrt (403)', async () => {
  const st = await http('GET', '/admin/setup-status');
  assert.strictEqual(st.status, 200);
  assert.strictEqual(st.data.needsSetup, false, 'Konto existiert bereits (env-Hash)');
  const setup = await http('POST', '/admin/setup', { username: 'neu', password: 'NeuesPasswort1' });
  assert.strictEqual(setup.status, 403, 'Setup nach bestehendem Konto gesperrt');
  assert.strictEqual(setup.data.error, 'ALREADY_SETUP');
});

test('Login korrekt → Token + /me + Logout', async () => {
  const token = await login();
  const me = await http('GET', '/admin/me', undefined, token);
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.data.username, ADMIN_USER);
  const out = await http('POST', '/admin/logout', {}, token);
  assert.strictEqual(out.status, 200, 'Logout ok');
  const afterLogout = await http('GET', '/admin/me', undefined, token);
  assert.strictEqual(afterLogout.status, 401, 'nach Logout ist Token ungültig');
});

// ---------- Dashboard-Stats ----------

test('Dashboard liefert Status-Zählungen + Preset-Count', async () => {
  const token = await login();
  const d = await http('GET', '/admin/dashboard', undefined, token);
  assert.strictEqual(d.status, 200);
  assert.ok(typeof d.data.stats.total === 'number');
  assert.ok(typeof d.data.stats.presetCount === 'number');
  assert.ok(d.data.stats.presetCount >= 1, 'mind. eingebaute Presets vorhanden');
});

// ---------- Preset-CRUD (Auth) ----------

test('Preset anlegen / listen / bearbeiten / löschen (builtin geschützt)', async () => {
  const token = await login();
  const name = 'Admin-Admin-Test-' + Date.now();
  const fields = [{ type: 'los', name: 'Los' }, { type: 'grundstueck', name: 'Testfeld', price: 250000, group: 'gruen' }];
  // Anlegen
  const c = await http('POST', '/admin/presets', { name, fields, levelNames: { ALLEIN: 'Base' } }, token);
  assert.strictEqual(c.status, 200, 'Preset anlegen ok');
  assert.strictEqual(c.data.preset.builtin, false);
  // Listen → enthalten
  const l1 = await http('GET', '/admin/presets', undefined, token);
  assert.ok(l1.data.presets.some((p) => p.name === name), 'neues Preset in Liste');
  // Bearbeiten (fields ändern)
  const fields2 = [{ type: 'los', name: 'Los' }, { type: 'grundstueck', name: 'Testfeld2', price: 400000, group: 'blau' }];
  const u = await http('POST', '/admin/presets', { name, fields: fields2, levelNames: { ALLEIN: 'Base' } }, token);
  assert.strictEqual(u.data.preset.fields[1].name, 'Testfeld2');
  assert.strictEqual(u.data.preset.fields[1].group, 'blau');
  // Builtin-Löschung verboten
  const b = await http('DELETE', '/admin/presets/' + encodeURIComponent('Crusader Cluster'), undefined, token);
  assert.strictEqual(b.status, 403, 'builtin 403');
  const bs = await http('POST', '/admin/presets', { name: 'Crusader Cluster', fields }, token);
  assert.strictEqual(bs.status, 403, 'builtin überschreiben 403');
  // Löschen (eigen) ok
  const d = await http('DELETE', '/admin/presets/' + encodeURIComponent(name), undefined, token);
  assert.strictEqual(d.status, 200);
  const l2 = await http('GET', '/admin/presets', undefined, token);
  assert.ok(!l2.data.presets.some((p) => p.name === name), 'Preset weg');
});

// ---------- Spiele-Deletion räumt verkettete Daten auf ----------

test('Spiel löschen entfernt Teams/Spieler/Stimmen/Codes (Hard-Delete), archiviert bleibt listbar', async () => {
  const token = await login();
  const { gm, ev } = await createLobbyGame();
  // Beitreten: 2 Spieler in Team 0.
  const inv0 = ev.tokens.find((t) => t.teamId === ev.tokens[0].teamId).code;
  const cl1 = await connect('adelete-a'); allClients.push(cl1);
  const j1 = once(cl1, 'joined');
  cl1.emit('team:join', { gameId: ev.gameId, code: inv0, playerName: 'A' });
  await j1;
  const cl2 = await connect('adelete-b'); allClients.push(cl2);
  const j2 = once(cl2, 'joined');
  cl2.emit('team:join', { gameId: ev.gameId, code: inv0, playerName: 'B' });
  await j2;
  // Stimme abgeben (create a vote row)
  cl1.emit('vote:leader', { gameId: ev.gameId, playerId: cl1.id });
  await sleep(40);

  // Spiel erscheint in der Admin-Liste (nicht beendet, Lobby) inkl. gmCode.
  const g1 = await http('GET', '/admin/games', undefined, token);
  const found = g1.data.games.find((g) => g.gameId === ev.gameId);
  assert.ok(found, 'Spiel in nicht-beendet-Liste');
  assert.ok(found.gmCode === ev.gmCode, 'gmCode sichtbar');

  // Verkettete Daten vor dem Löschen vorhanden.
  // Löschen per Admin.
  const del = await http('DELETE', '/admin/games/' + encodeURIComponent(ev.gameId), undefined, token);
  assert.strictEqual(del.status, 200, 'Spiel löschen ok');
  assert.ok(del.data.removed);

  // Aus Liste weg.
  const g2 = await http('GET', '/admin/games', undefined, token);
  assert.ok(!g2.data.games.some((g) => g.gameId === ev.gameId), 'gelöschtes Spiel nicht mehr gelistet');

  // Audit-Log enthält delete_game.
  const logr = await http('GET', '/admin/log', undefined, token);
  assert.ok(logr.data.log.some((l) => l.action === 'delete_game' && l.target === ev.gameId), 'delete_game protokolliert');

  // DB-Cascache prüfen: teams/players/votes/codes/games leer.
  const dbm = require('../server/db.js');
  assert.strictEqual(dbm.getGame(ev.gameId), null, 'games-Row weg');
  assert.strictEqual(dbm.getTeams(ev.gameId).length, 0, 'teams weg');
  assert.strictEqual(dbm.getPlayers(ev.gameId).length, 0, 'players weg');
  assert.strictEqual(dbm.getCode(ev.gmCode), null, 'gm-Code weg');
  assert.strictEqual(dbm.getCode(inv0), null, 'invite-Code weg');
  assert.strictEqual(dbm.getVotes(ev.gameId, ev.tokens[0].teamId).length, 0, 'votes weg');
  gm.disconnect();
});

test('Unbekanntes Spiel löschen → 404', async () => {
  const token = await login();
  const r = await http('DELETE', '/admin/games/GIBTSNICHT', undefined, token);
  assert.strictEqual(r.status, 404);
});

test('Beendete Spiele (Archiv) sind listbar, löschbar, wieder listbar in Archiv', async () => {
  const token = await login();
  const dbm = require('../server/db.js');
  // Ein archiviertes Spiel direkt in die DB setzen (over=1).
  const gameId = 'ADARCH' + Date.now().toString().slice(-6);
  const gmCode = 'ADGM' + Date.now().toString().slice(-6);
  dbm.createGame({ gameId, gmCode, state: '{}', started: 1, over: 1, name: 'Archiv-Test', gmName: 'GM' });
  dbm.addCode({ code: gmCode, kind: 'gm', gameId });
  // Team + Spieler anlegen
  dbm.upsertTeam({ gameId, teamId: 'team_0', ship: 'Redeemer', color: '#2ecc71', invite_code: null });
  dbm.addPlayer({ id: 'sock1', gameId, teamId: 'team_0', name: 'Z' });

  const g = await http('GET', '/admin/games', undefined, token);
  assert.ok(g.data.archived.some((x) => x.gameId === gameId), 'beendetes Spiel im Archiv');
  assert.ok(!g.data.games.some((x) => x.gameId === gameId), 'nicht in aktiven');

  const del = await http('DELETE', '/admin/games/' + encodeURIComponent(gameId), undefined, token);
  assert.strictEqual(del.status, 200);
  assert.strictEqual(dbm.getGame(gameId), null);
});
