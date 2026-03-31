# Running StreamGrabber

Two ways to run: **Docker Compose** (recommended, all dependencies included) or **local dev** (faster iteration, requires manual setup).

---

## Docker Compose (recommended)

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Mac/Windows) or Docker Engine + Compose plugin (Linux)

### First-time setup

Create the data directories that Docker will bind-mount:

```bash
mkdir -p data/downloads data/db data/logs data/redis
```

Build and start everything:

```bash
docker compose up -d --build
```

This starts three containers:
- `redis` — job queue and pub/sub
- `api` — FastAPI + React frontend on port 8000
- `worker` — ARQ worker (Playwright scraping + yt-dlp downloads)

Open the app at **http://localhost:8000**

### Subsequent starts

```bash
docker compose up -d
```

No rebuild needed unless you changed the code. To rebuild after a code change:

```bash
docker compose up -d --build
```

### Stopping

```bash
docker compose down
```

This stops all containers but preserves your data in `./data/`. To also wipe all data (database, downloads, logs):

```bash
docker compose down
rm -rf data/
```

### Viewing logs

```bash
docker compose logs -f          # all containers
docker compose logs -f api      # API only
docker compose logs -f worker   # worker only
```

### Data layout

| Directory | Contents |
|---|---|
| `data/downloads/` | Downloaded video files + `downloaded.txt` yt-dlp archive |
| `data/db/` | SQLite database (`streamgrabber.db`) |
| `data/logs/` | Rotating log files for API and worker |
| `data/redis/` | Redis RDB snapshot (job queue persistence across restarts) |

### Configuration

All settings have safe defaults. Override via environment variables in `docker-compose.yml`:

| Variable | Default | Notes |
|---|---|---|
| `MAX_CONCURRENT` | `2` | Parallel download jobs in the worker |
| `DOWNLOAD_DIR` | `/downloads` | Maps to `data/downloads/` on the host |
| `DB_PATH` | `/app/db/streamgrabber.db` | Maps to `data/db/` on the host |
| `LOG_DIR` | `/app/logs` | Maps to `data/logs/` on the host |

### Updating yt-dlp without a full rebuild

Streaming sites break extractors frequently. To update yt-dlp in the running worker:

```bash
docker compose exec worker pip install -U yt-dlp
docker compose restart worker
```

---

## Local development

### Prerequisites

- Python 3.12+
- Node.js 22+
- Redis (via Docker or native install)

### First-time setup

```bash
# Create and activate virtualenv
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate

# Install Python dependencies
pip install -r requirements.txt

# Install Playwright's Chromium browser
playwright install chromium

# Install and build the frontend
cd frontend
npm install
npm run build
cd ..
```

### Start Redis

If you have Docker available, the easiest way:

```bash
docker run -d --name streamgrabber-redis -p 6379:6379 redis:7-alpine
# On subsequent runs:
docker start streamgrabber-redis
```

### Run the app (three terminals)

**Terminal 1 — API:**
```bash
source venv/bin/activate
uvicorn main:app --reload --port 8000
```

**Terminal 2 — Worker:**
```bash
source venv/bin/activate
arq worker.WorkerSettings
```

**Terminal 3 — Frontend (optional, for live reload during UI development):**
```bash
cd frontend
npm run dev
```

Open the app at **http://localhost:8000** (or http://localhost:5173 for the Vite dev server with hot reload).

### Default local paths

| Resource | Default location |
|---|---|
| Downloads | `~/Downloads/StreamGrabber/` |
| Database | `downloads.db` (project root) |
| Logs | `logs/` (project root) |

All of these are created automatically on first run.

---

## Database migrations

The database schema is created automatically on first run. If a future update changes the schema (adds columns, new tables), you will need to run the migration manually against your existing database before starting the new version:

```bash
# Example — adding a new column:
sqlite3 data/db/streamgrabber.db "ALTER TABLE episodes ADD COLUMN my_new_column TEXT"
```

Migration steps will be documented in the release notes for any version that requires them.

---

## Troubleshooting

**Worker not picking up jobs** — check that Redis is running and healthy:
```bash
docker compose ps          # Docker setup
redis-cli ping             # local setup — should return PONG
```

**Scraping fails / no sources found** — update Playwright and yt-dlp:
```bash
pip install -U yt-dlp
playwright install chromium
```

**Downloads stuck at 0%** — the CDN may be geo-restricted. Some sources (strcdn/cfglobalcdn) only work from Romanian IP addresses.

**Port 8000 already in use** — change the port mapping in `docker-compose.yml`:
```yaml
ports:
  - "9000:8000"   # host:container
```
