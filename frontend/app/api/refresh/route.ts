export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Manual-refresh proxy for the dashboard's "Refresh data" button.
//
// The Fly API's /api/admin/fetch endpoint wants a bearer token, so the browser
// can never call it directly: this route keeps the token server-side (both vars
// are server-only, never NEXT_PUBLIC_) and queues the fetch for the caller. The
// app is internal and the endpoint only starts a background job, so it is
// rate-limited instead of authenticated.
//
// The guard below lives in module memory, i.e. per Vercel instance: it stops a
// double-click on one instance, not a coordinated burst. Server-side hardening
// is a separate task.
//
// Only POST is exported, so Next answers every other method with 405.

const COOLDOWN_MS = 2 * 60 * 1000;
// How long the request is held "in flight" after the API accepted it, so the
// client can start polling without a second click slipping through.
const RELEASE_MS = 8_000;

let isFetching = false;
let lastTriggeredAt = 0;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Best-effort message from a failed upstream response. */
async function readUpstreamDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (text.length === 0) {
      return "empty upstream response";
    }
    try {
      const body: unknown = JSON.parse(text);
      if (body !== null && typeof body === "object") {
        const record = body as Record<string, unknown>;
        if (typeof record.detail === "string") {
          return record.detail;
        }
        if (typeof record.error === "string") {
          return record.error;
        }
      }
    } catch {
      // Not JSON; fall back to the raw text.
    }
    return text.slice(0, 200);
  } catch {
    return "unreadable upstream response";
  }
}

/** Let the guard go once the API has been asked to queue the fetch. */
function scheduleRelease(): void {
  setTimeout(() => {
    isFetching = false;
  }, RELEASE_MS);
}

export async function POST(): Promise<Response> {
  const token = process.env.FETCH_TOKEN;
  const apiUrl = process.env.FETCH_API_URL;
  if (!token || !apiUrl) {
    return json({ error: "server_misconfigured" }, 500);
  }

  if (isFetching) {
    return json({ error: "already_running" }, 409);
  }

  const elapsed = Date.now() - lastTriggeredAt;
  if (elapsed < COOLDOWN_MS) {
    return json(
      { error: "rate_limited", retryAfterMs: COOLDOWN_MS - elapsed },
      429,
    );
  }

  isFetching = true;
  lastTriggeredAt = Date.now();
  console.log(`[refresh] triggered at ${new Date().toISOString()}`);

  let upstream: Response;
  try {
    upstream = await fetch(`${apiUrl.replace(/\/+$/, "")}/api/admin/fetch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      cache: "no-store",
    });
  } catch (error) {
    scheduleRelease();
    return json(
      {
        error: "upstream_failed",
        status: 0,
        detail:
          error instanceof Error ? error.message : "upstream request failed",
      },
      502,
    );
  }

  // A 409 is passed through untouched: the client tells "already running"
  // (409 -> poll now) from "cooldown" (429 -> show a countdown).
  if (upstream.status === 409) {
    scheduleRelease();
    return json({ error: "already_running" }, 409);
  }

  if (upstream.ok) {
    scheduleRelease();
    return json({ ok: true, triggeredAt: lastTriggeredAt }, 202);
  }

  scheduleRelease();
  return json(
    {
      error: "upstream_failed",
      status: upstream.status,
      detail: await readUpstreamDetail(upstream),
    },
    502,
  );
}
