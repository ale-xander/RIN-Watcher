"use client";

// The integrated RIN dashboard: provider tabs, the PG&E component toggle, the
// segment x component health matrix (or, for HFP, the single summary strip that
// replaces both matrices — HFP RINs carry no NBT codes), the NBT vintage matrix,
// and the drill those matrices open.
//
// One rule keeps the page coherent: the matrices are always built from the
// provider-wide payload (`?component=all`), because a matrix cell is meaningless
// without its other columns. The component toggle therefore selects which
// headline renders above the matrices, not what they aggregate. The category
// chips are a scope on top of that payload: they narrow the matrices and, with
// them, every drill opened from them.
//
// Clicking a cell opens the drill below the matrices: the filter pill
// (breadcrumb, whose last segment is the status tab), the pattern chips ("what
// do the failing RINs have in common") and the affected-RINs table with its
// status tabs and copy button. A click defaults the table to the status its
// cell is about — a red cell opens Missing, a green cell Healthy — so a drill
// never opens on an empty list. This file owns the state; every counting rule
// lives in `lib/`.

import { useEffect, useMemo, useRef, useState } from "react";

import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  DASHBOARD_URL,
  DEFAULT_COMPONENT,
  EMPTY_RINS,
} from "@/lib/constants";
import {
  drillBaselineRins,
  filterByAttributes,
  sameDrill,
  sortByStaleness,
} from "@/lib/drill";
import type { Drill, MainColKey, MainRowKey, NbtColKey } from "@/lib/drill";
import type { MatrixCell } from "@/lib/health-matrix";
import { normalizeDashboard } from "@/lib/normalize";
import { isNbt } from "@/lib/rin-utils";
import type {
  Category,
  CategoryChip,
  CategoryFilter,
  Component,
  Dashboard,
} from "@/lib/types";

import { AffectedRinsTable } from "./affected-rins-table";
import type { RinStatusTab } from "./affected-rins-table";
import { CategoryChips } from "./category-chips";
import { ComponentToggle } from "./component-toggle";
import { DashboardSkeleton } from "./dashboard-skeleton";
import { ErrorPanel } from "./error-panel";
import { FilterPill } from "./filter-pill";
import { HfpStrip } from "./hfp-strip";
import { HealthMatrix } from "./health-matrix";
import { NbtMatrix } from "./nbt-matrix";
import { PatternStrip } from "./pattern-strip";
import { ProviderTabs } from "./provider-tabs";
import { useDashboardData } from "./use-dashboard-data";

const ROW_LABELS: Record<MainRowKey, string> = {
  ag: "AG",
  non_res: "Non-Res",
  resid: "Residential",
  all: "All segments",
};

const COL_LABELS: Record<MainColKey, string> = {
  bundled: "Bundled",
  unbundled: "Unbundled",
  all: "All components",
};

const NBT_COL_LABELS: Record<NbtColKey, string> = {
  "2023": "2023",
  "2024": "2024",
  "2025": "2025",
  "2026": "2026",
  "2027": "2027",
  floating: "Floating",
  all: "All vintages",
};

/** Breadcrumb label for each status tab of the affected-RINs table. */
const STATUS_LABELS: Record<RinStatusTab, string> = {
  missing: "Missing",
  healthy: "Healthy",
  pending: "Pending Launch",
};

/** The proxy route that queues POST /api/admin/fetch on the Fly API. */
const REFRESH_URL = "/api/refresh";
/** Poll cadence once a fetch is queued (the fetch itself runs 2–3 min). */
const REFRESH_POLL_INTERVAL_MS = 4_000;
/** How long the button waits for the fresh payload before standing down. */
const REFRESH_POLL_TIMEOUT_MS = 60_000;
/** How long "Last checked" stays green after a refresh lands. */
const FRESHNESS_FLASH_MS = 2_000;

/** One click's poll loop: cancelled on success, timeout, unmount or a switch. */
type RefreshRun = {
  cancelled: boolean;
  controller: AbortController | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Resolver of the inter-poll pause, so an abort never leaves it pending. */
  wake: (() => void) | null;
};

/** Stop a poll loop: cancel it, wake it out of its pause, abort its request. */
function abortRefreshRun(run: RefreshRun | null): void {
  if (run === null) {
    return;
  }
  run.cancelled = true;
  if (run.timer !== null) {
    clearTimeout(run.timer);
    run.timer = null;
  }
  run.wake?.();
  run.wake = null;
  run.controller?.abort();
}

/** Best-effort JSON object body; every proxy reply is a small JSON object. */
async function readJsonBody(
  response: Response,
): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await response.json();
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Chips that select an enrollment PROGRAM, not a tariff segment. A program card
 * overlaps the segments (an NBT RIN is also Residential/Non-Res/AG), so its
 * count never adds up with theirs and it must not sit in the segment row.
 */
const PROGRAM_FILTERS: Category[] = ["nbt"];

function isProgramFilter(id: CategoryFilter): boolean {
  return (PROGRAM_FILTERS as CategoryFilter[]).includes(id);
}

/** One open drill plus the status tab it opened on. */
type DrillState = Drill & { statusFilter: RinStatusTab };

/**
 * The status tab a click should open: the cell's missing count wins because
 * that is what the matrix is about; a clean cell opens on its healthy RINs; a
 * cell holding only not-yet-live RINs opens on Pending. A drill opened without
 * a cell (a provider-wide view) keeps the caller's default.
 */
function getDefaultStatus(cell: MatrixCell): RinStatusTab {
  if (cell.missing > 0) return "missing";
  if (cell.healthy > 0) return "healthy";
  return "pending";
}

/** Stable identity of a drill cell: the affected table resets its own search,
 *  filters and sort when this changes, but keeps them across toggles. */
function drillKeyOf(drill: Drill): string {
  switch (drill.kind) {
    case "main":
      return `main:${drill.row}:${drill.col}`;
    case "nbt":
      return `nbt:${drill.row}:${drill.col}`;
    default:
      return drill.kind;
  }
}

/** Breadcrumb labels for a drill, before the status and filter segments. */
function drillScopeLabels(drill: Drill): string[] {
  switch (drill.kind) {
    case "main":
      return [COL_LABELS[drill.col], ROW_LABELS[drill.row]];
    case "nbt": {
      if (drill.row === "all") {
        return ["All NBT", NBT_COL_LABELS[drill.col]];
      }
      // `<component>-<segment>`; neither part contains a dash.
      const dash = drill.row.indexOf("-");
      const component = drill.row.slice(0, dash) as MainColKey;
      const segment = drill.row.slice(dash + 1) as MainRowKey;
      return [
        COL_LABELS[component],
        ROW_LABELS[segment],
        "NBT",
        NBT_COL_LABELS[drill.col],
      ];
    }
    case "hfp":
      return ["HFP"];
    case "provider":
      return ["All RINs"];
  }
}

export function Dashboard() {
  const [component, setComponent] = useState<Component>(DEFAULT_COMPONENT);
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [drill, setDrill] = useState<DrillState | null>(null);
  const [activeAttributes, setActiveAttributes] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedRins, setSelectedRins] = useState<Set<string>>(
    () => new Set(),
  );
  const drillRef = useRef<HTMLElement>(null);

  // Manual refresh: a landed poll stores its payload here, and the hook's own
  // payload (see `data` below) always supersedes it.
  const [polledData, setPolledData] = useState<Dashboard | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [flashFreshness, setFlashFreshness] = useState(false);
  const refreshRunRef = useRef<RefreshRun | null>(null);
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The matrices need every component at once, so the request is always the
  // provider-wide snapshot; `component` only picks the headline below.
  const {
    providersState,
    providers,
    providerId,
    setProviderId,
    showComponentToggle,
    requestComponent,
    dashboardState,
    data: fetchedData,
    providersLoading,
    dashboardLoading,
    reloadProviders,
    reloadDashboard,
  } = useDashboardData("all");

  // A refresh that has landed is newer than the payload the hook fetched, so it
  // stands in for it until the hook fetches again.
  const data = polledData ?? fetchedData;

  const isHfp = showComponentToggle && component === "hfp";

  // A new provider/component means new RINs: every drill, filter and check on
  // the old ones is stale, and so is a payload a refresh poll stored.
  useEffect(() => {
    setCategory("all");
    setDrill(null);
    setActiveAttributes(new Set());
    setSelectedRins(new Set());
    setPolledData(null);
    // A switch mid-refresh abandons that poll: it belongs to the old provider.
    abortRefreshRun(refreshRunRef.current);
    refreshRunRef.current = null;
    setIsRefreshing(false);
    setRefreshMessage(null);
  }, [providerId, requestComponent]);

  // Anything the hook itself fetches (a retry, a switch) supersedes a poll.
  useEffect(() => {
    setPolledData(null);
  }, [fetchedData]);

  // Stop any in-flight poll and pending flash if the dashboard unmounts.
  useEffect(
    () => () => {
      abortRefreshRun(refreshRunRef.current);
      if (flashTimeoutRef.current !== null) {
        clearTimeout(flashTimeoutRef.current);
      }
    },
    [],
  );

  const failedRins = data?.failed_rins ?? EMPTY_RINS;
  const successfulRins = data?.successful_rins ?? EMPTY_RINS;

  // Both matrices, the HFP strip and every drill read this one list, so a cell
  // and the drill it opens can never disagree about which RINs it contains.
  const allRins = useMemo(
    () => [...failedRins, ...successfulRins],
    [failedRins, successfulRins],
  );

  // The chips scope the current component, not the provider-wide payload: HFP
  // RINs carry no segment (their category is `other`), so counting them would
  // make "All" read 902 on the PG&E tabs and leave an "Other" chip that only
  // HFP populates. The matrices below still receive `allRins` — they need both
  // PG&E components to fill their columns. Providers without a component split
  // (the CCAs, `component === null`) keep every RIN.
  const chipRins = useMemo(() => {
    if (!showComponentToggle) {
      return allRins;
    }
    if (component === "hfp") {
      return EMPTY_RINS;
    }
    return allRins.filter((entry) => entry.component === component);
  }, [allRins, component, showComponentToggle]);

  // Chip counts describe the payload in memory (no refetch on click); "nbt" is
  // detected from the enrollment codes, the rest come from the stored segment.
  const categoryCounts = useMemo(() => {
    const counts: Record<CategoryFilter, number> = {
      all: 0,
      ag: 0,
      non_res: 0,
      resid: 0,
      nbt: 0,
      other: 0,
    };
    for (const entry of chipRins) {
      counts.all += 1;
      counts[entry.category] += 1;
      if (isNbt(entry)) {
        counts.nbt += 1;
      }
    }
    return counts;
  }, [chipRins]);

  const { segmentChips, programChips } = useMemo(() => {
    const list: CategoryChip[] = [
      { id: "all", label: "All", count: categoryCounts.all },
      ...CATEGORY_ORDER.map((id) => ({
        id,
        label: CATEGORY_LABELS[id].chip,
        count: categoryCounts[id],
      })),
    ];
    // Zero-count chips collapse, except the active one: keeping it visible
    // means the filter can always be switched back off.
    const visible = list.filter(
      (chip) => chip.count > 0 || chip.id === category,
    );
    return {
      segmentChips: visible.filter((chip) => !isProgramFilter(chip.id)),
      programChips: visible.filter((chip) => isProgramFilter(chip.id)),
    };
  }, [categoryCounts, category]);

  // A refresh can remove the last RIN of the active segment; fall back to All
  // rather than leaving the dashboard stuck on an empty scope.
  useEffect(() => {
    if (!data) {
      return;
    }
    if (category !== "all" && categoryCounts[category] === 0) {
      setCategory("all");
      setDrill(null);
    }
  }, [data, category, categoryCounts]);

  const scopedRins = useMemo(() => {
    if (category === "all") {
      return allRins;
    }
    if (category === "nbt") {
      return allRins.filter(isNbt);
    }
    return allRins.filter((entry) => entry.category === category);
  }, [allRins, category]);

  // Providers without a component split (the CCAs) have no matrix to click, so
  // their dashboard opens straight into a provider-wide list. The status tab
  // still needs an owner, so it hangs off the synthesized provider drill.
  const effectiveDrill = useMemo<DrillState | null>(() => {
    if (showComponentToggle) {
      return drill;
    }
    return {
      kind: "provider",
      statusFilter: drill?.statusFilter ?? "missing",
    };
  }, [showComponentToggle, drill]);

  const drillBaseline = useMemo(
    () =>
      effectiveDrill
        ? drillBaselineRins(scopedRins, effectiveDrill)
        : EMPTY_RINS,
    [scopedRins, effectiveDrill],
  );

  // The pattern strip describes what failed: the drill's missing RINs, before
  // the pattern chips. The table instead receives every status and splits it
  // into tabs, which is what makes the Healthy and Pending rows reachable.
  const drillAffected = useMemo(
    () => drillBaseline.filter((entry) => entry.status_kind === "missing"),
    [drillBaseline],
  );
  const drillRows = useMemo(
    () => sortByStaleness(filterByAttributes(drillBaseline, activeAttributes)),
    [drillBaseline, activeAttributes],
  );

  // Drop checks that no longer exist so the copy button can never reference a
  // RIN that left the drill (attribute chip, status tab, refresh).
  useEffect(() => {
    setSelectedRins((current) => {
      if (current.size === 0) {
        return current;
      }
      const available = new Set(drillRows.map((entry) => entry.rin));
      const next = new Set<string>();
      let pruned = false;
      for (const rin of current) {
        if (available.has(rin)) {
          next.add(rin);
        } else {
          pruned = true;
        }
      }
      return pruned ? next : current;
    });
  }, [drillRows]);

  // A different cell (or a different provider) is a new question: it starts
  // unfiltered and brings itself into view. Switching status tabs changes the
  // open drill's state, not its identity, so it must neither scroll the page
  // nor drop the user's pattern chips.
  const drillIdentity = useMemo(
    () =>
      effectiveDrill ? `${providerId}:${drillKeyOf(effectiveDrill)}` : null,
    [providerId, effectiveDrill],
  );
  useEffect(() => {
    if (drillIdentity === null || !showComponentToggle) {
      return;
    }
    setActiveAttributes(new Set());
    setSelectedRins(new Set());
    drillRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [drillIdentity, showComponentToggle]);

  const drillSegments = useMemo(() => {
    if (!effectiveDrill) {
      return [];
    }
    const segments = drillScopeLabels(effectiveDrill);
    segments.push(STATUS_LABELS[effectiveDrill.statusFilter]);
    if (category !== "all") {
      segments.push(CATEGORY_LABELS[category].group);
    }
    segments.push(...activeAttributes);
    return segments;
  }, [effectiveDrill, category, activeAttributes]);

  /**
   * Open a drill on the status its cell is about; a caller with no cell (the
   * provider-wide view) keeps the default. Same cell keeps the object, so the
   * scroll/reset effect stays quiet and the user's tab survives a re-click.
   */
  function openDrill(next: Drill, statusFilter: RinStatusTab = "missing") {
    const candidate = { ...next, statusFilter } as DrillState;
    setDrill((current) =>
      current !== null && sameDrill(current, candidate) ? current : candidate,
    );
  }

  /** The table's tabs; the drill owns the filter so the pill can mirror it. */
  function handleStatusTabChange(statusFilter: RinStatusTab) {
    setDrill((current) =>
      current === null
        ? { kind: "provider", statusFilter }
        : { ...current, statusFilter },
    );
  }

  function closeDrill() {
    setDrill(null);
    setActiveAttributes(new Set());
    setSelectedRins(new Set());
  }

  /** The pill's "clear all": drop the drill's filters, keep the drill open. */
  function clearDrillFilters() {
    setActiveAttributes(new Set());
    setSelectedRins(new Set());
  }

  function toggleAttribute(attribute: string) {
    setActiveAttributes((current) => {
      const next = new Set(current);
      if (next.has(attribute)) {
        next.delete(attribute);
      } else {
        next.add(attribute);
      }
      return next;
    });
  }

  function handleComponentChange(next: Component) {
    setComponent(next);
    closeDrill();
  }

  function handleCategoryChange(next: CategoryFilter) {
    setCategory(next);
    closeDrill();
  }

  /** Drop the loop a previous click started, if any. */
  function stopRefreshRun() {
    abortRefreshRun(refreshRunRef.current);
    refreshRunRef.current = null;
  }

  /**
   * Queue a fetch through the proxy, then poll the payload until its freshness
   * marker moves. The proxy answers 202 (queued), 409 (a fetch is already
   * running — poll straight away) or 429 (this instance's cooldown).
   */
  async function handleRefresh() {
    if (isRefreshing) {
      return;
    }
    stopRefreshRun();
    const run: RefreshRun = {
      cancelled: false,
      controller: null,
      timer: null,
      wake: null,
    };
    refreshRunRef.current = run;
    setRefreshMessage(null);

    // The API sends MAX(fetched_at) pre-formatted ("Nov 10, 2026 · 5:00 AM PT"),
    // so a marker that changed — not a parsed comparison — means a fetch landed.
    const previousFreshness = data?.last_checked ?? null;

    let response: Response;
    try {
      response = await fetch(REFRESH_URL, {
        method: "POST",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
    } catch {
      if (run.cancelled) {
        return;
      }
      refreshRunRef.current = null;
      setRefreshMessage("Refresh failed — try again");
      return;
    }
    if (run.cancelled || refreshRunRef.current !== run) {
      return;
    }

    const body = await readJsonBody(response);

    if (response.status === 429) {
      refreshRunRef.current = null;
      const retryAfter = body?.retryAfterMs;
      setRefreshMessage(
        typeof retryAfter === "number" && Number.isFinite(retryAfter)
          ? `Just refreshed — try again in ${Math.ceil(retryAfter / 1000)}s`
          : "Just refreshed — try again shortly",
      );
      return;
    }

    if (response.status !== 202 && response.status !== 409) {
      refreshRunRef.current = null;
      setRefreshMessage("Refresh failed — try again");
      return;
    }

    if (response.status === 409) {
      setRefreshMessage("Fetch already running — this takes ~2–3 min");
    }
    setIsRefreshing(true);
    await pollUntilFresh(run, previousFreshness);
  }

  /**
   * Poll the provider-wide payload every 4s for up to 60s, stopping the moment
   * the freshness marker moves past `previous`.
   */
  async function pollUntilFresh(run: RefreshRun, previous: string | null) {
    const startedAt = Date.now();
    const url = `${DASHBOARD_URL}/${encodeURIComponent(providerId)}?component=all`;

    for (;;) {
      if (run.cancelled) {
        return;
      }
      const remaining = REFRESH_POLL_TIMEOUT_MS - (Date.now() - startedAt);
      if (remaining <= 0) {
        break;
      }

      const controller = new AbortController();
      run.controller = controller;
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (response.ok) {
          const payload = normalizeDashboard(
            await response.json(),
            providerId,
            "all",
          );
          if (run.cancelled) {
            return;
          }
          if (
            payload.last_checked !== null &&
            payload.last_checked !== previous
          ) {
            finishRefresh(payload);
            return;
          }
        }
      } catch {
        // A dropped poll is not fatal: keep trying until the deadline.
        if (run.cancelled) {
          return;
        }
      } finally {
        run.controller = null;
      }

      await new Promise<void>((resolve) => {
        const wait = Math.max(0, Math.min(REFRESH_POLL_INTERVAL_MS, remaining));
        run.wake = resolve;
        run.timer = setTimeout(() => {
          run.timer = null;
          run.wake = null;
          resolve();
        }, wait);
      });
    }

    if (run.cancelled) {
      return;
    }
    refreshRunRef.current = null;
    setIsRefreshing(false);
    setRefreshMessage("Still running — check back shortly");
  }

  /** Store the polled payload, stop spinning and flash "Last checked" green. */
  function finishRefresh(payload: Dashboard) {
    refreshRunRef.current = null;
    setIsRefreshing(false);
    setRefreshMessage(null);
    setPolledData(payload);
    setFlashFreshness(true);
    if (flashTimeoutRef.current !== null) {
      clearTimeout(flashTimeoutRef.current);
    }
    flashTimeoutRef.current = setTimeout(() => {
      flashTimeoutRef.current = null;
      setFlashFreshness(false);
    }, FRESHNESS_FLASH_MS);
  }

  const isLoading = providersLoading || dashboardLoading;
  const lastChecked = data?.last_checked ?? null;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10" aria-busy={isLoading}>
      <header className="mb-6 flex items-start justify-between gap-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">RIN Watch</h1>
          <p className="text-sm text-gray-500">MIDAS rate publication monitor</p>
        </div>
        <div className="flex flex-col items-end gap-1 pt-1">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                void handleRefresh();
              }}
              disabled={isRefreshing}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2 py-1 text-[12px] text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isRefreshing ? (
                <>
                  <span
                    className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600"
                    aria-hidden="true"
                  />
                  Refreshing…
                </>
              ) : (
                "Refresh data"
              )}
            </button>
            <p className="text-sm text-gray-500">
              <span
                className="bg-green-500 w-2 h-2 rounded-full inline-block mr-2"
                aria-hidden="true"
              />
              Last checked:{" "}
              <span className={flashFreshness ? "text-green-600" : undefined}>
                {lastChecked ?? "—"}
              </span>
            </p>
          </div>
          {refreshMessage !== null ? (
            <p role="status" className="text-[12px] text-gray-500">
              {refreshMessage}
            </p>
          ) : null}
        </div>
      </header>

      {providersState.status === "error" ? (
        <ErrorPanel
          message={providersState.message}
          onRetry={reloadProviders}
        />
      ) : null}

      {providersLoading ? <DashboardSkeleton /> : null}

      {providersState.status === "ready" && providers.length === 0 ? (
        <section className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
          <h2 className="text-base font-semibold text-gray-900">
            No providers yet
          </h2>
          <p className="mt-2 text-sm text-gray-500">
            No RIN data is being collected yet. Tabs appear as soon as a
            provider has active RINs.
          </p>
        </section>
      ) : null}

      {providers.length > 0 ? (
        <>
          <ProviderTabs
            providers={providers}
            activeId={providerId}
            onSelect={setProviderId}
          />

          {showComponentToggle ? (
            <ComponentToggle
              component={component}
              onChange={handleComponentChange}
            />
          ) : null}

          {/* HFP RINs have no segment, so the category chips have no meaning
              on that tab: the strip is the whole HFP headline. */}
          {data && !isHfp ? (
            <CategoryChips
              segments={segmentChips}
              programs={programChips}
              active={category}
              onChange={handleCategoryChange}
            />
          ) : null}

          {isLoading ? <DashboardSkeleton /> : null}

          {dashboardState.status === "error" ? (
            <ErrorPanel
              message={dashboardState.message}
              onRetry={reloadDashboard}
            />
          ) : null}

          {data ? (
            <div className="space-y-6">
              {showComponentToggle ? (
                isHfp ? (
                  // HFP RINs carry no NBT codes (verified against the API), so
                  // the vintage matrix would be an empty panel here: the strip
                  // is the whole HFP headline.
                  <HfpStrip
                    rins={scopedRins}
                    onCellClick={(cell) =>
                      openDrill({ kind: "hfp" }, getDefaultStatus(cell))
                    }
                  />
                ) : (
                  <>
                    <HealthMatrix
                      rins={scopedRins}
                      selected={drill?.kind === "main" ? drill : null}
                      onCellClick={(cell, selection) =>
                        openDrill(
                          {
                            kind: "main",
                            row: selection.row,
                            col: selection.col,
                          },
                          getDefaultStatus(cell),
                        )
                      }
                    />

                    <NbtMatrix
                      rins={scopedRins}
                      selected={drill?.kind === "nbt" ? drill : null}
                      onCellClick={(cell, selection) =>
                        openDrill(
                          {
                            kind: "nbt",
                            row: selection.row,
                            col: selection.col,
                          },
                          getDefaultStatus(cell),
                        )
                      }
                    />
                  </>
                )
              ) : null}

              {effectiveDrill ? (
                <section
                  ref={drillRef}
                  aria-label="RIN drill"
                  className="scroll-mt-6 space-y-4"
                >
                  <FilterPill
                    segments={drillSegments}
                    onBack={showComponentToggle ? closeDrill : undefined}
                    onClear={clearDrillFilters}
                  />
                  <PatternStrip
                    affectedRins={drillAffected}
                    baselineRins={drillBaseline}
                    onAttributeClick={toggleAttribute}
                    activeAttributes={activeAttributes}
                  />
                  <AffectedRinsTable
                    rins={drillRows}
                    drillKey={`${providerId}:${drillKeyOf(effectiveDrill)}`}
                    activeStatusTab={effectiveDrill.statusFilter}
                    onStatusTabChange={handleStatusTabChange}
                    selectedRins={selectedRins}
                    onSelectionChange={setSelectedRins}
                  />
                </section>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
