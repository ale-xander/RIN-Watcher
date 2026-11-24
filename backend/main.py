"""RIN Watch FastAPI application.

Exposes the dashboard payload consumed by the Next.js frontend.
Run with:  uvicorn main:app --reload --port 8000

GET /api/providers lists the provider tabs that have active RINs.
GET /api/dashboard/{provider_code} returns one provider's status summary; pass
``?component=bundled``, ``?component=unbundled`` or ``?component=hfp`` to split
PG&E's PGPG/PGXX RINs and its HFP (Hourly Flex Pricing) RINs. ``?component=all``
(or no component at all) returns the provider-wide snapshot and tags every RIN
with its own ``component``.
POST /api/admin/fetch queues a MIDAS fetch in the background; it is guarded by
the FETCH_SECRET environment variable and returns 202 immediately.

GET /api/regressions compares the two newest ``status_history`` snapshots --
``fetch_data.process`` writes one before each fetch -- and reports the RINs
that lost a value (regressions) and the ones that gained one (recoveries).

POST /api/ops/preview and POST /api/ops/commit accept the add-only RIN CSV as a
FormData field named ``file`` and require the ADMIN_PASSWORD environment variable
in the ``X-Admin-Token`` header. Preview runs the importer's dry run; commit
inserts the new RINs and reports conflicts/skips.
"""

from __future__ import annotations

import hmac
import json
import os
import sqlite3
import sys
from contextlib import asynccontextmanager, closing
from datetime import datetime
from pathlib import Path
from typing import IO, Annotated, Any

import pytz
from dotenv import load_dotenv
from fastapi import (
    BackgroundTasks,
    FastAPI,
    File,
    Header,
    HTTPException,
    Query,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware

import fetch_data
from database import (
    BACKEND_DIR,
    get_connection,
    get_db_path,
    init_db,
    latest_snapshot_times,
)
from scripts.manage_rins import (
    CsvFormatError,
    apply_rows,
    classify_rows,
    normalize_rows,
    read_csv_text,
    read_stored,
)

load_dotenv(BACKEND_DIR / ".env")

PACIFIC = pytz.timezone("America/Los_Angeles")

DEFAULT_CORS_ORIGINS = "http://localhost:3000,http://127.0.0.1:3000"

# Shared secret required by POST /api/admin/fetch. When unset the endpoint is
# disabled (503) instead of running with an empty, guessable token.
FETCH_SECRET = os.getenv("FETCH_SECRET", "").strip()

# Ops API (/api/ops/*) authentication. The value is read per request so a
# rotated ADMIN_PASSWORD takes effect without a restart; unset disables the
# endpoints (503) instead of accepting an empty token.
ADMIN_TOKEN_HEADER = "X-Admin-Token"

# The whole RIN registry is ~1,300 rows, so a few MB is already generous. The
# limit keeps a mistaken upload from filling the request buffer.
MAX_OPS_UPLOAD_BYTES = 5 * 1024 * 1024

# Tab labels rendered by the frontend. A provider code missing from this map
# (e.g. a new CCA that shows up in the spreadsheet) still gets a tab: the code
# itself is upper-cased instead of being dropped.
PROVIDER_LABELS = {
    "pge": "PG&E",
    "mce": "MCE",
    "sjce": "SJCE",
    "pce": "PCE",
}

# PG&E RINs are split across three tabs: PGPG is bundled (PG&E supplies both
# delivery and generation), PGXX is unbundled (a CCA supplies the generation;
# the RIN itself is still owned/fetched by PG&E) and HFP is the Hourly Flex
# Pricing rate. HFP RINs come from ``HFP RINs.xlsx`` and carry a bucket-aware
# rate name (``HFP - Bundled Secondary``, ``HFP - CCA Prices``, ...) instead of a
# tariff, so the tab is selected by rate-name prefix. CCAs have no such split, so
# ``?component=`` is ignored for them.
PGE_PROVIDER_CODE = "pge"
COMPONENT_PREFIXES = {"bundled": "PGPG", "unbundled": "PGXX"}
HFP_COMPONENT = "hfp"
ALL_COMPONENT = "all"
# Prefix shared by every HFP rate name; the per-bucket suffix depends on the
# sheet column ("HFP - Bundled Primary", "HFP - CCA Prices", ...).
HFP_RATE_PREFIX = "HFP - "
# HFP RINs have no ``rins.prefix``, so the 38xx series that carries the HFP rate
# names is the fallback for rows that predate the HFP import (rate name used to be
# the single ``HFP - RTP``).
HFP_RIN_PREFIXES = ("USCA-PGPG-38", "USCA-PGXX-38")
# Tab order advertised by /api/providers and accepted by /api/dashboard.
PGE_COMPONENTS = (*COMPONENT_PREFIXES, HFP_COMPONENT)
# ``all`` is accepted by /api/dashboard only (it is not a tab).
DASHBOARD_COMPONENTS = (*PGE_COMPONENTS, ALL_COMPONENT)

# One fetch at a time: concurrent runs would fight over the same SQLite file and
# hammer the MIDAS API. The guard is an fcntl.flock on a file next to the
# database (see fetch_data.acquire_fetch_lock), not an in-process lock, so the
# fetch_data.py CLI and every API worker share it. Acquired by the endpoint,
# released by the worker.

# Resolved once at import time: RIN_WATCH_DB when set (e.g. /data/rin_watch.db
# on Render), otherwise backend/rin_watch.db. fetch_data.py resolves the same
# way, so the API server and the fetch script always open the same SQLite file.
DB_PATH = get_db_path()


def _normalize_origin(origin: str) -> str:
    """Trim whitespace and a trailing slash ('https://app.io/' -> 'https://app.io')."""
    return origin.strip().rstrip("/")


def _cors_origins() -> list[str]:
    """Browser origins allowed to call the API: CORS_ORIGINS plus FRONTEND_URL."""
    raw = os.getenv("CORS_ORIGINS", DEFAULT_CORS_ORIGINS)
    origins: list[str] = []
    for origin in raw.split(","):
        normalized = _normalize_origin(origin)
        if normalized and normalized not in origins:
            origins.append(normalized)
    if not origins:
        origins = [_normalize_origin(DEFAULT_CORS_ORIGINS.split(",")[0])]

    frontend_url = _normalize_origin(os.getenv("FRONTEND_URL", ""))
    if frontend_url and frontend_url not in origins:
        origins.append(frontend_url)
    return origins


@asynccontextmanager
async def lifespan(_: FastAPI):
    db_path = init_db(DB_PATH)
    print(f"RIN Watch API: using database at {db_path}", flush=True)
    yield


app = FastAPI(title="RIN Watch API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _format_date(value: str | None) -> str | None:
    """'2026-11-08' -> 'Nov 8, 2026'."""
    if not value:
        return None
    try:
        day = datetime.strptime(str(value)[:10], "%Y-%m-%d")
    except ValueError:
        return None
    return f"{day.strftime('%b')} {day.day}, {day.year}"


def _format_last_checked(value: str | None) -> str | None:
    """UTC ISO timestamp -> 'Nov 10, 2026 · 5:00 AM PT'."""
    if not value:
        return None
    try:
        moment = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = pytz.utc.localize(moment)
    local = moment.astimezone(PACIFIC)
    hour = local.hour % 12 or 12
    meridiem = "AM" if local.hour < 12 else "PM"
    return (
        f"{local.strftime('%b')} {local.day}, {local.year} · "
        f"{hour}:{local.minute:02d} {meridiem} PT"
    )


def _parse_enrollment_codes(value: str | None) -> list[str]:
    """Parse the JSON array string stored in ``rins.enrollment_codes``.

    The column is TEXT, e.g. ``'["CARE", "PGE-FS"]'``, so it has to be decoded
    before it can go into the JSON response. A NULL/blank value, a legacy plain
    string or malformed JSON all degrade to an empty list, so one bad row can
    never break the whole dashboard payload.
    """
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    return [str(code) for code in parsed]


def _rin_prefix(row: Any) -> str:
    """The RIN's prefix: the stored column, else its second dash segment.

    RINs registered by ``fetch_data`` before the first spreadsheet import have
    an empty ``prefix`` column, so the RIN itself is the fallback.
    """
    prefix = (row["prefix"] or "").strip().upper()
    if prefix:
        return prefix
    parts = str(row["rin"]).split("-")
    return parts[1].upper() if len(parts) > 1 else ""


def _rin_component(row: Any) -> str | None:
    """Derive a RIN's PG&E component from the RIN, not from the query param.

    HFP RINs are recognised by their rate name, which the HFP sheet writes as
    ``HFP - <bucket>`` (this also covers the CCA buckets, whose RIN prefixes are
    not in ``HFP_RIN_PREFIXES``). The 38xx series remains a fallback for rows
    imported before the bucket-aware sheet. CCA-owned RINs (XXMB, XXSJ, XXPC, ...)
    return ``None`` on purpose: ``unbundled`` names PG&E's PGXX delivery half, not
    a CCA's generation half, so conflating the two would mislabel every CCA RIN
    and break the delivery/generation pairing.
    """
    if (row["rate_name"] or "").startswith(HFP_RATE_PREFIX) or str(
        row["rin"]
    ).startswith(HFP_RIN_PREFIXES):
        return HFP_COMPONENT
    prefix = _rin_prefix(row)
    if prefix == COMPONENT_PREFIXES["bundled"]:
        return "bundled"
    if prefix == COMPONENT_PREFIXES["unbundled"]:
        return "unbundled"
    return None


def _status_kind(row: Any) -> str:
    """Three-way classification for the health matrix.

    'healthy'      -> status row exists, has_value_today = 1
    'missing'      -> status row exists, has_value_today = 0
    'not_in_midas' -> no status row (LEFT JOIN produced NULL)
    """
    raw = row["has_value_today"]
    if raw is None:
        return "not_in_midas"
    if raw == 1:
        return "healthy"
    return "missing"


def _rin_entry(row: Any) -> dict[str, Any]:
    """One dashboard row: identity, grouping fields and today's status."""
    # ``status.fetched_at`` is stored as an ISO-8601 UTC string; the isinstance
    # guard keeps this working if a row factory ever returns a datetime.
    fetched_at = row["fetched_at"]
    if fetched_at is not None and not isinstance(fetched_at, str):
        fetched_at = fetched_at.isoformat()
    return {
        "rin": row["rin"],
        "rate_name": row["rate_name"],
        "tariff": row["tariff"],
        "enrollment_codes": _parse_enrollment_codes(row["enrollment_codes"]),
        "category": row["category"],
        "component": _rin_component(row),
        "has_value_today": 1 if row["has_value_today"] == 1 else 0,
        "status_kind": _status_kind(row),
        "last_success_date": row["last_success_date"],
        # Kept for the current frontend; the display-formatted success date.
        "last_success": _format_date(row["last_success_date"]),
        # Raw ISO timestamp of this RIN's last check, for refresh polling.
        "fetched_at": fetched_at,
    }


def _provider_sort_key(code: str) -> tuple[int, str]:
    """Order tabs by ``PROVIDER_LABELS``, then unknown codes alphabetically."""
    if code in PROVIDER_LABELS:
        return (list(PROVIDER_LABELS).index(code), "")
    return (len(PROVIDER_LABELS), code)


@app.get("/api/providers")
def get_providers() -> list[dict[str, Any]]:
    """Provider tabs the frontend should render, one per active RIN owner.

    Only providers with at least one ``is_active = 1`` RIN are returned, so a
    CCA that disappears from the spreadsheet also loses its tab. PG&E advertises
    its bundled/unbundled/HFP split through ``components``; CCAs return an empty
    list because each one owns a single RIN prefix.
    """
    with closing(get_connection(DB_PATH)) as conn:
        codes = [
            row["provider_code"]
            for row in conn.execute(
                "SELECT DISTINCT provider_code FROM rins WHERE is_active = 1"
            )
        ]

    return [
        {
            "id": code,
            "label": PROVIDER_LABELS.get(code, code.upper()),
            "components": list(PGE_COMPONENTS) if code == PGE_PROVIDER_CODE else [],
        }
        for code in sorted(codes, key=_provider_sort_key)
    ]


@app.get("/api/dashboard/{provider_code}")
def get_dashboard(
    provider_code: str,
    component: Annotated[
        str | None,
        Query(
            description=(
                "PG&E only: 'bundled' (PGPG), 'unbundled' (PGXX) or 'hfp'"
                " (every 'HFP - <bucket>' rate name); 'all' returns the"
                " provider-wide snapshot. Ignored for CCAs."
            )
        ),
    ] = None,
) -> dict[str, Any]:
    """Status summary for one provider, optionally one PG&E component.

    ``?component=bundled`` keeps only PGPG RINs, ``?component=unbundled`` only
    PGXX RINs and ``?component=hfp`` only RINs whose rate name starts with
    ``HFP - `` (one bucket per HFP sheet column; HFP RINs have no prefix of their
    own). ``?component=all``, or no component at all, returns every active RIN of
    the provider -- for a CCA, which has no split, a component is ignored either
    way. Every row carries its own ``component``, derived from the RIN instead of
    the parameter.
    """
    code = provider_code.strip().lower()
    requested = (component or "").strip().lower() or None
    if requested is not None and requested not in DASHBOARD_COMPONENTS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown component: {component}. "
                f"Use one of: {', '.join(DASHBOARD_COMPONENTS)}."
            ),
        )

    filters = ["r.provider_code = ?", "r.is_active = 1"]
    params: list[Any] = [code]
    # The component only narrows PG&E; CCAs own a single prefix each, so a
    # component sent for them is ignored instead of returning an empty tab.
    if code == PGE_PROVIDER_CODE and requested not in (None, ALL_COMPONENT):
        if requested == HFP_COMPONENT:
            # HFP RINs share the PGPG/PGXX prefixes but their ``prefix`` column
            # is empty, so they are selected by rate-name prefix instead. LIKE
            # with a trailing wildcard also matches rows imported before the
            # bucket-aware sheet (rate name was ``HFP - RTP``).
            filters.append("r.rate_name LIKE ?")
            params.append(f"{HFP_RATE_PREFIX}%")
        else:
            filters.append("r.prefix = ?")
            params.append(COMPONENT_PREFIXES[requested])
    where_clause = " AND ".join(filters)

    with closing(get_connection(DB_PATH)) as conn:
        provider = conn.execute(
            "SELECT code, display_name FROM providers WHERE code = ?", (code,)
        ).fetchone()
        if provider is None:
            raise HTTPException(
                status_code=404, detail=f"Unknown provider: {provider_code}"
            )

        rows = conn.execute(
            f"""
            SELECT r.rin,
                   r.rate_name,
                   r.tariff,
                   r.enrollment_codes,
                   r.category,
                   r.prefix,
                   s.has_value_today,
                   s.last_success_date,
                   s.fetched_at
            FROM rins AS r
            LEFT JOIN status AS s ON s.rin = r.rin
            WHERE {where_clause}
            """,
            params,
        ).fetchall()

        last_checked_row = conn.execute(
            f"""
            SELECT MAX(s.fetched_at) AS fetched_at
            FROM status AS s
            JOIN rins AS r ON r.rin = s.rin
            WHERE {where_clause}
            """,
            params,
        ).fetchone()

    successes = [row for row in rows if row["has_value_today"] == 1]
    failures = [row for row in rows if row["has_value_today"] != 1]

    # Stalest first; RINs that were never checked (no last_success_date) lead.
    failures.sort(
        key=lambda row: (
            row["last_success_date"] is not None,
            row["last_success_date"] or "",
            row["rin"],
        )
    )
    successes.sort(key=lambda row: row["rin"])

    return {
        "provider": provider["code"],
        "component": requested,
        "last_checked": _format_last_checked(
            last_checked_row["fetched_at"] if last_checked_row else None
        ),
        # Counts scoped to the current provider/component filter.
        "total": len(rows),
        "has_value_count": len(successes),
        "no_value_count": len(failures),
        # Legacy names, kept until the frontend reads the counts above.
        "total_rins": len(rows),
        "success_count": len(successes),
        "failed_count": len(failures),
        "failed_rins": [_rin_entry(row) for row in failures],
        "successful_rins": [_rin_entry(row) for row in successes],
    }


@app.get("/api/regressions")
def get_regressions() -> dict[str, Any]:
    """RINs that changed between the last two recorded fetches.

    ``fetch_data.process`` copies ``status`` into ``status_history`` before
    every fetch, so the two newest ``fetched_at`` groups bracket one fetch:
    ``window_start`` is what the older snapshot saw and ``window_end`` what the
    newer one saw (the state the current fetch started from). A *regression* had
    a value at ``window_start`` and has none at ``window_end``; a *recovery* is
    the reverse.

    Only RINs present in both snapshots are compared, which is what the gap
    model means by "had a value / is missing": a RIN deleted from ``rins``
    (and therefore from ``status``) is neither. Both lists are plain RIN
    strings -- the historical snapshots do not carry rate names or dates, and
    joining ``rins`` would misreport deleted RINs -- and sorted for a stable
    banner. ``has_data`` is false, with a ``null`` window, until two snapshots
    exist.
    """
    with closing(get_connection(DB_PATH)) as conn:
        times = latest_snapshot_times(conn, limit=2)
        if len(times) < 2:
            return {
                "has_data": False,
                "window_start": None,
                "window_end": None,
                "regressions": [],
                "recoveries": [],
            }

        # times is newest first: [0] is the newer snapshot, [1] the older one.
        window_end, window_start = times[0], times[1]
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
            (window_start, window_end),
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
    return {
        "has_data": True,
        "window_start": window_start,
        "window_end": window_end,
        "regressions": regressions,
        "recoveries": recoveries,
    }


def _run_fetch(db_path: Path, lock: IO[str]) -> None:
    """Run the MIDAS fetch on a worker thread and release the fetch lock."""
    try:
        exit_code = fetch_data.process(db_path, lock)
        print(f"RIN Watch fetch finished with exit code {exit_code}", flush=True)
    except Exception as exc:  # noqa: BLE001 - a failed run must not kill the server
        print(
            f"RIN Watch fetch failed: {type(exc).__name__}: {exc}",
            file=sys.stderr,
            flush=True,
        )
    finally:
        fetch_data.release_fetch_lock(lock)


@app.post("/api/admin/fetch", status_code=202)
def trigger_fetch(
    background_tasks: BackgroundTasks,
    authorization: str | None = Header(default=None),
) -> dict[str, str]:
    """Queue a MIDAS fetch and answer 202 immediately.

    The fetch takes minutes (a ~14 MB RIN list plus one request per RIN), so it
    runs as a background task on the same instance that owns the database disk;
    the caller (an external scheduler) only waits for the queue acknowledgement.
    """
    if not FETCH_SECRET:
        raise HTTPException(
            status_code=503, detail="FETCH_SECRET is not configured on the server"
        )

    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(
        token.strip().encode(), FETCH_SECRET.encode()
    ):
        raise HTTPException(
            status_code=401,
            detail="Invalid or missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        lock = fetch_data.acquire_fetch_lock(DB_PATH)
    except fetch_data.FetchAlreadyRunning:
        raise HTTPException(
            status_code=409, detail="A fetch is already running"
        ) from None

    try:
        background_tasks.add_task(_run_fetch, DB_PATH, lock)
    except Exception:
        fetch_data.release_fetch_lock(lock)
        raise

    return {"status": "accepted", "message": "Fetch queued"}


def _require_admin(token: str | None) -> None:
    """Authorize an ops request by comparing ``X-Admin-Token`` to ADMIN_PASSWORD.

    Mirrors ``POST /api/admin/fetch``: an unconfigured secret returns 503 (fail
    closed) rather than accepting an empty token, and the comparison is
    constant-time. The environment variable is read per request so a rotated
    password does not need a restart.
    """
    expected = os.environ.get("ADMIN_PASSWORD", "").strip()
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="ADMIN_PASSWORD is not configured on the server",
        )
    provided = (token or "").strip()
    if not provided or not hmac.compare_digest(provided.encode(), expected.encode()):
        raise HTTPException(
            status_code=401,
            detail=f"Invalid or missing {ADMIN_TOKEN_HEADER} header",
        )


async def _read_upload(file: UploadFile) -> str:
    """Return the upload as text, rejecting oversized or non-UTF-8 files."""
    content = await file.read()
    if len(content) > MAX_OPS_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"CSV is larger than {MAX_OPS_UPLOAD_BYTES // (1024 * 1024)} MB",
        )
    try:
        return content.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(
            status_code=400, detail="CSV must be UTF-8 encoded"
        ) from exc


def _build_plan(
    conn: sqlite3.Connection, text: str, name: str
) -> tuple[list[dict], list[dict], list[str]]:
    """Classify an uploaded CSV against the DB without writing anything.

    Returns ``(ready, conflicts, skipped)`` -- the same three groups the CLI's
    ``--dry-run`` reports. Both ops routes call this, so preview and commit can
    never disagree about what a file means.
    """
    try:
        rows, skipped = normalize_rows(read_csv_text(text, name))
    except CsvFormatError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    ready, conflicts = classify_rows(rows, read_stored(conn))
    return ready, conflicts, skipped


def _added_entries(rows: list[dict]) -> list[dict[str, Any]]:
    """JSON-safe description of the RINs an import adds (or would add)."""
    return [
        {
            "rin": row["rin"],
            "prefix": row["prefix"],
            "provider_code": row["provider_code"],
            "component": row["component"],
            "tariff": row["tariff"],
            "enrollment_codes": row["enrollment_codes"],
            "category": row["category"],
        }
        for row in rows
    ]


def _plan_upload(text: str, name: str) -> tuple[list[dict], list[dict], list[str]]:
    """Run the dry-run classification on a short-lived database connection."""
    try:
        with closing(get_connection(DB_PATH)) as conn:
            return _build_plan(conn, text, name)
    except sqlite3.OperationalError as exc:
        raise HTTPException(
            status_code=503, detail=f"Database unavailable: {exc}"
        ) from exc


@app.post("/api/ops/preview")
async def preview_ops(
    file: Annotated[
        UploadFile,
        File(description="CSV with RIN, Tariff, Enrollment Code and Category"),
    ],
    x_admin_token: Annotated[str | None, Header(alias=ADMIN_TOKEN_HEADER)] = None,
) -> dict[str, Any]:
    """Dry-run an add-only CSV import. Writes nothing.

    ``added`` are the RINs the commit would insert, ``conflicts`` are rows whose
    RIN already exists in the database (active or inactive), and ``skipped`` are
    rows rejected before the DB check (bad prefix, missing category, duplicate
    in the CSV).
    """
    _require_admin(x_admin_token)
    name = file.filename or "upload.csv"
    text = await _read_upload(file)
    ready, conflicts, skipped = _plan_upload(text, name)
    return {
        "added": _added_entries(ready),
        "conflicts": conflicts,
        "skipped": skipped,
    }


@app.post("/api/ops/commit")
async def commit_ops(
    file: Annotated[
        UploadFile,
        File(description="CSV with RIN, Tariff, Enrollment Code and Category"),
    ],
    x_admin_token: Annotated[str | None, Header(alias=ADMIN_TOKEN_HEADER)] = None,
) -> dict[str, Any]:
    """Insert the CSV's new RINs, skipping conflicts and invalid rows.

    Existing RINs are never updated, so running this twice with the same file
    adds nothing the second time: every row comes back as a conflict.
    """
    _require_admin(x_admin_token)
    name = file.filename or "upload.csv"
    text = await _read_upload(file)
    try:
        with closing(get_connection(DB_PATH)) as conn:
            ready, conflicts, skipped = _build_plan(conn, text, name)
            added = apply_rows(conn, ready)
    except sqlite3.OperationalError as exc:
        raise HTTPException(
            status_code=503, detail=f"Database unavailable: {exc}"
        ) from exc
    except sqlite3.IntegrityError as exc:
        raise HTTPException(
            status_code=409,
            detail=(
                "A RIN from this CSV was inserted concurrently; run preview again."
            ),
        ) from exc
    return {
        "added": _added_entries(ready),
        "conflicts": conflicts,
        "skipped": skipped,
        "counts": {
            "added": added,
            "conflicts": len(conflicts),
            "skipped": len(skipped),
        },
    }
