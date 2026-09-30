/**
 * Stantonopoly V2 — Star-Citizen-Wiki-Katalog-Fetcher
 *
 * Holt die Schiffs- und Ortsnamen aus der öffentlichen Star-Citizen-Wiki-API
 * (https://api.star-citizen.wiki) und speichert sie in der SQLite-DB
 * (Tabellen sc_names / sc_meta), damit die Autovervollständigung im Client
 * OHNE Live-API-Abfrage auskommt.
 *
 * Abruf später (Scheduler) / manuell (Admin) — nie bei jeder Eingabe.
 */
'use strict';

const dbm = require('./db.js');

const BASE = 'https://api.star-citizen.wiki';
const UA = 'Stantonopoly-V2/1.0 (community board game; +https://github.com/)';
const PAGE_SIZE = 200; // API-Maximum

// ---------------------------------------------------------------------------
// HTTP-Helfer: holt eine URL mit Retry, Zeitlimit, JSON-Parsing.
// ---------------------------------------------------------------------------
async function getJSON(url, opts) {
  const { timeoutMs = 45000, retries = 2 } = opts || {};
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' für ' + url.split('?')[0]);
      const json = await res.json();
      return json;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

/**
 * Paginiert über alle Seiten einer List-API und gibt die Data-Arrays verkettet zurück.
 * Folgt links.next bis links.next === null.
 */
async function fetchAllPages(baseUrl, query, opts) {
  const all = [];
  let next = baseUrl;
  const seen = new Set();
  const sep = baseUrl.includes('?') ? '&' : '?';
  // Bereite Query-Parameter auf (kann Array sein -> mehrfach).
  const qs = [];
  for (const [k, v] of Object.entries(query || {})) {
    if (Array.isArray(v)) { for (const x of v) qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(x)); }
    else qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  }
  let url = baseUrl + sep + qs.join('&');
  for (let page = 1; page <= 100; page++) {
    if (seen.has(url)) break;
    seen.add(url);
    const json = await getJSON(url, opts);
    const data = (json && Array.isArray(json.data)) ? json.data : [];
    all.push(...data);
    const links = (json && json.links) || {};
    if (links.next && typeof links.next === 'string' && links.next !== url) {
      url = links.next;
    } else {
      break;
    }
  }
  return all;
}

// ---------------------------------------------------------------------------
// Fahrzeuge: ALLE Raumschiff-Namen (filter is_spaceship=true), Wert "name".
// ---------------------------------------------------------------------------
async function fetchShipNames(opts) {
  const data = await fetchAllPages(BASE + '/api/vehicles', { 'filter[is_spaceship]': 'true', 'page[size]': String(PAGE_SIZE) }, opts);
  const names = data.map((v) => v && v.name).filter((n) => typeof n === 'string' && n.trim());
  return { names };
}

// ---------------------------------------------------------------------------
// Standorte: Feldnamen-Kandidaten.
// filter type_classification in [Moon,Planet,Outpost,Asteroid,Settlement,Manmade]
// Ausschließen: quantum_travel == null ODER hide_in_starmap == true ODER block_travel == true
// ---------------------------------------------------------------------------
const LOCATION_TYPES = ['Moon', 'Planet', 'Outpost', 'Asteroid', 'Settlement', 'Manmade'];

// Pure Filter-Funktion: aus einer Liste von Location-Objekten die erlaubten
// Namens-Kandidaten extrahieren (Sebo-Regel: quantum_travel==null / hide_in_starmap
// / block_travel ausschließen). Separat exportiert, damit hermetisch testbar.
function locationAllowedNames(items) {
  const names = [];
  for (const loc of items) {
    if (!loc || typeof loc.name !== 'string' || !loc.name.trim()) continue;
    if (loc.quantum_travel == null) continue;              // nicht per QT erreichbar
    if (loc.hide_in_starmap === true) continue;             // in Starmap verborgen
    if (loc.block_travel === true) continue;                // Reise blockiert
    names.push(loc.name);
  }
  return names;
}

async function fetchLocationNames(opts) {
  // Komma-Liste: Die API akzeptiert mehrere Classifications komma-getrennt.
  const filter = LOCATION_TYPES.join(',');
  const data = await fetchAllPages(BASE + '/api/locations', { 'filter[type_classification]': filter, 'page[size]': String(PAGE_SIZE) }, opts);
  return { names: locationAllowedNames(data) };
}

// ---------------------------------------------------------------------------
// Einstiegspunkt für Scheduler/Admin: holt beide Kataloge und ersetzt die DB.
// Liefert { ok, ships:{count,updatedAt}, locations:{count,updatedAt}, errors:[] }
// ---------------------------------------------------------------------------
async function syncAll(opts) {
  const errors = [];
  const out = { ok: true, ships: null, locations: null, errors };
  if (!opts || opts.ships !== false) {
    try {
      const { names } = await fetchShipNames(opts);
      out.ships = dbm.scReplaceAll('ship', names);
    } catch (e) { out.ok = false; errors.push({ kind: 'ship', error: String(e.message || e) }); }
  }
  if (!opts || opts.locations !== false) {
    try {
      const { names } = await fetchLocationNames(opts);
      out.locations = dbm.scReplaceAll('location', names);
    } catch (e) { out.ok = false; errors.push({ kind: 'location', error: String(e.message || e) }); }
  }
  return out;
}

module.exports = {
  BASE,
  fetchAllPages,
  fetchShipNames,
  fetchLocationNames,
  locationAllowedNames,
  syncAll,
  LOCATION_TYPES
};