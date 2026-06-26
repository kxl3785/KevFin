# KevFin desktop app

A standalone desktop build of KevFin (Electron) for people who don't have a NAS —
no Docker, no terminal. It bundles the server + client and opens a native window.
Everything stays local; the storage location is user-choosable (e.g. a Dropbox or
NAS folder) so data can be backed up or moved between machines.

## Run it from source (dev)

```bash
npm run desktop          # builds client + server, then launches the app window
```

The server runs as a child process under the system Node in dev; the window opens
at the server's port (3001, or the next free one).

## Build installers

```bash
npm run desktop:dist     # builds, stages, and packages for the current OS
```

Output lands in `desktop/dist-app/`:
- **macOS** → `KevFin-<version>-arm64.dmg`
- **Windows** → `KevFin Setup <version>.exe` (NSIS installer)

These are **unsigned**. On first launch:
- **macOS** — right-click the app → **Open** → **Open** (one-time Gatekeeper bypass).
- **Windows** — "Windows protected your PC" → **More info** → **Run anyway**.

### How packaging works (the moving parts)

- `desktop/scripts/stage.js` assembles a production server copy under
  `desktop/staging/` and rebuilds **better-sqlite3** for Electron's ABI (the
  repo's own `node_modules`, built for system Node, is left untouched).
- `desktop/scripts/afterPack.js` copies the staged `node_modules` into the bundle
  (electron-builder strips `node_modules` from `extraResources`).
- Config: `desktop/electron-builder.yml`.

> better-sqlite3 must be **≥ 12** — older versions don't compile against
> Electron 33's V8 headers.

## Build for both macOS and Windows (CI)

A native module can't be reliably cross-built, so Windows builds run on a Windows
runner. The **Desktop build** workflow (`.github/workflows/desktop-build.yml`)
builds both and uploads the installers as artifacts:

- Run it from the repo's **Actions → Desktop build → Run workflow**, or
- push a tag: `git tag v1.0.0 && git push origin v1.0.0`.

Download the `KevFin-macos` / `KevFin-windows` artifacts from the run.

## Choosing where data lives

In the app: **Setup (⚙) → Storage location → Change folder…**. Pick any folder —
a Dropbox/iCloud/NAS folder keeps your database and keys file backed up or synced.
The app copies the files there and relaunches.

> Don't run KevFin on two computers against the same synced file at the same time
> — SQLite allows only one writer.

Under the hood the desktop app sets `DB_PATH` and `KEVFIN_ENV_PATH` for the server;
both default to the app's per-user data folder until you change them.

## AI assistant

The assistant runs on **your own Claude subscription**, not a paid API key. Sign in
once from the assistant's login gate:

- **Any OS:** run `claude setup-token` and paste the token into the gate, or
- **macOS:** click "Log in to Claude" to open a terminal and run `/login`.

The token is saved to your keys file (so it travels with your chosen storage
location). If no `claude` binary is found, the assistant shows the sign-in gate and
the rest of the app works normally.

**Bundling the binary (not yet done):** to make the assistant turnkey on a machine
without Claude Code installed, drop a native `claude` binary into the bundle at
`resources/claude/` (the desktop app points `CLAUDE_BIN` at it automatically). A
future step can fetch this per-OS in `stage.js` / CI.
