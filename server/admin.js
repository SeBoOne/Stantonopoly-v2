/**
 * Stantonopoly V2 — Admin-REST-Router (2o-BONUS)
 * Serverseitig abgesicherte Admin-Funktionen für das Dashboard.
 *
 * AUTH: genau EIN Admin-Konto. Anmeldung über Benutzername + Passwort,
 * Passwort wird NIE im Klartext gespeichert (scrypt-Hash + Salt). Nach dem
 * Login wird ein zufälliges Session-Token ausgestellt (serverseitig im
 * Memory-Store gehalten); ALLE Admin-Endpoints verlangen dieses Token
 * (Authorization: Bearer <token>). Ohne gültiges Token → 401.
 *
 * CREDENTIALS:
 *  - Produktion: env STANTONOPOLY_ADMIN_USER (default 'admin') und
 *    STANTONOPOLY_ADMIN_PASS_HASH im Format "salt:hash" (crypto.scryptSync(
 *    pass, salt, 64).toString('hex')). Kein Klartext-Passwort im Code.
 *  - Bootstrap (weder env-Hash noch DB-Eintrag): es wird beim ersten Start
 *    ein zufälliges Passwort erzeugt, gehasht in der DB (admin_config)
 *    abgelegt und genau einmal im Server-Log ausgegeben. Im Betrieb kann es
 *    über POST /admin/change-password ohne Terminal gewechselt werden.
 */
'use strict';

const crypto = require('crypto');
const express = require('express');
const dbm = require('./db.js');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

// In-Memory-Session-Store (ein Prozess, eine Serverinstanz).
const sessions = new Map(); // token -> { expiresAt }

function genToken() {
  return crypto.randomBytes(24).toString('hex');
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

// Löst die Admin-Credentials auf. Priorität: env-Hash > DB-Stored.
// Liefert { username, salt, hash }.
function resolveCredentials() {
  const username = process.env.STANTONOPOLY_ADMIN_USER || 'admin';
  const envHash = process.env.STANTONOPOLY_ADMIN_PASS_HASH;
  if (envHash && envHash.includes(':')) {
    const [salt, hash] = envHash.split(':');
    if (salt && hash) return { username, salt, hash };
  }
  const stored = dbm.getAdminConfig('admin_credentials');
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (parsed && parsed.salt && parsed.hash) {
        return { username: parsed.username || username, salt: parsed.salt, hash: parsed.hash };
      }
    } catch (e) { /* fall-through */ }
  }
  return null;
}

// Bootstrap: zufälliges Passwort, hash + in DB speichern, Rückgabe des
// Klartext-Nur-Einmal, damit er im Server-Log landen kann.
function bootstrapCredentials() {
  const username = process.env.STANTONOPOLY_ADMIN_USER || 'admin';
  const plain = crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toUpperCase() + crypto.randomInt(10, 99);
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(plain, salt);
  dbm.setAdminConfig('admin_credentials', JSON.stringify({ username, salt, hash }));
  if (process.env.NODE_ENV !== 'test') {
    console.log('[admin] Erstanmeldung erstellt — Benutzer: ' + username + '  Passwort: ' + plain);
    console.log('[admin] Passwort-Änderung im Dashboard unter „Konto“ möglich.');
  }
  return { username, salt, hash };
}

function getCredentials() {
  const c = resolveCredentials();
  if (c) return c;
  return bootstrapCredentials();
}

function requireAuth(req, res, next) {
  const h = req.get('authorization') || '';
  const m = /^Bearer\s+([A-Za-z0-9]+)$/.exec(h);
  if (!m) return res.status(401).json({ ok: false, error: 'UNAUTH', message: 'Nicht angemeldet.' });
  const s = sessions.get(m[1]);
  if (!s || s.expiresAt < Date.now()) {
    if (s) sessions.delete(m[1]);
    return res.status(401).json({ ok: false, error: 'UNAUTH', message: 'Session abgelaufen oder ungültig.' });
  }
  req.adminToken = m[1];
  req.adminUser = s.username;
  next();
}

function publicGamesView(gameRow) {
  const teams = dbm.getTeams(gameRow.gameId) || [];
  return {
    gameId: gameRow.gameId,
    gmCode: gameRow.gmCode,              // NUR im Admin sichtbar
    name: gameRow.name || 'Ohne Namen',
    started: !!gameRow.started,
    over: !!gameRow.over,
    paused: !!gameRow.paused,
    status: !!gameRow.over ? 'done'
      : (gameRow.paused ? 'paused'
        : (gameRow.started ? 'active' : 'lobby')),
    created_at: gameRow.created_at,
    updated_at: gameRow.updated_at,
    teams: teams.map((t) => ({ teamId: t.teamId, ship: t.ship, invite_code: t.invite_code })),
    players: dbm.getPlayers(gameRow.gameId).length
  };
}

function registerAdmin(app, rooms) {
  const router = express.Router();
  router.use(express.json());

  // ---- Login / Logout / Konto ----
    // Ersteinrichtung: solange KEINE Admin-Credentials existieren, darf der
    // erste Besucher das Admin-Passwort setzen (ohne Terminal). Sobald ein
    // Konto existiert, ist dieser Weg dauerhaft geschlossen.
    router.get('/setup-status', (req, res) => {
      const needsSetup = !resolveCredentials();
      return res.json({ ok: true, needsSetup });
    });

    router.post('/setup', (req, res) => {
      if (resolveCredentials()) {
        return res.status(403).json({ ok: false, error: 'ALREADY_SETUP', message: 'Admin-Konto existiert bereits.' });
      }
      const { username, password } = req.body || {};
      const u = String(username || '').trim().slice(0, 40);
      const p = String(password || '');
      if (!u) return res.status(400).json({ ok: false, error: 'BAD_USER', message: 'Benutzername fehlt.' });
      if (p.length < 8) return res.status(400).json({ ok: false, error: 'BAD_PW', message: 'Passwort muss mindestens 8 Zeichen haben.' });
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(p, salt);
      dbm.setAdminConfig('admin_credentials', JSON.stringify({ username: u, salt, hash }));
      dbm.logAdmin('setup', null, 'Admin-Konto eingerichtet');
      const token = genToken();
      sessions.set(token, { username: u, expiresAt: Date.now() + SESSION_TTL_MS });
      return res.json({ ok: true, token, username: u });
    });

    router.post('/login', (req, res) => {
          const { username, password } = req.body || {};
          const creds = getCredentials();
          const okUser = String(username || '').toLowerCase() === String(creds.username).toLowerCase();
          const hash = hashPassword(password || '', creds.salt);
          const okPass = crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(creds.hash, 'hex'));
          if (!okUser || !okPass) {
            dbm.logAdmin('login_failed', username, 'Fehlgeschlagener Login');
            return res.status(401).json({ ok: false, error: 'BAD_CRED', message: 'Benutzername oder Passwort falsch.' });
          }
          const token = genToken();
          sessions.set(token, { username: creds.username, expiresAt: Date.now() + SESSION_TTL_MS });
          dbm.logAdmin('login', null, 'Anmeldung als ' + creds.username);
          return res.json({ ok: true, token, username: creds.username });
        });

  router.post('/logout', requireAuth, (req, res) => {
    sessions.delete(req.adminToken);
    return res.json({ ok: true });
  });

  router.get('/me', requireAuth, (req, res) => {
    return res.json({ ok: true, username: req.adminUser });
  });

  // Admin-Passwort ohne Terminal wechseln (aktuelles Passwort erneut prüfen).
  router.post('/change-password', requireAuth, (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    const creds = getCredentials();
    const hashNow = hashPassword(currentPassword || '', creds.salt);
    const okPass = crypto.timingSafeEqual(Buffer.from(hashNow, 'hex'), Buffer.from(creds.hash, 'hex'));
    if (!okPass) return res.status(401).json({ ok: false, error: 'BAD_CRED', message: 'Aktuelles Passwort falsch.' });
    const np = String(newPassword || '');
    if (np.length < 8) return res.status(400).json({ ok: false, error: 'BAD_PW', message: 'Neues Passwort muss mindestens 8 Zeichen haben.' });
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(np, salt);
    dbm.setAdminConfig('admin_credentials', JSON.stringify({ username: req.adminUser, salt, hash }));
    dbm.logAdmin('change_password', null, 'Passwort geändert');
    return res.json({ ok: true });
  });

  // ---- Dashboard-Überblick ----
  router.get('/dashboard', requireAuth, (req, res) => {
    const games = dbm.listAllGames() || [];
    const presets = dbm.listPresets() || [];
    const count = (fn) => games.filter(fn).length;
    return res.json({
      ok: true,
      stats: {
        total: games.length,
        lobby: count((g) => !g.started && !g.over),
        active: count((g) => g.started && !g.over && !g.paused),
        paused: count((g) => g.started && !g.over && g.paused),
        done: count((g) => g.over),
        presetCount: presets.length,
        builtinPresetCount: presets.filter((p) => p.builtin).length,
        customPresetCount: presets.filter((p) => !p.builtin).length
      }
    });
  });

  // ---- Spiele: aktive + pausierte (nicht beendet) inkl. Game-Code + archivierte ----
  router.get('/games', requireAuth, (req, res) => {
    const games = dbm.listAllGames() || [];
    const all = games.map(publicGamesView);
    const nonEnded = all.filter((g) => g.status !== 'done');
    const archived = all.filter((g) => g.status === 'done');
    return res.json({ ok: true, games: nonEnded, archived });
  });

  // ---- Spiel löschen (Hard-Delete inkl. aller verketteten Daten) ----
  router.delete('/games/:gameId', requireAuth, (req, res) => {
    const id = String(req.params.gameId || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'BAD_ID', message: 'gameId fehlt.' });
    const ret = rooms.adminDeleteGame(id);
    if (!ret || ret.error) {
      const code = (ret && ret.error && ret.error.code) || 'NO_GAME';
      return res.status(404).json({ ok: false, error: code, message: (ret && ret.error && ret.error.message) || 'Unbekanntes Spiel.' });
    }
    return res.json({ ok: true, removed: true, gameId: id });
  });

  // ---- Presets (Auflisten) ----
  router.get('/presets', requireAuth, (req, res) => {
    return res.json({ ok: true, presets: dbm.listPresets() });
  });

  // ---- Preset speichern / neu anlegen / bearbeiten (reuse-preset-Logik) ----
  router.post('/presets', requireAuth, (req, res) => {
    const data = req.body || {};
    if (!data || !data.name || !Array.isArray(data.fields)) {
      return res.status(400).json({ ok: false, error: 'BAD_PRESET', message: 'Preset braucht einen Namen und ein Felder-Array.' });
    }
    const name = String(data.name).trim().slice(0, 40);
    if (!name) return res.status(400).json({ ok: false, error: 'BAD_PRESET', message: 'Ungültiger Preset-Name.' });
    const existing = dbm.getPreset(name);
    const levelNames = (data.levelNames && typeof data.levelNames === 'object') ? data.levelNames : null;
    let settings = (data.settings && typeof data.settings === 'object') ? data.settings : null;
    if (settings) {
      const hasContent = Object.keys(settings).some((k) => {
        const v = settings[k];
        if (typeof v === 'object' && v !== null) return Object.keys(v).length > 0;
        return v !== undefined && v !== '';
      });
      if (!hasContent) settings = null;
    }
    // Eingebaute Presets duerfen ueberschrieben werden (builtin-Flag bleibt) —
    // so laesst sich der Standard anpassen. Geloescht koennen sie nicht.
    dbm.upsertPreset({ name, fields: data.fields, builtin: (existing && existing.builtin) ? 1 : 0, levelNames, settings, enabled: (existing ? existing.enabled : 1) });
    dbm.logAdmin('save_preset', name, 'Gespeichert / geändert');
    return res.json({ ok: true, preset: dbm.getPreset(name) });
  });

  // ---- Preset aktivieren / deaktivieren (statt nur löschen; builtin freundlich) ----
  router.post('/presets/:name/set-enabled', requireAuth, (req, res) => {
    const name = String(req.params.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'BAD_NAME', message: 'Name fehlt.' });
    const existing = dbm.getPreset(name);
    if (!existing) return res.status(404).json({ ok: false, error: 'NO_PRESET', message: 'Preset nicht gefunden.' });
    const enabled = !!(req.body && req.body.enabled);
    dbm.setPresetEnabled(name, enabled);
    dbm.logAdmin(enabled ? 'enable_preset' : 'disable_preset', name, enabled ? 'Aktiviert' : 'Deaktiviert');
    return res.json({ ok: true, name, enabled, preset: dbm.getPreset(name) });
  });

  // ---- Preset löschen (builtin geschützt) ----
  router.delete('/presets/:name', requireAuth, (req, res) => {
    const name = String(req.params.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'BAD_NAME', message: 'Name fehlt.' });
    const existing = dbm.getPreset(name);
    if (!existing) return res.status(404).json({ ok: false, error: 'NO_PRESET', message: 'Preset nicht gefunden.' });
    if (existing.builtin) return res.status(403).json({ ok: false, error: 'FORBIDDEN', message: 'Eingebaute Presets können nicht gelöscht werden.' });
    dbm.deletePreset(name);
    dbm.logAdmin('delete_preset', name, 'Gelöscht');
    return res.json({ ok: true, deleted: name });
  });

  // ---- Audit-Log (Löschaktionen, Logins) ----
  router.get('/log', requireAuth, (req, res) => {
    return res.json({ ok: true, log: dbm.listAdminLog(Number(req.query.limit) || 100) });
  });

  // ---- Manager-Codes (Admin erzeugt Codes + internes Namenslabel) ----
  router.get('/manager-codes', requireAuth, (req, res) => {
    return res.json({ ok: true, codes: dbm.listManagerCodes() });
  });

  // Neuen Manager-Code erzeugen ({ name } = internes Label, z.B. Personen-Name/Rolle).
  router.post('/manager-codes', requireAuth, (req, res) => {
    const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ ok: false, error: 'BAD_NAME', message: 'Bitte ein internes Namenslabel angeben (z. B. wer der Manager ist).' });
    const code = dbm.generateManagerCode();
    dbm.addManagerCode(code, name);
    // Code nur bei Erzeugung einmalig sichtbar; im Log nur das Label (kein Geheimnis).
    dbm.logAdmin('create_manager_code', name, 'Manager-Code erzeugt');
    return res.json({ ok: true, code, name });
  });

  // Manager-Code entfernen (Zugang entziehen).
  router.delete('/manager-codes/:code', requireAuth, (req, res) => {
    const raw = String(req.params.code || '').trim().toUpperCase();
    if (!raw) return res.status(400).json({ ok: false, error: 'BAD_CODE', message: 'Code fehlt.' });
    const existing = dbm.getManagerCode(raw);
    if (!existing) return res.status(404).json({ ok: false, error: 'NO_CODE', message: 'Code nicht gefunden.' });
    dbm.deleteManagerCode(raw);
    dbm.logAdmin('delete_manager_code', existing.name, 'Manager-Code entfernt');
    return res.json({ ok: true, deleted: raw });
  });

  // Manager-Code umbenennen (Label pflegen, Code bleibt stabil).
  router.post('/manager-codes/:code/rename', requireAuth, (req, res) => {
    const raw = String(req.params.code || '').trim().toUpperCase();
    const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
    const existing = dbm.getManagerCode(raw);
    if (!existing) return res.status(404).json({ ok: false, error: 'NO_CODE', message: 'Code nicht gefunden.' });
    if (!name) return res.status(400).json({ ok: false, error: 'BAD_NAME', message: 'Label darf nicht leer sein.' });
    dbm.renameManagerCode(raw, name);
    dbm.logAdmin('rename_manager_code', name, 'Manager-Code umbenannt');
    return res.json({ ok: true, code: raw, name });
  });

  app.use('/admin', router);
}

module.exports = { registerAdmin, sessions };
