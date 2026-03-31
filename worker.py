"""
worker.py — ARQ worker process
Run with: arq worker.WorkerSettings
"""
import asyncio
import json
import os
import signal
from pathlib import Path

# Python 3.10+ no longer auto-creates an event loop; arq's CLI requires one.
try:
    asyncio.get_event_loop()
except RuntimeError:
    asyncio.set_event_loop(asyncio.new_event_loop())

from config import MAX_CONCURRENT, MAX_DOWNLOADS, REDIS_SETTINGS
from database import get_episode, get_episodes, get_conn, get_setting, set_setting, set_episode_status, upsert_show, upsert_episode, reset_stuck_downloads, set_show_episodes_sources, get_show_by_id, set_subtitle_status
from scraper import scrape_show, scrape_episode_sources
from downloader import download_episode, download_subs_only, init_download_sem, get_downloader_stats, kill_all_ytdlp, kill_orphan_ytdlp
import log as _log_module
from log import log_worker, log_download, register_episode_log

PID_FILE = Path(__file__).parent / "worker.pid"

# Read configured concurrency from DB (falls back to env var / config.py default)
_configured_max = int(get_setting("max_concurrent", str(MAX_CONCURRENT)))

# Playwright is heavy — cap simultaneous browser sessions to avoid OOM crashes
# even when multiple download/scan jobs run concurrently.
_playwright_sem: asyncio.Semaphore | None = None

# Count of ARQ job coroutines currently executing (all job types).
_active_jobs: int = 0

_restarting: bool = False

# Redis handle for publishing stats (set in _on_startup from ctx['redis']).
_stats_redis = None


async def _publish_stats():
    """Background task: write live worker counters to Redis every 2 s (TTL 10 s)."""
    while True:
        await asyncio.sleep(2)
        if _stats_redis is None:
            continue
        try:
            dl = get_downloader_stats()
            payload = json.dumps({
                "active_jobs":      _active_jobs,
                "active_downloads": dl["active_downloads"],
                "cdn_waiting":      dl["cdn_waiting"],
                "orphan_count":     dl["orphan_count"],
                "last_warning":     _log_module.get_last_warning(),
            })
            await _stats_redis.set("streamgrabber:stats", payload, ex=10)
        except Exception:
            pass


async def _restart_watcher(ctx):
    """Poll Redis for a restart request from the API.
    Graceful: wait for all active jobs to finish, then SIGTERM self.
    Immediate: kill all yt-dlp processes, then SIGTERM self.
    """
    global _restarting
    redis = ctx['redis']
    while True:
        await asyncio.sleep(2)
        try:
            val = await redis.get('streamgrabber:restart_requested')
            if not val:
                continue
            data = json.loads(val)
            mode = data.get('mode', 'graceful')
            await redis.delete('streamgrabber:restart_requested')

            if mode == 'immediate':
                log_worker("Immediate restart requested — killing downloads and restarting")
                kill_all_ytdlp()
                await asyncio.sleep(0.3)
                os.kill(os.getpid(), signal.SIGTERM)
                return
            else:
                _restarting = True
                log_worker(f"Graceful restart requested — waiting for {_active_jobs} active job(s) to finish")
                while _active_jobs > 0:
                    await asyncio.sleep(1)
                log_worker("All jobs done — restarting worker")
                os.kill(os.getpid(), signal.SIGTERM)
                return
        except asyncio.CancelledError:
            return
        except Exception:
            pass


async def _on_startup(ctx):
    global _playwright_sem, _stats_redis
    _playwright_sem = asyncio.Semaphore(1)
    _stats_redis = ctx["redis"]
    configured_max_dl = int(get_setting("max_downloads", str(MAX_DOWNLOADS)))
    init_download_sem(configured_max_dl)
    asyncio.create_task(_publish_stats())
    asyncio.create_task(_restart_watcher(ctx))
    PID_FILE.write_text(str(os.getpid()))
    try:
        set_setting("running_max_concurrent", str(_configured_max))
    except Exception as e:
        log_worker(f"[!] Could not save running_max_concurrent: {e}")
    reset_count = reset_stuck_downloads()
    if reset_count:
        log_worker(f"Reset {reset_count} stuck episode(s) to pending on startup")
    log_worker(f"Worker started — pid={os.getpid()}  max_jobs={_configured_max}")
    asyncio.create_task(_refresh_pid_file())


async def _refresh_pid_file():
    while True:
        await asyncio.sleep(30)
        try:
            PID_FILE.write_text(str(os.getpid()))
        except Exception:
            pass


async def _on_shutdown(ctx):
    # Don't delete PID file here — the process may still be alive during graceful
    # shutdown (ARQ waits for running jobs). The stale-PID cleanup in the API's
    # worker_status() handles removal once the process actually exits.
    log_worker("Worker stopped")


async def job_download_episode(ctx, episode_id: int, preferred_source: str = ''):
    global _active_jobs
    _active_jobs += 1
    try:
        ep = get_episode(episode_id)
        if not ep:
            return

        register_episode_log(episode_id, ep['season'], ep['episode'], ep['title'])
        log_worker(f"Download job started: ep={episode_id} S{ep['season']:02d}E{ep['episode']:02d} '{ep['title']}'")

        redis = ctx['redis']

        async def progress_callback(ep_id: int, percent: float, message: str):
            payload = json.dumps({'episode_id': ep_id, 'percent': percent, 'message': message})
            await redis.publish(f'progress:{ep_id}', payload)

        await _update_sources(episode_id, ep['url'])
        ep = get_episode(episode_id)
        if not ep:
            return

        sources = ep['sources'] or []
        if preferred_source:
            sources = sorted(sources, key=lambda s: 0 if s.get('label') == preferred_source else 1)

        show = get_show_by_id(ep['show_id']) if ep.get('show_id') else None
        show_title = show['title'] if show else ''
        await download_episode(
            episode_id=episode_id,
            episode_title=ep['title'],
            sources=sources,
            progress_callback=progress_callback,
            show_title=show_title,
            season=ep.get('season') or 0,
        )
        # If episode is still 'cancelling' after the job ends (cancel arrived before
        # yt-dlp started, or cancel_watcher killed it), set to 'cancelled'.
        ep_after = get_episode(episode_id)
        if ep_after and ep_after['status'] == 'cancelling':
            set_episode_status(episode_id, 'cancelled', progress=0, error='Cancelled by user')
        final_status = ep_after['status'] if ep_after else 'unknown'
        log_worker(f"Download job finished: ep={episode_id} status={final_status}")
    finally:
        _active_jobs -= 1


async def job_scan_episode(ctx, episode_id: int):
    global _active_jobs
    _active_jobs += 1
    try:
        ep = get_episode(episode_id)
        if not ep:
            return
        log_worker(f"Scan job started: ep={episode_id} '{ep['title']}'")
        await _update_sources(episode_id, ep['url'])
        log_worker(f"Scan job finished: ep={episode_id}")
    finally:
        _active_jobs -= 1


async def job_scrape_show(ctx, url: str):
    global _active_jobs
    _active_jobs += 1
    try:
        async with _playwright_sem:
            data = await scrape_show(url)
        show_id = upsert_show(url, data['title'])
        for ep in data['episodes']:
            upsert_episode(
                show_id=show_id,
                url=ep['url'],
                title=ep['title'],
                season=ep['season'],
                episode=ep['episode'],
                sources=[],
            )
        log_worker(f"Scraped show '{data['title']}' — {len(data['episodes'])} episodes")

        # Probe first 2 episodes to discover sources, then propagate to all episodes.
        # On this site sources are shared across a show, so one scan is usually enough;
        # scanning two gives a fallback if the first episode has a stale/broken embed.
        all_episodes = get_episodes(show_id)
        probe_eps = all_episodes[:2]
        merged_sources: list[dict] = []
        seen_keys: set[str] = set()
        for ep in probe_eps:
            log_worker(f"Probing sources for '{ep['title']}'")
            await _update_sources(ep['id'], ep['url'])
            fresh = get_episode(ep['id'])
            for src in (fresh.get('sources') or []):
                key = src.get('key') or src.get('label', '')
                if key and key not in seen_keys:
                    seen_keys.add(key)
                    merged_sources.append(src)
        if merged_sources:
            count = set_show_episodes_sources(show_id, merged_sources)
            log_worker(f"Propagated {len(merged_sources)} source(s) to {count} episode(s)")
        else:
            log_worker("No sources found during probe — episodes will need manual rescan")
    except Exception as e:
        log_worker(f"[!] Failed to scrape show {url}: {e}")
    finally:
        _active_jobs -= 1


async def _update_sources(episode_id: int, episode_url: str):
    try:
        from datetime import datetime
        async with _playwright_sem:
            sources = await scrape_episode_sources(episode_url, episode_id=episode_id)
        with get_conn() as conn:
            conn.execute(
                "UPDATE episodes SET sources=?, scanned_at=? WHERE id=?",
                (json.dumps(sources), datetime.utcnow().isoformat(), episode_id)
            )
        log_worker(f"Episode {episode_id}: found {len(sources)} source(s)")
    except Exception as e:
        log_worker(f"[!] Scan failed for episode {episode_id}: {e}")


async def job_download_subs(ctx, episode_id: int):
    global _active_jobs
    _active_jobs += 1
    try:
        ep = get_episode(episode_id)
        if not ep:
            return
        log_worker(f"Subs job started: ep={episode_id} '{ep['title']}'")

        redis = ctx['redis']

        async def progress_callback(ep_id: int, percent: float, message: str):
            payload = json.dumps({'episode_id': ep_id, 'percent': percent, 'message': message})
            await redis.publish(f'progress:{ep_id}', payload)

        sources = ep['sources'] or []
        if not sources:
            await _update_sources(episode_id, ep['url'])
            ep = get_episode(episode_id)
            sources = (ep['sources'] or []) if ep else []

        show = get_show_by_id(ep['show_id']) if ep.get('show_id') else None
        show_title = show['title'] if show else ''
        try:
            await download_subs_only(
                episode_id=episode_id,
                episode_title=ep['title'],
                sources=sources,
                progress_callback=progress_callback,
                show_title=show_title,
                season=ep.get('season') or 0,
                existing_file_path=ep.get('file_path') or '',
            )
            set_subtitle_status(episode_id, 'done')
        except Exception as e:
            log_worker(f"[!] Subs job failed: ep={episode_id}: {e}")
            set_subtitle_status(episode_id, 'failed')
        # Signal the frontend that the subs job is done
        await progress_callback(episode_id, 0, 'subs_done')
        log_worker(f"Subs job finished: ep={episode_id}")
    finally:
        _active_jobs -= 1


async def job_stop_downloads(ctx, mode: str = 'all'):
    """Stop yt-dlp processes on demand from the UI. mode: 'all' | 'orphans'"""
    if mode == 'orphans':
        killed = kill_orphan_ytdlp()
    else:
        killed = kill_all_ytdlp()
    log_worker(f"Stop downloads: mode={mode} killed={killed}")


class WorkerSettings:
    functions = [job_download_episode, job_scan_episode, job_scrape_show, job_stop_downloads, job_download_subs]
    redis_settings = REDIS_SETTINGS
    max_jobs = _configured_max
    job_timeout = 3600  # 1 hour max per job
    on_startup = _on_startup
    on_shutdown = _on_shutdown
