"""
database.py — SQLite state tracking for episodes and downloads
"""
import os
import sqlite3
import json
from contextlib import contextmanager
from pathlib import Path
from datetime import datetime
from typing import Optional

DB_PATH = Path(os.getenv("DB_PATH", str(Path(__file__).parent / "downloads.db")))


@contextmanager
def get_conn():
    """Open a SQLite connection, yield it, then always close it.
    Using sqlite3.Connection as a context manager only manages transactions —
    it does NOT close the connection. This wrapper guarantees the connection
    is closed so file descriptors don't accumulate in long-running processes.
    """
    import time
    conn = None
    for attempt in range(5):
        try:
            conn = sqlite3.connect(DB_PATH, timeout=30)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA busy_timeout=10000")
            break
        except sqlite3.OperationalError as e:
            if "unable to open" in str(e) and attempt < 4:
                time.sleep(0.1 * (attempt + 1))
                continue
            raise
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    with get_conn() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS folders (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL,
                is_system  INTEGER NOT NULL DEFAULT 0,
                sort_order INTEGER NOT NULL DEFAULT 0
            );
            INSERT OR IGNORE INTO folders (id, name, is_system, sort_order) VALUES (1, 'Archived', 1, 0);

            CREATE TABLE IF NOT EXISTS shows (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                url         TEXT UNIQUE NOT NULL,
                title       TEXT,
                scraped_at  TEXT
            );

            CREATE TABLE IF NOT EXISTS episodes (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                show_id     INTEGER REFERENCES shows(id),
                url         TEXT UNIQUE NOT NULL,
                title       TEXT,
                season      INTEGER,
                episode     INTEGER,
                sources     TEXT,   -- JSON list of {key, label, url}
                status           TEXT DEFAULT 'pending',
                progress         REAL DEFAULT 0,
                file_path        TEXT,
                file_size        INTEGER,
                error            TEXT,
                source_attempts  TEXT,   -- JSON [{label, error}]
                downloaded_via   TEXT,
                downloaded_at    TEXT,
                download_elapsed REAL,
                added_at         TEXT,
                updated_at       TEXT,
                scanned_at       TEXT,
                file_base        TEXT
            );
        """)
        # Migrate existing DB: add new columns if they don't exist yet
        for col_def in [
            "ALTER TABLE episodes ADD COLUMN scanned_at       TEXT",
            "ALTER TABLE episodes ADD COLUMN file_size        INTEGER",
            "ALTER TABLE episodes ADD COLUMN source_attempts  TEXT",
            "ALTER TABLE episodes ADD COLUMN downloaded_via   TEXT",
            "ALTER TABLE episodes ADD COLUMN downloaded_at    TEXT",
            "ALTER TABLE episodes ADD COLUMN download_elapsed REAL",
            "ALTER TABLE episodes ADD COLUMN file_base        TEXT",
            "ALTER TABLE episodes ADD COLUMN subtitle_langs   TEXT",
            "ALTER TABLE episodes ADD COLUMN subtitle_status  TEXT",
        ]:
            try:
                conn.execute(col_def)
            except Exception:
                pass  # Column already exists
        for col_def in [
            "ALTER TABLE shows ADD COLUMN folder_id  INTEGER REFERENCES folders(id) ON DELETE SET NULL",
            "ALTER TABLE shows ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
        ]:
            try:
                conn.execute(col_def)
            except Exception:
                pass
        # Normalize: set sort_order = id for any shows where sort_order is still 0
        conn.execute("UPDATE shows SET sort_order = id WHERE sort_order = 0")


# ── Shows ──────────────────────────────────────────────────────────────────────

def upsert_show(url: str, title: str) -> int:
    with get_conn() as conn:
        now = datetime.utcnow().isoformat()
        conn.execute(
            "INSERT INTO shows (url, title, scraped_at) VALUES (?,?,?) "
            "ON CONFLICT(url) DO UPDATE SET title=excluded.title, scraped_at=excluded.scraped_at",
            (url, title, now)
        )
        row = conn.execute("SELECT id FROM shows WHERE url=?", (url,)).fetchone()
        show_id = row["id"]
        conn.execute(
            "UPDATE shows SET sort_order=? WHERE id=? AND sort_order=0",
            (show_id, show_id)
        )
        return show_id


def get_show(url: str) -> Optional[dict]:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM shows WHERE url=?", (url,)).fetchone()
        return dict(row) if row else None


def get_show_by_id(show_id: int) -> Optional[dict]:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM shows WHERE id=?", (show_id,)).fetchone()
        return dict(row) if row else None


# ── Episodes ───────────────────────────────────────────────────────────────────

def upsert_episode(show_id: int, url: str, title: str,
                   season: int, episode: int, sources: list) -> int:
    with get_conn() as conn:
        now = datetime.utcnow().isoformat()
        sources_json = json.dumps(sources)
        # Only insert if not exists; don't overwrite status/progress of existing rows
        conn.execute(
            "INSERT INTO episodes (show_id, url, title, season, episode, sources, status, added_at, updated_at) "
            "VALUES (?,?,?,?,?,?,'pending',?,?) "
            "ON CONFLICT(url) DO UPDATE SET title=excluded.title, sources=excluded.sources, updated_at=excluded.updated_at",
            (show_id, url, title, season, episode, sources_json, now, now)
        )
        row = conn.execute("SELECT id FROM episodes WHERE url=?", (url,)).fetchone()
        return row["id"]


def get_episodes(show_id: int) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM episodes WHERE show_id=? ORDER BY season, episode", (show_id,)
        ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["sources"] = json.loads(d["sources"] or "[]")
            d["source_attempts"] = json.loads(d["source_attempts"] or "[]")
            result.append(d)
        return result


def get_episode(episode_id: int) -> Optional[dict]:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM episodes WHERE id=?", (episode_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        d["sources"] = json.loads(d["sources"] or "[]")
        d["source_attempts"] = json.loads(d["source_attempts"] or "[]")
        return d


def set_episode_status(
    episode_id: int,
    status: str,
    progress: float = None,
    file_path: str = None,
    error: str = None,
    file_size: int = None,
    source_attempts: str = None,   # JSON string
    downloaded_via: str = None,
    downloaded_at: str = None,
    download_elapsed: float = None,
    file_base: str = None,
    subtitle_langs: str = None,    # comma-separated lang codes, "" = attempted but none found
):
    now = datetime.utcnow().isoformat()
    fields = ["status=?", "updated_at=?"]
    values = [status, now]
    if progress is not None:
        fields.append("progress=?")
        values.append(progress)
    if file_path is not None:
        fields.append("file_path=?")
        values.append(file_path)
    if file_size is not None:
        fields.append("file_size=?")
        values.append(file_size)
    if source_attempts is not None:
        fields.append("source_attempts=?")
        values.append(source_attempts)
    if downloaded_via is not None:
        fields.append("downloaded_via=?")
        values.append(downloaded_via)
    if downloaded_at is not None:
        fields.append("downloaded_at=?")
        values.append(downloaded_at)
    if download_elapsed is not None:
        fields.append("download_elapsed=?")
        values.append(download_elapsed)
    if file_base is not None:
        fields.append("file_base=?")
        values.append(file_base)
    if subtitle_langs is not None:
        fields.append("subtitle_langs=?")
        values.append(subtitle_langs)
    # Always update error — None becomes SQL NULL, clearing stale errors on reset
    fields.append("error=?")
    values.append(error)
    values.append(episode_id)
    with get_conn() as conn:
        conn.execute(f"UPDATE episodes SET {', '.join(fields)} WHERE id=?", values)


def flush_queued_episodes() -> int:
    """Reset all queued (not yet started by worker) episodes back to pending.
    Returns the number of episodes reset.
    """
    now = datetime.utcnow().isoformat()
    with get_conn() as conn:
        cur = conn.execute(
            "UPDATE episodes SET status='pending', progress=0, error=NULL, updated_at=? WHERE status='queued'",
            (now,),
        )
        return cur.rowcount


def delete_episodes(episode_ids: list[int]) -> int:
    """Delete episode records (skip any that are actively queued/downloading).
    Returns the number of rows deleted.
    """
    if not episode_ids:
        return 0
    placeholders = ','.join('?' * len(episode_ids))
    with get_conn() as conn:
        cur = conn.execute(
            f"DELETE FROM episodes WHERE id IN ({placeholders})"
            f" AND status NOT IN ('queued','downloading','cancelling')",
            episode_ids,
        )
        return cur.rowcount


def set_show_episodes_sources(show_id: int, sources: list) -> int:
    """Overwrite sources (and scanned_at) for every episode in a show.
    Used to propagate probe-scanned sources to all episodes at once.
    Returns the number of rows updated.
    """
    now = datetime.utcnow().isoformat()
    sources_json = json.dumps(sources)
    with get_conn() as conn:
        cur = conn.execute(
            "UPDATE episodes SET sources=?, scanned_at=? WHERE show_id=?",
            (sources_json, now, show_id),
        )
        return cur.rowcount


def update_subtitle_langs(episode_id: int, subtitle_langs: str) -> None:
    """Update only subtitle_langs without touching status or other fields."""
    now = datetime.utcnow().isoformat()
    with get_conn() as conn:
        conn.execute(
            "UPDATE episodes SET subtitle_langs=?, updated_at=? WHERE id=?",
            (subtitle_langs, now, episode_id),
        )


def set_subtitle_status(episode_id: int, status: Optional[str]) -> None:
    """Set subtitle_status (pending / done / failed / None) without touching other fields."""
    now = datetime.utcnow().isoformat()
    with get_conn() as conn:
        conn.execute(
            "UPDATE episodes SET subtitle_status=?, updated_at=? WHERE id=?",
            (status, now, episode_id),
        )


def update_episode_progress(episode_id: int, progress: float) -> None:
    """Update progress without touching status.
    The WHERE guard ensures this is a no-op if the episode has been cancelled
    or otherwise moved out of an active download state, preventing a race where
    a late-arriving progress write from read_stdout overwrites a 'cancelling' status.
    """
    now = datetime.utcnow().isoformat()
    with get_conn() as conn:
        conn.execute(
            "UPDATE episodes SET progress=?, updated_at=? WHERE id=? AND status IN ('downloading', 'queued')",
            (progress, now, episode_id),
        )


def reset_episode_to_pending(episode_id: int, clear_download_data: bool = False):
    """Reset episode to pending.
    If clear_download_data=True, also wipes all download-related fields
    (file_path, file_size, downloaded_via, downloaded_at, download_elapsed, source_attempts).
    """
    now = datetime.utcnow().isoformat()
    with get_conn() as conn:
        if clear_download_data:
            conn.execute(
                """UPDATE episodes SET
                       status='pending', progress=0, error=NULL,
                       file_path=NULL, file_size=NULL, file_base=NULL,
                       downloaded_via=NULL, downloaded_at=NULL,
                       download_elapsed=NULL, source_attempts='[]',
                       subtitle_langs=NULL, subtitle_status=NULL,
                       updated_at=?
                   WHERE id=?""",
                (now, episode_id),
            )
        else:
            conn.execute(
                "UPDATE episodes SET status='pending', progress=0, error=NULL, file_base=NULL, subtitle_status=NULL, updated_at=? WHERE id=?",
                (now, episode_id),
            )


def reset_stuck_downloads() -> int:
    """Reset any episodes left in 'downloading' or 'queued' state to 'pending'.
    Called on worker startup to recover from crash/restart without orphaned jobs.
    Returns the number of episodes reset.
    """
    now = datetime.utcnow().isoformat()
    with get_conn() as conn:
        cur = conn.execute(
            "UPDATE episodes SET status='pending', progress=0, error='Interrupted (worker restarted)', updated_at=? "
            "WHERE status IN ('downloading', 'queued')",
            (now,),
        )
        return cur.rowcount


def get_setting(key: str, default: str = '') -> str:
    try:
        with get_conn() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
            return row["value"] if row else default
    except Exception:
        return default


def set_setting(key: str, value: str):
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )


def get_all_shows() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM shows ORDER BY sort_order ASC, id ASC"
        ).fetchall()
        return [dict(r) for r in rows]


def delete_show(show_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM episodes WHERE show_id=?", (show_id,))
        conn.execute("DELETE FROM shows WHERE id=?", (show_id,))


def get_all_folders() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM folders ORDER BY is_system DESC, sort_order ASC, id ASC"
        ).fetchall()
        return [dict(r) for r in rows]


def create_folder(name: str) -> dict:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT COALESCE(MAX(sort_order), 0) as m FROM folders WHERE is_system=0"
        ).fetchone()
        next_order = row["m"] + 1
        cur = conn.execute(
            "INSERT INTO folders (name, is_system, sort_order) VALUES (?,0,?)",
            (name, next_order)
        )
        return {"id": cur.lastrowid, "name": name, "is_system": False, "sort_order": next_order}


def delete_folder(folder_id: int) -> bool:
    with get_conn() as conn:
        row = conn.execute("SELECT is_system FROM folders WHERE id=?", (folder_id,)).fetchone()
        if not row or row["is_system"]:
            return False
        conn.execute("UPDATE shows SET folder_id=NULL WHERE folder_id=?", (folder_id,))
        conn.execute("DELETE FROM folders WHERE id=?", (folder_id,))
        return True


def set_show_folder(show_id: int, folder_id: Optional[int]):
    with get_conn() as conn:
        conn.execute("UPDATE shows SET folder_id=? WHERE id=?", (folder_id, show_id))


def set_show_sort_orders(items: list[dict]):
    """items: list of {id: int, sort_order: int}"""
    with get_conn() as conn:
        for item in items:
            conn.execute(
                "UPDATE shows SET sort_order=? WHERE id=?",
                (item["sort_order"], item["id"])
            )


def get_archived_folder_id() -> int:
    with get_conn() as conn:
        row = conn.execute("SELECT id FROM folders WHERE is_system=1 LIMIT 1").fetchone()
        return row["id"] if row else 1
