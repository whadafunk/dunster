"""
main.py — FastAPI backend
"""
import asyncio
import json
import os
import re
import signal
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator, Optional

import httpx

import arq
import redis.asyncio as aioredis
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from config import (
    CONCURRENT_FRAGMENTS, DOWNLOAD_DIR, MAX_CONCURRENT, MAX_DOWNLOADS, REDIS_HOST, REDIS_PORT, REDIS_SETTINGS,
    LOG_LEVEL_WORKER, LOG_LEVEL_BACKEND, LOG_LEVEL_DOWNLOAD, LOG_LEVEL_EPISODE,
    LOG_MAX_MB_WORKER, LOG_MAX_MB_BACKEND, LOG_MAX_MB_DOWNLOAD, LOG_MAX_MB_EPISODE,
)
from log import log_backend
from database import (
    init_db, upsert_show, get_show, get_episodes,
    get_episode, set_episode_status, reset_episode_to_pending,
    get_all_shows, delete_show, get_setting, set_setting,
    get_all_folders, create_folder, delete_folder,
    set_show_folder, set_show_sort_orders, get_archived_folder_id,
    delete_episodes, flush_queued_episodes, set_subtitle_status,
)

# ── SSE progress bus ────────────────────────────────────────────────────────────
# Maps episode_id -> list of asyncio.Queue (one per connected SSE client).
# Populated by the Redis pub/sub listener below; SSE endpoint unchanged.
_progress_subscribers: dict[int, list[asyncio.Queue]] = {}

# ── Global Redis / ARQ handles (set in lifespan) ───────────────────────────────
arq_pool: arq.ArqRedis = None
_redis: aioredis.Redis = None

# ── System metrics ──────────────────────────────────────────────────────────────
_app_start_time: float = 0.0
_public_ip: str | None = None
_episode_speeds: dict[int, float] = {}   # episode_id → current speed in bps


def _parse_speed_bps(token: str) -> float | None:
    """Parse a yt-dlp speed token like '1.23MiB/s' into bytes per second."""
    m = re.match(r'^([\d.]+)\s*(B|KB|KiB|MB|MiB|GB|GiB)/s$', token, re.IGNORECASE)
    if not m:
        return None
    val = float(m.group(1))
    mult = {'b': 1, 'kb': 1000, 'kib': 1024, 'mb': 10**6, 'mib': 1024**2,
            'gb': 10**9, 'gib': 1024**3}
    return val * mult.get(m.group(2).lower(), 1)


async def _fetch_public_ip():
    global _public_ip
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get('https://api.ipify.org')
                if resp.status_code == 200:
                    _public_ip = resp.text.strip()
                    return
        except Exception:
            if attempt < 2:
                await asyncio.sleep(5)


async def _pubsub_listener():
    """Subscribe to Redis progress:* and forward to SSE asyncio queues.
    Reconnects automatically on connection errors so a worker restart never
    kills the listener permanently.
    """
    while True:
        pubsub = None
        try:
            pubsub = _redis.pubsub()
            await pubsub.psubscribe('progress:*')
            async for message in pubsub.listen():
                if message['type'] != 'pmessage':
                    continue
                channel = message['channel'].decode()
                episode_id = int(channel.split(':')[1])
                payload = message['data'].decode()
                try:
                    data = json.loads(payload)
                    msg = data.get('message', '')
                    speed_token = msg.split()[0] if msg else ''
                    speed_bps = _parse_speed_bps(speed_token)
                    if speed_bps is not None:
                        _episode_speeds[episode_id] = speed_bps
                    elif msg == 'Complete' or data.get('percent', 0) >= 100:
                        _episode_speeds.pop(episode_id, None)
                except Exception:
                    pass
                for q in _progress_subscribers.get(episode_id, []):
                    await q.put(payload)
        except asyncio.CancelledError:
            return
        except Exception:
            pass  # connection dropped — fall through to reconnect
        finally:
            if pubsub is not None:
                try:
                    await pubsub.aclose()
                except Exception:
                    pass
        # Brief pause before reconnecting to avoid a tight loop on persistent errors
        await asyncio.sleep(2)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global arq_pool, _redis, _app_start_time
    _app_start_time = time.time()
    init_db()
    arq_pool = await arq.create_pool(REDIS_SETTINGS)
    _redis = aioredis.Redis(host=REDIS_HOST, port=REDIS_PORT)
    listener = asyncio.create_task(_pubsub_listener())
    asyncio.create_task(_fetch_public_ip())
    yield
    listener.cancel()
    await arq_pool.aclose()
    await _redis.aclose()


app = FastAPI(title="StreamGrabber", lifespan=lifespan)

# Endpoints that are polled every few seconds — log at debug level only
_POLLING_PATHS = {
    '/api/status', '/api/worker/status',
    '/api/system/metrics', '/api/downloader/status',
    '/api/shows', '/api/folders',
}


@app.middleware("http")
async def request_logger(request: Request, call_next):
    response = await call_next(request)
    try:
        path = request.url.path
        if path.startswith('/api/'):
            is_polling = request.method == 'GET' and path in _POLLING_PATHS
            level = 'debug' if is_polling else 'normal'
            msg = f"{request.method} {path} → {response.status_code}"
            # Run in thread pool — log_backend does synchronous SQLite I/O
            await asyncio.get_running_loop().run_in_executor(
                None, lambda: log_backend(msg, level=level)
            )
    except Exception:
        pass
    return response


# ── Models ─────────────────────────────────────────────────────────────────────

class AddShowRequest(BaseModel):
    url: str

class DownloadRequest(BaseModel):
    episode_ids: list[int]
    preferred_source: str = ''

class MaxJobsRequest(BaseModel):
    max_jobs: int

class MaxDownloadsRequest(BaseModel):
    max_downloads: int

class ConcurrentFragmentsRequest(BaseModel):
    concurrent_fragments: int

class ResetRequest(BaseModel):
    delete_file: bool = False
    delete_temp: bool = False
    delete_log: bool = False

class StopDownloadersRequest(BaseModel):
    mode: str = 'all'   # 'all' | 'orphans'

class LoggingSettingsRequest(BaseModel):
    log_level_worker:   str | None = None
    log_level_backend:  str | None = None
    log_level_download: str | None = None
    log_level_episode:  str | None = None
    log_max_mb_worker:   int | None = None
    log_max_mb_backend:  int | None = None
    log_max_mb_download: int | None = None
    log_max_mb_episode:  int | None = None

class CreateFolderRequest(BaseModel):
    name: str

class SetFolderRequest(BaseModel):
    folder_id: Optional[int]  # null = ungrouped

class ReorderShowsRequest(BaseModel):
    items: list[dict]  # [{id: int, sort_order: int}]

class BulkShowActionRequest(BaseModel):
    show_ids: list[int]
    action: str  # 'archive' | 'remove' | 'queue'

class RestartWorkerRequest(BaseModel):
    mode: str = 'graceful'  # 'graceful' | 'immediate'

class BandwidthRequest(BaseModel):
    bandwidth_limit: float  # MB/s total, 0 = unlimited


# ── Routes ─────────────────────────────────────────────────────────────────────

@app.get("/api/shows")
async def list_shows():
    shows = get_all_shows()
    result = []
    for show in shows:
        episodes = get_episodes(show["id"])
        show["episode_count"] = len(episodes)
        show["done_count"] = sum(1 for e in episodes if e["status"] == "done")
        show["active_count"] = sum(1 for e in episodes if e["status"] in ("queued", "downloading"))
        result.append(show)
    return result


@app.post("/api/shows")
async def add_show(req: AddShowRequest):
    url = req.url.strip().rstrip("/") + "/"
    await arq_pool.enqueue_job('job_scrape_show', url)
    return {"status": "scraping", "url": url}


@app.get("/api/folders")
async def list_folders():
    return get_all_folders()


@app.post("/api/folders")
async def add_folder(req: CreateFolderRequest):
    name = req.name.strip()
    if not name:
        raise HTTPException(400, "Folder name cannot be empty")
    return create_folder(name)


@app.delete("/api/folders/{folder_id}")
async def remove_folder(folder_id: int):
    ok = delete_folder(folder_id)
    if not ok:
        raise HTTPException(400, "Cannot delete system folder or folder not found")
    return {"status": "deleted"}


@app.put("/api/shows/{show_id}/folder")
async def move_show_to_folder(show_id: int, req: SetFolderRequest):
    set_show_folder(show_id, req.folder_id)
    return {"status": "ok"}


@app.post("/api/shows/reorder")
async def reorder_shows(req: ReorderShowsRequest):
    set_show_sort_orders(req.items)
    return {"status": "ok"}


@app.post("/api/shows/bulk")
async def bulk_show_action(req: BulkShowActionRequest):
    if req.action == 'archive':
        archived_id = get_archived_folder_id()
        for show_id in req.show_ids:
            set_show_folder(show_id, archived_id)
    elif req.action == 'remove':
        for show_id in req.show_ids:
            delete_show(show_id)
    elif req.action == 'queue':
        for show_id in req.show_ids:
            for ep in get_episodes(show_id):
                if ep["status"] == "pending":
                    set_episode_status(ep["id"], "queued", progress=0)
                    await arq_pool.enqueue_job('job_download_episode', ep["id"], '')
    else:
        raise HTTPException(400, f"Unknown action: {req.action}")
    return {"status": "ok"}


@app.delete("/api/shows/{show_id}")
async def remove_show(show_id: int):
    delete_show(show_id)
    return {"status": "deleted"}


@app.get("/api/shows/{show_id}/episodes")
async def list_episodes(show_id: int):
    return get_episodes(show_id)


@app.post("/api/episodes/{episode_id}/scan")
async def scan_episode_sources(episode_id: int):
    ep = get_episode(episode_id)
    if not ep:
        raise HTTPException(404, "Episode not found")
    await arq_pool.enqueue_job('job_scan_episode', episode_id)
    return {"status": "scanning"}


@app.post("/api/download")
async def start_downloads(req: DownloadRequest):
    if get_setting("worker_paused", "false") == "true":
        raise HTTPException(409, "Worker is paused — resume before queuing downloads")
    queued = 0
    for eid in req.episode_ids:
        ep = get_episode(eid)
        if not ep or ep["status"] == "done":
            continue
        set_episode_status(eid, "queued", progress=0)
        await arq_pool.enqueue_job('job_download_episode', eid, req.preferred_source)
        queued += 1
    return {"status": "queued", "count": queued}


@app.post("/api/episodes/{episode_id}/download-subs")
async def download_episode_subs(episode_id: int):
    ep = get_episode(episode_id)
    if not ep:
        raise HTTPException(404, "Episode not found")
    set_subtitle_status(episode_id, "pending")
    await arq_pool.enqueue_job('job_download_subs', episode_id)
    return {"status": "queued"}


@app.post("/api/episodes/{episode_id}/cancel")
async def cancel_episode(episode_id: int):
    set_episode_status(episode_id, "cancelling", progress=0)
    return {"status": "cancelling"}


@app.post("/api/episodes/{episode_id}/reset")
async def reset_episode(episode_id: int, req: Optional[ResetRequest] = None):
    import glob as _glob
    ep = get_episode(episode_id)
    if not ep:
        raise HTTPException(404, "Episode not found")
    r = req or ResetRequest()

    if r.delete_file and ep.get("file_path"):
        try:
            Path(ep["file_path"]).unlink(missing_ok=True)
        except OSError:
            pass

    # Use the stored file_base (set when download started) to find temp files reliably
    file_base = ep.get("file_base")
    if r.delete_file and file_base:
        for f in _glob.glob(f"{_glob.escape(file_base)}*.srt"):
            try:
                Path(f).unlink(missing_ok=True)
            except OSError:
                pass
    if r.delete_temp and file_base:
        for leftover in _glob.glob(f"{_glob.escape(file_base)}.*"):
            if (leftover.endswith(".part")
                    or ".part-Frag" in leftover
                    or leftover.endswith(".ytdl")):
                try:
                    Path(leftover).unlink(missing_ok=True)
                except OSError:
                    pass

    if r.delete_log:
        title  = ep.get("title") or ""
        season = ep.get("season")  or 0
        ep_num = ep.get("episode") or 0
        log_slug = re.sub(r'[\\/*?:"<>|\s]+', '_', title).strip('_')[:80]
        log_file = DOWNLOAD_DIR / "logs" / f"S{season:02d}E{ep_num:02d}_{log_slug}.log"
        try:
            log_file.unlink(missing_ok=True)
        except OSError:
            pass

    reset_episode_to_pending(episode_id, clear_download_data=r.delete_file)
    return {"status": "reset"}


class RemoveEpisodesRequest(BaseModel):
    episode_ids: list[int]
    delete_files: bool = False

@app.post("/api/episodes/remove")
async def remove_episodes(req: RemoveEpisodesRequest):
    import glob as _glob
    for eid in req.episode_ids:
        ep = get_episode(eid)
        if not ep or ep["status"] in ("queued", "downloading", "cancelling"):
            continue
        if req.delete_files:
            if ep.get("file_path"):
                try:
                    Path(ep["file_path"]).unlink(missing_ok=True)
                except OSError:
                    pass
            # Delete subtitle files and temp files via file_base
            file_base = ep.get("file_base") or (ep["file_path"].rsplit(".", 1)[0] if ep.get("file_path") else None)
            if file_base:
                for f in _glob.glob(f"{_glob.escape(file_base)}*.srt"):
                    try: Path(f).unlink(missing_ok=True)
                    except OSError: pass
                for f in _glob.glob(f"{_glob.escape(file_base)}*.part*"):
                    try: Path(f).unlink(missing_ok=True)
                    except OSError: pass
    count = delete_episodes(req.episode_ids)
    return {"status": "removed", "count": count}


@app.get("/api/episodes/{episode_id}/progress")
async def episode_progress_sse(episode_id: int):
    queue: asyncio.Queue = asyncio.Queue()
    _progress_subscribers.setdefault(episode_id, []).append(queue)

    async def event_stream() -> AsyncGenerator[str, None]:
        try:
            ep = get_episode(episode_id)
            if ep:
                yield f"data: {json.dumps({'episode_id': episode_id, 'percent': ep['progress'], 'message': '', 'status': ep['status'], 'snapshot': True})}\n\n"
            while True:
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=30)
                    yield f"data: {payload}\n\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            subs = _progress_subscribers.get(episode_id, [])
            if queue in subs:
                subs.remove(queue)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.get("/api/status")
async def global_status():
    shows = get_all_shows()
    total = done = failed = downloading = queued = 0
    for show in shows:
        for ep in get_episodes(show["id"]):
            total += 1
            if ep["status"] == "done":           done += 1
            elif ep["status"] == "failed":       failed += 1
            elif ep["status"] == "downloading":  downloading += 1
            elif ep["status"] == "queued":       queued += 1
    return {
        "total": total, "done": done, "failed": failed,
        "downloading": downloading, "queued": queued,
        "pending": total - done - failed - downloading - queued,
    }


_PID_FILE = Path(__file__).parent / "worker.pid"


@app.get("/api/worker/status")
async def worker_status():
    running_max  = int(get_setting("running_max_concurrent",  str(MAX_CONCURRENT)))
    configured   = int(get_setting("max_concurrent",          str(MAX_CONCURRENT)))
    configured_max_dl = int(get_setting("max_downloads", str(MAX_DOWNLOADS)))
    configured_cf     = int(get_setting("concurrent_fragments", str(CONCURRENT_FRAGMENTS)))
    configured_bw     = float(get_setting("bandwidth_limit", "0") or "0")
    running = False
    active_jobs = 0
    # Primary: Redis heartbeat — worker publishes every 2 s with 10 s TTL
    raw_stats = None
    last_warning = ''
    orphan_count = 0
    try:
        raw_stats = await _redis.get("streamgrabber:stats")
        if raw_stats:
            stats = json.loads(raw_stats)
            active_jobs = stats.get("active_jobs", 0)
            last_warning = stats.get("last_warning", '')
            orphan_count = stats.get("orphan_count", 0)
            running = True
    except Exception:
        pass
    # Secondary: PID file
    if not running and _PID_FILE.exists():
        try:
            pid = int(_PID_FILE.read_text().strip())
            os.kill(pid, 0)   # signal 0 = existence check only
            running = True
        except (ProcessLookupError, PermissionError, ValueError, OSError):
            _PID_FILE.unlink(missing_ok=True)   # stale — clean up
    # Tertiary: scan process list for arq worker
    if not running:
        try:
            import subprocess as _sp
            r = _sp.run(
                ['pgrep', '-f', 'arq worker.WorkerSettings'],
                capture_output=True, timeout=2,
            )
            if r.returncode == 0:
                running = True
                # Re-create PID file so next poll uses the fast path
                pids = r.stdout.decode().split()
                if pids:
                    _PID_FILE.write_text(pids[0].strip())
        except Exception:
            pass
    queued_jobs = 0
    try:
        queued_jobs = await _redis.zcard("arq:queue")
    except Exception:
        pass
    return {
        "running": running,
        "active_jobs": active_jobs,
        "queued_jobs": queued_jobs,
        "max_jobs": running_max,
        "configured_max_jobs": configured,
        "configured_max_downloads": configured_max_dl,
        "configured_concurrent_fragments": configured_cf,
        "configured_bandwidth_limit": configured_bw,
        "last_warning": last_warning,
        "orphan_count": orphan_count,
        "paused": get_setting("worker_paused", "false") == "true",
    }


@app.post("/api/worker/max-jobs")
async def set_worker_max_jobs(req: MaxJobsRequest):
    clamped = max(1, min(10, req.max_jobs))
    set_setting("max_concurrent", str(clamped))
    # Keep display value in sync so UI shows the right number even when worker is down
    set_setting("running_max_concurrent", str(clamped))
    return {"status": "saved", "max_jobs": clamped}


@app.post("/api/worker/max-downloads")
async def set_worker_max_downloads(req: MaxDownloadsRequest):
    clamped = max(1, min(10, req.max_downloads))
    set_setting("max_downloads", str(clamped))
    return {"status": "saved", "max_downloads": clamped}


@app.post("/api/worker/concurrent-fragments")
async def set_concurrent_fragments(req: ConcurrentFragmentsRequest):
    clamped = max(1, min(4, req.concurrent_fragments))
    set_setting("concurrent_fragments", str(clamped))
    return {"status": "saved", "concurrent_fragments": clamped}


@app.get("/api/downloader/status")
async def downloader_status():
    try:
        raw = await _redis.get("streamgrabber:stats")
        if raw:
            stats = json.loads(raw)
            return {
                "active": stats.get("active_downloads", 0),
                "orphans": stats.get("orphan_count", 0),
            }
    except Exception:
        pass
    return {"active": 0, "orphans": 0}


@app.post("/api/downloader/stop")
async def stop_downloaders(req: StopDownloadersRequest):
    await arq_pool.enqueue_job('job_stop_downloads', req.mode)
    return {"status": "stopping", "mode": req.mode}


@app.get("/api/episodes/active")
async def get_active_episodes():
    """All episodes currently queued, downloading, or cancelling — across all shows."""
    result = []
    for show in get_all_shows():
        for ep in get_episodes(show["id"]):
            if ep["status"] in ("queued", "downloading", "cancelling"):
                result.append({
                    "id": ep["id"],
                    "show_id": show["id"],
                    "show_title": show.get("title") or "",
                    "title": ep.get("title") or f'S{ep.get("season") or 0:02d}E{ep.get("episode") or 0:02d}',
                    "season": ep.get("season") or 0,
                    "episode": ep.get("episode") or 0,
                    "status": ep["status"],
                    "progress": ep["progress"],
                })
    return result


@app.get("/api/worker/active-downloads")
async def get_active_downloads():
    """Return currently downloading episodes for the restart confirmation dialog."""
    result = []
    for show in get_all_shows():
        for ep in get_episodes(show["id"]):
            if ep["status"] == "downloading":
                result.append({
                    "id": ep["id"],
                    "title": ep.get("title") or f"Episode {ep['id']}",
                    "show_title": show.get("title") or "",
                })
    return result


@app.post("/api/worker/restart")
async def restart_worker(req: Optional[RestartWorkerRequest] = None):
    mode = (req.mode if req else 'graceful')
    if mode not in ('graceful', 'immediate'):
        mode = 'graceful'
    # Primary: Redis signal — works across containers without Docker socket
    try:
        await _redis.set(
            'streamgrabber:restart_requested',
            json.dumps({"mode": mode}),
            ex=30
        )
        return {"status": "restarting", "mode": mode}
    except Exception:
        pass
    # Fallback: PID file (local dev, Redis unavailable)
    if _PID_FILE.exists():
        try:
            pid = int(_PID_FILE.read_text().strip())
            os.kill(pid, signal.SIGTERM)
            return {"status": "restarting", "mode": mode}
        except (ProcessLookupError, ValueError, OSError):
            _PID_FILE.unlink(missing_ok=True)
    return {"status": "worker not running"}


@app.post("/api/worker/bandwidth")
async def set_bandwidth(req: BandwidthRequest):
    limit = max(0.0, req.bandwidth_limit)
    set_setting("bandwidth_limit", str(limit))
    return {"status": "saved", "bandwidth_limit": limit}


@app.post("/api/worker/flush-queue")
async def flush_worker_queue():
    count = flush_queued_episodes()
    return {"status": "flushed", "count": count}


@app.post("/api/worker/pause")
async def toggle_worker_pause():
    current = get_setting("worker_paused", "false")
    new_val = "false" if current == "true" else "true"
    set_setting("worker_paused", new_val)
    return {"status": "ok", "paused": new_val == "true"}


@app.get("/api/system/metrics")
async def system_metrics():
    uptime = round(time.time() - _app_start_time) if _app_start_time else None
    bandwidth = sum(_episode_speeds.values()) or None
    active_downloads = 0
    cdn_waiting = 0
    queue_count = 0
    try:
        raw = await _redis.get("streamgrabber:stats")
        if raw:
            stats = json.loads(raw)
            active_downloads = stats.get("active_downloads", 0)
            cdn_waiting = stats.get("cdn_waiting", 0)
        queue_count = await _redis.zcard("arq:queue")
    except Exception:
        pass
    max_downloads = int(get_setting("max_downloads", str(MAX_DOWNLOADS)))
    return {
        "queue_count": queue_count,
        "bandwidth_bps": bandwidth,
        "public_ip": _public_ip,
        "uptime_seconds": uptime,
        "active_downloads": active_downloads,
        "cdn_waiting": cdn_waiting,
        "max_downloads": max_downloads,
    }


# ── Logging settings ───────────────────────────────────────────────────────────

@app.get("/api/settings/logging")
async def get_logging_settings():
    return {
        "log_level_worker":   get_setting("log_level_worker",   LOG_LEVEL_WORKER),
        "log_level_backend":  get_setting("log_level_backend",  LOG_LEVEL_BACKEND),
        "log_level_download": get_setting("log_level_download", LOG_LEVEL_DOWNLOAD),
        "log_level_episode":  get_setting("log_level_episode",  LOG_LEVEL_EPISODE),
        "log_max_mb_worker":   int(get_setting("log_max_mb_worker",   str(LOG_MAX_MB_WORKER))),
        "log_max_mb_backend":  int(get_setting("log_max_mb_backend",  str(LOG_MAX_MB_BACKEND))),
        "log_max_mb_download": int(get_setting("log_max_mb_download", str(LOG_MAX_MB_DOWNLOAD))),
        "log_max_mb_episode":  int(get_setting("log_max_mb_episode",  str(LOG_MAX_MB_EPISODE))),
    }


@app.post("/api/settings/logging")
async def save_logging_settings(req: LoggingSettingsRequest):
    valid_levels = {"none", "normal", "debug"}
    pairs = [
        ("log_level_worker",   req.log_level_worker,   None),
        ("log_level_backend",  req.log_level_backend,  None),
        ("log_level_download", req.log_level_download, None),
        ("log_level_episode",  req.log_level_episode,  None),
        ("log_max_mb_worker",   req.log_max_mb_worker,   (1, 5)),
        ("log_max_mb_backend",  req.log_max_mb_backend,  (1, 5)),
        ("log_max_mb_download", req.log_max_mb_download, (1, 5)),
        ("log_max_mb_episode",  req.log_max_mb_episode,  (1, 5)),
    ]
    for key, val, clamp in pairs:
        if val is None:
            continue
        if clamp:
            val = str(max(clamp[0], min(clamp[1], int(val))))
        else:
            if val not in valid_levels:
                continue
        set_setting(key, str(val))
    return {"status": "saved"}


class DownloadSettingsRequest(BaseModel):
    folder_per_show:   bool | None = None
    folder_per_season: bool | None = None
    bandwidth_limit:   float | None = None

class SubtitleSettingsRequest(BaseModel):
    enabled: bool
    lang1: str
    lang2: str


@app.get("/api/settings/download")
async def get_download_settings():
    return {
        "folder_per_show":   get_setting("folder_per_show",   "false") == "true",
        "folder_per_season": get_setting("folder_per_season", "true")  == "true",
        "bandwidth_limit":   float(get_setting("bandwidth_limit", "0") or "0"),
    }


@app.post("/api/settings/download")
async def save_download_settings(req: DownloadSettingsRequest):
    if req.folder_per_show is not None:
        set_setting("folder_per_show", "true" if req.folder_per_show else "false")
    if req.folder_per_season is not None:
        set_setting("folder_per_season", "true" if req.folder_per_season else "false")
    if req.bandwidth_limit is not None:
        set_setting("bandwidth_limit", str(max(0.0, req.bandwidth_limit)))
    return {"status": "saved"}


VALID_SUBTITLE_LANGS = {"ro", "en", "es", ""}

@app.get("/api/settings/subtitles")
async def get_subtitle_settings():
    return {
        "enabled": get_setting("subtitles_enabled", "false") == "true",
        "lang1":   get_setting("subtitles_lang1", "ro"),
        "lang2":   get_setting("subtitles_lang2", ""),
    }

@app.post("/api/settings/subtitles")
async def save_subtitle_settings(req: SubtitleSettingsRequest):
    lang1 = req.lang1 if req.lang1 in VALID_SUBTITLE_LANGS else "ro"
    lang2 = req.lang2 if req.lang2 in VALID_SUBTITLE_LANGS else ""
    set_setting("subtitles_enabled", "true" if req.enabled else "false")
    set_setting("subtitles_lang1", lang1)
    set_setting("subtitles_lang2", lang2)
    return {"status": "saved"}


# ── Serve React frontend (must be last) ────────────────────────────────────────
app.mount("/", StaticFiles(directory="static", html=True))
