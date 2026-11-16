"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check } from "lucide-react";

import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  DEFAULT_COMPONENT,
  DEFAULT_SORT,
  EMPTY_RINS,
  SEGMENT_ORDER,
} from "@/lib/constants";
import { isNbt, sortEntries } from "@/lib/rin-utils";
import type {
  CategoryChip,
  CategoryFilter,
  Component,
  RinGroup,
  Segment,
  Sort,
  SortColumn,
  ViewMode,
} from "@/lib/types";

import { CategoryChips } from "./category-chips";
import { ComponentToggle } from "./component-toggle";
import { DashboardSkeleton } from "./dashboard-skeleton";
import { ErrorPanel } from "./error-panel";
import { ProviderTabs } from "./provider-tabs";
import { RinTable } from "./rin-table";
import { StatCard } from "./stat-card";
import { useDashboardData } from "./use-dashboard-data";

export function Dashboard() {
  const [component, setComponent] = useState<Component>(DEFAULT_COMPONENT);
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("failed");
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [searchQuery, setSearchQuery] = useState("");
  const [checkedRins, setCheckedRins] = useState<Set<string>>(
    () => new Set(),
  );
  const [collapsedGroups, setCollapsedGroups] = useState<Set<Segment>>(
    () => new Set(),
  );

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
  } = useDashboardData(component);

  // HFP is a single flat list: no category chips and no group headers.
  const isHfp = showComponentToggle && component === "hfp";
  // Chips can't be clicked while HFP is selected, so any leftover selection is
  // ignored instead of filtering the flat list down to nothing.
  const activeCategory: CategoryFilter = isHfp ? "all" : category;

  // A new provider/component means new RINs and new category counts.
  useEffect(() => {
    setCategory("all");
    setCheckedRins(new Set());
    setCollapsedGroups(new Set());
  }, [providerId, requestComponent]);

  // Switching between the failed/successful lists invalidates the selection.
  useEffect(() => {
    setCheckedRins(new Set());
  }, [viewMode]);

  const failedRins = data?.failed_rins ?? EMPTY_RINS;
  const successfulRins = data?.successful_rins ?? EMPTY_RINS;

  // Chip counts ignore viewMode/search: they describe the provider/component
  // payload that is already in memory (no refetch when a chip is clicked).
  // ``nbt`` is counted from the enrollment codes, every other key from the
  // segment stored on the row.
  const categoryCounts = useMemo(() => {
    const counts: Record<CategoryFilter, number> = {
      all: 0,
      ag: 0,
      non_res: 0,
      resid: 0,
      nbt: 0,
      other: 0,
    };
    for (const entry of failedRins) {
      counts.all += 1;
      counts[entry.category] += 1;
      if (isNbt(entry)) {
        counts.nbt += 1;
      }
    }
    for (const entry of successfulRins) {
      counts.all += 1;
      counts[entry.category] += 1;
      if (isNbt(entry)) {
        counts.nbt += 1;
      }
    }
    return counts;
  }, [failedRins, successfulRins]);

  const viewEntries = useMemo(
    () => (viewMode === "failed" ? failedRins : successfulRins),
    [viewMode, failedRins, successfulRins],
  );

  // Drop checks that no longer exist after a refresh so the copy button can
  // never reference a RIN that disappeared from the payload.
  useEffect(() => {
    setCheckedRins((current) => {
      if (current.size === 0) {
        return current;
      }
      const available = new Set(viewEntries.map((entry) => entry.rin));
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
  }, [viewEntries]);

  const visibleRows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const filtered = viewEntries.filter((entry) => {
      if (activeCategory === "nbt") {
        // NBT is a program, detected from the enrollment codes. The table
        // groups the result by segment rather than filtering it.
        if (!isNbt(entry)) {
          return false;
        }
      } else if (
        activeCategory !== "all" &&
        entry.category !== activeCategory
      ) {
        return false;
      }
      if (!query) {
        return true;
      }
      return (
        entry.rin.toLowerCase().includes(query) ||
        (entry.tariff ?? "").toLowerCase().includes(query) ||
        entry.enrollment_codes.some((code) =>
          code.toLowerCase().includes(query),
        )
      );
    });
    return sortEntries(filtered, sort);
  }, [viewEntries, activeCategory, searchQuery, sort]);

  // HFP has no categories, so it is always a flat list. "All" (every segment)
  // and NBT (every segment, NBT only) stay grouped; a single segment chip is a
  // flat list.
  const grouped =
    !isHfp && (activeCategory === "all" || activeCategory === "nbt");

  const groups = useMemo<RinGroup[]>(() => {
    if (!grouped) {
      return [];
    }
    return SEGMENT_ORDER.map((group) => ({
      category: group,
      label: CATEGORY_LABELS[group].group,
      rows: visibleRows.filter((entry) => entry.category === group),
    })).filter((group) => group.rows.length > 0);
  }, [visibleRows, grouped]);

  // Cards stay in sync with the chip selection without a network round trip.
  const cardCounts = useMemo(() => {
    if (!data) {
      return { total: 0, withValue: 0, withoutValue: 0 };
    }
    if (activeCategory === "all") {
      return {
        total: data.total,
        withValue: data.has_value_count,
        withoutValue: data.no_value_count,
      };
    }
    const inCategory = [...data.failed_rins, ...data.successful_rins].filter(
      (entry) => {
        if (activeCategory === "nbt") {
          return isNbt(entry);
        }
        return entry.category === activeCategory;
      },
    );
    const withValue = inCategory.filter(
      (entry) => entry.has_value_today === 1,
    ).length;
    return {
      total: inCategory.length,
      withValue,
      withoutValue: inCategory.length - withValue,
    };
  }, [data, activeCategory]);

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
    return list.filter(
      (chip) => chip.count > 0 || chip.id === activeCategory,
    );
  }, [categoryCounts, activeCategory]);

  useEffect(() => {
    if (!data) {
      return;
    }
    if (activeCategory !== "all" && categoryCounts[activeCategory] === 0) {
      setCategory("all");
    }
  }, [data, activeCategory, categoryCounts]);

  // Checked rows win; otherwise copy what is on screen, in sort order.
  const copyRows = useMemo(
    () =>
      checkedRins.size > 0
        ? viewEntries.filter((entry) => checkedRins.has(entry.rin))
        : visibleRows,
    [checkedRins, viewEntries, visibleRows],
  );

  function toggleRow(rin: string) {
    setCheckedRins((current) => {
      const next = new Set(current);
      if (next.has(rin)) {
        next.delete(rin);
      } else {
        next.add(rin);
      }
      return next;
    });
  }

  function toggleAllVisible() {
    const visible = visibleRows.map((entry) => entry.rin);
    setCheckedRins((current) => {
      const next = new Set(current);
      const allChecked =
        visible.length > 0 && visible.every((rin) => next.has(rin));
      for (const rin of visible) {
        if (allChecked) {
          next.delete(rin);
        } else {
          next.add(rin);
        }
      }
      return next;
    });
  }

  function toggleGroup(group: Segment) {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  }

  function handleSort(column: SortColumn) {
    setSort((current) =>
      current.column === column
        ? {
            column,
            direction: current.direction === "asc" ? "desc" : "asc",
          }
        : { column, direction: "asc" },
    );
  }

  const successPercentage =
    cardCounts.total > 0 ? (cardCounts.withValue / cardCounts.total) * 100 : 0;
  const isLoading = providersLoading || dashboardLoading;
  const lastChecked = data?.last_checked ?? null;
  const categoryLabel =
    activeCategory === "all" ? null : CATEGORY_LABELS[activeCategory].group;
  const emptyMessage =
    searchQuery.trim().length > 0
      ? "No RINs match your search."
      : categoryLabel && categoryCounts[activeCategory] > 0
        ? viewMode === "failed"
          ? `No failed ${categoryLabel} RINs — all caught up 🎉`
          : `No successful ${categoryLabel} RINs yet.`
        : viewMode === "failed"
          ? "No failed RINs — everything published 🎉"
          : "No RIN has published a value today yet.";

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
              onChange={setComponent}
            />
          ) : null}

          {data && !isHfp ? (
            <CategoryChips
              chips={chips}
              active={category}
              onChange={setCategory}
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
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 sm:gap-6 mb-6">
                <StatCard
                  label="TOTAL RINS"
                  value={cardCounts.total}
                  valueClassName="text-5xl text-gray-900"
                />
                <StatCard
                  label="HAS VALUE TODAY"
                  value={cardCounts.withValue}
                  valueClassName="text-5xl text-green-600"
                  subtext={`${successPercentage.toFixed(1)}% published successfully`}
                  icon={
                    <Check
                      className="w-5 h-5 text-green-600"
                      strokeWidth={2.5}
                      aria-hidden="true"
                    />
                  }
                  active={viewMode === "successful"}
                  activeRingClassName="ring-green-500"
                  onClick={() => setViewMode("successful")}
                />
                <StatCard
                  label="NO VALUE TODAY"
                  value={cardCounts.withoutValue}
                  valueClassName="text-5xl text-red-600"
                  subtext="Requires utility follow-up"
                  icon={
                    <AlertTriangle
                      className="w-5 h-5 text-red-600"
                      strokeWidth={2.5}
                      aria-hidden="true"
                    />
                  }
                  active={viewMode === "failed"}
                  activeRingClassName="ring-red-500"
                  onClick={() => setViewMode("failed")}
                />
              </div>

              <RinTable
                viewMode={viewMode}
                grouped={grouped}
                rows={visibleRows}
                groups={groups}
                copyRows={copyRows}
                sort={sort}
                onSort={handleSort}
                checkedRins={checkedRins}
                onToggleRow={toggleRow}
                onToggleAll={toggleAllVisible}
                collapsedGroups={collapsedGroups}
                onToggleGroup={toggleGroup}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                emptyMessage={emptyMessage}
              />
            </>
          ) : null}
        </>
      ) : null}
    </main>
  );
}

