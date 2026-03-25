"""
main.py — FastAPI backend
"""
import asyncio
import json
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from database import (
    init_db, upsert_show, upsert_episode, get_show, get_episodes,
    get_episode, set_episode_status, get_all_shows, delete_show,
)
from scraper import scrape_show, scrape_episode_sources
from downloader import download_episode, cancel_download
from config import MAX_CONCURRENT

# ── SSE progress bus ───────────────────────────────────────────────────────────
# Maps episode_id -> list of asyncio.Queue (one per connected SSE client)
_progress_subscribers: dict[int, list[asyncio.Queue]] = {}


async def _broadcast_progress(episode_id: int, percent: float, message: str):
    queues = _progress_subscribers.get(episode_id, [])
    payload = json.dumps({"episode_id": episode_id, "percent": percent, "message": message})
    for q in queues:
        await q.put(payload)


# ── Download semaphore ─────────────────────────────────────────────────────────
_download_sem: asyncio.Semaphore = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _download_sem
    init_db()
    _download_sem = asyncio.Semaphore(MAX_CONCURRENT)
    yield


app = FastAPI(title="StreamGrabber", lifespan=lifespan)


# ── Models ─────────────────────────────────────────────────────────────────────

class AddShowRequest(BaseModel):
    url: str

class DownloadRequest(BaseModel):
    episode_ids: list[int]


# ── Routes ─────────────────────────────────────────────────────────────────────



@app.get("/api/shows")
async def list_shows():
    shows = get_all_shows()
    result = []
    for show in shows:
        episodes = get_episodes(show["id"])
        show["episode_count"] = len(episodes)
        show["done_count"] = sum(1 for e in episodes if e["status"] == "done")
        result.append(show)
    return result


@app.post("/api/shows")
async def add_show(req: AddShowRequest, background_tasks: BackgroundTasks):
    """Scrape a show page and save episodes to DB."""
    url = req.url.strip().rstrip("/") + "/"
    background_tasks.add_task(_scrape_show_task, url)
    return {"status": "scraping", "url": url}


async def _scrape_show_task(url: str):
    try:
        data = await scrape_show(url)
        show_id = upsert_show(url, data["title"])
        for ep in data["episodes"]:
            upsert_episode(
                show_id=show_id,
                url=ep["url"],
                title=ep["title"],
                season=ep["season"],
                episode=ep["episode"],
                sources=[],  # sources loaded lazily per episode
            )
        print(f"[✓] Scraped show '{data['title']}' — {len(data['episodes'])} episodes")
    except Exception as e:
        print(f"[✗] Failed to scrape show {url}: {e}")


@app.delete("/api/shows/{show_id}")
async def remove_show(show_id: int):
    delete_show(show_id)
    return {"status": "deleted"}


@app.get("/api/shows/{show_id}/episodes")
async def list_episodes(show_id: int):
    episodes = get_episodes(show_id)
    return episodes


@app.post("/api/episodes/{episode_id}/scan")
async def scan_episode_sources(episode_id: int, background_tasks: BackgroundTasks):
    """Scrape sources for a single episode."""
    ep = get_episode(episode_id)
    if not ep:
        raise HTTPException(404, "Episode not found")
    background_tasks.add_task(_scan_sources_task, episode_id, ep["url"])
    return {"status": "scanning"}


async def _scan_sources_task(episode_id: int, episode_url: str):
    try:
        sources = await scrape_episode_sources(episode_url)
        ep = get_episode(episode_id)
        if ep:
            from database import get_conn
            import json as _json
            with get_conn() as conn:
                conn.execute(
                    "UPDATE episodes SET sources=? WHERE id=?",
                    (_json.dumps(sources), episode_id)
                )
        print(f"[✓] Episode {episode_id}: found {len(sources)} source(s)")
    except Exception as e:
        print(f"[✗] Scan failed for episode {episode_id}: {e}")


@app.post("/api/download")
async def start_downloads(req: DownloadRequest, background_tasks: BackgroundTasks):
    """Enqueue episodes for download."""
    queued = 0
    for eid in req.episode_ids:
        ep = get_episode(eid)
        if not ep:
            continue
        if ep["status"] in ("done",):
            continue
        set_episode_status(eid, "queued", progress=0)
        background_tasks.add_task(_download_task, eid)
        queued += 1
    return {"status": "queued", "count": queued}


async def _download_task(episode_id: int):
    ep = get_episode(episode_id)
    if not ep:
        return

    # Always re-scrape sources — the CDN URLs are IP+time signed and stale ones fail
    print(f"[→] Scraping fresh sources for episode {episode_id}…")
    await _scan_sources_task(episode_id, ep["url"])
    ep = get_episode(episode_id)

    async with _download_sem:
        await download_episode(
            episode_id=episode_id,
            episode_title=ep["title"],
            sources=ep["sources"],
            progress_callback=_broadcast_progress,
        )


@app.post("/api/episodes/{episode_id}/cancel")
async def cancel_episode(episode_id: int):
    await cancel_download(episode_id)
    return {"status": "cancelled"}


@app.post("/api/episodes/{episode_id}/reset")
async def reset_episode(episode_id: int):
    set_episode_status(episode_id, "pending", progress=0, error=None)
    return {"status": "reset"}


@app.get("/api/episodes/{episode_id}/progress")
async def episode_progress_sse(episode_id: int):
    """Server-Sent Events stream for live download progress."""
    queue: asyncio.Queue = asyncio.Queue()
    _progress_subscribers.setdefault(episode_id, []).append(queue)

    async def event_stream() -> AsyncGenerator[str, None]:
        try:
            # Send current state immediately
            ep = get_episode(episode_id)
            if ep:
                yield f"data: {json.dumps({'episode_id': episode_id, 'percent': ep['progress'], 'message': ep['status']})}\n\n"
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
    """Quick summary across all shows."""
    shows = get_all_shows()
    total = done = failed = downloading = queued = 0
    for show in shows:
        for ep in get_episodes(show["id"]):
            total += 1
            if ep["status"] == "done":
                done += 1
            elif ep["status"] == "failed":
                failed += 1
            elif ep["status"] == "downloading":
                downloading += 1
            elif ep["status"] == "queued":
                queued += 1
    return {
        "total": total,
        "done": done,
        "failed": failed,
        "downloading": downloading,
        "queued": queued,
        "pending": total - done - failed - downloading - queued,
    }


@app.get("/api/worker/status")
async def worker_status():
    return {"running": True, "active_jobs": 0, "queued_jobs": 0, "max_jobs": MAX_CONCURRENT}


@app.get("/api/system/metrics")
async def system_metrics():
    return {"queue_count": 0, "bandwidth_bps": None, "public_ip": None, "uptime_seconds": None}


# ── Serve React frontend (must be last — catches everything not matched above) ──
app.mount("/", StaticFiles(directory="static", html=True))
