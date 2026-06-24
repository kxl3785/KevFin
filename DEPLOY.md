# KevFin — Docker / Synology NAS deployment

> **Security note:** KevFin has no authentication layer.
> Keep it on your LAN or behind Tailscale — **do not expose port 3001 to the
> public internet.**

---

## Local build and smoke-test

```bash
# Build the image (runs on your Mac; image is linux/amd64 by default)
docker build -t kevfin:latest .

# Create a local data dir and env file, then start
mkdir -p data
cp kevfin.env.example kevfin.env   # fill in your real API keys
docker compose up
```

Browse to **http://localhost:3001** — the app and API share the same port.

To confirm the SQLite volume persists: stop the container, restart it
(`docker compose up`), and verify that account data and net-worth history
are still present.

---

## Build for the Synology (linux/amd64 Intel)

Most Synology NAS units ship Intel CPUs; the default `linux/amd64` image works
directly.  For rare ARM units (e.g. DS223) use `--platform linux/arm64`.

```bash
# Save a tarball to transfer to the NAS
docker buildx build --platform linux/amd64 -t kevfin:latest --output type=docker,dest=kevfin-amd64.tar .

# Copy to NAS (adjust user/host)
scp kevfin-amd64.tar admin@nas.local:/volume1/docker/kevfin/
```

---

## Synology Container Manager setup

### 1 — Import the image

1. Open **Container Manager → Image → Add → Add from file**
2. Select `kevfin-amd64.tar` → it appears as `kevfin:latest`

### 2 — Prepare host directories and env file

SSH into the NAS (or use File Station) and run:

```bash
mkdir -p /volume1/docker/kevfin/data
# Create the env file from the example; fill in real API keys
cp /path/to/kevfin.env.example /volume1/docker/kevfin/kevfin.env
nano /volume1/docker/kevfin/kevfin.env
```

### 3 — Launch with docker-compose (recommended)

Copy `docker-compose.yml` to the NAS alongside the env file:

```bash
scp docker-compose.yml admin@nas.local:/volume1/docker/kevfin/
```

Then on the NAS:

```bash
cd /volume1/docker/kevfin
KEVFIN_DATA_DIR=/volume1/docker/kevfin/data docker compose up -d
```

> The `KEVFIN_DATA_DIR` variable overrides the default `./data` path so the
> SQLite database lands at `/volume1/docker/kevfin/data/kevfin.db` on the host.

### 4 — Or launch via the Container Manager GUI

| Setting | Value |
|---|---|
| Image | `kevfin:latest` |
| Container name | `kevfin` |
| Port mapping | Host `3001` → Container `3001` |
| Volume (host) | `/volume1/docker/kevfin/data` |
| Volume (container) | `/app/data` |
| Env file | `/volume1/docker/kevfin/kevfin.env` |
| Restart policy | Unless stopped |

---

## Accessing KevFin

| Method | URL |
|---|---|
| LAN | `http://nas-ip:3001` |
| Tailscale | `http://nas-tailscale-ip:3001` |

If you use Tailscale on the NAS, no port-forwarding is required — connect to
the NAS's Tailscale IP from any device on your tailnet.

---

## Automatic snapshots

The server runs three cron jobs inside the container:

| Schedule | What it does |
|---|---|
| Daily at midnight | Snapshot current net-worth to DB (`DAILY_SNAPSHOT=false` disables) |
| Daily at 06:00 | Refresh SimpleFIN + Plaid accounts, then snapshot |
| 1st + 15th at 06:30 | Refresh Zillow real-estate values, then snapshot |

No manual Backfill is needed once the container has been running for a few days.

---

## Updating

```bash
# On your Mac: rebuild and export
docker buildx build --platform linux/amd64 -t kevfin:latest --output type=docker,dest=kevfin-amd64.tar .
scp kevfin-amd64.tar admin@nas.local:/volume1/docker/kevfin/

# On the NAS
cd /volume1/docker/kevfin
docker compose down
# Import the new image via Container Manager, or:
docker load -i kevfin-amd64.tar
KEVFIN_DATA_DIR=/volume1/docker/kevfin/data docker compose up -d
```

The SQLite database at `/volume1/docker/kevfin/data/kevfin.db` is never touched
during an update — only the container image is replaced.
