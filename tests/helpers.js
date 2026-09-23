/* =====================================================================
 * Stantonopoly V2 — Test-Helper
 * Server IM SELBEN PROZESS (jeder Testfile läuft in eigenem Prozess),
 * mit eigener Wegwerf-DB. Genau EIN Server + EINE DB pro Prozess
 * (node:sqlite + index-module sind Singletons) — startServer() cached.
 * ===================================================================== */
'use strict';

const path = require('path');
const os = require('os');

const PROJ = path.join(__dirname, '..');

// Ein laufender Server pro Prozess.
let _current = null;

/**
 * Startet den Server in-process (nur beim ersten Aufruf; danach Cached).
 * @returns {{server, io, app, rooms, port, dbPath, ready, stop}}
 */
function startServer() {
  if (_current) return _current;

  const port = 8400 + Math.floor(Math.random() * 400);
  const sysTmp = process.env.TMPDIR || os.tmpdir();
  const dbPath = path.join(sysTmp, 'stp-test-' + process.pid + '.db');
  process.env.STANTONOPOLY_DB = dbPath;
  process.env.NODE_ENV = 'test';
  process.env.PORT = String(port);

  const mod = require(path.join(PROJ, 'server', 'index.js'));
  const srv = mod.start(port);
  mod.port = port;

  _current = {
    server: srv,
    io: mod.io,
    app: mod.app,
    rooms: mod.rooms,
    port,
    dbPath,
    ready: true,
    stop: () => { try { srv.close(); } catch (e) {} }
  };
  return _current;
}

module.exports = { startServer, PROJ };