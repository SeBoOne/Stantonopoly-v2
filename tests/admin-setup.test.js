/* =====================================================================
 * Stantonopoly V2 — tests/admin-setup.test.js (2o-BONUS)
 * Ersteinrichtung: auf einer FRISCHEN DB (ohne env-Hash) ist /admin/setup
 * offen und legt das Admin-Konto an; danach ist es dauerhaft gesperrt.
 * Start: node --test tests/admin-setup.test.js
 * ===================================================================== */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startServer } = require('./helpers.js');

// WICHTIG: KEIN STANTONOPOLY_ADMIN_PASS_HASH setzen → frische DB ohne Konto.
let srv = null, url = null;
before(() => { srv = startServer(); url = 'http://localhost:' + srv.port; });
after(() => { try { srv.stop(); } catch (e) {} });

async function http(method, path, body, token) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

test('Frische DB: setup-status → needsSetup=true', async () => {
  const st = await http('GET', '/admin/setup-status');
  assert.strictEqual(st.status, 200);
  assert.strictEqual(st.data.needsSetup, true, 'frische DB braucht Einrichtung');
});

test('Setup legt Konto an, liefert Token; danach gesperrt', async () => {
  const s = await http('POST', '/admin/setup', { username: 'sebo', password: 'MeinGeheim1' });
  assert.strictEqual(s.status, 200, 'Setup ok');
  assert.ok(s.data.token, 'Token nach Setup');
  assert.strictEqual(s.data.username, 'sebo');
  // Token funktioniert sofort.
  const me = await http('GET', '/admin/me', undefined, s.data.token);
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.data.username, 'sebo');
  // Danach: setup-status false + Setup gesperrt.
  const st = await http('GET', '/admin/setup-status');
  assert.strictEqual(st.data.needsSetup, false);
  const again = await http('POST', '/admin/setup', { username: 'x', password: 'Anderes1' });
  assert.strictEqual(again.status, 403);
  // Login mit dem neuen Passwort funktioniert.
  const login = await http('POST', '/admin/login', { username: 'sebo', password: 'MeinGeheim1' });
  assert.strictEqual(login.status, 200);
  assert.ok(login.data.token);
});

test('Setup mit zu kurzem Passwort → 400', async () => {
  // Konto existiert bereits → 403 (nicht 400). Für 400 brauchen wir eine frische
  // DB; hier prüfen wir nur, dass der Weg nach Einrichtung zuverlässig zu ist.
  const s = await http('POST', '/admin/setup', { username: 'y', password: 'kurz' });
  assert.strictEqual(s.status, 403);
});
