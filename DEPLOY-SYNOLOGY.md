# Deploying KevFin to a Synology NAS via Portainer

Target: **DS224+** (Intel Celeron J4125, x86_64/amd64, 18 GB RAM). The image is
built **on the NAS** by Portainer — same architecture as the dev machine, so the
native `better-sqlite3` build "just works." 18 GB is ample for the build, the app,
Portainer, and the Claude Code subprocess the assistant spawns.

> **Privacy:** there is no auth layer. Do **not** port-forward 3001 to the
> internet. Reach it over LAN or **Tailscale** only.

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
4. **Compose path:** `docker-compose.portainer.yml`
5. **Environment variables** (this panel, not the file — keeps secrets out of Git):
   | Name | Value |
   |------|-------|
   | `CLAUDE_CODE_OAUTH_TOKEN` | the `claude setup-token` output (assistant) |
   | `OPENWEBNINJA_KEY` | your Real-Time Zillow key |
   | `PLAID_CLIENT_ID` | your Plaid client id |
   | `PLAID_SECRET` | your Plaid secret |
   | `PLAID_ENV` | `production` |
6. **Deploy the stack.** Portainer clones the repo, runs `build: .` (installs deps,
   compiles the server, builds the client, installs Claude Code), and starts the
   container with `restart: unless-stopped`.
7. Browse to `http://<nas-ip>:3001`.

**Redeploy after a code change:** push to GitHub, then in Portainer open the stack
and **Pull and redeploy** (tick "re-pull image / re-build"). Optionally enable
Portainer's **GitOps / automatic updates** (polling or webhook) for push-to-deploy.

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
