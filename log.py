"""
log.py — Structured logging for StreamGrabber.

Three global logs (written to LOG_DIR):
  worker.log   — ARQ worker lifecycle and job events
  backend.log  — FastAPI request/event log
  download.log — yt-dlp activity, CDN waits, source attempts

One per-episode log (written to LOG_DIR/episodes/):
  S{season:02d}E{episode:02d}_{sanitized_title}.log

All logs support three levels: none, normal, debug.
  none   — nothing written
  normal — human-readable milestones (start, success, failure, warnings)
  debug  — full technical detail (URLs, commands, per-line yt-dlp output)

Levels and max sizes are read from the DB settings table with a short cache
so runtime changes take effect within ~10 seconds without a process restart.
Env vars (from config.py) provide the initial defaults.
"""
import re
import time
from datetime import datetime
from pathlib import Path

from config import (
    LOG_DIR, DOWNLOAD_DIR,
    LOG_LEVEL_WORKER, LOG_LEVEL_BACKEND, LOG_LEVEL_DOWNLOAD, LOG_LEVEL_EPISODE,
    LOG_MAX_MB_WORKER, LOG_MAX_MB_BACKEND, LOG_MAX_MB_DOWNLOAD, LOG_MAX_MB_EPISODE,
)

# ── Internal state ─────────────────────────────────────────────────────────────

_LEVELS = {'none': 0, 'normal': 1, 'debug': 2}
_EPISODE_LOG_DIR = DOWNLOAD_DIR / 'logs'

# Last warning/error line — surfaced in the Worker widget via Redis stats.
_last_warning: str = ''

# episode_id → log filename stem (e.g. "S01E03_NCIS_Sydney")
# Populated by register_episode_log() before each download job.
_episode_slugs: dict[int, str] = {}

# Settings cache: key → (value, expires_at monotonic).
# Avoids a DB read on every log line (yt-dlp emits 60+ lines/s per download).
_cache: dict[str, tuple[str, float]] = {}
_CACHE_TTL = 10.0


# ── Public API ─────────────────────────────────────────────────────────────────

def get_last_warning() -> str:
    return _last_warning


def register_episode_log(episode_id: int, season: int, episode: int, title: str) -> None:
    """Call once per download job to map episode_id → its log filename."""
    slug = f"S{season:02d}E{episode:02d}_{_sanitize(title)}"
    _episode_slugs[episode_id] = slug


def get_episode_log_path(episode_id: int) -> 'Path | None':
    """Return the Path of the episode log file, or None if not registered."""
    slug = _episode_slugs.get(episode_id)
    if not slug:
        return None
    return _EPISODE_LOG_DIR / f"{slug}.log"


def log_worker(msg: str, level: str = 'normal') -> None:
    """Write to worker.log. Use level='debug' for verbose internal detail."""
    configured = _setting('log_level_worker', LOG_LEVEL_WORKER)
    if not _passes(level, configured):
        return
    line = _fmt(msg)
    print(line, flush=True)
    _write(LOG_DIR / 'worker.log', line, _max_bytes('log_max_mb_worker', LOG_MAX_MB_WORKER))


def log_backend(msg: str, level: str = 'normal') -> None:
    """Write to backend.log. Use level='debug' for polling/status endpoints."""
    configured = _setting('log_level_backend', LOG_LEVEL_BACKEND)
    if not _passes(level, configured):
        return
    line = _fmt(msg)
    print(line, flush=True)
    _write(LOG_DIR / 'backend.log', line, _max_bytes('log_max_mb_backend', LOG_MAX_MB_BACKEND))


def log_download(msg: str, episode_id: int | None = None, level: str = 'normal') -> None:
    """Write to download.log (and to the episode log if episode_id is set).

    Use level='normal' for milestones (start, try source, success, failure).
    Use level='debug'  for URLs, commands, per-line yt-dlp output.
    """
    global _last_warning
    ep_tag = f"[ep={episode_id}] " if episode_id is not None else ""
    line = _fmt(f"{ep_tag}{msg}")
    if '[!]' in msg:
        _last_warning = line
    configured_dl = _setting('log_level_download', LOG_LEVEL_DOWNLOAD)
    if _passes(level, configured_dl):
        print(line, flush=True)
        _write(LOG_DIR / 'download.log', line,
               _max_bytes('log_max_mb_download', LOG_MAX_MB_DOWNLOAD))
    # Route to episode log regardless of download-log level (episode log has its own setting)
    if episode_id is not None:
        _write_episode(episode_id, msg, level)


# Backward-compat shim — existing call sites in downloader.py / scraper.py
def app_log(msg: str, episode_id: int | None = None) -> None:
    log_download(msg, episode_id=episode_id)


# ── Internal helpers ───────────────────────────────────────────────────────────

def _sanitize(name: str) -> str:
    return re.sub(r'[\\/*?:"<>|\s]+', '_', name).strip('_')[:80]


def _fmt(msg: str) -> str:
    return f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}"


def _passes(msg_level: str, configured: str) -> bool:
    return _LEVELS.get(msg_level, 1) <= _LEVELS.get(configured, 1)


def _setting(key: str, default: str) -> str:
    now = time.monotonic()
    cached = _cache.get(key)
    if cached and now < cached[1]:
        return cached[0]
    try:
        from database import get_setting
        val = get_setting(key, default)
    except Exception:
        val = default
    _cache[key] = (val, now + _CACHE_TTL)
    return val


def _max_bytes(key: str, default_mb: int) -> int:
    raw = _setting(key, str(default_mb))
    try:
        return max(1, min(5, int(raw))) * 1024 * 1024
    except ValueError:
        return default_mb * 1024 * 1024


def _rotate(path: Path, max_bytes: int) -> None:
    try:
        if path.stat().st_size > max_bytes:
            backup = path.with_suffix('.log.1')
            backup.unlink(missing_ok=True)
            path.rename(backup)
    except FileNotFoundError:
        pass
    except Exception:
        pass


def _write(path: Path, line: str, max_bytes: int) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        _rotate(path, max_bytes)
        with open(path, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass


def _write_episode(episode_id: int, msg: str, level: str) -> None:
    configured = _setting('log_level_episode', LOG_LEVEL_EPISODE)
    if not _passes(level, configured):
        return
    slug = _episode_slugs.get(episode_id)
    if not slug:
        return
    _write(
        _EPISODE_LOG_DIR / f"{slug}.log",
        _fmt(msg),
        _max_bytes('log_max_mb_episode', LOG_MAX_MB_EPISODE),
    )
