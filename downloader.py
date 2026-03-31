"""
downloader.py — yt-dlp wrapper with:
  - Source priority fallback
  - Resume support (--continue)
  - Progress reporting via callback
  - Per-source attempt tracking for report
"""
import asyncio
import glob
import json
import os
import re
import signal
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

# Subtitle/player-config query params that confuse yt-dlp when they contain
# another full URL as a value (e.g. c1_file=https://...vtt).
_STRIP_PARAMS = frozenset({'c1_file', 'c1_label', 'sub_file', 'sub_lang', 'cc_file', 'cc_lang'})

# Downloads smaller than this are almost certainly error pages or stubs.
_MIN_VALID_BYTES = 50 * 1024  # 50 KB

from config import CONCURRENT_FRAGMENTS, DOWNLOAD_DIR, MAX_DOWNLOADS, YTDLP_EXTRA_ARGS
from database import set_episode_status, update_episode_progress, update_subtitle_langs, get_episode, get_setting
from log import log_download, get_episode_log_path

# episode_id → running yt-dlp subprocess (worker process memory only)
_active_procs: dict[int, asyncio.subprocess.Process] = {}

# Per-CDN semaphore: limits simultaneous downloads from the same CDN to 1.
# Prevents CDN rate-limiting / connection kills when 3+ jobs all hit the same host.
_cdn_sems: dict[str, asyncio.Semaphore] = {}

# Global download semaphore: caps total simultaneous yt-dlp processes.
# Initialised by init_download_sem() called from the worker's _on_startup.
_download_sem: asyncio.Semaphore | None = None

# Number of download jobs currently blocked waiting on a CDN semaphore.
_cdn_waiting: int = 0


def init_download_sem(limit: int) -> None:
    """Create (or replace) the global download semaphore. Call once from _on_startup."""
    global _download_sem
    _download_sem = asyncio.Semaphore(limit)


def get_orphan_pids() -> list[int]:
    """Return PIDs of yt-dlp processes running on this system that we are NOT tracking."""
    try:
        r = subprocess.run(['pgrep', '-f', 'yt_dlp'], capture_output=True, timeout=3)
        system_pids = {int(p) for p in r.stdout.decode().split() if p.strip()}
    except Exception:
        return []
    tracked_pids = {proc.pid for proc in _active_procs.values()}
    return list(system_pids - tracked_pids)


def kill_all_ytdlp() -> int:
    """Kill all tracked + orphan yt-dlp processes. Returns count killed."""
    killed = 0
    for eid, proc in list(_active_procs.items()):
        _kill_proc(proc, eid)
        killed += 1
    for pid in get_orphan_pids():
        try:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
            killed += 1
        except Exception:
            pass
    return killed


def kill_orphan_ytdlp() -> int:
    """Kill only yt-dlp processes not tracked by this worker. Returns count killed."""
    killed = 0
    for pid in get_orphan_pids():
        try:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
            killed += 1
        except Exception:
            pass
    return killed


def get_downloader_stats() -> dict:
    """Return live counters for the worker stats publisher."""
    return {
        "active_downloads": len(_active_procs),
        "cdn_waiting": _cdn_waiting,
        "orphan_count": len(get_orphan_pids()),
    }


def _kill_proc(proc: asyncio.subprocess.Process, eid: int) -> None:
    """Kill a subprocess and its entire process group (SIGKILL).
    Using killpg instead of proc.kill() ensures any children spawned by yt-dlp
    (e.g. fragment sub-processes) are also terminated.
    Falls back to proc.kill() if the pgid lookup fails (process already gone).
    """
    try:
        pgid = os.getpgid(proc.pid)
        os.killpg(pgid, signal.SIGKILL)
        _log(f"[kill] sent SIGKILL to pgid={pgid} (pid={proc.pid})", eid, level='debug')
    except ProcessLookupError:
        pass   # already dead
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def _cdn_sem(url: str) -> asyncio.Semaphore:
    """Return (creating if needed) a Semaphore(1) keyed by the CDN's root domain."""
    host = urlparse(url).hostname or url
    # Collapse subdomains: edge1-waw-sprintcdn.r66nv9ed.com → r66nv9ed.com
    parts = host.rsplit(".", 2)
    domain = ".".join(parts[-2:]) if len(parts) >= 2 else host
    if domain not in _cdn_sems:
        _cdn_sems[domain] = asyncio.Semaphore(1)
    return _cdn_sems[domain]


def _log(msg: str, episode_id: int | None = None, level: str = 'normal'):
    log_download(msg, episode_id=episode_id, level=level)


def _sanitize_filename(name: str) -> str:
    return re.sub(r'[\\/*?:"<>|]', "_", name).strip()


def _clean_url(url: str) -> str:
    """Strip player-config query params that embed another URL as a value.
    e.g. https://f16px.com/e/abc?c1_file=https://site/sub.vtt&c1_label=Romana
         → https://f16px.com/e/abc
    """
    parsed = urlparse(url)
    if not parsed.query:
        return url
    params = {k: v for k, v in parse_qs(parsed.query, keep_blank_values=True).items()
              if k.lower() not in _STRIP_PARAMS}
    return urlunparse(parsed._replace(query=urlencode(params, doseq=True)))


# ── Subtitle helpers ───────────────────────────────────────────────────────────

_LABEL_TO_LANG: dict[str, str] = {
    # Romanian
    'ro': 'ro', 'romanian': 'ro', 'romana': 'ro', 'română': 'ro',
    # English
    'en': 'en', 'english': 'en', 'engleza': 'en', 'engleză': 'en',
    # Spanish
    'es': 'es', 'spanish': 'es', 'espanol': 'es', 'español': 'es',
    # French
    'fr': 'fr', 'french': 'fr', 'franceza': 'fr', 'franceza': 'fr',
    # German
    'de': 'de', 'german': 'de', 'germana': 'de',
    # Italian
    'it': 'it', 'italian': 'it',
    # Portuguese
    'pt': 'pt', 'portuguese': 'pt',
}


def _extract_subs_from_url(raw_url: str) -> list[dict]:
    """Parse subtitle URLs embedded as query params in embed player URLs.
    Returns [{'url': '...', 'lang': 'ro'}, ...].
    Pairs: c1_file/c1_label, sub_file/sub_lang, cc_file/cc_lang.
    """
    if not raw_url:
        return []
    parsed = urlparse(raw_url)
    if not parsed.query:
        return []
    from urllib.parse import parse_qs
    params = parse_qs(parsed.query, keep_blank_values=True)
    results = []
    for file_key, label_key in (('c1_file', 'c1_label'), ('sub_file', 'sub_lang'), ('cc_file', 'cc_lang')):
        if file_key not in params:
            continue
        sub_url = params[file_key][0].strip()
        if not sub_url:
            continue
        label = params.get(label_key, [''])[0].lower().strip()
        lang = _LABEL_TO_LANG.get(label, label[:2] if len(label) >= 2 else '')
        if sub_url and lang:
            results.append({'url': sub_url, 'lang': lang})
    return results


def _vtt_to_srt(vtt_text: str) -> str:
    """Convert WebVTT subtitle text to SRT format."""
    text = vtt_text.replace('\r\n', '\n').replace('\r', '\n')
    # Strip WEBVTT header and any metadata blocks
    text = re.sub(r'^WEBVTT[^\n]*\n', '', text, count=1)
    text = re.sub(r'\nNOTE[^\n]*(?:\n[^\n]+)*', '', text)
    blocks = re.split(r'\n{2,}', text.strip())
    srt_parts: list[str] = []
    seq = 1
    for block in blocks:
        lines = block.strip().splitlines()
        if not lines:
            continue
        # Find the cue timing line
        ts_idx = next((i for i, l in enumerate(lines) if '-->' in l), -1)
        if ts_idx == -1:
            continue
        ts_line = lines[ts_idx]
        # Normalise MM:SS.mmm → HH:MM:SS,mmm; keep HH:MM:SS.mmm → HH:MM:SS,mmm
        def _fix_ts(m: re.Match) -> str:
            t = m.group(0)
            if t.count(':') == 1:
                t = '00:' + t
            return t.replace('.', ',')
        ts_line = re.sub(r'\d{1,2}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3}', _fix_ts, ts_line)
        # Remove WebVTT positioning tags
        ts_line = re.sub(r'\s+(?:align|line|position|size|vertical):\S+', '', ts_line).strip()
        sub_text = '\n'.join(lines[ts_idx + 1:]).strip()
        if not sub_text:
            continue
        # Strip VTT inline tags like <00:01.000> or <c.yellow>
        sub_text = re.sub(r'<[^>]+>', '', sub_text)
        srt_parts.append(f"{seq}\n{ts_line}\n{sub_text}\n")
        seq += 1
    return '\n'.join(srt_parts)


async def _download_sub_direct(
    sub_url: str,
    lang: str,
    file_base: str,
    referer: str = '',
    episode_id: int | None = None,
) -> bool:
    """Download a subtitle file (VTT or SRT) and save as {file_base}.{lang}.srt."""
    import httpx
    try:
        headers: dict[str, str] = {'User-Agent': 'Mozilla/5.0'}
        if referer:
            headers['Referer'] = referer
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(sub_url, headers=headers)
        if resp.status_code != 200:
            _log(f"[subs] HTTP {resp.status_code} for {sub_url[:80]}", episode_id)
            return False
        text = resp.text
        if 'WEBVTT' in text[:20] or sub_url.lower().endswith('.vtt'):
            text = _vtt_to_srt(text)
        out_path = Path(file_base).parent / f"{Path(file_base).name}.{lang}.srt"
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text, encoding='utf-8')
        _log(f"[subs] Saved {out_path.name}", episode_id)
        return True
    except Exception as e:
        _log(f"[subs] Download error ({lang}): {e}", episode_id)
        return False


def _output_dir(show_title: str = '', season: int = 0) -> Path:
    """Return (and create) the output directory based on current folder settings."""
    folder_per_show   = get_setting("folder_per_show",   "false") == "true"
    folder_per_season = get_setting("folder_per_season", "true")  == "true"
    if folder_per_show and show_title:
        safe_show = _sanitize_filename(show_title)
        if folder_per_season and season:
            d = DOWNLOAD_DIR / safe_show / f"Season {season}"
        else:
            d = DOWNLOAD_DIR / safe_show
    else:
        d = DOWNLOAD_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d


def _is_ts_container(path: str) -> bool:
    """Return True if the file is an MPEG-TS container (sync byte 0x47 at packet boundaries)."""
    try:
        with open(path, 'rb') as f:
            data = f.read(377)
        return (len(data) >= 377
                and data[0] == 0x47
                and data[188] == 0x47
                and data[376] == 0x47)
    except Exception:
        return False


def _maybe_rename_ts(path: str) -> str:
    """If a file is named .mp4 but is actually a MPEG-TS container, rename it to .ts."""
    if not path.endswith('.mp4'):
        return path
    if _is_ts_container(path):
        new_path = path[:-4] + '.ts'
        try:
            os.rename(path, new_path)
            return new_path
        except OSError:
            pass
    return path


def _find_output_file(file_base: str) -> tuple[Optional[str], Optional[int]]:
    """Return (path, size_bytes) of the downloaded video file at file_base.*, or (None, None).
    Excludes .part, .ytdl, and .srt files.
    """
    matches = [
        f for f in glob.glob(f"{glob.escape(file_base)}.*")
        if not any(f.endswith(x) for x in (".part", ".ytdl", ".srt"))
        and ".part-Frag" not in f
    ]
    if matches:
        p = Path(matches[0])
        try:
            return str(p), p.stat().st_size
        except OSError:
            return str(p), None
    return None, None


async def download_episode(
    episode_id: int,
    episode_title: str,
    sources: list[dict],
    progress_callback: Optional[Callable] = None,
    show_title: str = '',
    season: int = 0,
) -> bool:
    """
    Try each source in order. Returns True on first success, False if all fail.
    All SQLite calls run in a thread-pool executor so they never block the event loop.
    Each source URL is guarded by a per-CDN semaphore so the same CDN is never hit
    by more than one concurrent download (prevents CDN rate-kills).
    """
    eid = episode_id
    loop = asyncio.get_running_loop()

    async def _db(fn, *args, **kwargs):
        return await loop.run_in_executor(None, lambda: fn(*args, **kwargs))

    if not sources:
        await _db(set_episode_status, episode_id, "failed", error="No sources available")
        _log("No sources available", eid)
        return False

    # Check if cancelled before we touch the DB (cancel may arrive during source scraping)
    current = await _db(get_episode, episode_id)
    if not current or current["status"] not in ("downloading", "queued"):
        _log("Cancelled before download started — aborting", eid)
        return False

    _log(f"Download started: {episode_title!r} — {len(sources)} source(s)", eid)
    for i, src in enumerate(sources):
        _log(f"  source {i+1}: [{src.get('label','?')}] {src.get('url','')}", eid, level='debug')

    safe_title = _sanitize_filename(episode_title)
    out_dir = _output_dir(show_title, season)
    output_template = str(out_dir / f"{safe_title}.%(ext)s")
    file_base = str(out_dir / safe_title)

    await _db(set_episode_status, episode_id, "downloading", progress=0, file_base=file_base)

    start_time = datetime.now()
    attempts: list[dict] = []

    for i, source in enumerate(sources):
        # Abort if the episode was cancelled between source attempts
        current = await _db(get_episode, episode_id)
        if not current or current["status"] not in ("downloading", "queued"):
            _log("Cancelled between source attempts — aborting", eid)
            return False

        label = source.get("label", f"Source {i+1}")
        url = source.get("url", "")
        referer = source.get("referer", url)
        if not url:
            continue

        _log(f"Trying source {i+1}/{len(sources)}: {label}", eid)
        _log(f"  URL:     {url}", eid, level='debug')
        _log(f"  Referer: {referer}", eid, level='debug')

        # Acquire the per-CDN semaphore: serialises downloads from the same CDN
        # so the CDN doesn't see multiple concurrent streams from our IP and kill them.
        sem = _cdn_sem(url)
        _log(f"  CDN-sem: waiting (domain={urlparse(url).hostname})", eid, level='debug')
        global _cdn_waiting
        _cdn_waiting += 1
        if progress_callback:
            try:
                await progress_callback(episode_id, 0, "Waiting for CDN slot")
            except Exception:
                pass
        _sem_acquired = False
        try:
            async with sem:
                _cdn_waiting -= 1
                _sem_acquired = True
                _log(f"  CDN-sem: acquired", eid, level='debug')
                success, err_msg = await _run_ytdlp(
                    episode_id=episode_id,
                    url=url,
                    output_template=output_template,
                    referer=referer,
                    label=label,
                    progress_callback=progress_callback,
                )
        finally:
            if not _sem_acquired:
                _cdn_waiting -= 1

        if success:
            file_path, file_size = _find_output_file(file_base)
            if file_size is not None and file_size < _MIN_VALID_BYTES:
                _log(f"[!] File too small ({file_size} bytes) — stub or error page, skipping", eid, level='normal')
                if file_path:
                    try:
                        Path(file_path).unlink(missing_ok=True)
                    except OSError:
                        pass
                success = False
                err_msg = f"stub file ({file_size} bytes)"

        if success:
            elapsed = (datetime.now() - start_time).total_seconds()
            file_path, file_size = _find_output_file(file_base)
            if file_path:
                renamed = _maybe_rename_ts(file_path)
                if renamed != file_path:
                    _log(f"[rename] .mp4 → .ts (TS container detected)", eid)
                    file_path = renamed
                    try:
                        file_size = Path(file_path).stat().st_size
                    except OSError:
                        pass
            size_mb = f"{file_size / 1024 / 1024:.0f} MB" if file_size else "?"
            _log(f"SUCCESS via {label!r} — {size_mb} in {elapsed:.0f}s", eid)
            # Subtitle download: extract URLs from source embed params and download directly.
            # yt-dlp --write-subs is not used here because embed players store subtitle URLs
            # as query params (c1_file, sub_file, cc_file) which _clean_url() strips.
            subtitle_langs: str | None = None
            if get_setting("subtitles_enabled", "false") == "true":
                lang1 = get_setting("subtitles_lang1", "ro")
                lang2 = get_setting("subtitles_lang2", "")
                configured_langs = {lang1} | ({lang2} if lang2 else set())
                raw_source_url = source.get("embed_url") or source.get("url", "")
                sub_entries = _extract_subs_from_url(raw_source_url)
                downloaded_langs: list[str] = []
                for entry in sub_entries:
                    if entry['lang'] in configured_langs:
                        ok = await _download_sub_direct(
                            entry['url'], entry['lang'], file_base,
                            source.get("referer", raw_source_url), eid,
                        )
                        if ok:
                            downloaded_langs.append(entry['lang'])
                # Also pick up any .srt files yt-dlp may have written (fallback)
                for sf in glob.glob(f"{glob.escape(file_base)}.*.srt"):
                    stem_name = Path(sf).stem  # e.g. "Title.ro"
                    base_name = Path(file_base).name
                    if stem_name.startswith(base_name + "."):
                        lang = stem_name[len(base_name) + 1:]
                        if lang not in downloaded_langs:
                            downloaded_langs.append(lang)
                subtitle_langs = ",".join(sorted(downloaded_langs))
                _log(f"Subtitles: {subtitle_langs or 'none found'}", eid)
            await _db(
                set_episode_status,
                episode_id, "done", progress=100,
                downloaded_via=label,
                downloaded_at=datetime.utcnow().isoformat(),
                download_elapsed=elapsed,
                file_path=file_path,
                file_size=file_size,
                subtitle_langs=subtitle_langs,
            )
            # Clean up any leftover temp files and the episode log now that download succeeded
            for leftover in glob.glob(f"{glob.escape(file_base)}.*"):
                if (leftover.endswith(".part")
                        or ".part-Frag" in leftover
                        or leftover.endswith(".ytdl")):
                    try:
                        Path(leftover).unlink(missing_ok=True)
                        _log(f"[cleanup] removed temp: {Path(leftover).name}", eid, level='debug')
                    except OSError:
                        pass
            ep_log = get_episode_log_path(episode_id)
            if ep_log:
                try:
                    ep_log.unlink(missing_ok=True)
                    _log(f"[cleanup] removed episode log: {ep_log.name}", eid, level='debug')
                except OSError:
                    pass
            try:
                if progress_callback:
                    await progress_callback(episode_id, 100, "Complete")
            except Exception:
                pass
            return True
        else:
            attempts.append({"label": label, "error": err_msg})
            _log(f"Source failed: {label} — {err_msg}", eid)
            try:
                if progress_callback:
                    await progress_callback(episode_id, 0, f"Source {label} failed, trying next…")
            except Exception:
                pass

    # All sources exhausted
    _log(f"All {len(sources)} source(s) exhausted — download failed", eid)
    await _db(
        set_episode_status,
        episode_id, "failed",
        error="All sources failed",
        source_attempts=json.dumps(attempts),
    )
    try:
        if progress_callback:
            await progress_callback(episode_id, 0, "All sources failed")
    except Exception:
        pass
    return False


async def _run_ytdlp(
    episode_id: int,
    url: str,
    output_template: str,
    referer: str,
    label: str,
    progress_callback: Optional[Callable],
    _attempt: int = 1,
) -> tuple[bool, str]:
    """Run yt-dlp as a subprocess, parse progress output.
    Returns (success, error_message).
    Retries up to 3 times when the CDN returns an empty playlist (exit 0, no progress).
    """

    eid = episode_id

    # Clean up any leftover partial files from a previous interrupted attempt.
    # Covers manual stop, worker crash, and power outage — always runs before a
    # fresh yt-dlp starts so the download directory stays unambiguous.
    if _attempt == 1:   # only on first attempt, not on the "no-progress" retries
        base = output_template.replace(".%(ext)s", "")
        for leftover in glob.glob(f"{glob.escape(base)}.*"):
            if (leftover.endswith(".part")
                    or ".part-Frag" in leftover
                    or leftover.endswith(".ytdl")):
                try:
                    Path(leftover).unlink(missing_ok=True)
                    _log(f"[cleanup] removed leftover: {Path(leftover).name}", eid, level='debug')
                except OSError:
                    pass

    # Strip subtitle/player-config params that confuse yt-dlp's generic extractor
    url = _clean_url(url)

    # strcdn.org/f/ URLs are signed direct-download links, not embed pages.
    if "strcdn.org/f/" in url:
        resolved = await _follow_strcdn_redirect(url, referer, eid)
        if resolved and resolved != url:
            _log(f"[strcdn] Redirect resolved: {resolved[:120]}", eid, level='debug')
            url = resolved

    # Direct HLS/MP4 stream URLs need special flags
    is_direct_stream = ".m3u8" in url or (
        ".mp4" in url and "?" in url and "http" in url
    )

    cf = int(get_setting("concurrent_fragments", str(CONCURRENT_FRAGMENTS)))
    bandwidth_mb = float(get_setting("bandwidth_limit", "0") or "0")
    max_dl = max(1, int(get_setting("max_downloads", str(MAX_DOWNLOADS))))
    cmd = [
        sys.executable, "-m", "yt_dlp",
        url,
        "--output", output_template,
        "--force-overwrites",
        "--hls-use-mpegts",
        "--referer", referer,
        "--add-header", f"Origin:{_origin(referer)}",
        "--no-playlist",
        "--concurrent-fragments", str(cf),
        "--newline",
        "--progress-template", "download:%(progress._percent_str)s %(progress._speed_str)s %(progress._eta_str)s",
        *YTDLP_EXTRA_ARGS,
    ]
    if bandwidth_mb > 0:
        per_process_kbps = (bandwidth_mb * 1024) / max_dl
        cmd += ["--limit-rate", f"{per_process_kbps:.0f}K"]

    if is_direct_stream:
        cmd += ["--no-check-certificates"]

    _log(f"[cmd] {' '.join(cmd)}", eid, level='debug')

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,   # own process group — immune to parent SIGKILL
        )
        _active_procs[episode_id] = proc

        last_percent = 0.0
        stderr_lines: list[str] = []
        last_progress_time = datetime.now()

        loop = asyncio.get_running_loop()
        last_db_update: float = 0.0   # throttle: write DB at most once per second

        async def read_stdout():
            nonlocal last_percent, last_progress_time, last_db_update
            async for raw_line in proc.stdout:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                m = re.match(r'^\s*(\d+\.?\d*)%', line)
                if m:
                    try:
                        pct = float(m.group(1))
                        last_percent = pct
                        last_progress_time = datetime.now()
                        now = loop.time()
                        if now - last_db_update >= 1.0:
                            # Run SQLite write in thread pool — never block event loop.
                            # Use update_episode_progress (not set_episode_status) so a
                            # 'cancelling' status set by the API is never overwritten.
                            await loop.run_in_executor(
                                None,
                                lambda p=pct: update_episode_progress(episode_id, p),
                            )
                            last_db_update = now
                        if progress_callback:
                            parts = line.split()
                            speed = parts[1] if len(parts) > 1 else ""
                            eta = parts[2] if len(parts) > 2 else ""
                            await progress_callback(episode_id, pct, f"{speed} ETA {eta}")
                    except Exception as e:
                        _log(f"[!] read_stdout error (non-fatal): {e}", eid, level='debug')
                _log(f"  yt-dlp [{label}]: {line}", eid, level='debug')

        async def read_stderr():
            async for raw_line in proc.stderr:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if line:
                    stderr_lines.append(line)
                    _log(f"  yt-dlp [ERR/{label}]: {line}", eid)

        _NO_PROGRESS_TIMEOUT = 90  # seconds — kill yt-dlp if pipe hangs after SIGKILL

        async def cancel_watcher():
            """Poll DB every 2 s; kill yt-dlp if cancelled or stalled."""
            consecutive_errors = 0
            while True:
                await asyncio.sleep(2)
                # Kill if no progress for too long (e.g. pipe hung after jetsam SIGKILL)
                if (datetime.now() - last_progress_time).total_seconds() > _NO_PROGRESS_TIMEOUT:
                    if proc.returncode is None:
                        _log(f"[!] No progress for {_NO_PROGRESS_TIMEOUT}s — killing stalled yt-dlp (pid={proc.pid})", eid)
                        _kill_proc(proc, eid)
                    return
                try:
                    # Run in thread — never block the event loop on SQLite reads
                    ep = await loop.run_in_executor(None, lambda: get_episode(episode_id))
                    consecutive_errors = 0
                except Exception as e:
                    consecutive_errors += 1
                    _log(f"[!] cancel_watcher: get_episode failed ({e})", eid, level='debug')
                    if consecutive_errors >= 5:
                        _log(f"[!] cancel_watcher: 5 consecutive DB failures — killing yt-dlp (pid={proc.pid})", eid)
                        _kill_proc(proc, eid)
                        return
                    continue
                if ep and ep["status"] not in ("downloading", "queued"):
                    _log(f"Cancelled (status={ep['status']}) — stopping yt-dlp", eid)
                    _kill_proc(proc, eid)
                    return

        watcher = asyncio.create_task(cancel_watcher())
        try:
            await asyncio.gather(read_stdout(), read_stderr())
            await proc.wait()
        finally:
            watcher.cancel()
            _active_procs.pop(episode_id, None)
            # Kill yt-dlp if we're exiting due to an exception (orphan prevention)
            if proc.returncode is None:
                _log(f"[!] Killing orphaned yt-dlp (pid={proc.pid})", eid, level='debug')
                _kill_proc(proc, eid)
                try:
                    await proc.wait()
                except Exception:
                    pass

        _log(f"[exit] returncode={proc.returncode}  last_percent={last_percent:.1f}%  "
             f"stale={(datetime.now()-last_progress_time).total_seconds():.0f}s", eid, level='debug')

        if proc.returncode == 0 and last_percent < 1.0:
            hint = stderr_lines[-1] if stderr_lines else "no output (possible auth/geo block)"
            _log(f"[!] yt-dlp exited 0 with no progress (attempt {_attempt}/3): {hint}", eid)
            if _attempt < 3:
                await asyncio.sleep(2)
                return await _run_ytdlp(
                    episode_id, url, output_template, referer, label,
                    progress_callback, _attempt=_attempt + 1,
                )
            return False, hint

        if proc.returncode == 0:
            return True, ""
        else:
            # Log all stderr for diagnosis, not just the last line
            if stderr_lines:
                _log(f"[stderr/{label}] {len(stderr_lines)} line(s):", eid, level='debug')
                for l in stderr_lines[-10:]:
                    _log(f"  | {l}", eid, level='debug')
            err = stderr_lines[-1] if stderr_lines else f"yt-dlp exited {proc.returncode}"
            return False, err

    except Exception as e:
        _log(f"[!] Unexpected exception: {e}", eid)
        return False, str(e)


async def _follow_strcdn_redirect(url: str, referer: str, episode_id: int | None = None) -> str | None:
    """Follow strcdn.org/f/ redirect to get the actual CDN URL for yt-dlp."""
    import httpx
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            "Referer": referer,
        }
        async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
            resp = await client.head(url, headers=headers)
            return str(resp.url)
    except Exception as e:
        _log(f"[strcdn] Redirect follow error: {e}", episode_id)
        return None


def _origin(url: str) -> str:
    from urllib.parse import urlparse
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}"


async def download_subs_only(
    episode_id: int,
    episode_title: str,
    sources: list[dict],
    progress_callback: Optional[Callable] = None,
    show_title: str = '',
    season: int = 0,
    existing_file_path: str = '',
) -> bool:
    """Download subtitles for an episode.
    Extracts subtitle URLs from embed player query params (c1_file, sub_file, cc_file)
    and downloads them directly.  Falls back to yt-dlp --skip-download for sources
    that do not carry URL-embedded subtitle params.
    Updates subtitle_langs in DB.  Returns True if subs were found/saved.
    """
    eid = episode_id
    loop = asyncio.get_running_loop()

    async def _db(fn, *args, **kwargs):
        return await loop.run_in_executor(None, lambda: fn(*args, **kwargs))

    if not sources:
        _log("[subs] No sources available", eid)
        await _db(update_subtitle_langs, episode_id, "")
        return False

    lang1 = get_setting("subtitles_lang1", "ro")
    lang2 = get_setting("subtitles_lang2", "")
    configured_langs = {lang1} | ({lang2} if lang2 else set())
    ytdlp_langs = f"{lang1},{lang2}" if lang2 else lang1

    safe_title = _sanitize_filename(episode_title)
    # Determine output directory: next to the existing video if known, else via settings
    if existing_file_path:
        out_dir = Path(existing_file_path).parent
    else:
        out_dir = _output_dir(show_title, season)
    file_base = str(out_dir / safe_title)

    downloaded_langs: list[str] = []

    for i, source in enumerate(sources):
        raw_url = source.get("url", "")
        # embed_url preserves subtitle params that were stripped from url for yt-dlp
        embed_url = source.get("embed_url") or raw_url
        referer = source.get("referer", raw_url)
        label = source.get("label", f"Source {i+1}")
        if not raw_url:
            continue

        _log(f"[subs] Trying source {i+1}/{len(sources)}: {label}", eid)

        # Primary: extract subtitle URLs from embed player query params
        sub_entries = _extract_subs_from_url(embed_url)
        if sub_entries:
            for entry in sub_entries:
                if entry['lang'] in configured_langs:
                    # Acquire per-CDN semaphore: serialises subtitle downloads from the same
                    # CDN to avoid rate-limiting / connection kills (same guard as video downloads)
                    sub_sem = _cdn_sem(entry['url'])
                    global _cdn_waiting
                    _cdn_waiting += 1
                    if progress_callback:
                        try:
                            await progress_callback(episode_id, 0, "Waiting for CDN slot (subs)")
                        except Exception:
                            pass
                    _sem_acquired = False
                    try:
                        async with sub_sem:
                            _cdn_waiting -= 1
                            _sem_acquired = True
                            ok = await _download_sub_direct(
                                entry['url'], entry['lang'], file_base, referer, eid,
                            )
                    finally:
                        if not _sem_acquired:
                            _cdn_waiting -= 1
                    if ok and entry['lang'] not in downloaded_langs:
                        downloaded_langs.append(entry['lang'])
            if downloaded_langs:
                break  # got subs from this source — stop trying

        # Fallback: yt-dlp --skip-download (works when subtitles are embedded in the stream)
        clean_url = _clean_url(raw_url)
        output_template = str(out_dir / f"{safe_title}.%(ext)s")
        cmd = [
            sys.executable, "-m", "yt_dlp",
            clean_url,
            "--output", output_template,
            "--skip-download",
            "--write-subs",
            "--no-auto-captions",
            "--sub-langs", ytdlp_langs,
            "--convert-subs", "srt",
            "--referer", referer,
            "--add-header", f"Origin:{_origin(referer)}",
            "--no-playlist",
            "--newline",
        ]
        _log(f"[subs fallback cmd] {' '.join(cmd)}", eid, level='debug')
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
            _, stderr_data = await asyncio.wait_for(proc.communicate(), timeout=120)
        except asyncio.TimeoutError:
            try: _kill_proc(proc, eid)
            except Exception: pass
            _log(f"[subs] Source {label} timed out", eid)
            continue
        except Exception as e:
            _log(f"[subs] Source {label} error: {e}", eid)
            continue

        if proc.returncode != 0:
            stderr = stderr_data.decode("utf-8", errors="replace")
            _log(f"[subs] yt-dlp fallback failed (rc={proc.returncode}): {stderr[-200:]}", eid)
            continue

        # Pick up any .srt files yt-dlp wrote
        for sf in glob.glob(f"{glob.escape(file_base)}.*.srt"):
            stem_name = Path(sf).stem
            base_name = Path(file_base).name
            if stem_name.startswith(base_name + "."):
                lang = stem_name[len(base_name) + 1:]
                if lang not in downloaded_langs:
                    downloaded_langs.append(lang)
        if downloaded_langs:
            break

    subtitle_langs = ",".join(sorted(downloaded_langs))
    _log(f"[subs] Result: {subtitle_langs or 'none found'}", eid)
    await _db(update_subtitle_langs, episode_id, subtitle_langs)
    return bool(downloaded_langs)


async def cancel_download(episode_id: int):
    """Mark episode as pending (cancelled). Active subprocess will be orphaned — acceptable for Phase 1."""
    set_episode_status(episode_id, "pending", progress=0, error="Cancelled by user")
