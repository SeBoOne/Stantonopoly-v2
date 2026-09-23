# Stantonopoly V2 — Offene Folgeaufgaben (von Sebo verschoben)

## ✅ ERLEDIGT (beide umgesetzt + getestet, 18/18 Tests grün)

### 1. Gamemaster kann mitspielen ✅
- In der Lobby hat der GM pro Team einen **"Mitspielen"**-Button → tritt über den
  Einladungscode als Mitglied/Teamleiter bei, bleibt aber GM.
- Server-Seite unverändert (joinTeam akzeptiert GM-Socket), UI-Weg jetzt vorhanden.

### 2. Preset-Editor ✅
- Eigene Karten-Presets im Setup: Felder anlegen/löschen/umsortieren,
  Name+Typ(Los/Grundstück/Gundo)+Preis je Feld.
- Als benanntes Preset speichern, laden, löschen; Persistenz in SQLite-Tabelle `presets`.
- Engine ist jetzt **feldbewusst** (`game.fields` bestimmt Brett; eigene Reihenfolge/Anzahl).
- Beim Spiel-Start wird der aktuell bearbeitete Feldstand als `config.fields` verwendet.

## Notiz
- Source of truth Boards/Regeln: `server/engine/data.js` + `server/engine/engine.js`.
- Engine nutzt `game.fields` (statt hartkodiertem global), `D.tabelleFor(price)` für Miete.
- Presets: eingebaute = `builtin=1` (nicht löschbar), eigene in `presets`-Tabelle.