# Stantonopoly V2 — Docker
# Universal-Base-Image (keine nativen Module, node:sqlite ist eingebautes Builtin
# ≥ Node 22.5; getestet v26). Alpine hält das Image klein.
FROM node:26-alpine

ENV NODE_ENV=production \
    PORT=8000

WORKDIR /app

# Zuerst die Manifeste kopieren → Layer-Build-Cache: npm install nur bei
# Änderung der Abhängigkeiten neu.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Anwendung kopieren (Rest per .dockerignore ausgeschlossen: data/, node_modules/, …).
# data/ fehlt hier absichtlich: der Server legt es beim Start selbst an (db.js mkdir),
# und das VOLUME /app/data mountet die SQLite-Persistenz.
COPY server ./server
COPY public ./public

EXPOSE 8000

# Gesundheits-Checks vom Orchestrierer → /health (schnell).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:${PORT:-8000}/health >/dev/null 2>&1 || exit 1

# Volumes: SQLite-Datei + WAL leben auf einem gemounteten Daten-Volume.
# (bereits im Image angelegt: /app/data)
VOLUME /app/data

CMD ["node", "server/index.js"]