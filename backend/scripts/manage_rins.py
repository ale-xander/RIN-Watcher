#!/usr/bin/env python3
"""Insert *new* RINs from a CSV file into the RIN Watch database.

The database is the source of truth, so this importer is strictly add-only. A
RIN that is already in ``rins`` -- active (``is_active = 1``) or soft-deleted
(``is_active = 0``) -- is reported as a **Conflict** and left completely
untouched. Editing an existing RIN is a manual Cline/terminal job, never a CSV
import; nothing is deleted or reactivated either.

* a RIN that is missing is inserted with the provider route derived from its
  prefix, ``is_active = 1``, no ``rate_name`` (MIDAS never writes one, so the
  dashboard falls back to the tariff) and ``created_at = datetime('now')``;
* a RIN that already exists is a conflict: no column is updated;
* a RIN that is not in the CSV is left exactly as it is.

The CSV must have the columns ``RIN``, ``Tariff``, ``Enrollment Code`` and
``Category``; extra columns are ignored and header matching is
case-insensitive. A row is skipped (with a warning) when the RIN does not start
with ``USCA``, its prefix has no route, or its category is not one of ``ag``,
``non_res``, ``resid`` or ``other``. A RIN that appears twice in the file is
imported once; the later row is skipped with a warning.

``component`` is derived here only to validate the route and report what was
read: ``rins`` has no component column, and ``main.py`` derives the dashboard
component from the stored ``prefix`` (PGPG/PGXX) or ``rate_name`` (HFP).

Usage (works from the repo root or from ``backend/``)::

    python backend/scripts/manage_rins.py path/to/file.csv --dry-run
    python backend/scripts/manage_rins.py path/to/file.csv

``--dry-run`` prints the plan and writes nothing. A real run copies the
database to ``<db>.bak-YYYYMMDD-HHMMSS`` first unless ``--no-backup`` is
passed. The database location is ``--db``, then the ``RIN_WATCH_DB``
environment variable, then ``backend/rin_watch.db``.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import shutil
import sqlite3
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import IO

# Running ``python backend/scripts/manage_rins.py`` puts scripts/ on sys.path,
# not backend/, so make the backend modules importable from either cwd.
BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from database import get_connection, get_db_path  # noqa: E402

# Columns the importer needs; any other CSV column is ignored.
REQUIRED_HEADERS = ("RIN", "Tariff", "Enrollment Code", "Category")
VALID_CATEGORIES = ("ag", "non_res", "resid", "other")
RIN_PREFIX = "USCA"

# RIN prefix (second dash segment) -> (provider_code, component). PGPG is PG&E
# bundled, PGXX is PG&E unbundled and every XX* is a CCA-owned generation half.
# ``component`` is not stored -- see the module docstring -- but deriving it
# here keeps the route explicit and lets the report show what the file covers.
PREFIX_ROUTES: dict[str, tuple[str, str]] = {
    "PGPG": ("pge", "bundled"),
    "PGXX": ("pge", "unbundled"),
    "XXPR": ("mce", "hfp"),
    "XXVC": ("mce", "hfp"),
    "XXMB": ("mce", "hfp"),
    "XXEB": ("mce", "hfp"),
    "XXSJ": ("mce", "hfp"),
    "XXSV": ("mce", "hfp"),
    "XXPC": ("mce", "hfp"),
    "XXCA": ("mce", "hfp"),
    "XXMC": ("mce", "hfp"),
}
COMPONENT_ORDER = ("bundled", "unbundled", "hfp")

LABEL_WIDTH = 13
COUNT_WIDTH = 4
MAX_WARNINGS = 20
SEPARATOR = "─" * 38

# Printed after every run; the placeholders are filled in by ``print_report``.
NEXT_STEPS = (
    '  flyctl ssh console -a rin-watch-api-alex -C "rm -f /data/rin_watch.db"',
    "  flyctl sftp shell -a rin-watch-api-alex",
    "    put {db_path} /data/rin_watch.db",
    "    (Ctrl+D to exit)",
    '  flyctl ssh console -a rin-watch-api-alex -C "sqlite3 /data/rin_watch.db \\',
    '    \\"SELECT COUNT(*) FROM rins WHERE is_active=1;\\""',
)


def _text(value: object) -> str:
    """Return ``value`` as stripped text; ``None`` becomes an empty string."""
    if value is None:
        return ""
    return str(value).strip()


class CsvFormatError(ValueError):
    """The file is not a usable RIN CSV (empty, or missing a required column)."""


def _read_records(handle: IO[str], name: str) -> list[dict]:
    """Read CSV rows into plain dicts, one per row that has any content.

    Header names are matched case-insensitively after stripping, and the caller
    opens the file with ``utf-8-sig`` (or decodes the upload that way), so a
    spreadsheet exported with a slightly different header casing still imports.
    Values are returned untouched -- stripping and validation happen in
    ``parse_row``. Blank lines are ignored; every other row is kept so it can be
    reported. ``name`` only labels error messages.

    Raises ``CsvFormatError`` (a ``ValueError``) instead of exiting so both the
    CLI and the API can turn a bad file into their own error response.
    """
    reader = csv.reader(handle)
    try:
        header = next(reader)
    except StopIteration:
        raise CsvFormatError(f"{name}: file is empty.") from None
    columns = {
        _text(value).lower(): position
        for position, value in enumerate(header)
        if _text(value)
    }
    missing = [value for value in REQUIRED_HEADERS if value.lower() not in columns]
    if missing:
        raise CsvFormatError(
            f"{name}: missing required column(s): {', '.join(missing)}."
            f" Expected headers: {', '.join(REQUIRED_HEADERS)}."
        )
    indexes = {value: columns[value.lower()] for value in REQUIRED_HEADERS}

    def cell(row: list[str], column: str) -> str:
        """Read ``row`` at the column position of ``column`` (short rows -> '')."""
        position = indexes[column]
        return row[position] if position < len(row) else ""

    records: list[dict] = []
    for row_number, row in enumerate(reader, start=2):
        if not any(_text(value) for value in row):
            continue
        records.append(
            {
                "row": row_number,
                "rin": cell(row, "RIN"),
                "tariff": cell(row, "Tariff"),
                "enrollment_raw": cell(row, "Enrollment Code"),
                "category": cell(row, "Category"),
            }
        )
    return records


def read_csv(path: Path) -> list[dict]:
    """Read a CSV file from disk (UTF-8, BOM tolerated)."""
    with path.open(newline="", encoding="utf-8-sig") as handle:
        return _read_records(handle, path.name)


def read_csv_text(text: str, name: str = "upload.csv") -> list[dict]:
    """Parse CSV content that is already in memory (API uploads)."""
    return _read_records(io.StringIO(text), name)


def split_codes(raw: str) -> list[str]:
    """Split ``Enrollment Code`` on commas: stripped, upper-cased, de-duplicated.

    Upper-casing matches the data the old spreadsheet importer wrote; the
    dashboard compares codes exactly (``"CARE"``, ``"NBT-"``, ...), so a
    lowercase export would otherwise silently stop matching.
    """
    codes: list[str] = []
    for part in raw.split(","):
        code = part.strip().upper()
        if code and code not in codes:
            codes.append(code)
    return codes


def rin_prefix(rin: str) -> str:
    """Return the RIN's second dash segment (``PGPG``), or '' when malformed."""
    parts = rin.split("-")
    return parts[1].upper() if len(parts) > 1 else ""


def parse_row(raw: dict) -> tuple[dict | None, str | None]:
    """Normalize one CSV row into a writable dict, or return a skip warning.

    ``component`` is carried along for the report only. ``enrollment_codes``
    keeps its list form for the diff and ``enrollment_json`` is what gets
    stored, e.g. ``'["CARE","PDP"]'`` (empty list -> ``'[]'``).
    """
    row_number = raw["row"]
    rin = _text(raw["rin"]).upper()
    if not rin:
        return None, f"row {row_number}: skipped, no RIN"
    if not rin.startswith(RIN_PREFIX):
        return None, (
            f"row {row_number}: skipped, RIN '{rin}' does not start with {RIN_PREFIX}"
        )

    prefix = rin_prefix(rin)
    route = PREFIX_ROUTES.get(prefix)
    if route is None:
        shown = prefix or "no prefix"
        return None, (f"row {row_number}: skipped, no route for {shown} in RIN {rin}")

    category = _text(raw["category"]).lower()
    if category not in VALID_CATEGORIES:
        shown = _text(raw["category"]) or "blank"
        return None, (
            f"row {row_number}: skipped, invalid category '{shown}' for RIN"
            f" {rin} (expected one of: {', '.join(VALID_CATEGORIES)})"
        )

    provider_code, component = route
    enrollment_codes = split_codes(_text(raw["enrollment_raw"]))
    return (
        {
            "rin": rin,
            "prefix": prefix,
            "provider_code": provider_code,
            "component": component,
            "tariff": _text(raw["tariff"]) or None,
            "enrollment_codes": enrollment_codes,
            "enrollment_json": json.dumps(enrollment_codes, separators=(",", ":")),
            "category": category,
        },
        None,
    )


def normalize_rows(raw_rows: list[dict]) -> tuple[list[dict], list[str]]:
    """Normalize every row and collect one warning per skipped row."""
    rows: list[dict] = []
    skipped: list[str] = []
    first_row: dict[str, int] = {}
    for raw in raw_rows:
        row, warning = parse_row(raw)
        if row is None:
            skipped.append(warning or f"row {raw['row']}: skipped")
            continue
        rin = row["rin"]
        if rin in first_row:
            skipped.append(
                f"row {raw['row']}: skipped, duplicate RIN {rin}"
                f" (first seen on row {first_row[rin]})"
            )
            continue
        first_row[rin] = raw["row"]
        rows.append(row)
    return rows, skipped


def _stored_codes(value: str | None) -> list[str]:
    """Parse the JSON enrollment column, tolerating legacy plain-text values."""
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        parsed = str(value).split(",")
    if not isinstance(parsed, list):
        return []
    return [str(code).strip().upper() for code in parsed if str(code).strip()]


def read_stored(conn: sqlite3.Connection) -> dict[str, dict]:
    """Read the rins table into ``{rin: snapshot}`` for conflict reporting.

    Both active and soft-deleted RINs are returned: the importer is add-only, so
    ``is_active = 0`` is just as much of a conflict as ``is_active = 1``.

    The whole table is read instead of a ``WHERE rin IN (...)`` list: a CSV may
    hold the entire ~1,300 RIN registry, which would exceed SQLite's 999
    bound-variable limit.
    """
    stored: dict[str, dict] = {}
    for row in conn.execute(
        """
        SELECT rin, provider_code, prefix, tariff, enrollment_codes,
               category, is_active, created_at
        FROM rins
        """
    ):
        stored[row["rin"]] = {
            "provider_code": row["provider_code"],
            "prefix": row["prefix"],
            "tariff": row["tariff"] or None,
            "enrollment_codes": _stored_codes(row["enrollment_codes"]),
            "category": row["category"],
            "is_active": row["is_active"],
            "created_at": row["created_at"],
        }
    return stored


def csv_snapshot(row: dict) -> dict:
    """The CSV-owned fields of a planned row, JSON-safe (used in conflicts)."""
    return {
        "tariff": row["tariff"],
        "enrollment_codes": row["enrollment_codes"],
        "category": row["category"],
    }


def db_snapshot(stored: dict) -> dict:
    """The stored fields worth showing next to a conflicting CSV row."""
    return {
        "tariff": stored["tariff"],
        "enrollment_codes": stored["enrollment_codes"],
        "category": stored["category"],
        "is_active": stored["is_active"],
        "created_at": stored["created_at"],
    }


def classify_rows(
    rows: list[dict], stored: dict[str, dict]
) -> tuple[list[dict], list[dict]]:
    """Split the file's rows into ``(ready_to_add, conflicts)``.

    A RIN that exists in ``stored`` is a conflict whether it is active or
    soft-deleted: this importer never updates, reactivates or deletes a row, so
    the database keeps whatever it already has. Each conflict carries the stored
    (``db``) and CSV (``csv``) snapshots, which the CLI prints and the ops API
    returns as JSON.
    """
    ready: list[dict] = []
    conflicts: list[dict] = []
    for row in rows:
        current = stored.get(row["rin"])
        if current is None:
            ready.append(row)
        else:
            conflicts.append(
                {
                    "rin": row["rin"],
                    "csv": csv_snapshot(row),
                    "db": db_snapshot(current),
                }
            )
    return ready, conflicts


def apply_rows(conn: sqlite3.Connection, rows: list[dict]) -> int:
    """Insert ``rows`` as new RINs and return how many were written.

    Every row here is new by construction (``classify_rows`` diverts existing
    RINs to conflicts). ``created_at`` is the UTC import time. New RINs get the
    routed provider and prefix, ``rate_name`` NULL and ``is_active = 1``; no
    existing row is touched. One transaction, so a failure rolls the batch back
    and the database is never left half-imported.
    """
    if not rows:
        return 0
    conn.execute("BEGIN")
    try:
        conn.executemany(
            """
            INSERT INTO rins (
                rin, provider_code, rate_name, tariff, enrollment_codes,
                category, prefix, is_active, created_at
            )
            VALUES (?, ?, NULL, ?, ?, ?, ?, 1, datetime('now'))
            """,
            [
                (
                    row["rin"],
                    row["provider_code"],
                    row["tariff"],
                    row["enrollment_json"],
                    row["category"],
                    row["prefix"],
                )
                for row in rows
            ],
        )
        conn.execute("COMMIT")
    except Exception:  # noqa: BLE001 - roll back on anything, then re-raise
        conn.execute("ROLLBACK")
        raise
    return len(rows)


def _line(label: str, count: int) -> str:
    return f"{label:<{LABEL_WIDTH}}{count:>{COUNT_WIDTH}}"


def _fmt_codes(codes: list[str]) -> str:
    """Enrollment codes for the report: ``CARE, PGE-FS`` or ``(none)``."""
    return ", ".join(codes) if codes else "(none)"


def print_conflicts(conflicts: list[dict]) -> None:
    """List each conflicting RIN with its stored data next to the CSV data."""
    print(f"Conflicts ({len(conflicts)}):")
    if not conflicts:
        print("  (none)")
        return
    for conflict in conflicts:
        db = conflict["db"]
        csv_row = conflict["csv"]
        state = "active" if db["is_active"] else "inactive"
        print(f"  {conflict['rin']} (already in DB, {state})")
        print(
            f"    DB : tariff={db['tariff'] or '(none)'}"
            f"  category={db['category']}"
            f"  enrollment={_fmt_codes(db['enrollment_codes'])}"
            f"  created_at={db['created_at'] or '(none)'}"
        )
        print(
            f"    CSV: tariff={csv_row['tariff'] or '(none)'}"
            f"  category={csv_row['category']}"
            f"  enrollment={_fmt_codes(csv_row['enrollment_codes'])}"
        )


def print_report(
    csv_name: str,
    db_path: Path,
    ready: list[dict],
    conflicts: list[dict],
    skipped: list[str],
) -> None:
    """Print the add-only plan: what is ready, what conflicts, what was skipped."""
    print(f"Import plan for: {csv_name}")
    print(f"Database: {db_path}")
    if ready:
        components = Counter(row["component"] for row in ready)
        breakdown = "  ".join(
            f"{name}={components[name]}"
            for name in COMPONENT_ORDER
            if components.get(name)
        )
        if breakdown:
            print(f"Components: {breakdown}")
    print(_line("Ready to Add:", len(ready)))
    print(_line("Conflicts:", len(conflicts)))
    print(_line("Skipped:", len(skipped)))
    print(SEPARATOR)

    print_conflicts(conflicts)
    print(SEPARATOR)

    print(f"Skipped ({len(skipped)}):")
    if not skipped:
        print("  (none)")
    for message in skipped[:MAX_WARNINGS]:
        print(f"  {message}")
    if len(skipped) > MAX_WARNINGS:
        print(f"  ... and {len(skipped) - MAX_WARNINGS} more.")


def print_next_steps(db_path: Path) -> None:
    """Print the copy-paste commands that push the local database to Fly."""
    print(SEPARATOR)
    print("Next steps (copy-paste):")
    for line in NEXT_STEPS:
        print(line.format(db_path=db_path))


def backup_database(db_path: Path) -> Path:
    """Copy the database next to itself as ``<db>.bak-YYYYMMDD-HHMMSS``."""
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = db_path.with_name(f"{db_path.name}.bak-{stamp}")
    try:
        shutil.copy2(db_path, target)
    except OSError as exc:
        raise SystemExit(f"Could not back up {db_path} to {target}: {exc}") from exc
    return target


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python manage_rins.py",
        description=(
            "Insert new RINs from a CSV file. The importer is add-only: a RIN"
            " that already exists in the database (active or inactive) is"
            " reported as a conflict and never updated."
        ),
    )
    parser.add_argument("csv_path", type=Path, help="path to the CSV file")
    parser.add_argument(
        "--db",
        metavar="PATH",
        help="database file (default: $RIN_WATCH_DB or backend/rin_watch.db)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print Ready to Add / Conflicts / Skipped only: no writes, no backup",
    )
    parser.add_argument(
        "--no-backup",
        action="store_true",
        help="skip the automatic <db>.bak-<timestamp> copy (still writes)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry point; returns the process exit code."""
    args = build_parser().parse_args(argv)
    csv_path = Path(args.csv_path).expanduser()
    if not csv_path.is_file():
        raise SystemExit(f"CSV not found: {csv_path}")

    try:
        raw_rows = read_csv(csv_path)
    except CsvFormatError as exc:
        raise SystemExit(str(exc)) from exc
    rows, skipped = normalize_rows(raw_rows)

    db_path = get_db_path(args.db)
    if not db_path.is_file():
        raise SystemExit(
            f"Database not found: {db_path}. Run `python database.py` first."
        )

    conn = get_connection(db_path)
    try:
        try:
            ready, conflicts = classify_rows(rows, read_stored(conn))
        except sqlite3.OperationalError as exc:
            raise SystemExit(
                f"{db_path} is not an initialized RIN Watch database ({exc})."
                " Run `python database.py` first."
            ) from exc

        print_report(csv_path.name, db_path, ready, conflicts, skipped)
        if args.dry_run:
            print("DRY RUN — no changes written.")
        else:
            if not args.no_backup:
                print(f"Backup written to: {backup_database(db_path)}")
            try:
                added = apply_rows(conn, ready)
            except sqlite3.Error as exc:
                # apply_rows rolls the batch back, so the DB is unchanged.
                raise SystemExit(f"Import failed, nothing committed: {exc}") from exc
            print(
                f"Committed: {added} added,"
                f" {len(conflicts)} conflicts skipped,"
                f" {len(skipped)} skipped"
            )
        print_next_steps(db_path)
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
