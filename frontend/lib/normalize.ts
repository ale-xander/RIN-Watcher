import { SEGMENT_ORDER } from "@/lib/constants";
import type { Component, Dashboard, Provider, RinEntry, Segment } from "@/lib/types";

/**
 * Map an unknown API value onto the four segments the dashboard groups by.
 *
 * A legacy ``nbt`` category falls back to ``other``: it is a program, not a
 * segment, and the importer rewrites those rows to their real segment anyway.
 */
export function normalizeCategory(value: unknown): Segment {
  return typeof value === "string" &&
    (SEGMENT_ORDER as string[]).includes(value)
    ? (value as Segment)
    : "other";
}

export function normalizeRinEntry(raw: unknown): RinEntry | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const row = raw as Record<string, unknown>;
  if (typeof row.rin !== "string" || row.rin.length === 0) {
    return null;
  }

  return {
    rin: row.rin,
    rate_name: typeof row.rate_name === "string" ? row.rate_name : null,
    tariff:
      typeof row.tariff === "string" && row.tariff.trim()
        ? row.tariff
        : null,
    enrollment_codes: Array.isArray(row.enrollment_codes)
      ? row.enrollment_codes.filter(
          (code): code is string => typeof code === "string" && code.length > 0,
        )
      : [],
    category: normalizeCategory(row.category),
    component: isComponent(row.component) ? row.component : null,
    has_value_today:
      row.has_value_today === 1 || row.has_value_today === true ? 1 : 0,
    status_kind: normalizeStatusKind(row.status_kind),
    last_success_date:
      typeof row.last_success_date === "string" ? row.last_success_date : null,
    last_success:
      typeof row.last_success === "string" ? row.last_success : null,
  };
}

/** Narrow an API value to a component tab the dashboard can request. */
function isComponent(value: unknown): value is Component {
  return value === "bundled" || value === "unbundled" || value === "hfp";
}

/**
 * Narrow the backend's three-way status; anything unrecognised stays
 * `undefined` so callers can fall back to `has_value_today` instead of being
 * forced onto one branch (see `statusKindOf` in health-matrix.ts).
 */
function normalizeStatusKind(
  value: unknown,
): "healthy" | "missing" | "not_in_midas" | undefined {
  return value === "healthy" || value === "missing" || value === "not_in_midas"
    ? value
    : undefined;
}

/**
 * The API is the source of truth, but normalising the payload here keeps the
 * render tree safe: a slow/partial response can never make `.map()` explode.
 */
export function normalizeProviders(payload: unknown): Provider[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  const seen = new Set<string>();
  const providers: Provider[] = [];
  for (const raw of payload) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const row = raw as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim().toLowerCase() : "";
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    providers.push({
      id,
      label:
        typeof row.label === "string" && row.label.trim()
          ? row.label.trim()
          : id.toUpperCase(),
      components: Array.isArray(row.components)
        ? row.components.filter(isComponent)
        : [],
    });
  }
  return providers;
}

export function normalizeDashboard(
  payload: unknown,
  fallbackProvider: string,
  fallbackComponent: string | null,
): Dashboard {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const toEntries = (value: unknown): RinEntry[] =>
    Array.isArray(value)
      ? value
          .map(normalizeRinEntry)
          .filter((entry): entry is RinEntry => entry !== null)
      : [];
  const failedRins = toEntries(raw.failed_rins);
  const successfulRins = toEntries(raw.successful_rins);
  const countOr = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;

  return {
    provider:
      typeof raw.provider === "string" ? raw.provider : fallbackProvider,
    component:
      typeof raw.component === "string" ? raw.component : fallbackComponent,
    last_checked:
      typeof raw.last_checked === "string" ? raw.last_checked : null,
    total: countOr(raw.total, failedRins.length + successfulRins.length),
    has_value_count: countOr(raw.has_value_count, successfulRins.length),
    no_value_count: countOr(raw.no_value_count, failedRins.length),
    failed_rins: failedRins,
    successful_rins: successfulRins,
  };
}
