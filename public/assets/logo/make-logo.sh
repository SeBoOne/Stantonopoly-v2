#!/usr/bin/env bash
# Phase 2e — Logo-Ableitungen fuer die beiden Final-Prototypen.
#
# Quelle (unveraendert, im Repo committed):
#   public/assets/img/stantonopoly-logo.png   — 943x1302, RGBA, Ecken voll transparent
#
# Erzeugt:
#   logo-hero-512.png    Farb-Logo fuer den Landing-Hero (Silber/Orange)
#   logo-mark-96.png     Farb-Logo fuer den App-Header
#   logo-mask-512.png    Monochrom-Variante: Silhouette als Alpha-Maske
#                        (wird per CSS mask-image in der Palettenfarbe eingefaerbt)
#   logo-outline-512.png Outline-Variante: Kontur der Silhouette, ebenfalls Alpha-Maske
#   favicon-48.png       Favicon-Vorschlag
#   favicon-180.png      Apple-Touch-Vorschlag
#
# Aufruf:  bash make-logo.sh        (idempotent — ueberschreibt die Ableitungen)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
SRC="$REPO/public/assets/img/stantonopoly-logo.png"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

[ -f "$SRC" ] || { echo "FEHLT: $SRC" >&2; exit 1; }

# Farb-Varianten (unveraendert in Farbe, nur skaliert)
magick "$SRC" -resize 512x -strip -define png:compression-level=9 "$HERE/logo-hero-512.png"
magick "$SRC" -resize 96x  -strip -define png:compression-level=9 "$HERE/logo-mark-96.png"
magick "$SRC" -resize 48x48  -strip "$HERE/favicon-48.png"
magick "$SRC" -resize 180x180 -strip "$HERE/favicon-180.png"

# Alpha-Kanal des Originals = Form. Threshold 50 % macht sie binaer/kantenrein.
magick "$SRC" -alpha extract -threshold 50% "$TMP/mask_gray.png"

# Monochrom: weisse Silhouette mit der Form als Alpha -> per CSS maskierbar/einfaerbbar
magick "$TMP/mask_gray.png" -resize 512x "$TMP/mask512.png"
magick -size 512x707 xc:white "$TMP/mask512.png" -compose CopyOpacity -composite \
       PNG32:"$HERE/logo-mask-512.png"

# Outline: Kontur der Silhouette (1px EdgeOut, 2px verstaerkt), ebenfalls als Alpha-Maske
magick "$TMP/mask512.png" -morphology EdgeOut Octagon:1 -morphology Dilate Octagon:2 \
       -threshold 50% "$TMP/edge.png"
magick -size 512x707 xc:white "$TMP/edge.png" -compose CopyOpacity -composite \
       PNG32:"$HERE/logo-outline-512.png"

# ---------------------------------------------------------------------------------
# Vorgetoente Varianten je Palette.
#
# Warum vorgetoent statt CSS-Maske: `mask-image` mit diesem RGBA-PNG rendert in
# Chromium (headless, file://) NICHTS — gemessen mit probe-mask2.cjs (drei
# Masken-Schreibweisen, Mittelwert 0 vs. Kontrolle 0.213). Ein normales
# background-image malt dagegen zuverlaessig. Deshalb je Palette/Mode eine Datei.
#   mono-<palette>.png    Silhouette in der Textfarbe (--fg) der Palette
#   outline-<palette>.png Kontur in der Akzentfarbe (--accent) der Palette
# ---------------------------------------------------------------------------------
tint() {  # $1 = quelle, $2 = farbe, $3 = ziel
  magick "$1" -fill "$2" -colorize 100 -alpha on -strip PNG32:"$3"
}
while read -r PAL FG ACCENT; do
  [ -n "$PAL" ] || continue
  tint "$HERE/logo-mask-512.png"    "$FG"     "$HERE/mono-$PAL.png"
  tint "$HERE/logo-outline-512.png" "$ACCENT" "$HERE/outline-$PAL.png"
done <<'PALETTEN'
cargo  #f3f4f6 #ffb454
ion    #eef2fb #8ab4ff
uplink #ecf7f4 #5fe3c0
amber  #f4eee3 #f0a63c
azur   #e9f2fc #59c8ff
vektor #e9f6f0 #56e39a
PALETTEN

magick identify -format "%f  %[channels]  %wx%h  %B bytes\n" "$HERE"/*.png
