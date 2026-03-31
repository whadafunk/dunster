# StreamGrabber — User Manual

StreamGrabber downloads TV show episodes from streaming sites and saves them to your local disk. You add a show by URL, it discovers all episodes automatically, and you can download them one by one or in bulk.

---

## Requirements

Three things must be running before you open the app:

| Component | How to start |
|-----------|-------------|
| Redis | `docker start streamgrabber-redis` |
| API (uvicorn) | `uvicorn main:app --port 8000` |
| Worker (arq) | `arq worker.WorkerSettings` |

The worker status indicator in the top-right corner turns green when all three are up.

---

## Adding a Show

1. Paste the show's URL into the input field in the sidebar and press **Add** (or Enter).
2. The app immediately starts scraping the show page in the background. This takes 5–30 seconds depending on the number of episodes.
3. Once scraping finishes, the show appears in the sidebar and its episode list loads automatically.

The show URL must be the series index page (not a specific episode). Example:
```
https://www.seriale-online.net/show-name/
```

---

## The Episode List

### Filter Tabs

| Tab | Shows |
|-----|-------|
| All | Every episode |
| Not started | Episodes that have never been downloaded |
| Pending | Episodes actively queued, downloading, stopping, or incomplete |
| Done | Successfully downloaded episodes |
| Failed | Episodes where all sources failed |

### Episode Badge

Each episode shows a `S01E03`-style badge (season / episode number) and its title.

### Status Dots

The coloured dot to the left of the status text tells you what is happening at a glance:

| Dot | Status | Meaning |
|-----|--------|---------|
| Grey | Not started | Never downloaded |
| Purple (pulse) | Queued | Waiting for a worker slot |
| Blue (pulse) | Downloading | yt-dlp is running |
| Yellow (pulse) | Stopping | Stop requested; process is being killed |
| Orange | Incomplete | Download was stopped before completion |
| Amber (pulse) | Waiting for CDN slot | Another download from the same CDN is already running; this one is queued behind it |
| Green | Done | File on disk |
| Red | Failed | All sources failed |

---

## Downloading Episodes

### Single Episode

1. Find the episode in the list (use the **Not started** tab to filter).
2. Optionally pick a preferred source from the dropdown next to the episode.
3. Click the **↓** button.

### Batch Download

1. Select multiple episodes using their checkboxes.
2. Use the **Select all** button in the toolbar to select everything in the current tab.
3. Click **Download selected** in the toolbar.

You can optionally pick a preferred source in the toolbar's source dropdown before clicking — this applies to all selected episodes.

### Source Selection

Each episode can have multiple video sources (VideoVard, Doodstream, Streamsb, Netu, etc.). StreamGrabber tries them in priority order and falls back to the next one automatically if a source fails.

You can set a global source priority order in **Settings → Source Priority**. Drag sources up or down to reorder. The preferred source selected per episode overrides the global order.

---

## Stopping a Download

Click the **■** (stop) button on a downloading episode.

What happens:
1. The episode immediately shows **stopping…** (yellow pulsing dot) — the stop has been registered.
2. Within ~2 seconds the worker kills the yt-dlp process.
3. The episode transitions to **incomplete** (orange dot) and stays in the **Pending** tab.

From the incomplete state you can:
- **↓** — retry the download (overwrites the partial file and starts fresh).
- **↺** — reset to "not started" and move it back to the Not started tab.

> Clicking stop twice is not necessary. If the dot shows yellow/pulsing, the stop has been received.

---

## Configuration

Open the **⚙ Setup** panel from the top-right button.

### Downloads

**Download folder** — path where video files are saved. Supports `~` for your home directory. Default: `~/Downloads/StreamGrabber`.

**Bandwidth limit** — maximum download speed in MB/s. Enter `0` or leave empty for unlimited.

### Naming Rules

**Create subfolder per season** — organises files as:
```
ShowName/
  Season 1/
    S01E01 Episode Title.ts
    S01E02 Episode Title.ts
  Season 2/
    ...
```

**Normalize filenames to lowercase** — converts the filename to all lowercase letters.

### Source Priority

Lists all CDN sources discovered across your episodes. Drag them into your preferred order — sources are tried top to bottom. Per-episode overrides always take precedence over this global order.

- **Get from episodes** — populates the list from all currently known sources.
- **Clear** — empties the list (StreamGrabber will use its built-in default priority).

### Worker Settings

These control how the background worker processes jobs. Changes take effect after restarting the worker (use the **Restart worker** button in the worker widget).

**Concurrent jobs** — how many ARQ jobs run simultaneously. This includes both downloads and scraping jobs. Range: 1–10. Default: 2.

**Concurrent downloads** — how many yt-dlp processes run in parallel. Keep this at or below Concurrent jobs. Range: 1–10. Default: 2.

**Parallel HLS segments** — how many HLS segments each individual yt-dlp download fetches at the same time. Higher values can increase speed on CDNs with per-connection caps, but use more CPU and memory. Range: 1–4. Default: 3.

> Note: "Parallel HLS segments" takes effect on the next download without restarting the worker.

---

## Worker Widget

The small widget in the top-right corner shows the worker's live state.

| Indicator | Meaning |
|-----------|---------|
| Green dot | Worker process is running |
| Red dot | Worker is not running — start it with `arq worker.WorkerSettings` |
| Green pulsing dot | Worker is running and actively processing jobs |
| Active jobs count | Number of currently executing jobs |
| Queued jobs count | Jobs waiting in Redis to be picked up |

The **Restart worker** button sends SIGTERM to the worker process. Use it after changing Concurrent jobs in Settings so the new concurrency limit takes effect.

---

## Troubleshooting

### Worker shows red even though I started it

The app detects the worker via a Redis heartbeat. It can take up to 10 seconds after starting the worker for the green dot to appear. If it stays red:
- Make sure Redis is running: `docker ps | grep streamgrabber-redis`
- Check the worker terminal for startup errors
- Refresh the page

### Episodes are stuck in "Downloading" after a restart

This happens when the worker was killed while a download was running. The next time the worker starts it automatically resets stuck episodes back to **pending**. If the worker is already running, use the **↺** reset button on the stuck episode.

### Download starts but fails immediately

Check the episode's report panel (☰ button) after the failure — it lists which sources were tried and the exact error from each one. Common causes:
- CDN geo-restriction (e.g. strcdn / cfglobalcdn is Romania-only)
- Expired embed URL — click **Rescan sources** to fetch fresh URLs
- yt-dlp extractor outdated — run `pip install -U yt-dlp` and restart the worker

### "Waiting for CDN slot" — download seems stuck

This is intentional. StreamGrabber allows only one simultaneous connection per CDN to avoid rate-limiting. If another episode is already downloading from the same CDN, subsequent episodes queue behind it. The amber pulsing dot means the slot will be acquired as soon as the current download from that CDN finishes or fails.

### Show disappeared from the sidebar

The API or worker restarted while the page was open. Refresh the page — shows are stored in the SQLite database and will reappear.

### Downloaded file plays but has no audio or wrong container

Files are saved in `.ts` (MPEG-TS) container by default. Most players (VLC, mpv, Infuse, Plex) handle `.ts` natively. If your player requires `.mp4`, remux with ffmpeg (no re-encoding, instant):
```bash
ffmpeg -i input.ts -c copy output.mp4
```
