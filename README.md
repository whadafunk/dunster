# StreamGrabber

A local web app to scrape and download video streams from aggregator sites like `seriale-online.net`.
Built with Python, FastAPI, Playwright, and yt-dlp.

---

## Quick Setup (macOS)

### 1. Prerequisites

```bash
# Install Homebrew if you don't have it
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Python 3.11+ and ffmpeg
brew install python ffmpeg
```

### 2. Create a virtual environment

```bash
cd stream-grabber
python3 -m venv venv
source venv/bin/activate
```

### 3. Install Python dependencies

```bash
pip install -r requirements.txt
```

### 4. Install Playwright's headless browser

```bash
playwright install chromium
```

### 5. Run the app

```bash
uvicorn main:app --reload --port 8000
```

Then open **http://localhost:8000** in your browser.

---

## How to use

1. **Add a show** — Paste a show page URL (e.g. `https://seriale-online.net/seriale/happy-valley-2014/`) into the sidebar and click Add. The app will scrape all episode links in the background (takes 30–60 seconds).

2. **Scan sources** — Once episodes appear, click **Scan Sources** to fetch all available stream sources for each episode (VideoVard, Doodstream, StreamSB, etc.). This runs one Playwright browser per episode so it takes a while for many episodes.

3. **Download** — Select individual episodes with checkboxes, or use **Download All**. The downloader will try each source in priority order and move on to the next if one fails.

4. **Resume** — Downloads resume automatically if interrupted. Already-downloaded episodes are tracked in `~/Downloads/StreamGrabber/downloaded.txt`.

---

## Source Priority Order

The app tries sources in this order (easiest/most reliable first):

1. VideoVard
2. Doodstream
3. StreamSB
4. Netu (last — hardest to extract)

You can change this in `config.py` → `SOURCE_PRIORITY`.

---

## Downloaded files

Files are saved to: `~/Downloads/StreamGrabber/`

---

## Troubleshooting

**"No episodes found"** — The site's HTML structure may differ. Open the show page in your browser, right-click → Inspect, and look at the episode link pattern. You may need to tweak the selectors in `scraper.py → scrape_show()`.

**yt-dlp fails on all sources** — Try running yt-dlp manually on the source URL to see the full error:
```bash
yt-dlp --verbose "https://videovard.sx/v/abc123"
```

**Playwright times out** — The site may be using Cloudflare. Try increasing `SCRAPE_TIMEOUT` in `config.py`.

**Update yt-dlp** — Streaming sites change frequently. Keep yt-dlp updated:
```bash
pip install -U yt-dlp
```
