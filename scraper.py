"""
scraper.py — Playwright-based scraper
  1. Given a show page URL, extract all episode URLs + titles
  2. Given an episode URL, extract all embedded stream source URLs

Confirmed URL patterns for seriale-online.net:
  Show page:    /seriale/{slug}-{year}/
  Episode page: /episoade/{slug}-sezonul-{N}-episodul-{N}/
"""
import re
import asyncio
import httpx
from urllib.parse import urlparse
from playwright.async_api import async_playwright, Page, BrowserContext

from config import SCRAPE_TIMEOUT, SOURCE_PRIORITY

# Matches: /episoade/anything-sezonul-2-episodul-5/
# Also matches simpler: /episoade/anything-episodul-3/  (season defaults to 1)
_SERIALE_ONLINE_EP_RE = re.compile(
    r"/episoade/[^/]+-sezonul-(\d+)-episodul-(\d+)/?$"
    r"|/episoade/[^/]+-episodul-(\d+)/?$",
    re.I,
)

# ── Helpers ────────────────────────────────────────────────────────────────────

def _source_rank(label_or_url: str) -> int:
    """Lower = higher priority."""
    s = label_or_url.lower()
    for i, key in enumerate(SOURCE_PRIORITY):
        if key in s:
            return i
    return len(SOURCE_PRIORITY)  # unknown → last


def _normalise_url(url: str, base: str) -> str:
    if url.startswith("//"):
        return "https:" + url
    if url.startswith("/"):
        p = urlparse(base)
        return f"{p.scheme}://{p.netloc}{url}"
    return url


# ── Browser helpers ────────────────────────────────────────────────────────────

async def _make_browser(playwright):
    browser = await playwright.chromium.launch(
        headless=True,
        args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
    )
    context = await browser.new_context(
        user_agent=(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/122.0.0.0 Safari/537.36"
        ),
        viewport={"width": 1280, "height": 800},
        locale="en-US",
    )
    return browser, context


# ── Show scraper ───────────────────────────────────────────────────────────────

def _parse_seriale_online_ep_url(url: str) -> tuple[int, int] | None:
    """
    Extract (season, episode) from a seriale-online.net episode URL.
    Returns None if the URL doesn't match.

    Examples:
      /episoade/happy-valley-sezonul-1-episodul-1/  → (1, 1)
      /episoade/show-name-sezonul-2-episodul-5/     → (2, 5)
      /episoade/show-name-episodul-3/               → (1, 3)
    """
    m = re.search(r"sezonul-(\d+)-episodul-(\d+)", url, re.I)
    if m:
        return int(m.group(1)), int(m.group(2))
    m = re.search(r"episodul-(\d+)", url, re.I)
    if m:
        return 1, int(m.group(1))
    return None


async def scrape_show(show_url: str) -> dict:
    """
    Returns:
        {
            "title": "Happy Valley",
            "episodes": [
                {"url": "...", "title": "S01E01 ...", "season": 1, "episode": 1},
                ...
            ]
        }
    """
    async with async_playwright() as pw:
        browser, context = await _make_browser(pw)
        try:
            page = await context.new_page()
            await page.goto(show_url, timeout=SCRAPE_TIMEOUT, wait_until="domcontentloaded")
            await page.wait_for_timeout(2000)

            # ── Page title ──
            title = await page.title()
            for suffix in [
                " – Seriale Online",
                " - Seriale Online",
                " – seriale-online.net",
                " - seriale-online.net",
                " | Watch Online",
                " | seriale online",
            ]:
                title = title.replace(suffix, "").strip()

            # ── Grab ALL links from the page ──
            all_links = await page.evaluate("""
                () => Array.from(document.querySelectorAll('a[href]')).map(a => ({
                    url: a.href,
                    text: a.textContent.trim().replace(/\\s+/g, ' '),
                }))
            """)

            episodes = []
            seen_urls = set()

            for item in all_links:
                url = item.get("url", "")
                text = item.get("text", "")

                if not url or url in seen_urls:
                    continue

                # ── Strategy 1: seriale-online.net specific URL pattern ──
                parsed = _parse_seriale_online_ep_url(url)
                if parsed:
                    season, ep_num = parsed
                    seen_urls.add(url)
                    # Build a clean title from the URL slug if text is empty/useless
                    if not text or len(text) < 3:
                        text = f"S{season:02d}E{ep_num:02d}"
                    # Truncate and clean whitespace
                    ep_title = " ".join(text.split())[:120]
                    episodes.append({
                        "url": url,
                        "title": ep_title,
                        "season": season,
                        "episode": ep_num,
                    })
                    continue

                # ── Strategy 2: Generic patterns — skip /episoade/ prefix check,
                #    just look for season+episode numbers anywhere in the URL ──
                if "/episod" in url.lower() or "/season" in url.lower() or "/sezon" in url.lower():
                    season, ep_num = 1, 0
                    m = re.search(
                        r"(?:sezon|season)[_\-](\d+)[^/]*?(?:episod|episode|ep)[_\-](\d+)",
                        url, re.I
                    )
                    if m:
                        season, ep_num = int(m.group(1)), int(m.group(2))
                    else:
                        m = re.search(r"s(\d{1,2})e(\d{1,2})", url, re.I)
                        if m:
                            season, ep_num = int(m.group(1)), int(m.group(2))
                        else:
                            m = re.search(r"(?:episod|episode)[_\-](\d+)", url, re.I)
                            if m:
                                ep_num = int(m.group(1))

                    if ep_num > 0:
                        seen_urls.add(url)
                        ep_title = " ".join(text.split())[:120] if text else f"S{season:02d}E{ep_num:02d}"
                        episodes.append({
                            "url": url,
                            "title": ep_title,
                            "season": season,
                            "episode": ep_num,
                        })

            # ── Deduplicate by (season, episode) — keep first URL seen ──
            seen_se = set()
            deduped = []
            for ep in episodes:
                key = (ep["season"], ep["episode"])
                if key not in seen_se:
                    seen_se.add(key)
                    deduped.append(ep)

            deduped.sort(key=lambda x: (x["season"], x["episode"]))

            print(f"[scraper] Show '{title}': found {len(deduped)} episode(s)")
            return {"title": title, "episodes": deduped}
        finally:
            await browser.close()


# ── Known hoster domains (used for network sniffing) ──────────────────────────

KNOWN_HOSTERS = [
    "strcdn.org",
    "videovard", "doodstream", "dood.re", "dood.la", "dood.cx", "dood.pm",
    "dood.to", "dood.so", "dood.watch",
    "streamsb", "sbplay", "sbfull", "sbchill", "sbfast", "sblongwatch",
    "cloudemb", "embedsb",
    "netu.ac", "netu.tv",
    "hydrax",
    "streamtape",
    "voe.sx",
    "upstream",
    "mixdrop",
    "filemoon",
    "mp4upload",
    "okru", "ok.ru",
    "dailymotion",
]


def _is_hoster_url(url: str) -> bool:
    u = url.lower()
    return any(h in u for h in KNOWN_HOSTERS)


# ── Episode source scraper ─────────────────────────────────────────────────────

async def scrape_episode_sources(episode_url: str, debug: bool = True) -> list[dict]:
    """
    Returns list of sources sorted by priority:
        [{"label": "VideoVard", "url": "https://..."}, ...]

    With debug=True (default), prints detailed diagnostics to the terminal
    so you can see exactly what the page contains.
    """
    async with async_playwright() as pw:
        browser, context = await _make_browser(pw)
        try:
            page = await context.new_page()

            # ── Capture ALL outgoing requests ──────────────────────────────────
            all_requests: list[dict] = []

            def handle_request(request):
                all_requests.append({
                    "url": request.url,
                    "type": request.resource_type,
                })

            page.on("request", handle_request)

            print(f"\n[scraper] Loading episode: {episode_url}")
            await page.goto(episode_url, timeout=SCRAPE_TIMEOUT, wait_until="domcontentloaded")

            # Wait for JS to settle — some players inject iframes after DOMContentLoaded
            await page.wait_for_timeout(4000)

            # ── Dump page structure diagnostics ───────────────────────────────
            if debug:
                diag = await page.evaluate("""
                    () => {
                        // All iframes
                        const iframes = Array.from(document.querySelectorAll('iframe')).map(f => ({
                            src: f.src,
                            dataSrc: f.getAttribute('data-src'),
                            id: f.id,
                            className: f.className,
                        }));

                        // All elements with data-* attributes that look player-related
                        const dataEls = Array.from(document.querySelectorAll('[data-src],[data-url],[data-embed],[data-server],[data-host],[data-link],[data-file]')).map(el => ({
                            tag: el.tagName,
                            dataSrc: el.getAttribute('data-src'),
                            dataUrl: el.getAttribute('data-url'),
                            dataEmbed: el.getAttribute('data-embed'),
                            dataServer: el.getAttribute('data-server'),
                            dataHost: el.getAttribute('data-host'),
                            dataLink: el.getAttribute('data-link'),
                            dataFile: el.getAttribute('data-file'),
                            id: el.id,
                            className: el.className.substring(0, 80),
                        }));

                        // All <script> tags that contain embed-like URLs
                        const scripts = Array.from(document.querySelectorAll('script:not([src])')).map(s => s.textContent || '').filter(t =>
                            t.includes('iframe') || t.includes('embed') || t.includes('player') ||
                            t.includes('videovard') || t.includes('dood') || t.includes('netu') ||
                            t.includes('streamsb') || t.includes('streamtape') || t.includes('source')
                        ).map(t => t.substring(0, 500));

                        // All clickable elements that look like player tabs/buttons
                        const buttons = Array.from(document.querySelectorAll('li, button, [class*="player"], [class*="server"], [class*="source"], [class*="host"], [class*="tab"]')).filter(el => {
                            const text = el.textContent.trim();
                            return text.length > 0 && text.length < 50 && !el.querySelector('ul');
                        }).slice(0, 30).map(el => ({
                            tag: el.tagName,
                            text: el.textContent.trim(),
                            className: el.className.substring(0, 80),
                            dataAttrs: el.getAttributeNames().filter(a => a.startsWith('data-')).map(a => `${a}="${el.getAttribute(a)}"`).join(' '),
                        }));

                        return { iframes, dataEls, scripts, buttons };
                    }
                """)

                print(f"\n{'='*60}")
                print(f"DIAGNOSTIC: {episode_url}")
                print(f"{'='*60}")

                print(f"\n── IFRAMES ({len(diag['iframes'])}) ──")
                for f in diag['iframes']:
                    print(f"  src={f['src']!r}  data-src={f['dataSrc']!r}  class={f['className']!r}")

                print(f"\n── DATA-* ELEMENTS ({len(diag['dataEls'])}) ──")
                for el in diag['dataEls']:
                    attrs = {k: v for k, v in el.items() if v and k not in ('tag', 'id', 'className')}
                    print(f"  <{el['tag']} id={el['id']!r} class={el['className']!r} {attrs}>")

                print(f"\n── PLAYER-LIKE BUTTONS/TABS ({len(diag['buttons'])}) ──")
                for b in diag['buttons']:
                    print(f"  <{b['tag']} class={b['className']!r} {b['dataAttrs']}> {b['text']!r}")

                print(f"\n── INLINE SCRIPTS mentioning player/embed ({len(diag['scripts'])}) ──")
                for i, s in enumerate(diag['scripts'][:5]):
                    print(f"  Script {i+1}: {s[:300]!r}")

                hoster_requests = [r for r in all_requests if _is_hoster_url(r['url'])]
                print(f"\n── NETWORK REQUESTS to known hosters ({len(hoster_requests)}) ──")
                for r in hoster_requests:
                    print(f"  [{r['type']}] {r['url']}")

                print(f"\n── ALL NETWORK REQUESTS ({len(all_requests)} total, showing document/xhr/fetch) ──")
                for r in all_requests:
                    if r['type'] in ('document', 'xhr', 'fetch'):
                        print(f"  [{r['type']}] {r['url']}")

                print(f"{'='*60}\n")

            # ── Now actually extract sources ───────────────────────────────────
            sources = []

            # ── Step 1: collect all first-hop iframe URLs from the episode page ──
            # On seriale-online.net the active source is in iframe[src], but ALL sources
            # (Netu, VideoVard, Doodstream, Streamsb, …) are in data-vs attributes on
            # li.dooplay_player_option elements. Collect both.
            first_hop_iframes = await page.evaluate("""
                () => {
                    const results = [];
                    const seen = new Set();
                    const add = (url) => {
                        if (url && url.startsWith('http') && !seen.has(url)) {
                            seen.add(url);
                            results.push(url);
                        }
                    };
                    // Active iframe
                    document.querySelectorAll('iframe').forEach(f => {
                        add(f.src || f.getAttribute('data-src') || f.getAttribute('data-lazy-src') || '');
                    });
                    // All player-option tabs via data-vs (the other sources)
                    document.querySelectorAll('[data-vs]').forEach(el => {
                        add(el.getAttribute('data-vs') || '');
                    });
                    return results;
                }
            """)

            if debug:
                print(f"\n[scraper] First-hop iframes: {first_hop_iframes}")

            # ── Step 2: also check if there are player tab buttons that swap the iframe ──
            # (some episodes have multiple sources shown as tabs)
            tab_selectors = [
                "[class*='player-btn']", "[class*='source-btn']", "[class*='server-btn']",
                "[class*='host-btn']", "[class*='host-item']", "[class*='server-item']",
                "[data-server]", "[data-source]", "[data-host]", "[data-link]", "[data-embed]",
                ".player-tabs li", ".sources li", "ul.servers li", ".hostList li",
                ".tablinks", "[class*='tab-link']", "[class*='sourceBtn']",
            ]
            tab_buttons = await page.query_selector_all(", ".join(tab_selectors))

            if debug:
                print(f"[scraper] Found {len(tab_buttons)} potential tab/button elements")

            for btn in tab_buttons:
                try:
                    await btn.click()
                    await page.wait_for_timeout(1200)
                except Exception:
                    continue

                new_iframe = await page.evaluate("""
                    () => {
                        for (const f of document.querySelectorAll('iframe')) {
                            const src = f.src || f.getAttribute('data-src') || '';
                            if (src && src.startsWith('http')) return src;
                        }
                        return null;
                    }
                """)
                if new_iframe and new_iframe not in first_hop_iframes:
                    first_hop_iframes.append(new_iframe)

            # Also add anything from network intercept at the document level
            for req in all_requests:
                url = req["url"]
                if req["type"] == "document" and (
                    "database.seriale-online.net/iframe" in url or
                    _is_hoster_url(url)
                ):
                    if url not in first_hop_iframes:
                        first_hop_iframes.append(url)

            if debug:
                print(f"[scraper] All first-hop URLs to follow: {first_hop_iframes}")

            # ── Step 3: resolve each first-hop URL to the real hoster ─────────────
            # database.seriale-online.net/iframe/{token} URLs follow HTTP redirects
            # directly to the final embed (strcdn, f16px, myvidplay, vidload, etc.).
            # We use httpx (not Playwright) so bot-detection on embed pages doesn't
            # interfere with redirect-following.
            for hop_url in first_hop_iframes:
                # Already-resolved strcdn embed — use httpx resolver
                if "strcdn.org/e/" in hop_url:
                    print(f"[scraper] Resolving strcdn: {hop_url}")
                    stream_url = await _resolve_strcdn(context, hop_url)
                    if stream_url and not any(s["url"] == stream_url for s in sources):
                        sources.append({"label": "VideoVard", "url": stream_url, "referer": "https://strcdn.org/"})
                        print(f"[scraper] ✓ strcdn stream: {stream_url[:80]}")
                    elif not stream_url:
                        if not any(s["url"] == hop_url for s in sources):
                            sources.append({"label": "VideoVard", "url": hop_url})
                    continue

                # Skip strcdn internal player pages
                if "embed_player.php" in hop_url:
                    continue

                # For database.seriale-online.net proxy URLs, follow HTTP redirects with
                # httpx to discover the real embed URL (no Playwright needed).
                if "database.seriale-online.net/iframe/" in hop_url:
                    print(f"[scraper] Following hop: {hop_url[:80]}")
                    final_url = await _follow_redirect(hop_url)
                    if not final_url:
                        continue
                    print(f"[scraper] → {final_url[:80]}")

                    if "strcdn.org/e/" in final_url:
                        stream_url = await _resolve_strcdn(context, final_url)
                        if stream_url and not any(s["url"] == stream_url for s in sources):
                            sources.append({"label": "VideoVard", "url": stream_url, "referer": "https://strcdn.org/"})
                            print(f"[scraper] ✓ strcdn stream: {stream_url[:80]}")
                        elif not stream_url and not any(s["url"] == final_url for s in sources):
                            sources.append({"label": "VideoVard", "url": final_url})
                        continue

                    if "f16px.com/e/" in final_url:
                        stream_url = await _resolve_f16px(context, final_url)
                        if stream_url and not any(s["url"] == stream_url for s in sources):
                            sources.append({"label": "VideoVard (f16px)", "url": stream_url, "referer": "https://f16px.com/"})
                            print(f"[scraper] ✓ f16px stream: {stream_url[:80]}")
                        elif not stream_url and not any(s["url"] == final_url for s in sources):
                            sources.append({"label": "f16px.com", "url": final_url})
                        continue

                    # Any other embed URL — add directly; yt-dlp handles the extraction
                    if "embed_player.php" not in final_url and not any(s["url"] == final_url for s in sources):
                        label = _guess_label(final_url)
                        sources.append({"label": label, "url": final_url})
                        print(f"[scraper] ✓ source: [{label}] {final_url[:80]}")
                    continue

                # Direct hoster URL (already resolved, e.g. from network intercept)
                if _is_hoster_url(hop_url) and "embed_player.php" not in hop_url:
                    label = _guess_label(hop_url)
                    if not any(s["url"] == hop_url for s in sources):
                        sources.append({"label": label, "url": hop_url})

            # ── Sort by priority, then deduplicate by label (keep best per label) ──
            sources.sort(key=lambda s: _source_rank(s["label"] + " " + s["url"]))
            seen_labels: set[str] = set()
            deduped = []
            for s in sources:
                if s["label"] not in seen_labels:
                    seen_labels.add(s["label"])
                    deduped.append(s)
            sources = deduped

            print(f"[scraper] Episode sources found: {len(sources)}")
            for i, s in enumerate(sources):
                print(f"  {i+1}. [{s['label']}] {s['url']}")

            return sources
        finally:
            await browser.close()


async def _resolve_strcdn(_context, strcdn_url: str) -> str | None:
    """
    strcdn.org / VideoVard — the signed HLS m3u8 stream URL is embedded directly
    in the server-rendered HTML (no click needed, no browser required).
    We fetch it with a plain HTTP request, then extract the m3u8 with a regex.

    The `secip`-signed CDN URL is IP-locked to the requesting machine.
    The static m3u8 in the HTML has an old IP baked in; the `ws` token contains
    fresh signing params (current IP + timestamp). We re-sign the URL before
    returning so the CDN accepts it.
    """
    from urllib.parse import parse_qsl

    # Strip fragment (#iss=... appended by some redirects)
    base_url = strcdn_url.split("#")[0]

    req_headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/122.0.0.0 Safari/537.36"
        ),
        "Referer": "https://seriale-online.net/",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }

    print(f"[strcdn] Fetching: {base_url[:80]}")
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=20) as client:
            resp = await client.get(base_url, headers=req_headers)
            html = resp.text
    except Exception as e:
        print(f"[strcdn] HTTP error: {e}")
        return None

    # ── Parse ws token — contains fresh IP + timestamp for this request ──────
    ws_match = re.search(r"var\s+ws\s*=\s*'([^']+)'", html)
    ws_params = {}
    if ws_match:
        ws_params = dict(parse_qsl(ws_match.group(1).lstrip("?")))

    # ── Primary: m3u8 URL in server-rendered HTML, re-signed with ws token ───
    # The static URL has an old IP baked in; replace the secip signing segment
    # with fresh md5/ip/time from the ws token so the CDN accepts it.
    for m3u8_url in re.findall(r'https?://[^\s\'"<>]+\.m3u8[^\s\'"<>]*', html):
        if any(x in m3u8_url.lower() for x in ["ads", "analytics", "tracker"]):
            continue
        if ws_params.get("md5") and ws_params.get("ip") and ws_params.get("time"):
            fresh = re.sub(
                r"/secip/1/[^/]+/[^/]+/[^/]+/",
                f'/secip/1/{ws_params["md5"]}/{ws_params["ip"]}/{ws_params["time"]}/',
                m3u8_url,
            )
            print(f"[strcdn] ✓ m3u8 (fresh-signed): {fresh[:120]}")
            return fresh
        # No ws token available — return static URL as-is (may fail if IP changed)
        print(f"[strcdn] ✓ m3u8 (static): {m3u8_url[:120]}")
        return m3u8_url

    # ── Secondary: ws token + file code → strcdn direct download URL ─────────
    code_match = re.search(r'strcdn\.org/[ef]/([A-Za-z0-9]+)', html)
    if ws_match and code_match:
        dl_url = f"https://strcdn.org/f/{code_match.group(1)}{ws_match.group(1)}"
        print(f"[strcdn] Fallback: {dl_url[:120]}")
        return dl_url

    print(f"[strcdn] ✗ No stream URL found")
    return None


async def _resolve_f16px(context, f16px_url: str) -> str | None:
    """
    f16px.com / VideoVard — uses a challenge/attest API that encrypts the CDN URL.
    We use Playwright to load the embed page and intercept the master.m3u8 request.
    The CDN (r66nv9ed.com / SprintCDN) is accessible where cfglobalcdn.com is not.
    """
    m3u8_found: list[str] = []

    page = await context.new_page()
    try:
        def on_req(req):
            url = req.url
            if "master.m3u8" in url or (".m3u8" in url and "sprintcdn" in url.lower()):
                m3u8_found.append(url)

        page.on("request", on_req)

        try:
            await page.goto(f16px_url, timeout=SCRAPE_TIMEOUT, wait_until="domcontentloaded")
            # Wait for the challenge/attest/playback API calls to complete
            await page.wait_for_timeout(6000)
        except Exception as e:
            print(f"[f16px] page load error: {e}")

        if m3u8_found:
            url = m3u8_found[0]
            print(f"[f16px] ✓ m3u8: {url[:100]}")
            return url

        print("[f16px] ✗ no m3u8 captured")
        return None
    finally:
        await page.close()


async def _follow_redirect(url: str) -> str | None:
    """Follow HTTP redirects (and JS/meta redirects) and return the final URL."""
    req_headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/122.0.0.0 Safari/537.36"
        ),
        "Referer": "https://seriale-online.net/",
    }
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
            resp = await client.get(url, headers=req_headers)
            final = str(resp.url)

            # If HTTP redirects landed back on the same proxy domain, the server
            # may be using a JS/meta redirect — parse the HTML for the real URL.
            if "database.seriale-online.net" in final or "seriale-online.net" in final:
                html = resp.text
                # window.location / location.href / location.replace patterns
                js_match = re.search(
                    r'(?:window\.location|location\.href|location\.replace\()\s*[=\(]\s*["\']([^"\']+)["\']',
                    html
                )
                if js_match:
                    return js_match.group(1)
                # <meta http-equiv="refresh" content="0;url=...">
                meta_match = re.search(
                    r'<meta[^>]+http-equiv=["\']refresh["\'][^>]+content=["\'][^;]*;\s*url=([^"\'>\s]+)',
                    html, re.IGNORECASE
                )
                if meta_match:
                    return meta_match.group(1)

            return final
    except Exception as e:
        print(f"[scraper] Redirect follow error: {e}")
        return None


def _guess_label(url: str) -> str:
    known = {
        "strcdn.org": "VideoVard",
        "videovard": "VideoVard",
        "doodstream": "Doodstream",
        "dood.re": "Doodstream",
        "dood.la": "Doodstream",
        "dood.cx": "Doodstream",
        "streamsb": "StreamSB",
        "sbplay": "StreamSB",
        "sbfull": "StreamSB",
        "netu.ac": "Netu",
        "netu.tv": "Netu",
        "hydrax": "Hydrax",
        "streamtape": "Streamtape",
        "voe.sx": "Voe",
        "mixdrop": "Mixdrop",
        "filemoon": "Filemoon",
        "mp4upload": "Mp4Upload",
        "ok.ru": "OK.ru",
        "dailymotion": "Dailymotion",
    }
    u = url.lower()
    for key, label in known.items():
        if key in u:
            return label
    # Fallback: use domain
    try:
        return urlparse(url).netloc.replace("www.", "")
    except Exception:
        return "Unknown"
