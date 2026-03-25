"""
config.py — App-wide settings
"""
from pathlib import Path

# Where downloaded files are saved
DOWNLOAD_DIR = Path.home() / "Downloads" / "StreamGrabber"

# Source priority order — tried left-to-right; first success wins.
# The actual embed hosts on seriale-online.net are: f16px.com (VideoVard),
# myvidplay.com (Doodstream), vidload.co (Streamsb), strcdn/cfglobalcdn (Netu).
# Put the yt-dlp-friendly embeds first; strcdn/cfglobalcdn last (CDN routing issues).
SOURCE_PRIORITY = [
    "f16px",        # VideoVard embed (seriale-online.net "VideoVard" tab)
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
    "strcdn",       # Last: CDN (cfglobalcdn.com) has routing issues on some ISPs
]

# Max concurrent downloads
MAX_CONCURRENT = 2

# Playwright timeout (ms)
SCRAPE_TIMEOUT = 30_000

# yt-dlp extra options
YTDLP_EXTRA_ARGS = [
    "--no-warnings",
    "--retries", "5",
    "--fragment-retries", "5",
]

# Ensure download dir exists
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
