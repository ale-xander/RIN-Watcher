#!/usr/bin/env python3
"""Print the RINs added to the RIN Watch database, grouped by creation date.

``rins.created_at`` is stamped by the add-only CSV importer
(``scripts/manage_rins.py``: ``datetime('now')``) or by the one-off backfill in
``database.init_db`` (``date('now')``), so this report doubles as the import
history: one line per RIN under the day it was added.

Usage (works from the repo root or from ``backend/``)::

    python backend/scripts/report_rins.py --since 2026-11-01
    python backend/scripts/report_rins.py            # last 30 days

The database location is ``--db``, then the ``RIN_WATCH_DB`` environment
variable, then ``backend/rin_watch.db``.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from contextlib import closing
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

# Running ``python backend/scripts/report_rins.py`` puts scripts/ on sys.path,
# not backend/, so make the backend modules importable from either cwd.
BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from database import get_connection, get_db_path  # noqa: E402

DEFAULT_DAYS = 30
DATE_FORMAT = "%Y-%m-%d"


def parse_date(value: str) -> date:
    """``argparse`` type: ``YYYY-MM-DD`` -> ``date``, with a readable error."""
    try:
        return datetime.strptime(value, DATE_FORMAT).date()
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            f"invalid date '{value}', expected YYYY-MM-DD"
        ) from exc


def default_since(today: date | None = None) -> date:
    """Thirty days before ``today`` (UTC by default) -- the no-flag window.

    UTC matches ``datetime('now')``/``date('now')``, which is what SQLite
    stamped into ``created_at``.
    """
    current = today or datetime.now(UTC).date()
    return current - timedelta(days=DEFAULT_DAYS)


def fetch_rins(conn: sqlite3.Connection, since: date) -> list[sqlite3.Row]:
    """RINs added on or after ``since``, oldest first.

    ``created_at`` is TEXT in both formats the codebase writes -- a date for
    backfilled rows and ``YYYY-MM-DD HH:MM:SS`` for imports -- and both sort and
    compare correctly against a ``YYYY-MM-DD`` string, so no date parsing is
    needed in SQL.
    """
    return conn.execute(
        """
        SELECT rin, category, tariff, created_at
        FROM rins
        WHERE created_at >= ?
        ORDER BY created_at, rin
        """,
        (since.isoformat(),),
    ).fetchall()


def group_by_day(rows: list[sqlite3.Row]) -> dict[str, list[sqlite3.Row]]:
    """Group rows under the date part of ``created_at``, keeping query order."""
    grouped: dict[str, list[sqlite3.Row]] = {}
    for row in rows:
        day = (row["created_at"] or "")[:10] or "unknown"
        grouped.setdefault(day, []).append(row)
    return grouped


def print_report(rows: list[sqlite3.Row], since: date) -> None:
    """Print the text table: one ``YYYY-MM-DD:`` block per creation day."""
    print(f"RINs added since {since.isoformat()}: {len(rows)}")
    if not rows:
        print("  (none)")
        return
    for day, day_rows in group_by_day(rows).items():
        print(f"{day}:")
        for row in day_rows:
            category = row["category"] or "other"
            tariff = row["tariff"] or "(none)"
            print(f"  {row['rin']} ({category}, {tariff})")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python report_rins.py",
        description=(
            "List the RINs added to the database, grouped by the day they were"
            " added. Reports the last 30 days unless --since is given."
        ),
    )
    parser.add_argument(
        "--since",
        type=parse_date,
        metavar="YYYY-MM-DD",
        help="first created_at date to include (default: 30 days ago, UTC)",
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
    since = args.since or default_since()

    db_path = get_db_path(args.db)
    if not db_path.is_file():
        raise SystemExit(
            f"Database not found: {db_path}. Run `python database.py` first."
        )

    with closing(get_connection(db_path)) as conn:
        try:
            rows = fetch_rins(conn, since)
        except sqlite3.OperationalError as exc:
            raise SystemExit(
                f"{db_path} is not an initialized RIN Watch database ({exc})."
                " Run `python database.py` first."
            ) from exc

    print_report(rows, since)
    return 0


if __name__ == "__main__":
    sys.exit(main())
