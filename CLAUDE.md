# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Activate virtualenv (always required first)
source venv/bin/activate

# Run the app (with hot-reload)
uvicorn main:app --reload --port 8000

# Install/update dependencies
pip install -r requirements.txt

# Install Playwright browser (first time or after playwright upgrade)
playwright install chromium

# Update yt-dlp (streaming sites break extractors frequently)
pip install -U yt-dlp

# Test scraper on a specific episode URL
python -c "
import asyncio
from scraper import scrape_episode_sources
result = asyncio.run(scrape_episode_sources('EPISODE_URL', debug=True))
print(result)
"

# Test show scraping
python -c "
import asyncio
from scraper import scrape_show
result = asyncio.run(scrape_show('SHOW_URL'))
print(result)
"
```

## Architecture

Single-process Python app. No task queue — downloads run as FastAPI `BackgroundTasks` (asyncio), bounded by `asyncio.Semaphore(MAX_CONCURRENT)` from `config.py`.

**Data flow:**
1. User pastes show URL → `POST /api/shows` → `scrape_show()` runs in background → episodes saved to SQLite
2. User triggers download → `POST /api/download` → `_download_task()` calls `scrape_episode_sources()` lazily if sources not cached → `download_episode()` tries each source with yt-dlp
3. Progress streams to UI via SSE (`GET /api/episodes/{id}/progress`)

**Key files:**
- `scraper.py` — all Playwright logic. Two entry points: `scrape_show()` (show page → episode list) and `scrape_episode_sources()` (episode page → stream URLs). The strcdn/VideoVard resolver `_resolve_strcdn()` uses plain `httpx` (not Playwright) because the m3u8 URL is in server-rendered HTML.
- `downloader.py` — wraps yt-dlp as subprocess, parses `--progress-template` output line by line, calls `progress_callback` for SSE.
- `config.py` — `SOURCE_PRIORITY`, `MAX_CONCURRENT`, `SCRAPE_TIMEOUT`, `DOWNLOAD_DIR`.
- `database.py` — SQLite via stdlib `sqlite3`. Schema: `shows` + `episodes` tables. `sources` column is a JSON blob.
- `static/index.html` — entire frontend in one file (vanilla JS, no framework).

## seriale-online.net specifics

Episode pages embed a `database.seriale-online.net/iframe/{token}` which redirects to `strcdn.org/e/{code}`.

**strcdn/VideoVard resolution** (`_resolve_strcdn`): The signed HLS m3u8 URL (`cfglobalcdn.com/secip/1/...`) is present in the **server-rendered HTML** of the strcdn embed page — no browser/click needed. Fetched with `httpx`. Falls back to constructing `strcdn.org/f/{code}?{ws_token}` if m3u8 not found.

The `secip` CDN URL is IP-locked to the requesting machine. Since scraper and yt-dlp run on the same machine this works, but the CDN (`cfglobalcdn.com`) is geo-restricted to Romania — unreachable from outside.

Sources include a `referer` key (e.g. `"https://strcdn.org/"`) passed to yt-dlp via `--referer`. The downloader uses `source.get("referer", url)` — explicit referer overrides the default (source URL).

## Known behaviours

- `_resolve_strcdn` is called twice per episode (once via hop redirect, once direct) but deduplication on `url` in `sources` list prevents duplicate entries.
- Downloads are not crash-safe: if the process restarts, in-progress episodes stay in `downloading` status. Use `POST /api/episodes/{id}/reset` to reset them to `pending`.
- yt-dlp archive file at `~/Downloads/StreamGrabber/downloaded.txt` prevents re-downloading already completed episodes.
