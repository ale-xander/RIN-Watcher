"""RIN Watch FastAPI application.

Exposes the dashboard payload consumed by the Next.js frontend.
Run with:  uvicorn main:app --reload --port 8000

POST /api/admin/fetch queues a MIDAS fetch in the background; it is guarded by
the FETCH_SECRET environment variable and returns 202 immediately.
"""

from __future__ import annotations

import hmac
import os
import sys
import threading
from contextlib import asynccontextmanager, closing
from datetime import datetime
from pathlib import Path
from typing import Any

import pytz
from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware

import fetch_data
from database import BACKEND_DIR, get_connection, get_db_path, init_db

load_dotenv(BACKEND_DIR / ".env")

PACIFIC = pytz.timezone("America/Los_Angeles")

DEFAULT_CORS_ORIGINS = "http://localhost:3000,http://127.0.0.1:3000"

# Shared secret required by POST /api/admin/fetch. When unset the endpoint is
# disabled (503) instead of running with an empty, guessable token.
FETCH_SECRET = os.getenv("FETCH_SECRET", "").strip()

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


def _rin_entry(row: Any) -> dict[str, Any]:
    return {
        "rin": row["rin"],
        "rate_name": row["rate_name"],
        "last_success": _format_date(row["last_success_date"]),
    }


@app.get("/api/dashboard/{provider_code}")
def get_dashboard(provider_code: str) -> dict[str, Any]:
    """Status summary for one provider: who has a value today and who doesn't."""
    code = provider_code.strip().lower()

    with closing(get_connection(DB_PATH)) as conn:
        provider = conn.execute(
            "SELECT code, display_name FROM providers WHERE code = ?", (code,)
        ).fetchone()
        if provider is None:
            raise HTTPException(
                status_code=404, detail=f"Unknown provider: {provider_code}"
            )

        rows = conn.execute(
            """
            SELECT r.rin,
                   r.rate_name,
                   s.has_value_today,
                   s.last_success_date,
                   s.fetched_at
            FROM rins AS r
            LEFT JOIN status AS s ON s.rin = r.rin
            WHERE r.provider_code = ?
            """,
            (code,),
        ).fetchall()

        last_checked_row = conn.execute(
            """
            SELECT MAX(s.fetched_at) AS fetched_at
            FROM status AS s
            JOIN rins AS r ON r.rin = s.rin
            WHERE r.provider_code = ?
            """,
            (code,),
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
        "last_checked": _format_last_checked(
            last_checked_row["fetched_at"] if last_checked_row else None
        ),
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
