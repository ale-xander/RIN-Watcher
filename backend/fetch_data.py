#!/usr/bin/env python3
"""Fetch realtime MIDAS values for the RINs the importer registered.

The RIN list itself comes from the API: one ``GET /api/valuedata?SignalType=1``
request returns every rate plan MIDAS knows about under a ``Rates`` key. Only the
entries whose ``RateID`` starts with a watched prefix are kept — PG&E's
``USCA-PGPG`` / ``USCA-PGXX`` plus the CCA-owned generation halves
(``USCA-XXMB``, ``USCA-XXSJ``, ``USCA-XXPC``, ...). Test RINs (``RateID`` ending
in ``-TEST``) are dropped: the ``-0000`` variants carry the real values.

The importer (``scripts/import_rins.py``) owns the RIN registry. This script
never registers a RIN: it reads prices only for RINs the importer created and
left active, and reports the rest as ``unknown`` (not in the database yet) or
``inactive`` (soft-deleted by an import that dropped them). Without that guard a
fetch would resurrect every RIN MIDAS still lists -- including HFP RINs that were
removed from the HFP sheet -- and the active count would grow on every run.

For each such RIN the script records whether it published at least one non-null
value for today (America/Los_Angeles) in the ``status`` table. Test RINs
(``-TEST``) already in the database are deleted on every run, with their
``status`` rows; real RINs that dropped out of the list are kept.

Usage:
    python fetch_data.py [--db /path/to/rin_watch.db]
    python fetch_data.py --clean-test-rins [--db /path/to/rin_watch.db]

The database location is resolved as: ``--db`` argument, then the
``RIN_WATCH_DB`` environment variable (set to ``/data/rin_watch.db`` in
production), then ``backend/rin_watch.db``. ``main.py`` uses the same helper,
so the API server always reads the file this script writes.

Only one fetch runs at a time: an ``fcntl.flock`` on ``<database>.fetch.lock``
(see ``acquire_fetch_lock``) is shared with the API server and its workers, so
a run started while another one is in flight exits with a non-zero status
instead of hammering MIDAS and fighting over the same SQLite file.
"""

from __future__ import annotations

import argparse
import fcntl
import math
import sys
import time
from contextlib import closing
from datetime import UTC, date, datetime
from pathlib import Path
from typing import IO, Any

import pytz
import requests
from dotenv import load_dotenv

from database import (
    BACKEND_DIR,
    DbPath,
    delete_test_rins,
    get_connection,
    get_db_path,
    get_fetch_lock_path,
    init_db,
    save_status,
)

load_dotenv(BACKEND_DIR / ".env")

API_URL = "https://midasapi.energy.ca.gov/api/valuedata"
PACIFIC = pytz.timezone("America/Los_Angeles")
RIN_LIST_SIGNAL_TYPE = 1  # SignalType value that returns the full RIN list
# Rate plans this fetcher reads. PGPG/PGXX are PG&E-owned (bundled delivery +
# generation / unbundled delivery); the XX* prefixes are the CCA-owned generation
# halves (XXMB = MCE, XXSJ = SJCE, XXPC = PCE, ...). MIDAS lists all of them
# under SignalType=1, so one list request covers every provider we track.
RIN_ID_PREFIXES = (
    "USCA-PGPG",
    "USCA-PGXX",
    "USCA-XXMB",
    "USCA-XXSJ",
    "USCA-XXPC",
    "USCA-XXPR",
    "USCA-XXVC",
    "USCA-XXEB",
    "USCA-XXSV",
    "USCA-XXCA",
    "USCA-XXMC",
)
RIN_TEST_SUFFIX = "-TEST"  # e.g. USCA-PGXX-4004-TEST; only -0000 variants are real
REQUEST_TIMEOUT = 30  # seconds
RIN_LIST_TIMEOUT = 120  # seconds; the full RIN list is roughly 14 MB
MAX_ATTEMPTS = 3
RETRY_BACKOFF = 2.0  # seconds, multiplied by the attempt number
USER_AGENT = "RIN-Watch/0.1"


class FetchAlreadyRunning(RuntimeError):
    """Another process holds the fetch lock for this database."""


def acquire_fetch_lock(db_path: DbPath = None) -> IO[str]:
    """Take the cross-process fetch lock, or raise :class:`FetchAlreadyRunning`.

    ``fcntl.flock`` is tied to the open file rather than to the process, so the
    API server, every one of its workers and the ``fetch_data.py`` CLI contend
    for the same lock file. A ``threading.Lock`` would only guard one process.

    Returns the open handle that owns the lock; the caller must pass it to
    :func:`release_fetch_lock` when the fetch is done.
    """
    lock_path = get_fetch_lock_path(db_path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(lock_path, "a+")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        raise FetchAlreadyRunning(f"another fetch holds {lock_path}") from None
    return handle


def release_fetch_lock(handle: IO[str]) -> None:
    """Unlock and close a handle returned by :func:`acquire_fetch_lock`."""
    try:
        fcntl.flock(handle, fcntl.LOCK_UN)
    finally:
        handle.close()


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

    MIDAS wraps the list in a ``Rates`` key. Only the watched prefixes (PG&E's
    ``USCA-PGPG`` / ``USCA-PGXX`` and the CCA-owned ``USCA-XX*`` plans) are
    kept, and test RINs (``RateID`` ending in ``-TEST``) are ignored — the
    ``-0000`` variants hold the real values, so ``USCA-PGXX-4004-TEST`` is
    dropped while ``USCA-PGXX-4004-0000`` is kept.
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
        f"RIN list: kept {len(rows)}, skipped {skipped_prefix} outside the "
        f"watched prefixes, {skipped_test} test, {duplicates} duplicate",
        flush=True,
    )
    return rows


def fetch_rin_list(session: requests.Session) -> list[tuple[str, str]]:
    """GET every RIN MIDAS knows about and keep the watched rate plans."""
    payload = _get_json(
        session,
        {"SignalType": RIN_LIST_SIGNAL_TYPE},
        "RIN list",
        timeout=RIN_LIST_TIMEOUT,
    )
    return rin_entries(payload)


def process(db_path: Path | None = None, lock: IO[str] | None = None) -> int:
    """Fetch the RIN list, then read realtime values for the registered ones.

    Only RINs that already exist in ``rins`` with ``is_active = 1`` are fetched;
    unknown and inactive RINs are counted and skipped (see the module docstring).
    Returns a shell exit code.

    ``lock`` is a handle from :func:`acquire_fetch_lock`. When omitted the fetch
    takes the lock itself (and raises :class:`FetchAlreadyRunning` if another
    process holds it); the API passes the handle it already acquired, so the
    endpoint and its background worker share one lock.
    """
    handle = lock
    if handle is None:
        handle = acquire_fetch_lock(db_path)
    try:
        return _process_locked(db_path)
    finally:
        if lock is None:
            release_fetch_lock(handle)


def _process_locked(db_path: Path | None = None) -> int:
    """The fetch itself; the caller must hold the fetch lock."""
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
        print("No RINs matched the watched prefixes - nothing to do.")
        return 0

    db_file = init_db(db_path)
    target_date = today_pacific()
    print(
        f"RIN Watch fetch | providers=PG&E + CCA | "
        f"checking values for {target_date.isoformat()} (America/Los_Angeles)"
    )
    print(f"Database: {db_file}")
    print(f"RINs: {total}\n", flush=True)

    failures = 0
    with_value = 0
    skipped_not_in_db: list[str] = []
    skipped_inactive: list[str] = []

    with closing(get_connection(db_path)) as conn:
        removed = delete_test_rins(conn)
        conn.commit()
        if removed:
            print(
                f"Deleted {removed} test RIN(s) ending in {RIN_TEST_SUFFIX} "
                "from the database",
                flush=True,
            )

        for index, (rin, _) in enumerate(entries, start=1):
            prefix = f"[{index}/{total}] {rin}"
            try:
                # The importer owns the registry, so do not write the rins table
                # here: a registration would resurrect RINs an import
                # deliberately deactivated and the active count would grow on
                # every fetch. MIDAS rate names are not stored either -- the HFP
                # sheet owns the 'HFP - <bucket>' names, so a fetch must never
                # rename a RIN. This loop only records status.
                existing = conn.execute(
                    "SELECT is_active FROM rins WHERE rin = ?", (rin,)
                ).fetchone()
                if existing is None:
                    skipped_not_in_db.append(rin)
                    continue
                if existing[0] == 0:
                    skipped_inactive.append(rin)
                    continue

                payload = fetch_rate(session, rin)
                has_value, dated, valued = evaluate_payload(payload, target_date)
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

    attempted = total - len(skipped_not_in_db) - len(skipped_inactive)
    if skipped_not_in_db or skipped_inactive:
        print(
            f"\nSkipped {len(skipped_not_in_db)} RIN(s) not in the database, "
            f"{len(skipped_inactive)} deactivated by an import"
        )
        for label, rins in (
            ("not in the database", skipped_not_in_db),
            ("deactivated", skipped_inactive),
        ):
            if rins:
                print(f"  {label} (first 5): {', '.join(rins[:5])}")
    print(
        f"Done: {attempted - failures}/{attempted} RINs updated, "
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
    try:
        return process(db_path)
    except FetchAlreadyRunning as exc:
        print(f"already running: {exc}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
