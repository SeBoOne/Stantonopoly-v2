/**
 * Stantonopoly V2 — P4: Preset-Editor-Rechte (Manager-Rolle) Tests
 * Start: node --test tests/manager.test.js
 *
 * Abgedeckt:
 *  P4a  preset:save / preset:delete OHNE Manager-Code → FORBIDDEN (Standardmodus temporär)
 *  P4b  manager:auth mit gültigem Code → save ok; builtin darf per Socket NICHT überschrieben
 *       werden (nur Admin); deaktivierte Presets im Spiel ausgeblendet
 *  P4c  Admin REST: manager-codes CRUD (create/list/delete/rename), requireAuth=401,
 *       Manager-Aktionen erscheinen im Audit-Log (admin_log) mit Manager-Name
 */
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const { io: ClientIO } = require('socket.io-client');
const crypto = require('node:crypto');
const http = require('http');
const path = require('path');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Server im selben Prozess mit Wegwerf-DB ─────────────────────────
const TMPDIR = process.env.TMPDIR || os.tmpdir();
const DB_PATH = path.join(TMPDIR, 'manager-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.db');
const PORT = 19400 + Math.floor(Math.random() * 200);
process.env.STANTONOPOLY_DB = DB_PATH;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'test';

// Admin creds (scrypt salt:hash, identisch zur Server-Implementierung)
const ADMIN_USER = 'qa';
const ADMIN_PASS = 'abc123';
const SALT = crypto.randomBytes(16).toString('hex');
const HASH = crypto.scryptSync(ADMIN_PASS, SALT, 64).toString('hex');
process.env.STANTONOPOLY_ADMIN_USER = ADMIN_USER;
process.env.STANTONOPOLY_ADMIN_PASS_HASH = SALT + ':' + HASH;

const mod = require(path.join(__dirname, '..', 'server', 'index.js'));
const srv = mod.start(PORT);
const { io, app } = mod;
const dbm = require(path.join(__dirname, '..', 'server', 'db.js'));

const ALL_SOCKETS = [];
const track = (c) => { ALL_SOCKETS.push(c); return c; };

function connect(name) {
  const c = ClientIO(`http://localhost:${PORT}`, { transports: ['websocket'], reconnection: false, forceNew: true, timeout: 3000 });
  if (c.io && c.io.engine) c.io.engine.on('open', () => { c.io.engine.pingInterval = 0; c.io.engine.pingTimeout = 0; });
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { c.disconnect(true); reject(new Error(`Connect ${name}`)); }, 5000);
    c.on('connect', () => { clearTimeout(to); resolve(c); });
    c.on('connect_error', (e) => { clearTimeout(to); c.disconnect(true); reject(new Error(`${name}: ${e.message}`)); });
  });
}

function once(emitter, event, ms = 5000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { emitter.off(event, h); reject(new Error(`once timeout ${event}`)); }, ms);
    const h = (data) => { clearTimeout(to); resolve(data); };
    emitter.once(event, h);
  });
}

function httpReq(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const req = http.request({ host: 'localhost', port: PORT, path: p, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let j = null; try { j = JSON.parse(data); } catch (e) {}
        resolve({ status: res.statusCode, data: j });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Admin-Token für requireAuth-Routen ───────────────────────────────
let ADMIN_TOKEN = null;
async function adminLogin() {
  if (ADMIN_TOKEN) return ADMIN_TOKEN;
  const r = await httpReq('POST', '/admin/login', { username: 'qa', password: 'abc123' });
  assert.strictEqual(r.status, 200, 'Admin-Login ok');
  ADMIN_TOKEN = r.data.token;
  return ADMIN_TOKEN;
}

after(async () => {
  ALL_SOCKETS.forEach((c) => { try { c.disconnect(true); } catch (e) {} });
  try { srv.close(); } catch (e) {}
});

// ─── P4a: ohne Manager-Code kein permanentes Speichern ────────────────
test('P4a: preset:save/prest:delete verweigert ohne Manager (FORBIDDEN)', async () => {
  const c = await track(connect('p4a-anon'));
  // Socket-seitig 'error'-Event abfangen
  const errP = once(c, 'error').catch(() => ({}));
  c.emit('preset:save', { name: 'anon-test', fields: [{ type: 'los', name: 'Los' }] });
  const err = await errP;
  assert.strictEqual(err.code, 'FORBIDDEN', 'ohne Manager kein Speichern');
  // Und wirklich nichts gespeichert:
  assert.ok(!dbm.getPreset('anon-test'), 'kein Preset angelegt');
  // Delete ebenso
  const errD = once(c, 'error').catch(() => ({}));
  c.emit('preset:delete', { name: 'Crusader Cluster' });
  const ed = await errD;
  assert.strictEqual(ed.code, 'FORBIDDEN');
  c.disconnect(true);
});

// ─── P4b: Manager-Auth aktiviert Rechte; builtin-Überschreibung trotzdem gesperrt ───
test('P4b: manager:auth → save ok; builtin per Socket NIE überschreibbar; Log mit Name', async () => {
  // Manager-Code direkt in der Test-DB anlegen (wie Admin es tun würde).
  dbm.addManagerCode('QA-MGR-8X', 'QA-Leiter');
  const c = await track(connect('p4b-mgr'));

  // ohne manager:auth → save der aktuelle Datei abgelehnt
  let errP = once(c, 'error').catch(() => ({}));
  c.emit('preset:save', { name: 'mgr-preset', fields: [{ type: 'los', name: 'X' }] });
  assert.strictEqual((await errP).code, 'FORBIDDEN');

  // auth mit falschem Code → Fehler
  let e2 = once(c, 'error').catch(() => ({}));
  c.emit('manager:auth', { code: 'FALSCH' });
  assert.strictEqual((await e2).code, 'BAD_MANAGER_CODE');

  // auth mit gültigem Code
  const okP = once(c, 'manager:auth-ok');
  c.emit('manager:auth', { code: 'qa-mgr-8x' }); // lowercase → server normalisiert uppercase
  const auth = await okP;
  assert.strictEqual(auth.name, 'QA-Leiter');

  // jetzt speichern erlaubt
  const preP = once(c, 'presets');
  c.emit('preset:save', { name: 'mgr-preset', fields: [{ type: 'los', name: 'Los' }, { type: 'grundstueck', name: 'Feld', price: 200000, group: 'rot' }] });
  await preP;
  const saved = dbm.getPreset('mgr-preset');
  assert.ok(saved, 'Preset gespeichert');
  assert.strictEqual(saved.fields[1].price, 200000);

  // QA-Fix (Punkt 1): Betrags-Felder (fee/bonus) für Los/Ereignis/Steuer/Gefängnis
  // werden über preset:save sauber persistiert.
  const pre2 = once(c, 'presets');
  c.emit('preset:save', { name: 'mgr-preset-2', fields: [
    { type: 'los', name: 'Los', bonus: 30000 },
    { type: 'ereignis', name: 'Ereignis', fee: 50000 },
    { type: 'steuer', name: 'Steuer', fee: 25000 },
    { type: 'gefangnis', name: 'Klescher', fee: 75000 }
  ] });
  await pre2;
  const s2 = dbm.getPreset('mgr-preset-2');
  assert.ok(s2, 'Betrag-Preset gespeichert');
  assert.strictEqual(s2.fields.find((f) => f.type === 'los').bonus, 30000, 'Los-Bonus persistiert');
  assert.strictEqual(s2.fields.find((f) => f.type === 'ereignis').fee, 50000, 'Ereignis-Fee persistiert');
  assert.strictEqual(s2.fields.find((f) => f.type === 'steuer').fee, 25000, 'Steuer-Betrag persistiert');
  assert.strictEqual(s2.fields.find((f) => f.type === 'gefangnis').fee, 75000, 'Gefängnis-Lösegeld persistiert');

  // QA-Fix (Punkt 2): manager:logout setzt Rechte zurück → save danach wieder FORBIDDEN.
  const lgP = once(c, 'manager:auth-ok');
  c.emit('manager:logout', {});
  const lg = await lgP;
  assert.strictEqual(lg.name, null, 'Logout bestätigt (name null)');
  const eOut = once(c, 'error').catch(() => ({}));
  c.emit('preset:save', { name: 'nach-logout', fields: [{ type: 'los', name: 'X' }] });
  const eOutR = await eOut;
  assert.strictEqual(eOutR.code, 'FORBIDDEN', 'nach Logout kein Speichern mehr');

  // builtin per Socket NICHT überschreiben (nur Admin)
  const e3 = once(c, 'error').catch(() => ({}));
  c.emit('preset:save', { name: 'Crusader Cluster', fields: [{ type: 'los', name: 'MUTED' }] });
  const e3r = await e3;
  assert.strictEqual(e3r.code, 'FORBIDDEN', 'builtin nur über Admin');

  // Audit-Log enthält save mit Manager-Name
  const log = dbm.listAdminLog(20);
  const saveLog = log.find((l) => l.action === 'save_preset' && l.target === 'mgr-preset');
  assert.ok(saveLog, 'save_preset im Log');
  assert.ok(saveLog.detail.includes('QA-Leiter'), 'Manager-Name im Log: ' + saveLog.detail);

  c.disconnect(true);
  dbm.deletePreset('mgr-preset');
  dbm.deletePreset('mgr-preset-2');
  dbm.deletePreset('nach-logout');
  dbm.deleteManagerCode('QA-MGR-8X');
});

// ─── P4c: Admin REST manager-codes CRUD + requireAuth + Audit ─────────
test('P4c: Admin REST manager-codes CRUD (create/list/rename/delete), 401 ohne Token, Audit', async () => {
  // ohne Token → 401
  assert.strictEqual((await httpReq('GET', '/admin/manager-codes')).status, 401, 'GET 401');
  assert.strictEqual((await httpReq('POST', '/admin/manager-codes', { name: 'x' })).status, 401, 'POST 401');
  assert.strictEqual((await httpReq('DELETE', '/admin/manager-codes/ABC', undefined, undefined)).status, 401, 'DELETE 401');

  const tok = await adminLogin();

  // create
  const cr = await httpReq('POST', '/admin/manager-codes', { name: 'Sebo' }, tok);
  assert.strictEqual(cr.status, 200);
  assert.ok(cr.data.code && cr.data.code.length >= 8, 'Code erzeugt');
  assert.strictEqual(cr.data.name, 'Sebo');
  const createdCode = cr.data.code;

  // list enthält es
  const ls = (await httpReq('GET', '/admin/manager-codes', undefined, tok)).data;
  assert.ok(Array.isArray(ls.codes));
  const row = ls.codes.find((x) => x.code === createdCode);
  assert.ok(row, 'Code in Liste');
  assert.strictEqual(row.name, 'Sebo');

  // rename
  const rn = await httpReq('POST', '/admin/manager-codes/' + createdCode + '/rename', { name: 'Sebo (Server)' }, tok);
  assert.strictEqual(rn.status, 200);
  assert.strictEqual(rn.data.name, 'Sebo (Server)');

  // delete
  const dl = await httpReq('DELETE', '/admin/manager-codes/' + createdCode, undefined, tok);
  assert.strictEqual(dl.status, 200);
  const ls2 = (await httpReq('GET', '/admin/manager-codes', undefined, tok)).data;
  assert.ok(!ls2.codes.some((x) => x.code === createdCode), 'Code entfernt');

  // Audit-Log-Einträge
  const log = dbm.listAdminLog(50);
  assert.ok(log.some((l) => l.action === 'create_manager_code' && l.target === 'Sebo'), 'create im Log');
  assert.ok(log.some((l) => l.action === 'delete_manager_code' && l.target === 'Sebo (Server)'), 'delete im Log');
});