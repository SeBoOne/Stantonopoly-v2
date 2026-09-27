/**
 * Stantonopoly V2 — Persistenz (node:sqlite, eingebaut, KEINE nativen Module).
 * Eine Datenbank: data/stantonopoly.db
 *
 * Tabellen:
 *  - games       (gameId, gmCode, state, eingeMetadata?, created_at, started)
 *  - teams       (gameId, teamId, ship, color, invite_code, leaderId)
 *  - players     (id, gameId, teamId, name)
 *  - votes       (gameId, teamId, voterId, candidateId)   [Stimm-Mehrheit Teamleiter]
 *  - codes       (code, kind['gm'|'invite'], gameId, teamId) — Index für Lookup
 *
 * Runden-Zustände werden als JSON im `games.state` gespeichert (Engine-serialisiert).
 * Alle Geschäftsregel-Prüfungen (Rechte, Codes) liegen in rooms.js / index.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.STANTONOPOLY_DB || path.join(DB_DIR, 'stantonopoly.db');

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    gameId     TEXT PRIMARY KEY,
    gmCode     TEXT UNIQUE NOT NULL,
    state      TEXT NOT NULL,
    started    INTEGER NOT NULL DEFAULT 0,
    over       INTEGER NOT NULL DEFAULT 0,
    paused     INTEGER NOT NULL DEFAULT 0,
    name       TEXT,
    gmName     TEXT NOT NULL DEFAULT 'GM',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    lastActivity INTEGER,            -- (2m-A) ms-Timestamp letzte Spieleraktion (Auto-Pause)
    lastPausedAt INTEGER             -- (2m-A) ms-Timestamp Beginn Pause (Auto-Beenden)
  );
  CREATE TABLE IF NOT EXISTS teams (
    gameId      TEXT NOT NULL,
    teamId      TEXT NOT NULL,
    ship        TEXT,
    color       TEXT,
    invite_code TEXT UNIQUE,
    leaderId    TEXT,
    PRIMARY KEY (gameId, teamId)
  );
  CREATE TABLE IF NOT EXISTS players (
    id      TEXT PRIMARY KEY,     -- aktuelle Socket-ID (wird bei Rejoin auf alte ID umgemappt)
    gameId  TEXT NOT NULL,
    teamId  TEXT NOT NULL,
    name    TEXT NOT NULL,
    token   TEXT UNIQUE           -- stabiler Rejoin-Token (überlebt Reload)
  );
  CREATE TABLE IF NOT EXISTS votes (
    gameId      TEXT NOT NULL,
    teamId      TEXT NOT NULL,
    voterId     TEXT NOT NULL,
    candidateId TEXT NOT NULL,
    PRIMARY KEY (gameId, teamId, voterId)
  );
  CREATE TABLE IF NOT EXISTS codes (
    code    TEXT PRIMARY KEY,
    kind    TEXT NOT NULL,            -- 'gm' | 'invite'
    gameId  TEXT NOT NULL,
    teamId  TEXT
  );
  CREATE TABLE IF NOT EXISTS presets (
    name    TEXT PRIMARY KEY,
    fields  TEXT NOT NULL,            -- JSON-Array der Felder
    builtin INTEGER NOT NULL DEFAULT 0, -- 1 = eingebaute Presets (nicht löschbar)
    level_names TEXT,                 -- JSON-Objekt: Stufe -> anzeigename (Standard/Cyclone/...)
    settings TEXT,                    -- JSON-Objekt: Spielregeln (Miet-Mult/Cost/Hypothek/Bank/Timer)
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migrationen für Bestands-DBs: fehlende Spalten ergänzen.
(function migrate() {
  const cols = db.prepare(`SELECT name FROM pragma_table_info('games')`).all().map((c) => c.name);
  if (!cols.includes('name')) { try { db.exec(`ALTER TABLE games ADD COLUMN name TEXT`); } catch (e) {} }
  if (!cols.includes('updated_at')) { try { db.exec(`ALTER TABLE games ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))`); } catch (e) {} }
  if (!cols.includes('paused')) { try { db.exec(`ALTER TABLE games ADD COLUMN paused INTEGER NOT NULL DEFAULT 0`); } catch (e) {} }
  if (!cols.includes('gm_owner')) { try { db.exec(`ALTER TABLE games ADD COLUMN gm_owner TEXT`); } catch (e) {} }
  if (!cols.includes('gmName')) { try { db.exec(`ALTER TABLE games ADD COLUMN gmName TEXT NOT NULL DEFAULT 'GM'`); } catch (e) {} }
  if (!cols.includes('lastActivity')) { try { db.exec(`ALTER TABLE games ADD COLUMN lastActivity INTEGER`); } catch (e) {} }
  if (!cols.includes('lastPausedAt')) { try { db.exec(`ALTER TABLE games ADD COLUMN lastPausedAt INTEGER`); } catch (e) {} }
  const pcols = db.prepare(`SELECT name FROM pragma_table_info('presets')`).all().map((c) => c.name);
  if (!pcols.includes('level_names')) { try { db.exec(`ALTER TABLE presets ADD COLUMN level_names TEXT`); } catch (e) {} }
  if (!pcols.includes('settings')) { try { db.exec(`ALTER TABLE presets ADD COLUMN settings TEXT`); } catch (e) {} }
})();

const stmts = {
  insertGame: db.prepare('INSERT INTO games (gameId, gmCode, state, started, over, name, gmName, lastActivity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  getGame: db.prepare('SELECT * FROM games WHERE gameId = ?'),
  getGameByGm: db.prepare('SELECT * FROM games WHERE gmCode = ?'),
  listGames: db.prepare('SELECT gameId, gmCode, started, over, paused, name, created_at, updated_at, lastActivity, lastPausedAt FROM games ORDER BY created_at DESC'),
  setGameName: db.prepare('UPDATE games SET name = ?, updated_at = datetime(\'now\') WHERE gameId = ?'),
  setGmName: db.prepare('UPDATE games SET gmName = ?, updated_at = datetime(\'now\') WHERE gameId = ?'),
  touchGame: db.prepare('UPDATE games SET updated_at = datetime(\'now\') WHERE gameId = ?'),
  touchActivity: db.prepare('UPDATE games SET lastActivity = ? WHERE gameId = ?'),
  updateState: db.prepare('UPDATE games SET state = ?, started = ?, over = ? WHERE gameId = ?'),
  setStarted: db.prepare('UPDATE games SET started = ? WHERE gameId = ?'),
  setPaused: db.prepare('UPDATE games SET paused = ?, lastPausedAt = ?, updated_at = datetime(\'now\') WHERE gameId = ?'),
  setGmOwner: db.prepare('UPDATE games SET gm_owner = ?, updated_at = datetime(\'now\') WHERE gameId = ?'),
  insertTeam: db.prepare('INSERT OR REPLACE INTO teams (gameId, teamId, ship, color, invite_code, leaderId) VALUES (?, ?, ?, ?, ?, ?)'),
  getTeams: db.prepare('SELECT * FROM teams WHERE gameId = ?'),
  getTeam: db.prepare('SELECT * FROM teams WHERE gameId = ? AND teamId = ?'),
  getTeamByInvite: db.prepare('SELECT * FROM teams WHERE invite_code = ?'),
  setLeader: db.prepare('UPDATE teams SET leaderId = ? WHERE gameId = ? AND teamId = ?'),
  insertPlayer: db.prepare('INSERT OR REPLACE INTO players (id, gameId, teamId, name, token) VALUES (?, ?, ?, ?, ?)'),
  getPlayers: db.prepare('SELECT * FROM players WHERE gameId = ?'),
  getPlayer: db.prepare('SELECT * FROM players WHERE id = ?'),
  getPlayerByToken: db.prepare('SELECT * FROM players WHERE token = ?'),
  updatePlayerSock: db.prepare('UPDATE players SET id = ? WHERE token = ?'),
  deletePlayer: db.prepare('DELETE FROM players WHERE gameId = ? AND id = ?'),
  deleteVotesForPlayer: db.prepare('DELETE FROM votes WHERE gameId = ? AND (voterId = ? OR candidateId = ?)'),
  getPlayerByGameId: db.prepare('SELECT * FROM players WHERE gameId = ? ORDER BY rowid'),
  insertVote: db.prepare('INSERT OR REPLACE INTO votes (gameId, teamId, voterId, candidateId) VALUES (?, ?, ?, ?)'),
  getVotes: db.prepare('SELECT * FROM votes WHERE gameId = ? AND teamId = ?'),
  clearVotes: db.prepare('DELETE FROM votes WHERE gameId = ? AND teamId = ?'),
  insertCode: db.prepare('INSERT OR REPLACE INTO codes (code, kind, gameId, teamId) VALUES (?, ?, ?, ?)'),
  deleteCode: db.prepare('DELETE FROM codes WHERE code = ?'),
  getCode: db.prepare('SELECT * FROM codes WHERE code = ?'),

  upsertPreset: db.prepare('INSERT OR REPLACE INTO presets (name, fields, builtin, level_names, settings) VALUES (?, ?, ?, ?, ?)'),
  getPresets: db.prepare('SELECT name, fields, builtin, updated_at, level_names, settings FROM presets ORDER BY builtin DESC, name ASC'),
  getPreset: db.prepare('SELECT * FROM presets WHERE name = ?'),
  deletePreset: db.prepare('DELETE FROM presets WHERE name = ?')
};

function createGame({ gameId, gmCode, state, started = 0, over = 0, name = null, gmName = 'GM' }) {
  stmts.insertGame.run(gameId, gmCode, state, started ? 1 : 0, over ? 1 : 0, name, gmName, Date.now());
}

function listAllGames() {
  return stmts.listGames.all();
}

function setGameName(gameId, name) {
  stmts.setGameName.run(String(name || '').slice(0, 60), gameId);
}

function setGmName(gameId, name) {
  stmts.setGmName.run(String(name || 'GM').slice(0, 40), gameId);
}

function touchGame(gameId) {
  stmts.touchGame.run(gameId);
}

// (2m-A) Markiert eine Spieleraktion (zählt als Aktivität — verhindert Auto-Pause).
function touchActivity(gameId) {
  stmts.touchActivity.run(Date.now(), gameId);
}

function getGame(gameId) {
  return stmts.getGame.get(gameId) || null;
}

function getGameByGmCode(gmCode) {
  return stmts.getGameByGm.get(gmCode) || null;
}

function updateState(gameId, { state, started, over }) {
  const cur = getGame(gameId);
  const s = started !== undefined ? (started ? 1 : 0) : (cur ? cur.started : 0);
  const o = over !== undefined ? (over ? 1 : 0) : (cur ? cur.over : 0);
  stmts.updateState.run(state, s, o, gameId);
}

function setStarted(gameId, started) {
  stmts.setStarted.run(started ? 1 : 0, gameId);
}

function setPaused(gameId, paused) {
  // (2m-A) Beim Pausieren den Pause-Startstempel setzen; beim Fortsetzen den
  // Aktivitäts-Stempel aktualisieren und den Pause-Stempel zurücksetzen,
  // damit die 30-Tage-Auto-Beenden-Zeit neu startet.
  const pausedAt = paused ? Date.now() : null;
  stmts.setPaused.run(paused ? 1 : 0, pausedAt, gameId);
  if (!paused) stmts.touchActivity.run(Date.now(), gameId);
}

function upsertTeam({ gameId, teamId, ship, color, invite_code, leaderId = null }) {
  stmts.insertTeam.run(gameId, teamId, ship, color, invite_code, leaderId);
}

function getTeams(gameId) {
  return stmts.getTeams.all(gameId);
}

function getTeam(gameId, teamId) {
  return stmts.getTeam.get(gameId, teamId) || null;
}

function getTeamByInvite(code) {
  return stmts.getTeamByInvite.get(code) || null;
}

function setLeader(gameId, teamId, leaderId) {
  stmts.setLeader.run(leaderId, gameId, teamId);
}

function addPlayer({ id, gameId, teamId, name, token }) {
  stmts.insertPlayer.run(id, gameId, teamId, name, token || null);
}

function getPlayers(gameId) {
  return stmts.getPlayers.all(gameId);
}

// Spieler (socket-ID-gebunden) aus einem Spiel entfernen — „Spiel verlassen“
// für Beobachter/Spieler/GM. Löscht auch Stimmen des Spielers.
function removePlayer(gameId, sockId) {
  stmts.deleteVotesForPlayer.run(gameId, sockId, sockId);
  stmts.deletePlayer.run(gameId, sockId);
}

function getPlayer(id) {
  return stmts.getPlayer.get(id) || null;
}

function getPlayerByToken(token) {
  return stmts.getPlayerByToken.get(token) || null;
}

// Beim Rejoin die Socket-ID auf die neue umsetzen (UPDATE id), damit join-Verknüpfungen
// (votes.voterId/candidateId, teams.leaderId) auf dieselbe Spieler-Identität zeigen.
function remapPlayerSock(newSockId, oldSockId) {
  if (!newSockId || !oldSockId || newSockId === oldSockId) return false;
  // Votes umziehen (voterId + candidateId)
  db.prepare('UPDATE votes SET voterId = ? WHERE voterId = ?').run(newSockId, oldSockId);
  db.prepare('UPDATE votes SET candidateId = ? WHERE candidateId = ?').run(newSockId, oldSockId);
  // Teamleiter umziehen (leaderId <- alte Socket-ID)
  db.prepare('UPDATE teams SET leaderId = ? WHERE leaderId = ?').run(newSockId, oldSockId);
  // Spieler-ID selbst neu setzen (id = neue Socket-ID), Token bleibt stabil
  db.prepare('UPDATE players SET id = ? WHERE id = ?').run(newSockId, oldSockId);
  return true;
}

function addVote({ gameId, teamId, voterId, candidateId }) {
  stmts.insertVote.run(gameId, teamId, voterId, candidateId);
}

function getVotes(gameId, teamId) {
  return stmts.getVotes.all(gameId, teamId);
}

function clearVotes(gameId, teamId) {
  stmts.clearVotes.run(gameId, teamId);
}

function addCode({ code, kind, gameId, teamId = null }) {
  stmts.insertCode.run(code, kind, gameId, teamId);
}

function getCode(code) {
  return stmts.getCode.get(code) || null;
}

function deleteCode(code) {
  stmts.deleteCode.run(code);
}

function setGmOwner(gameId, sockId) {
  stmts.setGmOwner.run(sockId, gameId);
}

// ---------------- Presets ----------------
function parseLevelNames(raw) {
  try { const v = raw && JSON.parse(raw); return (v && typeof v === 'object') ? v : null; } catch (e) { return null; }
}
function parseSettings(raw) {
  try { const v = raw && JSON.parse(raw); return (v && typeof v === 'object') ? v : null; } catch (e) { return null; }
}
function upsertPreset({ name, fields, builtin = 0, levelNames = null, settings = null }) {
  stmts.upsertPreset.run(name, JSON.stringify(fields), builtin ? 1 : 0, levelNames ? JSON.stringify(levelNames) : null, settings ? JSON.stringify(settings) : null);
}
function listPresets() {
  const rows = stmts.getPresets.all();
  return rows.map((r) => ({ name: r.name, builtin: !!r.builtin, updated_at: r.updated_at, fields: JSON.parse(r.fields || '[]'), levelNames: parseLevelNames(r.level_names), settings: parseSettings(r.settings) }));
}
function getPreset(name) {
  const row = stmts.getPreset.get(name);
  if (!row) return null;
  return { name: row.name, builtin: !!row.builtin, fields: JSON.parse(row.fields || '[]'), levelNames: parseLevelNames(row.level_names), settings: parseSettings(row.settings) };
}
function deletePreset(name) {
  stmts.deletePreset.run(name);
}

// Eingebaute Presets beim ersten Start in die DB seeden (Felder von data.js).
function seedBuiltinPresets() {
  const D = require('./engine/data.js');
  Object.keys(D.PRESETS || {}).forEach((name) => {
    const has = stmts.getPreset.get(name);
    if (!has) stmts.upsertPreset.run(name, JSON.stringify(D.PRESETS[name].fields), 1,
      (D.PRESETS[name].levelNames ? JSON.stringify(D.PRESETS[name].levelNames) : null),
      (D.PRESETS[name].settings ? JSON.stringify(D.PRESETS[name].settings) : null));
  });
}

function deleteGame(gameId) {
  db.prepare('DELETE FROM codes WHERE gameId = ?').run(gameId);
  db.prepare('DELETE FROM votes WHERE gameId = ?').run(gameId);
  db.prepare('DELETE FROM players WHERE gameId = ?').run(gameId);
  db.prepare('DELETE FROM teams WHERE gameId = ?').run(gameId);
  db.prepare('DELETE FROM games WHERE gameId = ?').run(gameId);
}

module.exports = {
  db,
  DB_PATH,
  createGame,
  getGame,
  getGameByGmCode,
  listAllGames,
  setGameName,
  setGmName,
  touchGame,
  touchActivity,
  updateState,
  setStarted,
  setPaused,
  upsertTeam,
  getTeams,
  getTeam,
  getTeamByInvite,
  setLeader,
  addPlayer,
  getPlayers,
  removePlayer,
  getPlayer,
  getPlayerByToken,
  remapPlayerSock,
  addVote,
  getVotes,
  clearVotes,
  addCode,
  getCode,
  deleteCode,
  setGmOwner,
  upsertPreset,
  listPresets,
  getPreset,
  deletePreset,
  seedBuiltinPresets,
  deleteGame
};