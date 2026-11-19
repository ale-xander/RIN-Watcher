#!/usr/bin/env python3
"""Import the PG&E RIN spreadsheets into the RIN Watch database.

Two files are *authoritative* and together they define the RIN registry:

* ``MIDAS RIN.xlsx`` -- the tariff sheet (``Seq``, ``RIN``, ``Tariff``,
  ``Enrollment Code``). Every RIN it lists is inserted or refreshed with the
  prefix, owning provider, tariff, enrollment codes and dashboard category
  derived from the row.
* ``HFP RINs.xlsx`` -- the Hourly Flex Pricing sheet: one header row, then one
  column per HFP bucket, each cell holding an HFP RIN. Every RIN found there is
  imported as ``provider_code='pge'``, ``category='other'`` and a bucket-aware
  ``rate_name`` (see ``HFP_BUCKETS``) so the dashboard can group the HFP RINs by
  bucket. Its ``prefix`` is deliberately left empty: ``main.py`` splits the
  bundled/unbundled tabs by ``rins.prefix``, so a PGPG/PGXX prefix on an HFP RIN
  would make it appear twice in those component tabs.

Every RIN in either file is active afterwards; every RIN that is active in the
database but in neither file is soft-deleted (``is_active = 0``). Soft-deleted
RINs keep their status history but disappear from the dashboard. ``fetch_data.py``
never registers RINs (it only reads prices for RINs this importer left active),
so an HFP RIN that drops out of the sheet stays deactivated instead of coming
back on the next fetch.

For each tariff row the importer derives the RIN's prefix and owning provider
(``parse_rin``), the dashboard category (``derive_category``) and a normalized
JSON list of enrollment codes, then writes it through ``upsert_rin``. The tariff
``rate_name`` and ``status`` are never touched, so the MIDAS rate names fetched
by ``fetch_data.py`` survive a re-import; the bucket ``rate_name`` of an HFP RIN
is the one exception, and it comes from the HFP sheet.

Excel drops the leading zero from an 8-digit HFP sequence
(``...-38xx-14321101`` instead of ``...-38xx-014321101``), so
``read_hfp_spreadsheet`` left-pads every short sequence back to nine digits and
reports how many it padded.

Usage (run from ``backend/`` so that ``database`` is importable)::

    python -m scripts.import_rins "MIDAS RIN.xlsx" --hfp-input "HFP RINs.xlsx" --dry-run
    python -m scripts.import_rins "MIDAS RIN.xlsx" --hfp-input "HFP RINs.xlsx"

``--dry-run`` is the safe first step: it parses both files, prints the plan and
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
# absent because the tariff sheet never writes them. HFP rate names are fixed by
# the sheet bucket, so they are compared separately (see ``diff_against_db``).
COMPARED_FIELDS = ("prefix", "provider_code", "tariff", "enrollment_codes", "category")
DIFF_KEYS = ("added", "reactivated", "updated", "unchanged", "deactivated")

# HFP sheet layout: column index -> ``rins.rate_name``. The columns are HFP
# buckets rather than tariffs, so the rate name is what the dashboard groups by.
# A cell in an unknown column (a bucket someone added to the sheet) is skipped
# instead of being imported under a made-up rate name.
HFP_BUCKETS = {
    0: "HFP - Bundled Secondary",
    1: "HFP - Bundled Primary",
    2: "HFP - Bundled Transmission",
    3: "HFP - Representative Circuit",
    4: "HFP - CCA Prices",
}
# HFP RINs live in the 38xx series. Excel strips a leading zero from the 8-digit
# sequence, so the captured digits are left-padded back to nine.
HFP_SEQ_PATTERN = re.compile(r"^USCA-(?:PGPG|PGXX)-38\d{2}-(\d+)$")
# HFP is a PG&E rate; the sheet also lists CCA generation prices (XXMB, XXSJ,
# XXPC, ...), which are still read through PG&E's HFP rows.
HFP_PROVIDER_CODE = "pge"

# Display order of the category breakdown; counts of 0 are hidden.
CATEGORY_ORDER = ("nbt", "ag", "non_res", "resid", "other")
# Human-readable names for the category keys; the keys themselves are the
# values stored in the database, so they must not change.
CATEGORY_LABELS = {
    "nbt": "NBT",
    "ag": "AG",
    "non_res": "Non-Residential",
    "resid": "Residential",
    "other": "Other",
}
CATEGORY_LABEL_WIDTH = max(len(label) for label in CATEGORY_LABELS.values()) + 3
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


def read_hfp_spreadsheet(path: Path) -> tuple[list[tuple[str, str]], int]:
    """Read the HFP sheet into ``[(rin, rate_name), ...]`` plus a pad count.

    The sheet is a grid, not a table: row 1 names the buckets, then every cell
    below holds one HFP RIN. A cell is imported when its stripped value starts
    with ``USCA-`` and its column maps to ``HFP_BUCKETS``; cells in any other
    column are skipped. Sequences Excel shortened (``...-38xx-14321101``) are
    left-padded back to nine digits, and the count of padded sequences is
    returned so the report can prove the pre-flight fix ran.

    Duplicate ``(rin, rate_name)`` pairs are dropped in file order. A RIN that
    appears in two buckets is *not* collapsed here: it would give the RIN two
    rate names, so the caller rejects that instead of silently picking one.
    """
    workbook = load_workbook(path, read_only=True, data_only=True)
    try:
        sheet = workbook.worksheets[0]
        entries: list[tuple[str, str]] = []
        seen: set[tuple[str, str]] = set()
        pad_count = 0
        for row in sheet.iter_rows(min_row=2, values_only=True):
            for index, value in enumerate(row):
                rin = _text(value).upper()
                if not rin.startswith("USCA-"):
                    continue
                rate_name = HFP_BUCKETS.get(index)
                if rate_name is None:
                    continue
                match = HFP_SEQ_PATTERN.match(rin)
                if match and len(match.group(1)) < 9:
                    sequence = match.group(1)
                    rin = f"{rin[: -len(sequence)]}{sequence.zfill(9)}"
                    pad_count += 1
                if (rin, rate_name) in seen:
                    continue
                seen.add((rin, rate_name))
                entries.append((rin, rate_name))
        return entries, pad_count
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
    """Read the rins table into ``{rin: comparable state}``.

    ``rate_name`` is read only so the HFP diff can compare a RIN against the
    rate name its sheet bucket maps to; it is not part of ``COMPARED_FIELDS``.
    """
    stored: dict[str, dict] = {}
    for row in conn.execute(
        "SELECT rin, prefix, provider_code, tariff, enrollment_codes, category,"
        " rate_name, is_active FROM rins"
    ):
        stored[row["rin"]] = {
            "prefix": row["prefix"],
            "provider_code": row["provider_code"],
            "tariff": row["tariff"] or None,
            "enrollment_codes": _stored_codes(row["enrollment_codes"]),
            "category": row["category"],
            "rate_name": row["rate_name"],
            "is_active": row["is_active"],
        }
    return stored


def diff_against_db(
    conn: sqlite3.Connection,
    rows: list[dict],
    hfp_entries: list[tuple[str, str]],
) -> dict:
    """Classify both sheets against the database and list the deactivations.

    Tariff rows are compared field by field (``COMPARED_FIELDS``). HFP RINs are
    compared against the rate name their bucket maps to and must stay
    ``category='other'``; their empty prefix and NULL tariff/enrollment codes are
    what the importer writes, so those are not diffed.

    ``reactivated`` wins over ``updated`` for a soft-deleted RIN: the import
    brings it back, so "changed while hidden" is not interesting. RINs that are
    already inactive and in neither sheet stay out of the diff -- they are
    already deactivated, so nothing changes for them. Everything that is active
    and in neither sheet is deactivated, HFP RINs included: they are protected by
    being listed in ``HFP RINs.xlsx``, not by a special case.
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

    for rin, rate_name in hfp_entries:
        in_file.add(rin)
        current = stored.get(rin)
        if current is None:
            diff["added"].append(rin)
        elif not current["is_active"]:
            diff["reactivated"].append(rin)
        elif current["rate_name"] != rate_name or current["category"] != "other":
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


def apply_import(
    conn: sqlite3.Connection,
    rows: list[dict],
    hfp_entries: list[tuple[str, str]],
) -> None:
    """Deactivate every active RIN, then re-upsert both sheets; one transaction.

    Why "deactivate everything, then upsert" instead of replaying the per-row
    diff: ``upsert_rin`` sets ``is_active`` unconditionally, so the RINs in the
    two sheets end up active and everything else stays inactive. That is
    idempotent, reaches the same end state as the diff, and avoids a
    ``WHERE rin NOT IN (?, ?, ...)`` clause, which would blow past SQLite's
    bound-variable limit (999 by default) on a 1000+ RIN list. Deactivating
    instead of deleting keeps ``status`` history, and the following upsert also
    restores RINs that an earlier import soft-deleted.

    HFP RINs are written with ``prefix=''`` on purpose: ``main.py`` splits the
    bundled/unbundled tabs by ``rins.prefix``, so a PGPG/PGXX prefix on an HFP RIN
    would make it show up twice in those component tabs.

    The whole import runs in an explicit transaction: any error (unknown
    provider, foreign-key violation, disk full) rolls back the deactivation
    *and* the upserts, so the database is never left half-imported.
    """
    conn.execute("BEGIN")
    try:
        # 1. Deactivate everything that is currently active. The upserts below
        #    re-activate every RIN present in either sheet, so this is safe and
        #    avoids a giant "NOT IN (...)" list.
        conn.execute("UPDATE rins SET is_active = 0 WHERE is_active = 1")
        # 2. Upsert every tariff row from the main sheet with is_active=1.
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
        # 3. Upsert every HFP RIN under its bucket rate name. ``is_active=1``
        #    restores the rows step 1 just deactivated: the importer, not the
        #    fetch, is the authority on which RINs exist.
        for rin, rate_name in hfp_entries:
            upsert_rin(
                conn,
                rin=rin,
                provider_code=HFP_PROVIDER_CODE,
                rate_name=rate_name,
                tariff=None,
                enrollment_codes=None,
                category="other",
                prefix="",
                is_active=1,
            )
        # ``upsert_rin`` keeps a non-empty stored prefix (NULLIF in the ON
        # CONFLICT branch), so clear it explicitly: a leftover PGPG/PGXX prefix
        # would put the HFP RIN in the bundled/unbundled tabs as well.
        conn.executemany(
            "UPDATE rins SET prefix = '' WHERE rin = ?",
            [(rin,) for rin, _ in hfp_entries],
        )
        conn.execute("COMMIT")
    except Exception:  # noqa: BLE001 - roll back on anything, then re-raise
        conn.execute("ROLLBACK")
        raise


def find_duplicates(rins: list[str]) -> list[str]:
    """Return RINs that appear more than once, sorted."""
    counts = Counter(rins)
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
    hfp_path: Path,
    rows: list[dict],
    hfp_entries: list[tuple[str, str]],
    pad_count: int,
    diff: dict,
    warnings: list[str],
    quiet: bool,
) -> None:
    """Print the import plan: inputs, diff counts, breakdowns and warnings.

    ``Active after import`` is the number of RINs in the two sheets: every one of
    them is upserted active and nothing else survives the import. The category
    and provider breakdowns cover the main sheet only -- HFP RINs have no tariff
    and all belong to PG&E, so they would only add noise there.
    """
    counts = diff["counts"]
    print(f"Import plan for: {spreadsheet.name}")
    print(f"Main: {spreadsheet.name} ({len(rows)} rows)")
    print(
        f"HFP:  {hfp_path.name} ({len(hfp_entries)} RINs,"
        f" {pad_count} seqs left-padded)"
    )
    print(f"Active after import: {len(rows) + len(hfp_entries)}")
    print("─" * 32)
    print(_line("Will add:", counts["added"]))
    print(_line("Will reactivate:", counts["reactivated"]))
    print(_line("Will update:", counts["updated"]))
    print(_line("Unchanged:", counts["unchanged"]))
    print(_line("Will deactivate:", counts["deactivated"]))
    print("─" * 32)

    print("Category breakdown (main sheet):")
    categories = Counter(row["category"] for row in rows)
    for name in CATEGORY_ORDER:
        if not categories.get(name):
            continue
        note = "   ← ETOUB / blank-tariff; see warnings" if name == "other" else ""
        label = CATEGORY_LABELS[name]
        print(f"  {label:<{CATEGORY_LABEL_WIDTH}}{categories[name]:>5}{note}")

    print("Provider breakdown (main sheet):")
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
        description="Import the PG&E RIN spreadsheets into the RIN Watch database.",
    )
    parser.add_argument("spreadsheet", type=Path, help="path to MIDAS RIN.xlsx")
    parser.add_argument(
        "--hfp-input",
        type=Path,
        default=Path("HFP RINs.xlsx"),
        help='path to the HFP RIN sheet (default: "HFP RINs.xlsx" in the cwd)',
    )
    parser.add_argument(
        "--db",
        metavar="PATH",
        help="database file (default: $RIN_WATCH_DB or backend/rin_watch.db)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="parse and diff both sheets only: no writes, no backup",
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
    hfp_path = Path(args.hfp_input).expanduser()
    if not hfp_path.is_file():
        raise SystemExit(f"HFP spreadsheet not found: {hfp_path}")

    raw_rows = read_spreadsheet(spreadsheet)
    rows, warnings = normalize_rows(raw_rows)
    if not rows:
        raise SystemExit(
            f"{spreadsheet.name}: no RINs found. Refusing to import -- every RIN"
            " would be deactivated."
        )
    duplicates = find_duplicates([row["rin"] for row in rows])
    if duplicates:
        shown = ", ".join(duplicates[:10])
        more = " ..." if len(duplicates) > 10 else ""
        raise SystemExit(
            f"{spreadsheet.name}: duplicate RIN(s) in the file: {shown}{more}."
            " The Seq column should keep every RIN unique."
        )

    hfp_entries, pad_count = read_hfp_spreadsheet(hfp_path)
    if not hfp_entries:
        raise SystemExit(
            f"{hfp_path.name}: no HFP RINs found. Refusing to import -- every HFP"
            " RIN would be deactivated."
        )
    # One RIN can only carry one bucket rate name, so a RIN listed twice (in two
    # buckets) is a sheet error, not something to resolve silently.
    hfp_duplicates = find_duplicates([rin for rin, _ in hfp_entries])
    if hfp_duplicates:
        shown = ", ".join(hfp_duplicates[:10])
        more = " ..." if len(hfp_duplicates) > 10 else ""
        raise SystemExit(
            f"{hfp_path.name}: RIN(s) in more than one bucket: {shown}{more}."
            " Each HFP RIN belongs to exactly one bucket column."
        )
    # Both sheets are authoritative; a RIN in both would get conflicting
    # tariff/category data, so the import refuses instead of picking a winner.
    overlap = sorted({row["rin"] for row in rows} & {rin for rin, _ in hfp_entries})
    if overlap:
        shown = ", ".join(overlap[:10])
        more = " ..." if len(overlap) > 10 else ""
        raise SystemExit(
            f"RIN(s) listed in both {spreadsheet.name} and {hfp_path.name}:"
            f" {shown}{more}. Each RIN must come from exactly one sheet."
        )

    db_path = get_db_path(args.db)
    if not db_path.is_file():
        raise SystemExit(
            f"Database not found: {db_path}. Run `python database.py` first."
        )

    conn = get_connection(db_path)
    try:
        try:
            diff = diff_against_db(conn, rows, hfp_entries)
        except sqlite3.OperationalError as exc:
            raise SystemExit(
                f"{db_path} is not an initialized RIN Watch database ({exc})."
                " Run `python database.py` first."
            ) from exc

        print_report(
            spreadsheet,
            hfp_path,
            rows,
            hfp_entries,
            pad_count,
            diff,
            warnings,
            args.quiet,
        )
        if args.dry_run:
            print("DRY RUN — no changes written.")
            return 0
        if not args.no_backup:
            print(f"Backup written to: {backup_database(db_path)}")

        apply_import(conn, rows, hfp_entries)
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
