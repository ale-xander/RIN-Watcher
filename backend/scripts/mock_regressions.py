#!/usr/bin/env python3
"""Seed ``status_history`` with two fake fetches so the regression banner works.

``fetch_data.process`` snapshots ``status`` into ``status_history`` after every
fetch, so a fresh database has no history and ``GET /api/regressions`` returns
an empty window until two fetches have run. This script inserts a fake
"previous fetch" and a fake "current fetch" instead::

    python backend/scripts/mock_regressions.py
    python backend/scripts/mock_regressions.py --clean

The API joins the changed RIN strings against ``rins`` and returns full dashboard
rows, so a mock snapshot has to name RINs that really exist. The script picks
RINs the dashboard already shows -- two currently missing ones become
regressions, two healthy ones become recoveries -- so the newest mock snapshot
agrees with what ``status`` says today. A sentinel RIN (``-MOCK-WINDOW``, which
no real RIN can match) tags both mock timestamps, which is how ``--clean``
deletes exactly what a run wrote and never a real snapshot. The timestamps are
at/after *now* (UTC), so the two mock snapshots are always the newest ones the
API compares. The script prints the regressions and recoveries it expects,
re-reads the window from the database to prove the inserts, and exits non-zero
if the two disagree.

Only ``status_history`` is written: ``rins`` and ``status`` -- i.e. what the
dashboard shows and what the fetcher reads -- are never modified. Remove the mock
rows before the next real fetch so the banner goes back to real data.

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

# Two RINs per outcome, so the banner shows both lists without any real fetch
# having run.
PICKS_PER_OUTCOME = 2
# Marks both mock snapshots without naming a RIN: a leading dash is not a valid
# MIDAS RIN, so it can never collide with one, and the API never reports it (it
# has the same value in both snapshots, and it is not in ``rins``).
SENTINEL_RIN = "-MOCK-WINDOW"
# Time between the two fake fetches; long enough that nobody mistakes the two
# snapshots for one run, short enough to keep the banner's window readable.
WINDOW = timedelta(hours=1)
# Same format as SQLite's datetime('now'), which the real snapshots use.
TIMESTAMP_FORMAT = "%Y-%m-%d %H:%M:%S"


def _candidate_rins(conn: sqlite3.Connection) -> tuple[list[str], list[str]]:
    """(missing, healthy): the live RINs the mock can contradict.

    The newest mock snapshot repeats what ``status`` says today -- a regressed
    RIN is missing now, a recovered one has a value now -- so the banner never
    describes a RIN the rest of the dashboard disagrees about. A RIN with no
    ``status`` row counts as missing: the dashboard's LEFT JOIN keeps it and
    classifies it as not-in-MIDAS.
    """
    rows = conn.execute(
        """
        SELECT r.rin AS rin, s.has_value_today AS has_value_today
        FROM rins AS r
        LEFT JOIN status AS s ON s.rin = r.rin
        ORDER BY r.rin
        """
    ).fetchall()
    missing = [row["rin"] for row in rows if row["has_value_today"] != 1]
    healthy = [row["rin"] for row in rows if row["has_value_today"] == 1]
    return missing, healthy


def pick_rows(conn: sqlite3.Connection) -> tuple[tuple[str, int, int], ...]:
    """``(rin, has_value at T_old, has_value at T_new)`` for the mock snapshots.

    Raises ``ValueError`` when the database cannot supply both outcomes, so the
    CLI can explain why instead of writing half a demo.
    """
    missing, healthy = _candidate_rins(conn)
    if len(missing) < PICKS_PER_OUTCOME or len(healthy) < PICKS_PER_OUTCOME:
        raise ValueError(
            f"need {PICKS_PER_OUTCOME} RINs with a value and {PICKS_PER_OUTCOME}"
            " without one to mock both outcomes"
            f" (found {len(healthy)} with, {len(missing)} without);"
            " open the dashboard or run a fetch first"
        )
    return tuple(
        [(rin, 1, 0) for rin in missing[:PICKS_PER_OUTCOME]]
        + [(rin, 0, 1) for rin in healthy[:PICKS_PER_OUTCOME]]
    )


def expected_changes(
    rows: tuple[tuple[str, int, int], ...],
) -> tuple[list[str], list[str]]:
    """(regressions, recoveries) implied by the mock rows.

    Computed straight from the rows above -- not from the database and not by
    the API's SQL -- so re-reading the table below is an independent check of
    the inserts.
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


def seed_snapshots(
    conn: sqlite3.Connection,
    rows: tuple[tuple[str, int, int], ...],
    t_old: str,
    t_new: str,
) -> int:
    """Write both mock snapshots; returns the number of rows written."""
    params = [(rin, t_old, old) for rin, old, _ in rows] + [
        (rin, t_new, new) for rin, _, new in rows
    ]
    # The sentinel has the same value in both snapshots, so the window query
    # never reports it; it exists to tag the timestamps for ``--clean``.
    params += [(SENTINEL_RIN, t_old, 0), (SENTINEL_RIN, t_new, 0)]
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
    """Delete every row a previous run wrote, sentinel rows included.

    The mock timestamps are exactly the ones that carry the sentinel, so this
    removes a run's own snapshots and never a real fetch's.
    """
    return conn.execute(
        """
        DELETE FROM status_history
        WHERE fetched_at IN (
            SELECT fetched_at FROM status_history WHERE rin = ?
        )
        """,
        (SENTINEL_RIN,),
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
        help="delete the rows a previous run wrote and exit",
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
            print(f"Removed {removed} mock row(s).")
            return 0

        try:
            rows = pick_rows(conn)
        except ValueError as error:
            print(f"Cannot mock regressions: {error}.", file=sys.stderr)
            return 1

        t_old, t_new = window_timestamps()
        written = seed_snapshots(conn, rows, t_old, t_new)
        conn.commit()
        sizes = _snapshot_sizes(conn, (t_old, t_new))
        actual = changes_in_window(conn, t_old, t_new)

    print(f"Wrote {written} row(s) into status_history:")
    for label, timestamp in (("T_old", t_old), ("T_new", t_new)):
        print(f"  {label} {timestamp} -> {sizes.get(timestamp, 0)} row(s)")

    expected = expected_changes(rows)
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
