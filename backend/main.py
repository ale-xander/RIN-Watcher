"""RIN Watch FastAPI application.

Exposes the dashboard payload consumed by the Next.js frontend.
Run with:  uvicorn main:app --reload --port 8000
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager, closing
from datetime import datetime
from typing import Any, Optional

import pytz
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from database import get_connection, init_db

PACIFIC = pytz.timezone("America/Los_Angeles")

DEFAULT_CORS_ORIGINS = "http://localhost:3000,http://127.0.0.1:3000"


def _cors_origins() -> list[str]:
    raw = os.getenv("CORS_ORIGINS", DEFAULT_CORS_ORIGINS)
    origins = [origin.strip() for origin in raw.split(",") if origin.strip()]
    return origins or [DEFAULT_CORS_ORIGINS.split(",")[0]]


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="RIN Watch API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _format_date(value: Optional[str]) -> Optional[str]:
    """'2026-11-08' -> 'Nov 8, 2026'."""
    if not value:
        return None
    try:
        day = datetime.strptime(str(value)[:10], "%Y-%m-%d")
    except ValueError:
        return None
    return f"{day.strftime('%b')} {day.day}, {day.year}"


def _format_last_checked(value: Optional[str]) -> Optional[str]:
    """UTC ISO timestamp -> 'Nov 10, 2026 · 5:00 AM PT'."""
    if not value:
        return None
    try:
        moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
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

    with closing(get_connection()) as conn:
        provider = conn.execute(
            "SELECT code, display_name FROM providers WHERE code = ?", (code,)
        ).fetchone()
        if provider is None:
            raise HTTPException(status_code=404, detail=f"Unknown provider: {provider_code}")

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
