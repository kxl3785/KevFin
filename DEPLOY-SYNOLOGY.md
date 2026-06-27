# Deploying KevFin to a Synology NAS via Portainer

Target: **DS224+** (Intel Celeron J4125, x86_64/amd64, 18 GB RAM). The image is
built **on the NAS** by Portainer — same architecture as the dev machine, so the
native `better-sqlite3` build "just works." 18 GB is ample for the build, the app,
Portainer, and the Claude Code subprocess the assistant spawns.

> **Privacy:** there is no auth layer. Do **not** port-forward 3001 to the
> internet. Reach it over LAN or **Tailscale** only.

---

## How a change reaches the NAS (the deploy pipeline)

Deploys are **GitOps**, gated on a green build — you never deploy by hand:

```
push to main ──▶ CI (build + tests) ──▶ if green: fast-forward `production`
                                              │
                              Portainer polls `production` and rebuilds ──▶ NAS
```

- [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs build + tests on
  every push to `main`. Its `promote` job then does `git push origin HEAD:production`,
  so **`production` only ever points at a tested commit.**
- Portainer's stack tracks the **`production`** branch (not `main`) with GitOps
  auto-updates on. When `production` moves, Portainer re-pulls and rebuilds on the
  NAS. **So only green `main` commits ever reach the box.**

Day-to-day, that means: **just push to `main`.** A failing build never deploys; a
passing one ships itself. (`production` is CI-managed — don't commit to it directly.)

---

## What makes the in-app assistant work in a container

`services/assistant.ts` shells out to a local `claude` binary using your
**subscription** login (no API key). The [Dockerfile](Dockerfile) installs the
Claude Code CLI and sets `CLAUDE_BIN=/root/.local/bin/claude`. You supply the login
with a **long-lived OAuth token** passed as the `CLAUDE_CODE_OAUTH_TOKEN`
environment variable — no credential file to mount.

Why a token instead of copying a credentials file: on **Windows** there is no
portable credentials file (Claude Code keeps the login in the Windows Credential
Manager, DPAPI-encrypted and machine-bound), so it can't be copied to a Linux
container. A token sidesteps that and is the documented headless mechanism.

**Generate the token once**, on any machine already logged into Claude Code:

```
claude setup-token
```

It opens a browser to authorize your subscription and prints a long-lived token
(`sk-ant-oat...`). Copy it — you'll paste it into Portainer below. (On Windows,
if `claude` isn't on your PATH, call the desktop-app binary directly, e.g.
`& "$env:APPDATA\Claude\claude-code\<version>\claude.exe" setup-token`.)

---

## One-time NAS prep (File Station or SSH)

Only one folder is needed — the database volume. In **File Station**: open the
`docker` shared folder → Create folder `kevfin` → inside it create `data`. Or over
SSH:

```bash
mkdir -p /volume1/docker/kevfin/data
```

(No credential file to upload — auth is the `CLAUDE_CODE_OAUTH_TOKEN` env var.)

---

## Deploy as a Portainer Git stack (recommended)

1. **Portainer → Stacks → Add stack.**
2. Name: `kevfin`. Build method: **Repository**.
3. **Repository URL:** `https://github.com/kxl3785/KevFin`
   - Private repo → enable **Authentication** and supply a GitHub username + PAT
     (a fine-grained token with read access to this repo).
4. **Repository reference:** `refs/heads/production` — track the deploy branch,
   **not** `main`. CI fast-forwards `production` to each green commit (see the
   pipeline section above), so this is what gives you "only tested code on the NAS."
   Tick **GitOps updates / Automatic updates** (polling, e.g. every 5 min, or a
   webhook) so Portainer redeploys whenever `production` moves.
5. **Compose path:** `docker-compose.portainer.yml`
6. **Environment variables** (this panel, not the file — keeps secrets out of Git):
   | Name | Value |
   |------|-------|
   | `CLAUDE_CODE_OAUTH_TOKEN` | the `claude setup-token` output (assistant) |
   | `OPENWEBNINJA_KEY` | your Real-Time Zillow key |
   | `PLAID_CLIENT_ID` | your Plaid client id |
   | `PLAID_SECRET` | your Plaid secret |
   | `PLAID_ENV` | `production` |

   **Optional — storage locations** (all have sensible defaults; set only to relocate):
   | Name | Default | What it sets |
   |------|---------|--------------|
   | `KEVFIN_DATA_DIR` | `/volume1/docker/kevfin/data` | host folder mounted at `/app/data` (move everything to another share) |
   | `DB_PATH` | `/app/data/kevfin.db` | the SQLite database file |
   | `KEVFIN_ENV_PATH` | `/app/data/kevfin.env` | the keys file the app writes to — kept on the volume so keys saved **in the app** survive rebuilds |

   Keys set in this panel always win over the keys file. The defaults keep both the
   database and the keys file on the mounted volume, so nothing is lost on rebuild.
7. **Deploy the stack.** Portainer clones the repo, runs `build: .` (installs deps,
   compiles the server, builds the client, installs Claude Code), and starts the
   container with `restart: unless-stopped`.
8. Browse to `http://<nas-ip>:3001`.

**Redeploy after a code change:** just `git push` to `main`. CI builds + tests it,
fast-forwards `production`, and Portainer's GitOps polling picks it up and rebuilds
on the NAS — no manual step. (Need to force it? Open the stack and **Pull and
redeploy** with "re-pull image / re-build" ticked — that rebuilds from whatever
`production` currently points at.)

---

## Alternative: pre-built image (no Git access from Portainer)

If you'd rather not give Portainer repo access, build the image once and let the
stack just run it:

```bash
# over SSH on the NAS, from a checkout of this repo:
sudo docker compose build          # produces kevfin:latest on the NAS daemon
```

Then create a Portainer **Web editor** stack with the same contents as
`docker-compose.portainer.yml` but **delete the `build: .` line** (leaving
`image: kevfin:latest`). Set the env vars as above and deploy.

---

## Notes / gotchas

- **Two managers, one daemon.** If both Container Manager and Portainer are
  installed, manage this stack from **Portainer only** — driving the same container
  from both UIs confuses Container Manager's project tracking.
- **Autostart across reboots** is handled by `restart: unless-stopped` plus
  Portainer starting on boot.
- **Daily snapshot cron** (`node-cron`, midnight) runs in-process — the
  long-lived container keeps it firing. Disable with `DAILY_SNAPSHOT=false` if
  desired.
- **Backups:** everything stateful is under `/volume1/docker/kevfin/` — include it
  in Hyper Backup. The SQLite DB is `data/kevfin.db`.
