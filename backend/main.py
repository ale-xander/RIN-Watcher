"""RIN Watch FastAPI application.

Exposes the dashboard payload consumed by the Next.js frontend.
Run with:  uvicorn main:app --reload --port 8000

GET /api/providers lists the provider tabs that have active RINs.
GET /api/dashboard/{provider_code} returns one provider's status summary; pass
``?component=bundled``, ``?component=unbundled`` or ``?component=hfp`` to split
PG&E's PGPG/PGXX RINs and its HFP (Hourly Flex Pricing) RINs.
POST /api/admin/fetch queues a MIDAS fetch in the background; it is guarded by
the FETCH_SECRET environment variable and returns 202 immediately.
"""

from __future__ import annotations

import hmac
import json
import os
import sys
import threading
from contextlib import asynccontextmanager, closing
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any

import pytz
from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

import fetch_data
from database import BACKEND_DIR, get_connection, get_db_path, init_db

load_dotenv(BACKEND_DIR / ".env")

PACIFIC = pytz.timezone("America/Los_Angeles")

DEFAULT_CORS_ORIGINS = "http://localhost:3000,http://127.0.0.1:3000"

# Shared secret required by POST /api/admin/fetch. When unset the endpoint is
# disabled (503) instead of running with an empty, guessable token.
FETCH_SECRET = os.getenv("FETCH_SECRET", "").strip()

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
# Pricing rate, which lives in MIDAS only (no RIN spreadsheet rows) and is
# therefore identified by rate name instead of prefix. CCAs have no such split,
# so ``?component=`` is ignored for them.
PGE_PROVIDER_CODE = "pge"
COMPONENT_PREFIXES = {"bundled": "PGPG", "unbundled": "PGXX"}
HFP_COMPONENT = "hfp"
HFP_RATE_NAME = "HFP - RTP"
# Tab order advertised by /api/providers and accepted by /api/dashboard.
PGE_COMPONENTS = (*COMPONENT_PREFIXES, HFP_COMPONENT)

# One fetch at a time: concurrent runs would fight over the same SQLite file and
# hammer the MIDAS API. Acquired by the endpoint, released by the worker.
_fetch_lock = threading.Lock()

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


def _rin_entry(row: Any) -> dict[str, Any]:
    """One dashboard row: identity, grouping fields and today's status."""
    return {
        "rin": row["rin"],
        "rate_name": row["rate_name"],
        "tariff": row["tariff"],
        "enrollment_codes": _parse_enrollment_codes(row["enrollment_codes"]),
        "category": row["category"],
        "has_value_today": 1 if row["has_value_today"] == 1 else 0,
        "last_success_date": row["last_success_date"],
        # Kept for the current frontend; the display-formatted success date.
        "last_success": _format_date(row["last_success_date"]),
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
                " (HFP - RTP). Ignored for CCAs."
            )
        ),
    ] = None,
) -> dict[str, Any]:
    """Status summary for one provider, optionally one PG&E component.

    ``?component=bundled`` keeps only PGPG RINs, ``?component=unbundled`` only
    PGXX RINs and ``?component=hfp`` only RINs whose rate name is
    ``HFP - RTP`` (HFP has no prefix of its own). Without a component (or for a
    CCA, which has no split) all of the provider's active RINs are returned.
    """
    code = provider_code.strip().lower()
    requested = (component or "").strip().lower() or None
    if requested is not None and requested not in PGE_COMPONENTS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown component: {component}. "
                f"Use one of: {', '.join(PGE_COMPONENTS)}."
            ),
        )

    filters = ["r.provider_code = ?", "r.is_active = 1"]
    params: list[Any] = [code]
    # The component only narrows PG&E; CCAs own a single prefix each, so a
    # component sent for them is ignored instead of returning an empty tab.
    if code == PGE_PROVIDER_CODE and requested is not None:
        if requested == HFP_COMPONENT:
            # HFP RINs share the PGPG/PGXX prefixes but have no spreadsheet
            # row, so they are selected by rate name instead.
            filters.append("r.rate_name = ?")
            params.append(HFP_RATE_NAME)
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


def _run_fetch(db_path: Path) -> None:
    """Run the MIDAS fetch on a worker thread and release the fetch lock."""
    try:
        exit_code = fetch_data.process(db_path)
        print(f"RIN Watch fetch finished with exit code {exit_code}", flush=True)
    except Exception as exc:  # noqa: BLE001 - a failed run must not kill the server
        print(
            f"RIN Watch fetch failed: {type(exc).__name__}: {exc}",
            file=sys.stderr,
            flush=True,
        )
    finally:
        _fetch_lock.release()


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

    if not _fetch_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="A fetch is already running")

    try:
        background_tasks.add_task(_run_fetch, DB_PATH)
    except Exception:
        _fetch_lock.release()
        raise

    return {"status": "accepted", "message": "Fetch queued"}
