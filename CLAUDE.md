# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Activate virtualenv (always required first)
source venv/bin/activate

# Run the API
uvicorn main:app --reload --port 8000

# Run the worker (separate terminal)
arq worker.WorkerSettings

# Redis (Docker — must be running before API or worker)
docker start streamgrabber-redis
# First time: docker run -d --name streamgrabber-redis -p 6379:6379 redis:7-alpine

# Install/update dependencies
pip install -r requirements.txt

# Install Playwright browser (first time or after playwright upgrade)
playwright install chromium

# Update yt-dlp (streaming sites break extractors frequently)
pip install -U yt-dlp

# Build frontend
cd frontend && npm run build

# Test scraper on a specific episode URL
python -c "
import asyncio
from scraper import scrape_episode_sources
result = asyncio.run(scrape_episode_sources('EPISODE_URL', debug=True))
print(result)
"
```

## Architecture

Three processes communicating via Redis:

- **FastAPI** (`main.py` + uvicorn) — serves the React frontend and REST API. Enqueues jobs into Redis via ARQ. Subscribes to `progress:*` Redis pub/sub and forwards to browser via SSE.
- **Worker** (`worker.py`) — ARQ worker process. Picks up jobs from Redis, runs Playwright scraping and yt-dlp downloads, publishes progress to Redis pub/sub.
- **Redis** — job queue (ARQ protocol) + progress pub/sub channel (`progress:{episode_id}`).

**Data flow:**
1. User pastes show URL → `POST /api/shows` → `arq_pool.enqueue_job('job_scrape_show', url)` → worker scrapes with Playwright → episodes saved to SQLite
2. User triggers download → `POST /api/download` → episode set to `queued` in DB → `arq_pool.enqueue_job('job_download_episode', id)` → worker scrapes fresh sources → yt-dlp downloads
3. Worker publishes progress → Redis `progress:{id}` channel → API pub/sub listener → asyncio Queue → SSE → browser

**Key files:**
- `config.py` — all tuneable settings as env vars with safe defaults. Import from here, never hardcode.
- `worker.py` — ARQ job functions: `job_download_episode`, `job_scan_episode`, `job_scrape_show`. `WorkerSettings` controls concurrency (`max_jobs = MAX_CONCURRENT`).
- `main.py` — FastAPI routes + lifespan (creates ARQ pool, redis client, starts pub/sub listener task).
- `scraper.py` — all Playwright logic. `scrape_show()` and `scrape_episode_sources()`. `_resolve_strcdn()` uses httpx (m3u8 URL is in server-rendered HTML). `_resolve_f16px()` uses Playwright network interception.
- `downloader.py` — wraps yt-dlp as subprocess, parses progress output, calls `progress_callback` which publishes to Redis.
- `database.py` — SQLite via stdlib `sqlite3`. `shows` + `episodes` tables. `sources` column is JSON. Episode statuses: `pending` → `queued` → `downloading` → `done` / `failed`.
- `frontend/` — React + TypeScript + Vite. `npm run build` outputs to `../static/` which FastAPI serves.

## seriale-online.net specifics

Episode pages embed `database.seriale-online.net/iframe/{token}` which redirects to the real hoster (strcdn, f16px, myvidplay, vidload, netu). Some redirects are HTTP 302; Netu uses JS redirect — `_follow_redirect()` parses `window.location` patterns from HTML as fallback.

**strcdn/VideoVard** (`_resolve_strcdn`): signed HLS m3u8 URL is in server-rendered HTML of the strcdn embed page. Fetched with httpx. The `cfglobalcdn.com` CDN is IP-locked and geo-restricted to Romania.

Sources include a `referer` key passed to yt-dlp via `--referer`. After scraping, sources are sorted by `SOURCE_PRIORITY` and deduplicated by label (best per label kept).

## Production (Docker Compose)

```bash
# Build and start everything (API + worker + Redis)
docker compose up -d --build

# View logs
docker compose logs -f api
docker compose logs -f worker

# Stop
docker compose down

# Upgrade yt-dlp inside the running worker (without full rebuild)
docker compose exec worker pip install -U yt-dlp
# Then restart the worker so the new version is used:
docker compose restart worker
```

**Named volumes:**
| Volume | Contents |
|---|---|
| `downloads` | Downloaded video files + `downloaded.txt` yt-dlp archive |
| `db-data` | SQLite database (`streamgrabber.db`) |
| `redis-data` | Redis RDB snapshot (job queue persistence) |

**Environment variables** (override in `docker-compose.yml` or a `.env` file):
| Variable | Default | Notes |
|---|---|---|
| `REDIS_HOST` | `redis` | Service name inside Compose network |
| `DOWNLOAD_DIR` | `/downloads` | Maps to the `downloads` volume |
| `DB_PATH` | `/app/db/streamgrabber.db` | Maps to the `db-data` volume |
| `MAX_CONCURRENT` | `2` | Parallel download jobs in the worker |
| `API_HOST` | `0.0.0.0` | Bind address inside the container |
| `API_PORT` | `8000` | Exposed on the host as well |

**Image prerequisites baked into the Dockerfile:**
- `python:3.12-slim` base
- `ffmpeg` — required by yt-dlp to merge HLS segments; SprintCDN (f16px/VideoVard) streams fail without it
- Playwright Chromium + all its shared-library deps — installed via `playwright install chromium --with-deps`
- All Python packages from `requirements.txt`
- React frontend pre-built via a `node:22-alpine` builder stage; output copied to `static/`

## Episode status lifecycle

```
pending → queued → downloading → done
                              ↘ failed
                 → cancelling → cancelled   (user pressed Stop mid-download)
```

- `pending` — not yet queued; default state after scraping or reset.
- `queued` — job enqueued in Redis; worker hasn't picked it up yet.
- `downloading` — yt-dlp subprocess is running.
- `cancelling` — stop requested; cancel_watcher will kill yt-dlp within 2 s.
- `cancelled` — yt-dlp was killed; partial file may exist on disk. Episode stays in the Pending tab so the user can retry.
- `done` / `failed` — terminal states.

`reset_stuck_downloads()` is called on worker startup and moves any `downloading` or `queued` episodes back to `pending` to recover from crash/restart.

## Implementation notes

### Cancel / stop race condition (`update_episode_progress`)
`read_stdout` in `downloader.py` writes `set_episode_status(id, "downloading", progress=p)` on every yt-dlp progress line. This can race with the cancel API, which sets status to `cancelling` — the late-arriving progress write would silently overwrite it, causing the cancel_watcher to see `downloading` and do nothing.

Fix: `update_episode_progress(id, p)` in `database.py` uses a conditional UPDATE:
```sql
UPDATE episodes SET progress=?, updated_at=? WHERE id=? AND status IN ('downloading', 'queued')
```
This is a no-op if the episode is already `cancelling`, so the cancel status is never clobbered.

### Process group kill (`os.killpg`)
yt-dlp is launched with `start_new_session=True` so it is immune to the worker's own SIGKILL (prevents orphaning yt-dlp when ARQ restarts the worker). The side-effect is that `proc.kill()` only kills the one PID. `_kill_proc()` in `downloader.py` uses `os.killpg(os.getpgid(proc.pid), SIGKILL)` to kill the entire process group, catching any children yt-dlp may have spawned.

### SQLite connection leak (`@contextmanager get_conn`)
`with sqlite3.Connection` only manages transactions (commit/rollback) — it does **not** close the connection. Long-running uvicorn + polling endpoints accumulated 100+ open file descriptors pointing to the DB file, eventually causing `unable to open database file` errors. Fix: `get_conn()` is a `@contextmanager` that always calls `conn.close()` in `finally`.

### `--hls-use-mpegts` (no ffmpeg merge)
HLS downloads default to collecting segments then merging into MP4 via ffmpeg. On macOS the ffmpeg merge step allocates 200–400 MB for the `moov` atom, which triggers jetsam (OS memory-pressure SIGKILL) at 25–50% progress. `--hls-use-mpegts` writes segments directly to a `.ts` container as they arrive — no merge step, flat ~50 MB peak memory.

`CONCURRENT_FRAGMENTS` (default 3) controls how many HLS segments yt-dlp fetches in parallel. It is safe with `--hls-use-mpegts` because segments are written to disk immediately (no accumulation). SprintCDN (f16px/VideoVard) caps each connection at 5.5 Mbps; 3 parallel fragments gives ~16.5 Mbps effective throughput. Configurable at runtime via the Settings panel (stored in DB, read per-download via `get_setting`).

### Redis pub/sub listener reconnect loop
`_pubsub_listener` in `main.py` wraps the entire subscribe/listen loop in `while True` with `await asyncio.sleep(2)` at the bottom. Without this, a single Redis connection error permanently killed the listener task and all subsequent SSE progress updates would be silently dropped. The loop also calls `pubsub.aclose()` in `finally` before reconnecting to avoid socket leaks.

### Worker status detection (three-tier)
1. **Redis heartbeat** (primary): worker publishes `streamgrabber:stats` key every 2 s with 10 s TTL. API reads this key; if present, worker is alive. Also carries `active_jobs` count.
2. **PID file** (secondary): `worker.pid` written on startup. API sends `os.kill(pid, 0)` to check existence. Stale files are removed automatically.
3. **pgrep** (tertiary): scans the process list for `arq worker.WorkerSettings`. Slow but catches cases where the PID file was never written. Recreates the PID file on success so subsequent polls use the fast path.

## Known behaviours

- Jobs are crash-safe: if API or worker restarts, queued/in-progress jobs remain in Redis and the worker picks them back up.
- Episodes stuck in `downloading` after a crash are reset to `pending` automatically on next worker startup (`reset_stuck_downloads`).
- yt-dlp archive at `DOWNLOAD_DIR/downloaded.txt` prevents re-downloading completed episodes.
- `_resolve_strcdn` may be called twice per episode but URL-level deduplication prevents duplicate sources.
- ffmpeg is still present in the Docker image (yt-dlp dependency for non-HLS formats) but is no longer involved in the normal HLS download path thanks to `--hls-use-mpegts`.
