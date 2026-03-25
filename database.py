"""
database.py — SQLite state tracking for episodes and downloads
"""
import sqlite3
import json
from pathlib import Path
from datetime import datetime
from typing import Optional

DB_PATH = Path("downloads.db")


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_conn() as conn:
        conn.executescript("""
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
                sources     TEXT,   -- JSON list of {label, url}
                status      TEXT DEFAULT 'pending',   -- pending/downloading/done/failed/skipped
                progress    REAL DEFAULT 0,
                file_path   TEXT,
                error       TEXT,
                added_at    TEXT,
                updated_at  TEXT
            );
        """)


# ── Shows ──────────────────────────────────────────────────────────────────────

def upsert_show(url: str, title: str) -> int:
    with get_conn() as conn:
        now = datetime.utcnow().isoformat()
        cur = conn.execute(
            "INSERT INTO shows (url, title, scraped_at) VALUES (?,?,?) "
            "ON CONFLICT(url) DO UPDATE SET title=excluded.title, scraped_at=excluded.scraped_at",
            (url, title, now)
        )
        if cur.lastrowid:
            return cur.lastrowid
        row = conn.execute("SELECT id FROM shows WHERE url=?", (url,)).fetchone()
        return row["id"]


def get_show(url: str) -> Optional[dict]:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM shows WHERE url=?", (url,)).fetchone()
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
            result.append(d)
        return result


def get_episode(episode_id: int) -> Optional[dict]:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM episodes WHERE id=?", (episode_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        d["sources"] = json.loads(d["sources"] or "[]")
        return d


def set_episode_status(episode_id: int, status: str, progress: float = None,
                       file_path: str = None, error: str = None):
    now = datetime.utcnow().isoformat()
    fields = ["status=?", "updated_at=?"]
    values = [status, now]
    if progress is not None:
        fields.append("progress=?")
        values.append(progress)
    if file_path is not None:
        fields.append("file_path=?")
        values.append(file_path)
    if error is not None:
        fields.append("error=?")
        values.append(error)
    values.append(episode_id)
    with get_conn() as conn:
        conn.execute(f"UPDATE episodes SET {', '.join(fields)} WHERE id=?", values)


def get_all_shows() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM shows ORDER BY scraped_at DESC").fetchall()
        return [dict(r) for r in rows]


def delete_show(show_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM episodes WHERE show_id=?", (show_id,))
        conn.execute("DELETE FROM shows WHERE id=?", (show_id,))
