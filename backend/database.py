"""SQLite schema and helpers for RIN Watch.

The database lives next to this file by default (backend/rin_watch.db). Set the
RIN_WATCH_DB environment variable to store it somewhere else.

Run ``python database.py`` to create/refresh the schema. New columns are defined
in ``MIGRATIONS`` rather than in ``SCHEMA`` so that databases created before the
column existed pick it up too; ``init_db`` applies them idempotently.
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

# Maps the RIN's second dash-segment to the provider that owns the RIN.
# PGPG = PG&E bundled (both delivery and generation from PG&E).
# PGXX = PG&E unbundled (delivery from PG&E, generation from a CCA — but the
#        generation half is a *separate* XX{CCA} RIN; the PGXX RIN is still
#        owned by PG&E and must be fetched from MIDAS as such).
# XX*  = the CCA owns this RIN (generation portion).
PREFIX_TO_PROVIDER = {
    "PGPG": "pge",
    "PGXX": "pge",
    "XXMB": "mce",
    "XXSJ": "sjce",
    "XXPC": "pce",
}

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
    # Tariff / rate from the PG&E RIN spreadsheet, e.g. ETOUC, B1, AGFA.
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


def upsert_provider(conn: sqlite3.Connection, code: str, display_name: str) -> None:
    conn.execute(
        """
        INSERT INTO providers (code, display_name)
        VALUES (?, ?)
        ON CONFLICT (code) DO UPDATE SET display_name = excluded.display_name
        """,
        (code, display_name),
    )


def parse_rin(rin: str) -> dict:
    """Split a RIN into its prefix, owning provider and CCA code.

    RINs are formatted ``USCA-{DIST}-{GEN}-{SEQ}``, e.g. ``USCA-PGXX-0622-0000``
    or ``USCA-XXMB-0077-PGE``. The second segment decides who owns the RIN:
    ``PGPG``/``PGXX`` belong to PG&E, ``XXMB`` to MCE and so on.

    Returns ``{"prefix": ..., "provider_code": ..., "cca_code": ...}``, where
    ``cca_code`` is ``None`` for PG&E-owned RINs and the provider code for CCA
    RINs. Malformed input (fewer than four segments, or a blank prefix) returns
    the defaults instead of raising, so the importer can park the row in its
    Misc group. An unknown prefix falls back to ``prefix.lower()`` so a new CCA
    auto-creates its own tab on the next import without a code change —
    ``PREFIX_TO_PROVIDER`` only pins the display labels of the known ones.
    """
    parts = rin.split("-")
    if len(parts) < 4 or not parts[1]:
        return {"prefix": "", "provider_code": "pge", "cca_code": None}
    prefix = parts[1]
    provider_code = PREFIX_TO_PROVIDER.get(prefix.upper(), prefix.lower())
    return {
        "prefix": prefix,
        "provider_code": provider_code,
        "cca_code": None if provider_code == "pge" else provider_code,
    }


def derive_category(tariff: str | None, enrollment_codes: list[str]) -> str:
    """Derive the dashboard *segment* from a tariff.

    The category is the segment only and never the program: NBT (Net Billing
    Tariff) is an enrollment program, detected from the ``enrollment_codes``
    column (any code starting with ``NBT-``), not a segment. Keeping NBT out of
    this column is what lets one RIN belong to a segment (e.g. ``resid``) *and*
    match the frontend's NBT filter at the same time.

    Checks run in a fixed order and the first match wins:

    1. ``ag`` — agricultural tariffs, ``AG`` plus anything (e.g. ``AGFA``).
    2. ``non_res`` — commercial/industrial tariffs (e.g. ``B19``).
    3. ``resid`` — residential time-of-use and EV tariffs (e.g. ``ETOUC``).
    4. ``other`` — everything else, including blank tariffs. ``ETOUB``
       intentionally lands here because it is deprecated.

    Tariff comparison is case-insensitive after stripping whitespace. The
    ``enrollment_codes`` argument is accepted because the importer passes the
    row's codes to every categorisation call, but it no longer influences the
    result: program detection lives in the API/frontend. Pure function, no
    database access.
    """
    normalized = (tariff or "").strip().upper()
    if normalized.startswith("AG"):
        return "ag"
    if normalized in {"B1", "B6", "B10", "B19", "B20", "BEV1", "BEV2"}:
        return "non_res"
    if normalized in {"ETOUC", "ETOUD", "EELEC", "EVB", "EV2A"}:
        return "resid"
    return "other"


def upsert_rin(
    conn: sqlite3.Connection,
    rin: str,
    provider_code: str,
    rate_name: str | None = None,
    tariff: str | None = None,
    enrollment_codes: str | None = None,
    category: str | None = None,
    prefix: str | None = None,
    is_active: int = 1,
) -> None:
    """Insert a RIN or refresh only the fields the caller actually supplied.

    ``enrollment_codes`` is a JSON array string (``'["CARE","PGE-FS"]'``), not a
    Python list: the importer calls ``json.dumps``, which keeps this module free
    of a JSON import and mirrors the ``TEXT`` column one-for-one.

    Optional columns use ``COALESCE(NULLIF(excluded.X, ''), rins.X)``, so a
    re-import that omits a value keeps the stored one instead of blanking it —
    passing ``None`` or ``''`` means "leave this column alone". Clearing a value
    on purpose is therefore not possible through this helper. ``category`` and
    ``prefix`` are ``NOT NULL`` in the schema, so they are defaulted to
    ``'other'``/``''`` on insert while still preserving the old value on update.

    ``is_active`` is written unconditionally: the default ``1`` reactivates a
    soft-deleted RIN, which is what we want when a RIN reappears in a new
    spreadsheet. Soft deletion is the importer's job, done with an explicit
    ``is_active=0``.
    """
    conn.execute(
        """
        INSERT INTO rins (
            rin, provider_code, rate_name, tariff, enrollment_codes,
            category, prefix, is_active
        )
        VALUES (?1, ?2, ?3, ?4, ?5, COALESCE(?6, 'other'), COALESCE(?7, ''), ?8)
        ON CONFLICT (rin) DO UPDATE SET
            provider_code = excluded.provider_code,
            rate_name = COALESCE(NULLIF(excluded.rate_name, ''), rins.rate_name),
            tariff = COALESCE(NULLIF(excluded.tariff, ''), rins.tariff),
            enrollment_codes = COALESCE(
                NULLIF(excluded.enrollment_codes, ''), rins.enrollment_codes
            ),
            category = COALESCE(NULLIF(?6, ''), rins.category),
            prefix = COALESCE(NULLIF(excluded.prefix, ''), rins.prefix),
            is_active = excluded.is_active
        """,
        (
            rin,
            provider_code,
            rate_name,
            tariff,
            enrollment_codes,
            category,
            prefix,
            is_active,
        ),
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


if __name__ == "__main__":
    print(f"Initialized database at {init_db()}")
