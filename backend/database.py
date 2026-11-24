"""SQLite schema and helpers for RIN Watch.

The database lives next to this file by default (backend/rin_watch.db). Set the
RIN_WATCH_DB environment variable to store it somewhere else.

Run ``python database.py`` to create/refresh the schema. New columns are defined
in ``MIGRATIONS`` rather than in ``SCHEMA`` so that databases created before the
column existed pick it up too; ``init_db`` applies them idempotently. The
``created_at`` column additionally gets a one-off backfill (see
``backfill_created_at``) so pre-existing RINs are dated instead of left NULL.

New *tables* live in ``SCHEMA`` as ``CREATE TABLE IF NOT EXISTS``. ``init_db``
runs the whole script on every start, so that statement is itself the migration
for files created before the table existed -- ``status_history`` is added this
way (see ``record_status_snapshot``).
"""

from __future__ import annotations

import os
import sqlite3
from contextlib import closing
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
DEFAULT_DB_PATH = BACKEND_DIR / "rin_watch.db"

# Providers we know about. Seeded into the providers table by init_db(); RINs
# reference these codes, so a provider has to exist before its RINs can be saved.
PROVIDERS = (
    ("pge", "Pacific Gas & Electric"),
    ("mce", "MCE"),
    ("sjce", "San José Clean Energy"),
    ("pce", "Peninsula Clean Energy"),
)

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

-- One row per RIN per fetch, written *after* a fetch has written ``status``
-- (see ``record_status_snapshot``). Deliberately no foreign key to ``rins``:
-- the point of the table is a permanent record, so history has to survive the
-- deletion of a RIN. ``status`` only keeps today, this keeps every past fetch
-- so /api/regressions can diff the two newest snapshots.
CREATE TABLE IF NOT EXISTS status_history (
    rin        TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    has_value  INTEGER NOT NULL DEFAULT 0 CHECK (has_value IN (0, 1)),
    PRIMARY KEY (rin, fetched_at)
);

CREATE INDEX IF NOT EXISTS idx_status_history_fetched_at
    ON status_history (fetched_at);
"""

# Columns added after the first release. ``SCHEMA`` only creates missing tables,
# so new columns have to be applied as ``ALTER TABLE`` statements to databases
# that already exist. Entries are ``(table, column, ddl)``: ``init_db`` skips a
# migration when ``PRAGMA table_info`` already lists its column (SQLite has no
# ``ADD COLUMN IF NOT EXISTS``), which makes every run idempotent.
#
# New databases are migrated too -- the columns are intentionally not inlined in
# ``SCHEMA`` so fresh and upgraded files always end up with the same layout.
# Existing rows survive: every column is either nullable or has a default.
MIGRATIONS = (
    # Prefix of the RIN itself, e.g. PGPG, PGXX, XXMB.
    ("rins", "prefix", "ALTER TABLE rins ADD COLUMN prefix TEXT NOT NULL DEFAULT ''"),
    # Tariff / rate from the RIN import CSV, e.g. ETOUC, B1, AGFA.
    ("rins", "tariff", "ALTER TABLE rins ADD COLUMN tariff TEXT"),
    # JSON array string of enrollment codes, e.g. '["CARE","PGE-FS"]'.
    ("rins", "enrollment_codes", "ALTER TABLE rins ADD COLUMN enrollment_codes TEXT"),
    # ag | non_res | resid | nbt | other: drives the dashboard tab a RIN shows up in.
    (
        "rins",
        "category",
        "ALTER TABLE rins ADD COLUMN category TEXT NOT NULL DEFAULT 'other'",
    ),
    # 0 = soft-deleted: hidden from the dashboard but kept for history.
    (
        "rins",
        "is_active",
        "ALTER TABLE rins ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 "
        "CHECK (is_active IN (0, 1))",
    ),
    # UTC timestamp of the import that added the RIN. Written once, on insert:
    # it is the audit trail for the add-only CSV importer, so no code path
    # updates it afterwards. Pre-existing rows are backfilled by init_db.
    ("rins", "created_at", "ALTER TABLE rins ADD COLUMN created_at TEXT"),
)

DbPath = str | Path | None
Migration = tuple[str, str, str]


def get_db_path(db_path: DbPath = None) -> Path:
    """Resolve the database location (explicit argument > env var > default).

    ``RIN_WATCH_DB`` wins over ``BACKEND_DIR / "rin_watch.db"``; production sets
    it to the mounted persistent disk (e.g. ``/data/rin_watch.db``). A blank or
    whitespace-only value is ignored so it can't resolve to the current dir.
    """
    if db_path is not None:
        return Path(db_path).expanduser()
    env_path = (os.getenv("RIN_WATCH_DB") or "").strip()
    return Path(env_path).expanduser() if env_path else DEFAULT_DB_PATH


def get_fetch_lock_path(db_path: DbPath = None) -> Path:
    """Lock file that serialises fetches for this database.

    The lock sits next to the SQLite file instead of living in memory, so the
    API server, each of its workers and the ``fetch_data.py`` CLI all contend
    for the same lock. The suffix is appended to the full file name (e.g.
    ``/data/rin_watch.db`` -> ``/data/rin_watch.db.fetch.lock``); using
    ``Path.with_suffix`` would replace ``.db`` and make ``a.db`` and ``a.sqlite``
    share one lock.
    """
    db = get_db_path(db_path)
    return db.with_name(db.name + ".fetch.lock")


def get_connection(db_path: DbPath = None) -> sqlite3.Connection:
    """Open a connection with row access by name and foreign keys enabled."""
    path = get_db_path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(db_path: DbPath = None) -> Path:
    """Create the tables (if missing), apply pending migrations, seed providers."""
    path = get_db_path(db_path)
    with closing(get_connection(path)) as conn:
        conn.executescript(SCHEMA)
        added = apply_migrations(conn)
        if added:
            print(f"Applied {len(added)} schema migration(s): {', '.join(added)}")
        backfilled = backfill_created_at(conn)
        if backfilled:
            print(f"Backfilled created_at for {backfilled} RIN(s) with today's date")
        conn.executemany(
            "INSERT OR IGNORE INTO providers (code, display_name) VALUES (?, ?)",
            PROVIDERS,
        )
        conn.commit()
    return path


def table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    """Return the column names of ``table`` (empty when it does not exist).

    ``table`` always comes from ``MIGRATIONS``, never from user input, so the
    f-string is safe here -- SQLite does not accept PRAGMA arguments as ``?``.
    """
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def apply_migrations(
    conn: sqlite3.Connection,
    migrations: tuple[Migration, ...] = MIGRATIONS,
) -> list[str]:
    """Run the ``ALTER TABLE`` statements whose column is still missing.

    Returns the ``table.column`` names added, so callers (and ``init_db``) can
    log what changed. Running this twice is a no-op: a column that already
    exists is skipped instead of raising "duplicate column name".
    """
    added: list[str] = []
    known: dict[str, set[str]] = {}
    for table, column, ddl in migrations:
        if table not in known:
            known[table] = table_columns(conn, table)
        columns = known[table]
        if column in columns:
            continue
        conn.execute(ddl)
        columns.add(column)
        added.append(f"{table}.{column}")
    return added


def backfill_created_at(conn: sqlite3.Connection) -> int:
    """One-off ``created_at`` migration: date every RIN that has no timestamp.

    Databases created before the column existed get NULL for all their RINs
    after ``apply_migrations`` adds it. Stamping them with today's date keeps
    the column usable for reports instead of leaving a hole in the history.
    ``date('now')`` is SQLite's UTC date, consistent with the UTC
    ``datetime('now')`` the importer writes for new rows.

    The ``IS NULL`` filter makes this safe on every startup: a real import
    timestamp is never overwritten. Returns the number of rows backfilled.
    """
    return conn.execute(
        "UPDATE rins SET created_at = date('now') WHERE created_at IS NULL"
    ).rowcount


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
    deleted = conn.execute(
        "DELETE FROM rins WHERE UPPER(rin) LIKE ?", (pattern,)
    ).rowcount
    return deleted


def save_status(
    conn: sqlite3.Connection,
    rin: str,
    has_value_today: bool,
    fetched_at: str,
    last_success_date: str | None = None,
) -> None:
    """Write today's status for a RIN.

    A successful check always records a success date, so it can never leave the
    column NULL: ``last_success_date`` when supplied (``fetch_data`` passes the
    Pacific date it checked, i.e. today), otherwise the ``YYYY-MM-DD`` prefix of
    ``fetched_at``. A failed check (``has_value_today`` false) only overwrites
    the stored date when a date is supplied, keeping the last known good date.
    """
    if has_value_today:
        success_date = last_success_date or fetched_at[:10]
    else:
        success_date = last_success_date

    conn.execute(
        """
        INSERT INTO status (rin, has_value_today, last_success_date, fetched_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (rin) DO UPDATE SET
            has_value_today = excluded.has_value_today,
            last_success_date = COALESCE(excluded.last_success_date, status.last_success_date),
            fetched_at = excluded.fetched_at
        """,
        (rin, 1 if has_value_today else 0, success_date, fetched_at),
    )


def record_status_snapshot(conn: sqlite3.Connection) -> int:
    """Copy the current ``status`` table into ``status_history``.

    ``fetch_data.process`` calls this *after* it has written and committed the
    new status rows, so one ``fetched_at`` group holds the result of a completed
    fetch. Diffing the two newest groups is what ``/api/regressions`` reports
    (see ``latest_snapshot_times``); snapshotting before the fetch instead would
    make the window describe the previous run.

    ``fetched_at`` is SQLite's UTC ``datetime('now')`` (``YYYY-MM-DD HH:MM:SS``),
    which sorts lexicographically in chronological order -- that is what the
    window query relies on. The ``(rin, fetched_at)`` primary key makes a
    re-run inside the same second idempotent: ``OR REPLACE`` writes the same
    values again instead of failing.

    Returns the number of history rows written (0 until a fetch has recorded
    at least one status row).
    """
    return conn.execute(
        """
        INSERT OR REPLACE INTO status_history (rin, fetched_at, has_value)
        SELECT rin, datetime('now'), has_value_today FROM status
        """
    ).rowcount


def latest_snapshot_times(conn: sqlite3.Connection, limit: int = 2) -> list[str]:
    """The newest distinct ``status_history.fetched_at`` values, newest first.

    ``limit=2`` is the regression window: ``[0]`` is the newer snapshot and
    ``[1]`` the older one. Returns fewer entries when the history is shorter,
    and an empty list while no fetch has been snapshotted yet.
    """
    return [
        row[0]
        for row in conn.execute(
            """
            SELECT DISTINCT fetched_at
            FROM status_history
            ORDER BY fetched_at DESC
            LIMIT ?
            """,
            (limit,),
        )
    ]


if __name__ == "__main__":
    print(f"Initialized database at {init_db()}")
