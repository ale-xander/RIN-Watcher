#!/usr/bin/env python3
"""Fetch realtime MIDAS values for every PG&E RIN published by the MIDAS API.

The RIN list itself now comes from the API: one ``GET /api/valuedata?SignalType=1``
request returns every rate plan MIDAS knows about under a ``Rates`` key. Only the
entries whose ``RateID`` starts with ``USCA-PGPG`` or ``USCA-PGXX`` (PG&E) are
kept, and test RINs (``RateID`` ending in ``-TEST``) are dropped: the ``-0000``
variants carry the real values. Each remaining RIN is then queried for its latest
values and the script records whether it published at least one non-null value
for today (America/Los_Angeles) in the ``status`` table. Any test RIN already in
the database is deleted on every run (real RINs that dropped out of the list are
kept).

Usage:
    python fetch_data.py [--db /path/to/rin_watch.db]
    python fetch_data.py --clean-test-rins [--db /path/to/rin_watch.db]

The database location is resolved as: ``--db`` argument, then the
``RIN_WATCH_DB`` environment variable (set to ``/data/rin_watch.db`` in
production), then ``backend/rin_watch.db``. ``main.py`` uses the same helper,
so the API server always reads the file this script writes.
"""

from __future__ import annotations

import argparse
import math
import sys
import time
from contextlib import closing
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import pytz
import requests
from dotenv import load_dotenv

from database import (
    BACKEND_DIR,
    delete_test_rins,
    get_connection,
    get_db_path,
    init_db,
    save_status,
    upsert_rin,
)

load_dotenv(BACKEND_DIR / ".env")

API_URL = "https://midasapi.energy.ca.gov/api/valuedata"
PROVIDER_CODE = "pge"  # hardcoded for now
PACIFIC = pytz.timezone("America/Los_Angeles")
RIN_LIST_SIGNAL_TYPE = 1  # SignalType value that returns the full RIN list
RIN_ID_PREFIXES = ("USCA-PGPG", "USCA-PGXX")  # PG&E rate plan IDs
RIN_TEST_SUFFIX = "-TEST"  # e.g. USCA-PGXX-4004-TEST; only -0000 variants are real
REQUEST_TIMEOUT = 30  # seconds
RIN_LIST_TIMEOUT = 120  # seconds; the full RIN list is roughly 14 MB
MAX_ATTEMPTS = 3
RETRY_BACKOFF = 2.0  # seconds, multiplied by the attempt number
USER_AGENT = "RIN-Watch/0.1"


def today_pacific() -> date:
    """Today's date in the Pacific timezone (MIDAS dates are local dates)."""
    return datetime.now(PACIFIC).date()


def utc_timestamp() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def parse_date_start(raw: Any) -> date | None:
    """Return the Pacific date for a DateStart value, or None if unparseable."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    text = raw.strip()
    try:
        if len(text) == 10:  # MIDAS realtime rows use "YYYY-MM-DD"
            return date.fromisoformat(text)
        moment = datetime.fromisoformat(text)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = PACIFIC.localize(moment)
    return moment.astimezone(PACIFIC).date()


def is_value_present(raw: Any) -> bool:
    """True when the API actually published a value (0 is a valid value)."""
    if raw is None:
        return False
    if isinstance(raw, float) and math.isnan(raw):
        return False
    if isinstance(raw, str):
        return raw.strip().lower() not in ("", "null", "none", "n/a")
    return True


def value_entries(payload: Any) -> list[dict[str, Any]]:
    """MIDAS returns rows under ValueInformation; some payloads use ValueData."""
    if not isinstance(payload, dict):
        return []
    for key in ("ValueInformation", "ValueData"):
        entries = payload.get(key)
        if isinstance(entries, list):
            return [entry for entry in entries if isinstance(entry, dict)]
    return []


def evaluate_payload(payload: Any, target_date: date) -> tuple[bool, int, int]:
    """Return (has_value_today, entries_for_date, entries_with_value)."""
    entries_for_date = 0
    entries_with_value = 0
    for entry in value_entries(payload):
        if parse_date_start(entry.get("DateStart")) != target_date:
            continue
        entries_for_date += 1
        if is_value_present(entry.get("Value")):
            entries_with_value += 1
    return entries_with_value > 0, entries_for_date, entries_with_value


def _error_detail(response: requests.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return (response.text or "").strip()[:200] or "<empty response>"
    if isinstance(body, dict) and body.get("detail"):
        return str(body["detail"])[:200]
    return str(body)[:200]


def _get_json(
    session: requests.Session,
    params: dict[str, Any],
    what: str,
    timeout: int = REQUEST_TIMEOUT,
) -> Any:
    """GET API_URL with ``params``, retrying transient failures.

    ``what`` labels the request in error messages (the RIN, or "RIN list").
    """
    last_error = "unknown error"
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            response = session.get(API_URL, params=params, timeout=timeout)
        except requests.RequestException as exc:
            last_error = f"{type(exc).__name__}: {exc}"
        else:
            if response.status_code == 200:
                try:
                    return response.json()
                except ValueError as exc:
                    last_error = f"invalid JSON in response ({exc})"
            else:
                last_error = f"HTTP {response.status_code}: {_error_detail(response)}"
                # Unknown/malformed requests will never succeed, so don't retry them.
                if 400 <= response.status_code < 500 and response.status_code != 429:
                    raise RuntimeError(f"{what}: {last_error}")
        if attempt < MAX_ATTEMPTS:
            time.sleep(RETRY_BACKOFF * attempt)
    raise RuntimeError(f"{what}: gave up after {MAX_ATTEMPTS} attempts: {last_error}")


def fetch_rate(session: requests.Session, rin: str) -> Any:
    """GET the realtime values for one RIN, retrying transient failures."""
    return _get_json(session, {"ID": rin, "QueryType": "realtime"}, rin)


def entry_rate_name(entry: dict[str, Any]) -> str:
    """Human readable rate name for a RIN list entry.

    The list endpoint exposes it as ``RateName``; the realtime endpoint uses the
    same key. ``Description`` is the fallback for list payloads that omit it
    (e.g. "TOUC - TOU").
    """
    for key in ("RateName", "Description"):
        value = entry.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def rin_entries(payload: Any) -> list[tuple[str, str]]:
    """Extract (rin, rate_name) pairs from the RIN list payload.

    MIDAS wraps the list in a ``Rates`` key. Only PG&E rate plans (``RateID``
    starting with USCA-PGPG / USCA-PGXX) are kept, and test RINs (``RateID``
    ending in ``-TEST``) are ignored — the ``-0000`` variants hold the real
    values, so ``USCA-PGXX-4004-TEST`` is dropped while ``USCA-PGXX-4004-0000``
    is kept.
    """
    if not isinstance(payload, dict):
        raise TypeError("unexpected RIN list payload (expected a JSON object)")
    rates = payload.get("Rates")
    if not isinstance(rates, list):
        raise TypeError("RIN list payload is missing the 'Rates' array")

    rows: list[tuple[str, str]] = []
    seen: set[str] = set()
    skipped_prefix = 0
    skipped_test = 0
    duplicates = 0
    for entry in rates:
        if not isinstance(entry, dict):
            continue
        rin = str(entry.get("RateID") or "").strip().upper()
        if not rin:
            continue
        if not rin.startswith(RIN_ID_PREFIXES):
            skipped_prefix += 1
            continue
        if rin.endswith(RIN_TEST_SUFFIX):
            skipped_test += 1
            continue
        if rin in seen:
            duplicates += 1
            continue
        seen.add(rin)
        rows.append((rin, entry_rate_name(entry)))

    print(
        f"RIN list: kept {len(rows)}, skipped {skipped_prefix} non-PG&E, "
        f"{skipped_test} test, {duplicates} duplicate",
        flush=True,
    )
    return rows


def fetch_rin_list(session: requests.Session) -> list[tuple[str, str]]:
    """GET every RIN MIDAS knows about and keep the PG&E rate plans."""
    payload = _get_json(
        session,
        {"SignalType": RIN_LIST_SIGNAL_TYPE},
        "RIN list",
        timeout=RIN_LIST_TIMEOUT,
    )
    return rin_entries(payload)


def process(db_path: Path | None = None) -> int:
    """Fetch the RIN list, then run the realtime fetch for every RIN.

    Returns a shell exit code.
    """
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT

    print(
        f"Fetching RIN list from MIDAS (SignalType={RIN_LIST_SIGNAL_TYPE}, "
        f"keeping {', '.join(RIN_ID_PREFIXES)}) ...",
        flush=True,
    )
    try:
        entries = fetch_rin_list(session)
    except (RuntimeError, TypeError) as exc:
        print(f"error: could not load the RIN list: {exc}", file=sys.stderr)
        return 1

    total = len(entries)
    if total == 0:
        print("No RINs matched the PG&E prefixes - nothing to do.")
        return 0

    db_file = init_db(db_path)
    target_date = today_pacific()
    print(
        f"RIN Watch fetch | provider={PROVIDER_CODE} | "
        f"checking values for {target_date.isoformat()} (America/Los_Angeles)"
    )
    print(f"Database: {db_file}")
    print(f"RINs: {total}\n", flush=True)

    failures = 0
    with_value = 0

    with closing(get_connection(db_path)) as conn:
        removed = delete_test_rins(conn)
        conn.commit()
        if removed:
            print(
                f"Deleted {removed} test RIN(s) ending in {RIN_TEST_SUFFIX} "
                "from the database",
                flush=True,
            )

        for index, (rin, rate_name) in enumerate(entries, start=1):
            prefix = f"[{index}/{total}] {rin}"
            try:
                # Register the RIN up front so a failed fetch still shows up on
                # the dashboard instead of silently disappearing from the list.
                upsert_rin(conn, rin, PROVIDER_CODE, rate_name or None)
                conn.commit()

                payload = fetch_rate(session, rin)
                has_value, dated, valued = evaluate_payload(payload, target_date)
                api_rate_name = (
                    payload.get("RateName") if isinstance(payload, dict) else None
                )
                if not rate_name and api_rate_name:
                    upsert_rin(
                        conn, rin, PROVIDER_CODE, str(api_rate_name).strip() or None
                    )
                save_status(
                    conn,
                    rin,
                    has_value,
                    utc_timestamp(),
                    target_date.isoformat() if has_value else None,
                )
                conn.commit()
            except (RuntimeError, requests.RequestException) as exc:
                conn.rollback()
                failures += 1
                print(f"{prefix}: ERROR {exc}", file=sys.stderr, flush=True)
                continue
            except Exception as exc:  # noqa: BLE001 - one bad RIN must not stop the batch
                conn.rollback()
                failures += 1
                print(
                    f"{prefix}: ERROR {type(exc).__name__}: {exc}",
                    file=sys.stderr,
                    flush=True,
                )
                continue

            if has_value:
                with_value += 1
                detail = f"{valued}/{dated} entries for {target_date.isoformat()} have a value"
            elif dated:
                detail = (
                    f"{dated} entries for {target_date.isoformat()}, none with a value"
                )
            else:
                detail = f"no entries dated {target_date.isoformat()}"
            print(f"{prefix}: has_value_today={int(has_value)} ({detail})", flush=True)

    print(
        f"\nDone: {total - failures}/{total} RINs updated, "
        f"{with_value} with a value today, {failures} error(s)."
    )
    return 0 if failures == 0 else 1


def clean_test_rins(db_path: Path | None = None) -> int:
    """Delete every RIN ending in ``RIN_TEST_SUFFIX`` from the database.

    Only test RINs are removed; real RINs are never pruned. Returns a shell exit
    code.
    """
    db_file = init_db(db_path)
    with closing(get_connection(db_path)) as conn:
        removed = delete_test_rins(conn)
        conn.commit()

    print(f"Database: {db_file}")
    if removed:
        print(f"Deleted {removed} test RIN(s) ending in {RIN_TEST_SUFFIX}.")
    else:
        print(f"No RINs ending in {RIN_TEST_SUFFIX} found - nothing to delete.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Fetch realtime MIDAS values and update RIN Watch status."
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=None,
        help="SQLite database path (default: RIN_WATCH_DB or backend/rin_watch.db)",
    )
    parser.add_argument(
        "--clean-test-rins",
        action="store_true",
        help=(
            f"only delete RINs ending in {RIN_TEST_SUFFIX} from the database, then exit "
            "(also happens automatically on every fetch)"
        ),
    )
    args = parser.parse_args(argv)
    # Single resolution point for the whole script: --db, else RIN_WATCH_DB,
    # else backend/rin_watch.db. main.py calls the same helper.
    db_path = get_db_path(args.db)
    if args.clean_test_rins:
        return clean_test_rins(db_path)
    return process(db_path)


if __name__ == "__main__":
    sys.exit(main())
