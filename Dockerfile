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

# devDependencies are kept (not pruned) so Vitest ships in the runtime image and
# the Setup → Tests panel can run the unit suite on the NAS. The src/ tree is
# copied into the runtime stage too, since the tests run against the TypeScript
# sources.

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

# Claude Code CLI — powers the in-app assistant (services/assistant.ts shells out
# to it). It runs on the user's *subscription* login (no API key): mount the
# logged-in ~/.claude at /root/.claude and the assistant resolves CLAUDE_BIN below.
# ripgrep is required by Claude Code's Read/search tools; curl/ca-certificates by
# the installer. Kept above the COPY layers so app-code rebuilds don't reinstall it.
#
# The version is pinned on purpose. This layer is cached (on the NAS, which builds
# with `build: .`, and in CI), so an unpinned install silently stays at whatever
# was current when the layer was first built — which is how the NAS ended up on a
# CLI too old for the assistant's model. Changing this ARG rebuilds the layer.
# Keep it equal to CLAUDE_VERSION in desktop/scripts/stage.js and at or above
# MIN_CLAUDE_CODE_VERSION in server/src/services/assistant.ts (a test checks both).
ARG CLAUDE_CODE_VERSION=2.1.321
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_CODE_VERSION}"
ENV HOME=/root
ENV CLAUDE_BIN=/root/.local/bin/claude

# Server: package.json sets "type":"module" so Node loads dist as ESM.
COPY --from=builder /app/server/package.json  ./server/package.json
COPY --from=builder /app/server/dist          ./server/dist
COPY --from=builder /app/server/node_modules  ./server/node_modules
# Sources + tsconfig: the Setup → Tests panel runs Vitest against the TS sources.
COPY --from=builder /app/server/src           ./server/src
COPY --from=builder /app/server/tsconfig.json ./server/tsconfig.json

# Client: served as static files by Express when NODE_ENV=production.
COPY --from=builder /app/client/dist ./client/dist

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "server/dist/index.js"]
