"""
downloader.py — yt-dlp wrapper with:
  - Source priority fallback
  - Resume support (--continue + archive file)
  - Progress reporting via callback
"""
import asyncio
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

from config import DOWNLOAD_DIR, YTDLP_EXTRA_ARGS
from database import set_episode_status

ARCHIVE_FILE = DOWNLOAD_DIR / "downloaded.txt"
DEBUG_LOG = DOWNLOAD_DIR / "debug.log"


def _log(msg: str):
    """Append a timestamped line to the debug log AND print to console."""
    ts = datetime.now().strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    try:
        with open(DEBUG_LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def _sanitize_filename(name: str) -> str:
    return re.sub(r'[\\/*?:"<>|]', "_", name).strip()


async def download_episode(
    episode_id: int,
    episode_title: str,
    sources: list[dict],
    progress_callback: Optional[Callable] = None,
) -> bool:
    """
    Try each source in order. Returns True on first success, False if all fail.
    """
    if not sources:
        set_episode_status(episode_id, "failed", error="No sources available")
        return False

    safe_title = _sanitize_filename(episode_title)
    output_template = str(DOWNLOAD_DIR / f"{safe_title}.%(ext)s")

    set_episode_status(episode_id, "downloading", progress=0)

    for i, source in enumerate(sources):
        label = source.get("label", f"Source {i+1}")
        url = source.get("url", "")
        referer = source.get("referer", url)   # use explicit referer if set
        if not url:
            continue

        _log(f"  [→] Trying source {i+1}/{len(sources)}: {label}")
        _log(f"      URL:     {url}")
        _log(f"      Referer: {referer}")

        success = await _run_ytdlp(
            episode_id=episode_id,
            url=url,
            output_template=output_template,
            referer=referer,
            label=label,
            progress_callback=progress_callback,
        )

        if success:
            return True
        else:
            _log(f"  [✗] Source failed: {label}")
            if progress_callback:
                await progress_callback(episode_id, 0, f"Source {label} failed, trying next…")

    # All sources exhausted
    set_episode_status(episode_id, "failed", error="All sources failed")
    if progress_callback:
        await progress_callback(episode_id, 0, "All sources failed")
    return False


async def _run_ytdlp(
    episode_id: int,
    url: str,
    output_template: str,
    referer: str,
    label: str,
    progress_callback: Optional[Callable],
) -> bool:
    """Run yt-dlp as a subprocess, parse progress output, return True on success."""

    # Direct HLS/MP4 stream URLs (resolved by Playwright click) need special flags
    is_direct_stream = ".m3u8" in url or (
        ".mp4" in url and "?" in url and "http" in url
    )

    cmd = [
        sys.executable, "-m", "yt_dlp",
        url,
        "--output", output_template,
        "--continue",
        "--download-archive", str(ARCHIVE_FILE),
        "--referer", referer,
        "--add-header", f"Origin:{_origin(referer)}",
        "--no-playlist",
        "--merge-output-format", "mp4",
        "--newline",
        "--progress-template", "download:%(progress._percent_str)s %(progress._speed_str)s %(progress._eta_str)s",
        *YTDLP_EXTRA_ARGS,
    ]

    # For direct HLS streams, force the generic extractor and HLS downloader
    if is_direct_stream:
        cmd += [
            "--no-check-certificates",
            "--hls-prefer-native",
        ]

    _log(f"  [cmd] {' '.join(cmd)}")

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        last_percent = 0.0

        async def read_stdout():
            nonlocal last_percent
            async for raw_line in proc.stdout:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line:
                    continue

                if line.startswith("download:"):
                    parts = line.split()
                    pct_str = parts[1] if len(parts) > 1 else ""
                    try:
                        pct = float(pct_str.replace("%", ""))
                        last_percent = pct
                        set_episode_status(episode_id, "downloading", progress=pct)
                        if progress_callback:
                            speed = parts[2] if len(parts) > 2 else ""
                            eta = parts[3] if len(parts) > 3 else ""
                            await progress_callback(episode_id, pct, f"{speed} ETA {eta}")
                    except (ValueError, IndexError):
                        pass
                elif "[download]" in line and "has already been recorded" in line:
                    set_episode_status(episode_id, "done", progress=100)
                    if progress_callback:
                        await progress_callback(episode_id, 100, "Already downloaded (skipped)")
                    return

                _log(f"    yt-dlp [{label}]: {line}")

        async def read_stderr():
            async for raw_line in proc.stderr:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if line:
                    _log(f"    yt-dlp [ERR/{label}]: {line}")

        await asyncio.gather(read_stdout(), read_stderr())
        await proc.wait()

        _log(f"  [exit] yt-dlp returncode={proc.returncode}")
        if proc.returncode == 0:
            set_episode_status(episode_id, "done", progress=100)
            if progress_callback:
                await progress_callback(episode_id, 100, "Complete")
            return True
        else:
            return False

    except Exception as e:
        _log(f"    yt-dlp exception: {e}")
        return False


def _origin(url: str) -> str:
    from urllib.parse import urlparse
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}"


async def cancel_download(episode_id: int):
    """Mark episode as pending (cancelled). Active subprocess will be orphaned — acceptable for Phase 1."""
    set_episode_status(episode_id, "pending", progress=0, error="Cancelled by user")
