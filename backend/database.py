"""SQLite schema and helpers for RIN Watch.

The database lives next to this file by default (backend/rin_watch.db). Set the
RIN_WATCH_DB environment variable to store it somewhere else.

Run ``python database.py`` to create/refresh the schema.
"""

from __future__ import annotations

import os
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Optional, Union

BACKEND_DIR = Path(__file__).resolve().parent
DEFAULT_DB_PATH = BACKEND_DIR / "rin_watch.db"

# Providers we know about. The fetch script currently only handles PG&E.
PROVIDERS = (("pge", "Pacific Gas & Electric"),)

SCHEMA = """
CREATE TABLE IF NOT EXISTS providers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    code         TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rins (
    rin           TEXT PRIMARY KEY,
    provider_code TEXT NOT NULL REFERENCES providers (code) ON UPDATE CASCADE,
    rate_name     TEXT
);

CREATE INDEX IF NOT EXISTS idx_rins_provider_code ON rins (provider_code);

CREATE TABLE IF NOT EXISTS status (
    rin               TEXT PRIMARY KEY REFERENCES rins (rin) ON DELETE CASCADE,
    has_value_today   INTEGER NOT NULL DEFAULT 0 CHECK (has_value_today IN (0, 1)),
    last_success_date TEXT,
    fetched_at        TEXT NOT NULL
);
"""

DbPath = Union[str, Path, None]


def get_db_path(db_path: DbPath = None) -> Path:
    """Resolve the database location (explicit argument > env var > default)."""
    if db_path is not None:
        return Path(db_path).expanduser()
    return Path(os.getenv("RIN_WATCH_DB", str(DEFAULT_DB_PATH))).expanduser()


def get_connection(db_path: DbPath = None) -> sqlite3.Connection:
    """Open a connection with row access by name and foreign keys enabled."""
    path = get_db_path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(db_path: DbPath = None) -> Path:
    """Create the tables (if missing) and seed the known providers."""
    path = get_db_path(db_path)
    with closing(get_connection(path)) as conn:
        conn.executescript(SCHEMA)
        conn.executemany(
            "INSERT OR IGNORE INTO providers (code, display_name) VALUES (?, ?)",
            PROVIDERS,
        )
        conn.commit()
    return path


def upsert_provider(conn: sqlite3.Connection, code: str, display_name: str) -> None:
    conn.execute(
        """
        INSERT INTO providers (code, display_name)
        VALUES (?, ?)
        ON CONFLICT (code) DO UPDATE SET display_name = excluded.display_name
        """,
        (code, display_name),
    )


def upsert_rin(
    conn: sqlite3.Connection,
    rin: str,
    provider_code: str,
    rate_name: Optional[str] = None,
) -> None:
    """Insert a RIN or refresh it, keeping the old rate name if none is given."""
    conn.execute(
        """
        INSERT INTO rins (rin, provider_code, rate_name)
        VALUES (?, ?, ?)
        ON CONFLICT (rin) DO UPDATE SET
            provider_code = excluded.provider_code,
            rate_name = COALESCE(NULLIF(excluded.rate_name, ''), rins.rate_name)
        """,
        (rin, provider_code, rate_name),
    )


def delete_test_rins(conn: sqlite3.Connection, suffix: str = "-TEST") -> int:
    """Delete RINs whose ID ends with ``suffix``; returns how many were removed.

    Test RINs (e.g. ``USCA-PGXX-4004-TEST``) are not real, so their ``status``
    rows are removed as well. Real RINs that merely disappeared from the MIDAS
    list are left untouched.
    """
    pattern = f"%{suffix.upper()}"
    # Delete the status rows explicitly as well, so the cleanup also works on a
    # connection that was opened without PRAGMA foreign_keys = ON.
    conn.execute("DELETE FROM status WHERE UPPER(rin) LIKE ?", (pattern,))
    deleted = conn.execute("DELETE FROM rins WHERE UPPER(rin) LIKE ?", (pattern,)).rowcount
    return deleted


def save_status(
    conn: sqlite3.Connection,
    rin: str,
    has_value_today: bool,
    fetched_at: str,
    last_success_date: Optional[str] = None,
) -> None:
    """Write today's status for a RIN.

    ``last_success_date`` is only supplied when a value was found today; when it
    is None the previously stored date is preserved.
    """
    conn.execute(
        """
        INSERT INTO status (rin, has_value_today, last_success_date, fetched_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (rin) DO UPDATE SET
            has_value_today = excluded.has_value_today,
            last_success_date = COALESCE(excluded.last_success_date, status.last_success_date),
            fetched_at = excluded.fetched_at
        """,
        (rin, 1 if has_value_today else 0, last_success_date, fetched_at),
    )


if __name__ == "__main__":
    print(f"Initialized database at {init_db()}")
