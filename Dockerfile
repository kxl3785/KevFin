# ─── Stage 1: build ────────────────────────────────────────────────────────────
# node:20 is Debian-based; the build toolchain is available via apt.
# No --platform pin here: `docker buildx --platform linux/amd64|arm64` controls
# the target architecture so native modules compile for the right CPU.
FROM node:20 AS builder
WORKDIR /app

# python3 / make / g++ are required by node-gyp to compile better-sqlite3.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# ── Server ──────────────────────────────────────────────────────────────────────
# Copy manifests first so this layer is only invalidated when deps change.
COPY server/package*.json ./server/
RUN npm ci --prefix server

# Compile TypeScript
COPY server/tsconfig.json ./server/
COPY server/src ./server/src
RUN npm run build --prefix server

# Drop devDependencies from node_modules (retains compiled better-sqlite3 .node)
RUN npm prune --omit=dev --prefix server

# ── Client ──────────────────────────────────────────────────────────────────────
COPY client/package*.json ./client/
RUN npm ci --prefix client

COPY client/index.html ./client/
COPY client/tsconfig.json ./client/
COPY client/vite.config.ts ./client/
COPY client/src ./client/src
RUN npm run build --prefix client

# ─── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:20-slim AS runtime
WORKDIR /app

# Create data dir so the server can start even without a volume mount.
RUN mkdir -p /app/data

# Server: package.json sets "type":"module" so Node loads dist as ESM.
COPY --from=builder /app/server/package.json ./server/package.json
COPY --from=builder /app/server/dist         ./server/dist
COPY --from=builder /app/server/node_modules ./server/node_modules

# Client: served as static files by Express when NODE_ENV=production.
COPY --from=builder /app/client/dist ./client/dist

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "server/dist/index.js"]
