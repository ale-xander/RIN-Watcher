#!/usr/bin/env python3
"""Import the PG&E RIN spreadsheet into the RIN Watch database.

The spreadsheet (``MIDAS RIN.xlsx``) has four columns -- ``Seq``, ``RIN``,
``Tariff`` and ``Enrollment Code`` -- and the file is *authoritative*: every RIN
it lists is inserted or refreshed, and every RIN that is active in the database
but absent from the file is soft-deleted (``is_active = 0``). Soft-deleted RINs
keep their status history but disappear from the dashboard.

For each row the importer derives the RIN's prefix and owning provider
(``parse_rin``), the dashboard category (``derive_category``) and a normalized
JSON list of enrollment codes, then writes it through ``upsert_rin``.
``rate_name`` and ``status`` are never touched, so the MIDAS rate names fetched
by ``fetch_data.py`` survive a re-import.

Usage (run from ``backend/`` so that ``database`` is importable)::

    python -m scripts.import_rins "MIDAS RIN.xlsx" --dry-run
    python -m scripts.import_rins "MIDAS RIN.xlsx"

``--dry-run`` is the safe first step: it parses the file, prints the plan and
writes nothing. The flag itself defaults to off, so a plain run writes; real
runs copy the database to ``<db>.bak-YYYYMMDD-HHMMSS`` first unless
``--no-backup`` is passed. The database location is ``--db``, then the
``RIN_WATCH_DB`` environment variable, then ``backend/rin_watch.db``.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sqlite3
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

from openpyxl import load_workbook

from database import (
    PREFIX_TO_PROVIDER,
    derive_category,
    get_connection,
    get_db_path,
    parse_rin,
    upsert_rin,
)

# Columns the importer needs; ``Seq`` and any other extra column is ignored.
REQUIRED_HEADERS = ("RIN", "Tariff", "Enrollment Code")
RIN_PATTERN = re.compile(r"^USCA-[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$")

# Fields compared by the diff; ``rate_name`` and ``status`` are deliberately
# absent because the importer never writes them.
COMPARED_FIELDS = ("prefix", "provider_code", "tariff", "enrollment_codes", "category")
DIFF_KEYS = ("added", "reactivated", "updated", "unchanged", "deactivated")

# Display order of the category breakdown; counts of 0 are hidden.
CATEGORY_ORDER = ("nbt", "ag", "non_res", "resid", "other")
LABEL_WIDTH = 27
COUNT_WIDTH = 3
MAX_WARNINGS = 20


def _text(value: object) -> str:
    """Return ``value`` as stripped text; ``None`` becomes an empty string."""
    if value is None:
        return ""
    return str(value).strip()


def _cell(row: tuple[object, ...], index: int) -> object:
    """Read ``row[index]`` without failing on short rows (read-only sheets)."""
    return row[index] if index < len(row) else None


def read_spreadsheet(path: Path) -> list[dict]:
    """Read the first sheet into plain dicts, one per non-blank data row.

    Header names are matched case-insensitively after stripping, so ``Seq`` and
    any other extra column are ignored. Values are returned untouched -- the
    stripping, upper-casing and splitting happens in ``normalize_row``.
    """
    workbook = load_workbook(path, read_only=True, data_only=True)
    try:
        sheet = workbook.worksheets[0]
        rows = sheet.iter_rows(values_only=True)
        header = next(rows, None)
        columns = {
            _text(value).lower(): position
            for position, value in enumerate(header or ())
            if _text(value)
        }
        missing = [name for name in REQUIRED_HEADERS if name.lower() not in columns]
        if missing:
            raise SystemExit(
                f"{path.name}: missing required column(s): {', '.join(missing)}."
                f" Expected headers: {', '.join(REQUIRED_HEADERS)}."
            )

        rin_at = columns["rin"]
        tariff_at = columns["tariff"]
        enrollment_at = columns["enrollment code"]
        records: list[dict] = []
        for row_number, row in enumerate(rows, start=2):
            rin = _cell(row, rin_at)
            tariff = _cell(row, tariff_at)
            enrollment = _cell(row, enrollment_at)
            if not any(_text(value) for value in (rin, tariff, enrollment)):
                continue
            records.append(
                {
                    "row": row_number,
                    "rin": rin,
                    "tariff": tariff,
                    "enrollment_raw": enrollment,
                }
            )
        return records
    finally:
        workbook.close()


def _split_codes(raw: object) -> list[str]:
    """Split an enrollment cell on commas: stripped, upper-cased, de-duplicated."""
    codes: list[str] = []
    for part in _text(raw).split(","):
        code = part.strip().upper()
        if code and code not in codes:
            codes.append(code)
    return codes


def normalize_row(raw: dict) -> dict | None:
    """Normalize one spreadsheet row, or ``None`` when it carries no RIN.

    A malformed RIN is *not* rejected here: it is returned so the caller can
    report it and the row still lands in the database (with an empty prefix it
    shows up under Misc) instead of vanishing silently.
    """
    rin = _text(raw.get("rin")).upper()
    if not rin:
        return None
    tariff = _text(raw.get("tariff")) or None
    enrollment_codes = _split_codes(raw.get("enrollment_raw"))
    parsed = parse_rin(rin)
    return {
        "rin": rin,
        "tariff": tariff,
        "enrollment_codes": enrollment_codes,
        "enrollment_json": json.dumps(enrollment_codes, separators=(",", ":")),
        "prefix": parsed["prefix"],
        "provider_code": parsed["provider_code"],
        "category": derive_category(tariff, enrollment_codes),
    }


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


def _stored_rows(conn: sqlite3.Connection) -> dict[str, dict]:
    """Read the rins table into ``{rin: comparable state}``."""
    stored: dict[str, dict] = {}
    for row in conn.execute(
        "SELECT rin, prefix, provider_code, tariff, enrollment_codes, category,"
        " is_active FROM rins"
    ):
        stored[row["rin"]] = {
            "prefix": row["prefix"],
            "provider_code": row["provider_code"],
            "tariff": row["tariff"] or None,
            "enrollment_codes": _stored_codes(row["enrollment_codes"]),
            "category": row["category"],
            "is_active": row["is_active"],
        }
    return stored


def diff_against_db(conn: sqlite3.Connection, rows: list[dict]) -> dict:
    """Classify every file row against the database and list the deactivations.

    ``reactivated`` wins over ``updated`` for a soft-deleted RIN: the import
    brings it back, so "changed while hidden" is not interesting. RINs that are
    already inactive and still absent from the file stay out of the diff -- they
    are already deactivated, so nothing changes for them.
    """
    stored = _stored_rows(conn)
    diff: dict[str, list[str] | dict[str, int]] = {key: [] for key in DIFF_KEYS}
    in_file: set[str] = set()

    for row in rows:
        rin = row["rin"]
        in_file.add(rin)
        current = stored.get(rin)
        if current is None:
            diff["added"].append(rin)
        elif not current["is_active"]:
            diff["reactivated"].append(rin)
        elif any(current[field] != row[field] for field in COMPARED_FIELDS):
            diff["updated"].append(rin)
        else:
            diff["unchanged"].append(rin)

    diff["deactivated"] = [
        rin
        for rin, current in stored.items()
        if current["is_active"] and rin not in in_file
    ]

    result: dict = {key: sorted(diff[key]) for key in DIFF_KEYS}
    result["counts"] = {key: len(result[key]) for key in DIFF_KEYS}
    return result


def apply_import(conn: sqlite3.Connection, rows: list[dict], diff: dict) -> None:
    """Deactivate every RIN, then re-upsert the file; one transaction.

    Why "deactivate everything, then upsert" instead of replaying the per-row
    diff: ``upsert_rin`` sets ``is_active`` unconditionally, so the rows in the
    file end up active and everything else stays inactive. That is idempotent,
    reaches the same end state as the diff, and avoids a
    ``WHERE rin NOT IN (?, ?, ...)`` clause, which would blow past SQLite's
    bound-variable limit (999 by default) on a 1000+ RIN list. Deactivating
    instead of deleting keeps ``status`` history, and the following upsert also
    restores RINs that an earlier import soft-deleted.

    The whole import runs in an explicit transaction: any error (unknown
    provider, foreign-key violation, disk full) rolls back the deactivation
    *and* the upserts, so the database is never left half-imported.
    """
    conn.execute("BEGIN")
    try:
        # 1. Deactivate everything that is currently active. The upsert below
        #    will re-activate every RIN present in the file, so this is safe and
        #    avoids a giant "NOT IN (...)" list.
        conn.execute("UPDATE rins SET is_active = 0 WHERE is_active = 1")
        # 2. Upsert every row from the file with is_active=1.
        for row in rows:
            upsert_rin(
                conn,
                rin=row["rin"],
                provider_code=row["provider_code"],
                rate_name=None,  # preserve the fetched rate_name via COALESCE
                tariff=row["tariff"],
                enrollment_codes=row["enrollment_json"],
                category=row["category"],
                prefix=row["prefix"],
                is_active=1,
            )
        conn.execute("COMMIT")
    except Exception:  # noqa: BLE001 - roll back on anything, then re-raise
        conn.execute("ROLLBACK")
        raise


def find_duplicates(rows: list[dict]) -> list[str]:
    """Return RINs that appear more than once in the file, sorted."""
    counts = Counter(row["rin"] for row in rows)
    return sorted(rin for rin, count in counts.items() if count > 1)


def normalize_rows(raw_rows: list[dict]) -> tuple[list[dict], list[str]]:
    """Normalize every row and collect the per-row warnings for the report."""
    rows: list[dict] = []
    warnings: list[str] = []
    for raw in raw_rows:
        row_number = raw["row"]
        row = normalize_row(raw)
        if row is None:
            warnings.append(f"row {row_number}: skipped, no RIN")
            continue

        rin = row["rin"]
        if not RIN_PATTERN.match(rin):
            warnings.append(
                f"row {row_number}: malformed RIN '{rin}'"
                " (expected USCA-XXXX-XXXX-XXXX)"
            )
        if row["prefix"] and row["prefix"].upper() not in PREFIX_TO_PROVIDER:
            warnings.append(
                f"row {row_number}: unknown provider '{row['provider_code']}'"
                f" for RIN {rin}"
            )
        if row["category"] == "other":
            tariff = row["tariff"] or "blank tariff"
            warnings.append(
                f"row {row_number}: category 'other' ({tariff}) for RIN {rin}"
            )
        rows.append(row)
    return rows, warnings


def _line(label: str, count: int) -> str:
    return f"{label:<{LABEL_WIDTH}}{count:>{COUNT_WIDTH}}"


def print_report(
    spreadsheet: Path,
    rows: list[dict],
    diff: dict,
    warnings: list[str],
    quiet: bool,
) -> None:
    """Print the import plan: diff counts, breakdowns and warnings."""
    counts = diff["counts"]
    print(f"Import plan for: {spreadsheet.name}")
    print(_line("Rows in file:", len(rows)))
    print("─" * 32)
    print(_line("Will add:", counts["added"]))
    print(_line("Will reactivate:", counts["reactivated"]))
    print(_line("Will update:", counts["updated"]))
    print(_line("Unchanged:", counts["unchanged"]))
    print(_line("Will deactivate:", counts["deactivated"]))
    print("─" * 32)

    print("Category breakdown (of file rows):")
    categories = Counter(row["category"] for row in rows)
    for name in CATEGORY_ORDER:
        if not categories.get(name):
            continue
        note = "   ← ETOUB / blank-tariff; see warnings" if name == "other" else ""
        print(f"  {name:<8}{categories[name]:>5}{note}")

    print("Provider breakdown (of file rows):")
    providers = Counter(row["provider_code"] for row in rows)
    for code, count in sorted(providers.items(), key=lambda item: (-item[1], item[0])):
        print(f"  {code:<8}{count:>5}")

    if quiet:
        print(f"Warnings ({len(warnings)}) — details hidden by --quiet.")
        return
    print(f"Warnings ({len(warnings)}):")
    if not warnings:
        print("  (none)")
    for message in warnings[:MAX_WARNINGS]:
        print(f"  {message}")
    if len(warnings) > MAX_WARNINGS:
        print(f"  ... and {len(warnings) - MAX_WARNINGS} more.")


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
        prog="python -m scripts.import_rins",
        description="Import the MIDAS RIN spreadsheet into the RIN Watch database.",
    )
    parser.add_argument("spreadsheet", type=Path, help="path to MIDAS RIN.xlsx")
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
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="suppress per-RIN warnings, keep the summary",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry point; returns the process exit code."""
    args = build_parser().parse_args(argv)
    spreadsheet = Path(args.spreadsheet).expanduser()
    if not spreadsheet.is_file():
        raise SystemExit(f"Spreadsheet not found: {spreadsheet}")

    raw_rows = read_spreadsheet(spreadsheet)
    rows, warnings = normalize_rows(raw_rows)
    if not rows:
        raise SystemExit(
            f"{spreadsheet.name}: no RINs found. Refusing to import -- every RIN"
            " would be deactivated."
        )
    duplicates = find_duplicates(rows)
    if duplicates:
        shown = ", ".join(duplicates[:10])
        more = " ..." if len(duplicates) > 10 else ""
        raise SystemExit(
            f"{spreadsheet.name}: duplicate RIN(s) in the file: {shown}{more}."
            " The Seq column should keep every RIN unique."
        )

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

        print_report(spreadsheet, rows, diff, warnings, args.quiet)
        if args.dry_run:
            print("DRY RUN — no changes written.")
            return 0
        if not args.no_backup:
            print(f"Backup written to: {backup_database(db_path)}")

        apply_import(conn, rows, diff)
        counts = diff["counts"]
        print(
            f"Committed: +{counts['added']} ~{counts['updated']}"
            f" -{counts['deactivated']}"
        )
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
