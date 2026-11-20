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
// (breadcrumb + not-yet-live toggle), the pattern chips ("what do the failing
// RINs have in common") and the affected-RINs table with its copy button. This
// file owns the state; every counting rule lives in `lib/`.

import { useEffect, useMemo, useRef, useState } from "react";

import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  DEFAULT_COMPONENT,
  EMPTY_RINS,
} from "@/lib/constants";
import {
  affectedRins as selectAffectedRins,
  drillBaselineRins,
  filterByAttributes,
  sameDrill,
  sortByStaleness,
} from "@/lib/drill";
import type { Drill, MainColKey, MainRowKey, NbtColKey } from "@/lib/drill";
import { isNbt } from "@/lib/rin-utils";
import type { CategoryChip, CategoryFilter, Component } from "@/lib/types";

import { AffectedRinsTable } from "./affected-rins-table";
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
  const [drill, setDrill] = useState<Drill | null>(null);
  const [activeAttributes, setActiveAttributes] = useState<Set<string>>(
    () => new Set(),
  );
  const [showNotYetLive, setShowNotYetLive] = useState(false);
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
    setShowNotYetLive(false);
    setSelectedRins(new Set());
  }, [providerId, requestComponent]);

  // A new drill starts unfiltered and brings itself into view. Re-clicking the
  // same cell keeps the same object, so it does not yank the page around.
  useEffect(() => {
    if (!drill) {
      return;
    }
    setActiveAttributes(new Set());
    setShowNotYetLive(false);
    setSelectedRins(new Set());
    drillRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [drill]);

  const failedRins = data?.failed_rins ?? EMPTY_RINS;
  const successfulRins = data?.successful_rins ?? EMPTY_RINS;

  // Both matrices, the HFP strip and every drill read this one list, so a cell
  // and the drill it opens can never disagree about which RINs it contains.
  const allRins = useMemo(
    () => [...failedRins, ...successfulRins],
    [failedRins, successfulRins],
  );

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
    for (const entry of allRins) {
      counts.all += 1;
      counts[entry.category] += 1;
      if (isNbt(entry)) {
        counts.nbt += 1;
      }
    }
    return counts;
  }, [allRins]);

  const chips = useMemo<CategoryChip[]>(() => {
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
    return list.filter((chip) => chip.count > 0 || chip.id === category);
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
  // their dashboard opens straight into a provider-wide list.
  const effectiveDrill = useMemo<Drill | null>(
    () => (showComponentToggle ? drill : { kind: "provider" }),
    [showComponentToggle, drill],
  );

  const drillBaseline = useMemo(
    () =>
      effectiveDrill
        ? drillBaselineRins(scopedRins, effectiveDrill)
        : EMPTY_RINS,
    [scopedRins, effectiveDrill],
  );
  const drillAffected = useMemo(
    () => selectAffectedRins(drillBaseline, showNotYetLive),
    [drillBaseline, showNotYetLive],
  );
  // Drives the empty state's "include N not-yet-live RINs" shortcut: with none
  // in the baseline, turning the toggle on could not add a row.
  const drillNotYetLiveCount = useMemo(
    () =>
      drillBaseline.filter((entry) => entry.status_kind === "not_in_midas")
        .length,
    [drillBaseline],
  );
  const affectedRows = useMemo(
    () => sortByStaleness(filterByAttributes(drillAffected, activeAttributes)),
    [drillAffected, activeAttributes],
  );

  // Drop checks that no longer exist so the copy button can never reference a
  // RIN that left the drill (attribute chip, not-yet-live toggle, refresh).
  useEffect(() => {
    setSelectedRins((current) => {
      if (current.size === 0) {
        return current;
      }
      const available = new Set(affectedRows.map((entry) => entry.rin));
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
  }, [affectedRows]);

  const drillSegments = useMemo(() => {
    if (!effectiveDrill) {
      return [];
    }
    const segments = drillScopeLabels(effectiveDrill);
    segments.push(showNotYetLive ? "Missing + not-yet-live" : "Missing");
    if (category !== "all") {
      segments.push(CATEGORY_LABELS[category].group);
    }
    segments.push(...activeAttributes);
    return segments;
  }, [effectiveDrill, showNotYetLive, category, activeAttributes]);

  function openDrill(next: Drill) {
    // Same cell: keep the object so the scroll/reset effect stays quiet.
    setDrill((current) =>
      current !== null && sameDrill(current, next) ? current : next,
    );
  }

  function closeDrill() {
    setDrill(null);
    setActiveAttributes(new Set());
    setShowNotYetLive(false);
    setSelectedRins(new Set());
  }

  /** The pill's "clear all": drop the drill's filters, keep the drill open. */
  function clearDrillFilters() {
    setActiveAttributes(new Set());
    setShowNotYetLive(false);
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

          {data ? (
            <CategoryChips
              chips={chips}
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
                    onCellClick={() => openDrill({ kind: "hfp" })}
                  />
                ) : (
                  <>
                    <HealthMatrix
                      rins={scopedRins}
                      selected={drill?.kind === "main" ? drill : null}
                      onCellClick={(_cell, selection) =>
                        openDrill({
                          kind: "main",
                          row: selection.row,
                          col: selection.col,
                        })
                      }
                    />

                    <NbtMatrix
                      rins={scopedRins}
                      selected={drill?.kind === "nbt" ? drill : null}
                      onCellClick={(_cell, selection) =>
                        openDrill({
                          kind: "nbt",
                          row: selection.row,
                          col: selection.col,
                        })
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
                    showNotYetLive={showNotYetLive}
                    onToggleNotYetLive={setShowNotYetLive}
                  />
                  <PatternStrip
                    affectedRins={drillAffected}
                    baselineRins={drillBaseline}
                    onAttributeClick={toggleAttribute}
                    activeAttributes={activeAttributes}
                  />
                  <AffectedRinsTable
                    rins={affectedRows}
                    showNotYetLive={showNotYetLive}
                    onShowNotYetLiveChange={setShowNotYetLive}
                    notYetLiveCount={drillNotYetLiveCount}
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
