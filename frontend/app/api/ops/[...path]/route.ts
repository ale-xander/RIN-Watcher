export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Catch-all proxy for the hidden /lemons ops page.
//
// The Fly API's /api/ops/preview and /api/ops/commit endpoints authenticate
// with an `X-Admin-Token` header, which the browser cannot send cross-origin
// without CORS and credentials plumbing. This route keeps the call same-origin
// instead: it forwards the multipart body and the token to
// `${FETCH_API_URL}/api/ops/<op>` and hands the Fly JSON and status back
// untouched, so the page sees the backend's own validation errors.
//
// The bytes are forwarded as-is (not re-encoded) so the multipart boundary the
// browser generated stays valid. Only the two known ops are allowed through, so
// this cannot be used as a general-purpose proxy into the Fly admin surface.
// Only POST is exported, so Next answers every other method with 405.

const ADMIN_TOKEN_HEADER = "X-Admin-Token";
const ALLOWED_OPS = new Set(["preview", "commit"]);

type OpsRouteContext = { params: Promise<{ path: string[] }> };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(
  request: Request,
  context: OpsRouteContext,
): Promise<Response> {
  const { path } = await context.params;
  const op = path.join("/");
  if (!ALLOWED_OPS.has(op)) {
    return json({ error: "unknown_ops_endpoint", path: op }, 404);
  }

  const apiUrl = process.env.FETCH_API_URL;
  if (!apiUrl) {
    return json({ error: "server_misconfigured" }, 500);
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return json(
      { error: "invalid_body", detail: "expected a multipart/form-data upload" },
      400,
    );
  }

  let body: ArrayBuffer;
  try {
    body = await request.arrayBuffer();
  } catch {
    return json(
      { error: "invalid_body", detail: "could not read the request body" },
      400,
    );
  }

  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": contentType,
  });
  const token = request.headers.get(ADMIN_TOKEN_HEADER);
  if (token !== null) {
    headers.set(ADMIN_TOKEN_HEADER, token);
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${apiUrl.replace(/\/+$/, "")}/api/ops/${op}`, {
      method: "POST",
      headers,
      body,
      cache: "no-store",
    });
  } catch (error) {
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

  // The ops endpoints always answer with JSON (a plan, or FastAPI's
  // `{"detail": ...}` error), so a non-JSON body means the upstream itself
  // failed before reaching the route.
  let text: string;
  try {
    text = await upstream.text();
  } catch {
    return json(
      {
        error: "upstream_failed",
        status: upstream.status,
        detail: "unreadable upstream response",
      },
      502,
    );
  }

  try {
    JSON.parse(text);
  } catch {
    return json(
      {
        error: "upstream_failed",
        status: upstream.status,
        detail: text.slice(0, 200) || "empty upstream response",
      },
      502,
    );
  }

  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}
