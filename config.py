"""
config.py — Application settings.

All tuneable values are read from environment variables with safe local defaults.
In Docker Compose, pass these via the `environment:` block.
"""
import os
from pathlib import Path
from arq.connections import RedisSettings


# ── Redis ──────────────────────────────────────────────────────────────────────
# Worker and API both connect here. In Docker Compose set REDIS_HOST to the
# service name (e.g. "redis"). Locally defaults to localhost.

REDIS_HOST = os.getenv('REDIS_HOST', 'localhost')
REDIS_PORT = int(os.getenv('REDIS_PORT', '6379'))
REDIS_SETTINGS = RedisSettings(host=REDIS_HOST, port=REDIS_PORT)


# ── API server ─────────────────────────────────────────────────────────────────
# Passed to uvicorn at startup. In containers use 0.0.0.0 to bind all interfaces.

API_HOST = os.getenv('API_HOST', '127.0.0.1')
API_PORT = int(os.getenv('API_PORT', '8000'))


# ── Downloads ──────────────────────────────────────────────────────────────────
# Where yt-dlp saves files. In Docker Compose mount a host volume here.

DOWNLOAD_DIR = Path(os.getenv('DOWNLOAD_DIR', '~/Downloads/StreamGrabber')).expanduser()
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)


# ── Worker ─────────────────────────────────────────────────────────────────────
# MAX_CONCURRENT controls how many download jobs run in parallel.
# Raise it if your connection and CPU can handle more simultaneous streams.

MAX_CONCURRENT         = int(os.getenv('MAX_CONCURRENT',         '2'))
MAX_DOWNLOADS          = int(os.getenv('MAX_DOWNLOADS',          '2'))
CONCURRENT_FRAGMENTS   = int(os.getenv('CONCURRENT_FRAGMENTS',   '3'))


# ── Logging ────────────────────────────────────────────────────────────────────
# LOG_DIR is shared between the API and worker containers (mount the same volume).
# Log levels and max sizes can also be changed at runtime via the Settings panel
# (stored in the DB); these env vars only set the initial defaults.

LOG_DIR = Path(os.getenv('LOG_DIR', Path(__file__).parent / 'logs'))
LOG_DIR.mkdir(parents=True, exist_ok=True)

LOG_LEVEL_WORKER   = os.getenv('LOG_LEVEL_WORKER',   'normal')  # none | normal | debug
LOG_LEVEL_BACKEND  = os.getenv('LOG_LEVEL_BACKEND',  'normal')
LOG_LEVEL_DOWNLOAD = os.getenv('LOG_LEVEL_DOWNLOAD', 'normal')
LOG_LEVEL_EPISODE  = os.getenv('LOG_LEVEL_EPISODE',  'normal')
LOG_MAX_MB_WORKER   = int(os.getenv('LOG_MAX_MB_WORKER',   '2'))
LOG_MAX_MB_BACKEND  = int(os.getenv('LOG_MAX_MB_BACKEND',  '2'))
LOG_MAX_MB_DOWNLOAD = int(os.getenv('LOG_MAX_MB_DOWNLOAD', '5'))
LOG_MAX_MB_EPISODE  = int(os.getenv('LOG_MAX_MB_EPISODE',  '1'))


# ── Scraper ────────────────────────────────────────────────────────────────────
# Internal constants — not intended for per-deployment tuning.

# Playwright navigation timeout in milliseconds.
SCRAPE_TIMEOUT = 30_000

# Source priority — tried left-to-right; first successful download wins.
# The actual embed hosts on seriale-online.net are: f16px.com (VideoVard),
# myvidplay.com (Doodstream), vidload.co (Streamsb), strcdn/cfglobalcdn (Netu).
SOURCE_PRIORITY = [
    "f16px",        # VideoVard via f16px CDN
    "myvidplay",    # Doodstream embed
    "vidload",      # Streamsb embed
    "doodstream",
    "dood",
    "streamsb",
    "sbplay",
    "sbfull",
    "hydrax",
    "streamtape",
    "videovard",
    "netu",
    "strcdn",       # Last: cfglobalcdn has geo/routing issues outside Romania
]


# ── yt-dlp ─────────────────────────────────────────────────────────────────────
# Extra flags passed to every yt-dlp invocation.

YTDLP_EXTRA_ARGS = [
    "--no-warnings",
    "--retries", "3",
    "--fragment-retries", "2",  # was 5 — fail faster when CDN stalls mid-download
    "--socket-timeout", "20",   # was 30 — give up on a stalled connection sooner
    "--hls-use-mpegts",  # write segments directly to .ts — no ffmpeg merge, no memory spike
]
