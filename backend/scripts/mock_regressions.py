#!/usr/bin/env python3
"""Seed ``status_history`` with two fake fetches so the regression banner works.

``fetch_data.process`` snapshots ``status`` into ``status_history`` before every
fetch, so a fresh database has no history and ``GET /api/regressions`` returns
an empty window until a fetch has run. This script inserts a fake "previous
fetch" and a fake "current fetch" instead::

    python backend/scripts/mock_regressions.py
    python backend/scripts/mock_regressions.py --clean

Every row uses a RIN ending in ``-MOCK`` and a timestamp at/after *now* (UTC),
so the two mock snapshots are always the newest ones the API compares. The
script prints the regressions and recoveries it expects, re-reads the window
from the database to prove the inserts, and exits non-zero if the two disagree.
``--clean`` deletes the mock rows again and leaves everything else untouched.

Only ``status_history`` is written: ``rins`` and ``status`` -- i.e. what the
dashboard shows -- are never modified. Remove the mock rows before the next real
fetch so the banner goes back to real data.

The database location is ``--db``, then the ``RIN_WATCH_DB`` environment
variable, then ``backend/rin_watch.db``.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path

# Running ``python backend/scripts/mock_regressions.py`` puts scripts/ on
# sys.path, not backend/, so make the backend modules importable from either cwd.
BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from database import get_connection, get_db_path, init_db  # noqa: E402

# (rin, has_value at T_old, has_value at T_new). Two RINs per outcome, so the
# banner shows both lists without any real fetch having run.
MOCK_ROWS: tuple[tuple[str, int, int], ...] = (
    ("USCA-PGPG-9101-MOCK", 1, 0),  # regression
    ("USCA-PGXX-9102-MOCK", 1, 0),  # regression
    ("USCA-PGPG-9103-MOCK", 0, 1),  # recovery
    ("USCA-XXMB-9104-MOCK", 0, 1),  # recovery
    ("USCA-PGXX-9105-MOCK", 1, 1),  # unchanged: not in either list
    ("USCA-XXSJ-9106-MOCK", 0, 0),  # unchanged: not in either list
)

MOCK_SUFFIX = "-MOCK"
# Time between the two fake fetches; long enough that nobody mistakes the two
# snapshots for one run, short enough to keep the banner's window readable.
WINDOW = timedelta(hours=1)
# Same format as SQLite's datetime('now'), which the real snapshots use.
TIMESTAMP_FORMAT = "%Y-%m-%d %H:%M:%S"


def expected_changes(
    rows: tuple[tuple[str, int, int], ...] = MOCK_ROWS,
) -> tuple[list[str], list[str]]:
    """(regressions, recoveries) implied by ``MOCK_ROWS``.

    Computed straight from the constants above -- not from the database and not
    by the API's SQL -- so re-reading the table below is an independent check
    of the inserts.
    """
    regressions = [rin for rin, old, new in rows if old == 1 and new == 0]
    recoveries = [rin for rin, old, new in rows if old == 0 and new == 1]
    return regressions, recoveries


def window_timestamps(now: datetime | None = None) -> tuple[str, str]:
    """(T_old, T_new): one hour apart, ending at *now* in UTC.

    ``now`` is injectable for tests; the real snapshots are UTC too, so a mock
    window that ends at the current time is always newer than any recorded
    fetch and the API picks it as the comparison window.
    """
    end = (now or datetime.now(UTC)).replace(microsecond=0)
    return (
        (end - WINDOW).strftime(TIMESTAMP_FORMAT),
        end.strftime(TIMESTAMP_FORMAT),
    )


def seed_snapshots(conn: sqlite3.Connection, t_old: str, t_new: str) -> int:
    """Write both mock snapshots; returns the number of rows written."""
    params = [(rin, t_old, old) for rin, old, _ in MOCK_ROWS] + [
        (rin, t_new, new) for rin, _, new in MOCK_ROWS
    ]
    conn.executemany(
        """
        INSERT OR REPLACE INTO status_history (rin, fetched_at, has_value)
        VALUES (?, ?, ?)
        """,
        params,
    )
    return len(params)


def _snapshot_sizes(
    conn: sqlite3.Connection, timestamps: tuple[str, ...]
) -> dict[str, int]:
    """``{fetched_at: row count}`` for the mock timestamps, as stored."""
    placeholders = ", ".join("?" for _ in timestamps)
    rows = conn.execute(
        f"""
        SELECT fetched_at, COUNT(*) AS rows
        FROM status_history
        WHERE fetched_at IN ({placeholders})
        GROUP BY fetched_at
        ORDER BY fetched_at
        """,
        timestamps,
    ).fetchall()
    return {row["fetched_at"]: row["rows"] for row in rows}


def changes_in_window(
    conn: sqlite3.Connection, t_old: str, t_new: str
) -> tuple[list[str], list[str]]:
    """(regressions, recoveries) between two snapshots, per the gap model.

    Mirrors ``GET /api/regressions``: only RINs present in both snapshots are
    compared, because a missing row means the RIN was deleted, not that it lost
    its value.
    """
    rows = conn.execute(
        """
        SELECT prev.rin AS rin,
               prev.has_value AS has_value_before,
               curr.has_value AS has_value_after
        FROM status_history AS prev
        JOIN status_history AS curr ON curr.rin = prev.rin
        WHERE prev.fetched_at = ?
          AND curr.fetched_at = ?
        ORDER BY prev.rin
        """,
        (t_old, t_new),
    ).fetchall()
    regressions = [
        row["rin"]
        for row in rows
        if row["has_value_before"] == 1 and row["has_value_after"] == 0
    ]
    recoveries = [
        row["rin"]
        for row in rows
        if row["has_value_before"] == 0 and row["has_value_after"] == 1
    ]
    return regressions, recoveries


def clean_mock_rows(conn: sqlite3.Connection) -> int:
    """Delete every ``status_history`` row whose RIN ends in ``-MOCK``."""
    return conn.execute(
        "DELETE FROM status_history WHERE rin LIKE ?", (f"%{MOCK_SUFFIX}",)
    ).rowcount


def _print_list(label: str, rins: list[str]) -> None:
    print(f"{label} ({len(rins)}):")
    if not rins:
        print("  (none)")
        return
    for rin in rins:
        print(f"  {rin}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python mock_regressions.py",
        description=(
            "Insert two fake status_history snapshots so /api/regressions has a"
            " window to compare, then print the expected banner contents."
        ),
    )
    parser.add_argument(
        "--clean",
        action="store_true",
        help=f"delete the mock rows (RIN ending in {MOCK_SUFFIX}) and exit",
    )
    parser.add_argument(
        "--db",
        metavar="PATH",
        help="database file (default: $RIN_WATCH_DB or backend/rin_watch.db)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry point; returns the process exit code."""
    args = build_parser().parse_args(argv)
    # Creates status_history on a database that predates the table.
    db_path = init_db(get_db_path(args.db))
    print(f"Database: {db_path}")

    with closing(get_connection(db_path)) as conn:
        if args.clean:
            removed = clean_mock_rows(conn)
            conn.commit()
            print(f"Removed {removed} mock row(s) ending in {MOCK_SUFFIX}.")
            return 0

        t_old, t_new = window_timestamps()
        written = seed_snapshots(conn, t_old, t_new)
        conn.commit()
        sizes = _snapshot_sizes(conn, (t_old, t_new))
        actual = changes_in_window(conn, t_old, t_new)

    print(f"Wrote {written} row(s) into status_history:")
    for label, timestamp in (("T_old", t_old), ("T_new", t_new)):
        print(f"  {label} {timestamp} -> {sizes.get(timestamp, 0)} RIN(s)")

    expected = expected_changes()
    print()
    _print_list("Expected regressions", expected[0])
    _print_list("Expected recoveries", expected[1])

    if actual != expected:
        print("\nFAIL: status_history does not match the mock rows.", file=sys.stderr)
        print(f"  read back regressions: {actual[0]}", file=sys.stderr)
        print(f"  read back recoveries:  {actual[1]}", file=sys.stderr)
        return 1

    print()
    print("OK: the two newest snapshots match the expected changes.")
    print(
        "Check the API with: curl -s http://127.0.0.1:8000/api/regressions"
        " | python -m json.tool"
    )
    print(f"Remove the mock rows with: {Path(__file__).name} --clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
