#!/usr/bin/env python3
"""Upsert RINs from a CSV file into the RIN Watch database.

The database is the source of truth for which RINs exist; this script is an
*additive* maintenance tool, not a mirror of the CSV:

* a RIN that is already in ``rins`` gets its ``tariff``, ``enrollment_codes``
  and ``category`` overwritten from the row (and ``is_active`` set back to 1 if
  it had been soft-deleted);
* a RIN that is missing is inserted with the provider route derived from its
  prefix, ``is_active = 1`` and no ``rate_name`` (MIDAS never writes one, so the
  dashboard falls back to the tariff);
* a RIN that is not in the CSV is left exactly as it is -- nothing is deleted
  or soft-deleted. That is the difference from the retired ``MIDAS RIN.xlsx``
  importer, which treated the sheet as the complete registry.

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
import json
import shutil
import sqlite3
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

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


def read_csv(path: Path) -> list[dict]:
    """Read the CSV into plain dicts, one per row that has any content.

    Header names are matched case-insensitively after stripping, and
    ``utf-8-sig`` consumes a UTF-8 BOM, so a spreadsheet exported with a
    slightly different header casing still imports. Values are returned
    untouched -- stripping and validation happen in ``parse_row``. Blank lines
    are ignored; every other row is kept so it can be warned about.
    """
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.reader(handle)
        try:
            header = next(reader)
        except StopIteration:
            raise SystemExit(f"{path.name}: file is empty.") from None
        columns = {
            _text(name).lower(): position
            for position, name in enumerate(header)
            if _text(name)
        }
        missing = [name for name in REQUIRED_HEADERS if name.lower() not in columns]
        if missing:
            raise SystemExit(
                f"{path.name}: missing required column(s): {', '.join(missing)}."
                f" Expected headers: {', '.join(REQUIRED_HEADERS)}."
            )
        indexes = {name: columns[name.lower()] for name in REQUIRED_HEADERS}

        def cell(row: list[str], name: str) -> str:
            """Read ``row`` at the column position of ``name`` (short rows -> '')."""
            position = indexes[name]
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
    warnings: list[str] = []
    first_row: dict[str, int] = {}
    for raw in raw_rows:
        row, warning = parse_row(raw)
        if row is None:
            warnings.append(warning or f"row {raw['row']}: skipped")
            continue
        rin = row["rin"]
        if rin in first_row:
            warnings.append(
                f"row {raw['row']}: skipped, duplicate RIN {rin}"
                f" (first seen on row {first_row[rin]})"
            )
            continue
        first_row[rin] = raw["row"]
        rows.append(row)
    return rows, warnings


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
    """Read the rins table into ``{rin: {tariff, enrollment_codes, category, is_active}}``.

    The whole table is read instead of a ``WHERE rin IN (...)`` list: a CSV may
    hold the entire ~1,300 RIN registry, which would exceed SQLite's 999
    bound-variable limit.
    """
    stored: dict[str, dict] = {}
    for row in conn.execute(
        "SELECT rin, tariff, enrollment_codes, category, is_active FROM rins"
    ):
        stored[row["rin"]] = {
            "tariff": row["tariff"] or None,
            "enrollment_codes": _stored_codes(row["enrollment_codes"]),
            "category": row["category"],
            "is_active": row["is_active"],
        }
    return stored


def diff_against_db(conn: sqlite3.Connection, rows: list[dict]) -> dict[str, list[str]]:
    """Classify the file's RINs against the database.

    Only the three columns this importer owns are compared, so a re-run of the
    same file reports everything as unchanged even if the row's provider route
    or prefix differs from what is stored (neither is written for an existing
    RIN). ``reactivated`` wins over ``updated``: bringing a soft-deleted RIN
    back is the interesting fact, and its fields are refreshed at the same time.
    """
    stored = read_stored(conn)
    diff: dict[str, list[str]] = {
        "added": [],
        "updated": [],
        "reactivated": [],
        "unchanged": [],
    }
    for row in rows:
        current = stored.get(row["rin"])
        if current is None:
            diff["added"].append(row["rin"])
        elif not current["is_active"]:
            diff["reactivated"].append(row["rin"])
        elif (
            current["tariff"] != row["tariff"]
            or current["enrollment_codes"] != row["enrollment_codes"]
            or current["category"] != row["category"]
        ):
            diff["updated"].append(row["rin"])
        else:
            diff["unchanged"].append(row["rin"])
    return diff


def apply_rows(
    conn: sqlite3.Connection, rows: list[dict], diff: dict[str, list[str]]
) -> None:
    """Insert, update and reactivate the classified rows in one transaction.

    Existing RINs get exactly the CSV-owned columns (``tariff``,
    ``enrollment_codes``, ``category``) plus ``is_active = 1``. Their
    ``provider_code``, ``prefix`` and ``rate_name`` are left alone: the route is
    only needed to create a row, and ``rate_name`` may carry the fetched MIDAS
    or HFP bucket name. New RINs are inserted with the routed provider and
    prefix, ``rate_name`` NULL and ``is_active = 1``.

    No row outside the file is touched, and an error rolls the whole batch back
    so the database is never left half-imported.
    """
    by_rin = {row["rin"]: row for row in rows}
    conn.execute("BEGIN")
    try:
        for rin in diff["added"]:
            row = by_rin[rin]
            conn.execute(
                """
                INSERT INTO rins (
                    rin, provider_code, rate_name, tariff, enrollment_codes,
                    category, prefix, is_active
                )
                VALUES (?, ?, NULL, ?, ?, ?, ?, 1)
                """,
                (
                    row["rin"],
                    row["provider_code"],
                    row["tariff"],
                    row["enrollment_json"],
                    row["category"],
                    row["prefix"],
                ),
            )
        for rin in (*diff["updated"], *diff["reactivated"]):
            row = by_rin[rin]
            conn.execute(
                """
                UPDATE rins
                   SET tariff = ?, enrollment_codes = ?, category = ?,
                       is_active = 1
                 WHERE rin = ?
                """,
                (
                    row["tariff"],
                    row["enrollment_json"],
                    row["category"],
                    row["rin"],
                ),
            )
        conn.execute("COMMIT")
    except Exception:  # noqa: BLE001 - roll back on anything, then re-raise
        conn.execute("ROLLBACK")
        raise


def _line(label: str, count: int) -> str:
    return f"{label:<{LABEL_WIDTH}}{count:>{COUNT_WIDTH}}"


def print_report(
    csv_path: Path,
    db_path: Path,
    rows: list[dict],
    diff: dict[str, list[str]],
    warnings: list[str],
) -> None:
    """Print the import plan and one warning line per skipped row."""
    counts = {key: len(value) for key, value in diff.items()}
    print(f"Import plan for: {csv_path.name}")
    print(f"Database: {db_path}")
    if rows:
        components = Counter(row["component"] for row in rows)
        breakdown = "  ".join(
            f"{name}={components[name]}"
            for name in COMPONENT_ORDER
            if components.get(name)
        )
        print(f"Components: {breakdown}")
    print(_line("Added:", counts["added"]))
    print(_line("Updated:", counts["updated"]))
    print(_line("Reactivated:", counts["reactivated"]))
    print(_line("Skipped:", len(warnings)))
    print(_line("Unchanged:", counts["unchanged"]))
    print(SEPARATOR)

    print(f"Warnings ({len(warnings)}):")
    if not warnings:
        print("  (none)")
    for message in warnings[:MAX_WARNINGS]:
        print(f"  {message}")
    if len(warnings) > MAX_WARNINGS:
        print(f"  ... and {len(warnings) - MAX_WARNINGS} more.")


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
            "Upsert RINs from a CSV file. The importer is additive: RINs that"
            " are not in the file are never deleted or soft-deleted."
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
        help="parse and diff only: no writes, no backup",
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

    raw_rows = read_csv(csv_path)
    rows, warnings = normalize_rows(raw_rows)

    db_path = get_db_path(args.db)
    if not db_path.is_file():
        raise SystemExit(
            f"Database not found: {db_path}. Run `python database.py` first."
        )

    conn = get_connection(db_path)
    try:
        try:
            diff = diff_against_db(conn, rows)
        except sqlite3.OperationalError as exc:
            raise SystemExit(
                f"{db_path} is not an initialized RIN Watch database ({exc})."
                " Run `python database.py` first."
            ) from exc

        print_report(csv_path, db_path, rows, diff, warnings)
        if args.dry_run:
            print("DRY RUN — no changes written.")
        else:
            if not args.no_backup:
                print(f"Backup written to: {backup_database(db_path)}")
            apply_rows(conn, rows, diff)
            counts = {key: len(value) for key, value in diff.items()}
            print(
                f"Committed: +{counts['added']} added,"
                f" ~{counts['updated']} updated,"
                f" ^{counts['reactivated']} reactivated,"
                f" {len(warnings)} skipped"
            )
        print_next_steps(db_path)
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
