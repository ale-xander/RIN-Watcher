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
import { isNbt } from "@/lib/rin-utils";
import type {
  Category,
  CategoryChip,
  CategoryFilter,
  Component,
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
    data,
    providersLoading,
    dashboardLoading,
    reloadProviders,
    reloadDashboard,
  } = useDashboardData("all");

  const isHfp = showComponentToggle && component === "hfp";

  // A new provider/component means new RINs: every drill, filter and check on
  // the old ones is stale.
  useEffect(() => {
    setCategory("all");
    setDrill(null);
    setActiveAttributes(new Set());
    setSelectedRins(new Set());
  }, [providerId, requestComponent]);

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

  const isLoading = providersLoading || dashboardLoading;
  const lastChecked = data?.last_checked ?? null;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10" aria-busy={isLoading}>
      <header className="mb-6 flex items-start justify-between gap-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">RIN Watch</h1>
          <p className="text-sm text-gray-500">MIDAS rate publication monitor</p>
        </div>
        <p className="pt-1 text-sm text-gray-500">
          <span
            className="bg-green-500 w-2 h-2 rounded-full inline-block mr-2"
            aria-hidden="true"
          />
          Last checked: {lastChecked ?? "—"}
        </p>
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
