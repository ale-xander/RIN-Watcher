"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Copy,
  Search,
  X,
} from "lucide-react";

const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000"
).replace(/\/+$/, "");

const PROVIDERS_URL = `${API_BASE_URL}/api/providers`;
const DASHBOARD_URL = `${API_BASE_URL}/api/dashboard`;

const DEFAULT_PROVIDER_ID = "pge";
const DEFAULT_COMPONENT: Component = "bundled";
const DEFAULT_SORT: Sort = { column: "rin", direction: "asc" };

/** Table segments, in group order. NBT is a program, never a segment. */
const SEGMENT_ORDER: Segment[] = ["ag", "non_res", "resid", "other"];
/** Chip order: the segments, with the NBT program chip before Other. */
const CATEGORY_ORDER: Category[] = ["ag", "non_res", "resid", "nbt", "other"];

const CATEGORY_LABELS: Record<Category, { chip: string; group: string }> = {
  ag: { chip: "AG", group: "AG" },
  non_res: { chip: "Non-Res", group: "Non-Residential" },
  resid: { chip: "Residential", group: "Residential" },
  nbt: { chip: "NBT", group: "NBT" },
  other: { chip: "Other", group: "Other" },
};

const EMPTY_RINS: RinEntry[] = [];

type Component = "bundled" | "unbundled";
type ViewMode = "failed" | "successful";
/** The tariff segment a RIN belongs to. */
type Segment = "ag" | "non_res" | "resid" | "other";
/** The four segments plus ``nbt``, which is a program and not a segment. */
type Category = Segment | "nbt";
type CategoryFilter = "all" | Category;
type SortColumn = "rin" | "tariff" | "enrollment" | "last_success";
type SortDirection = "asc" | "desc";
type Sort = { column: SortColumn; direction: SortDirection };

type Provider = {
  id: string;
  label: string;
  components: string[];
};

type RinEntry = {
  rin: string;
  rate_name: string | null;
  tariff: string | null;
  enrollment_codes: string[];
  category: Segment;
  has_value_today: 0 | 1;
  last_success_date: string | null;
  last_success: string | null;
};

type Dashboard = {
  provider: string;
  component: string | null;
  last_checked: string | null;
  total: number;
  has_value_count: number;
  no_value_count: number;
  failed_rins: RinEntry[];
  successful_rins: RinEntry[];
};

type ProvidersState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; providers: Provider[] };

type DashboardState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: Dashboard };

type RinGroup = { category: Segment; label: string; rows: RinEntry[] };

type CategoryChip = { id: CategoryFilter; label: string; count: number };

/**
 * Map an unknown API value onto the four segments the dashboard groups by.
 *
 * A legacy ``nbt`` category falls back to ``other``: it is a program, not a
 * segment, and the importer rewrites those rows to their real segment anyway.
 */
function normalizeCategory(value: unknown): Segment {
  return typeof value === "string" &&
    (SEGMENT_ORDER as string[]).includes(value)
    ? (value as Segment)
    : "other";
}

/** NBT (Net Billing Tariff) is a program, detected from the enrollment codes. */
function isNbt(entry: RinEntry): boolean {
  return entry.enrollment_codes.some((code) => code.startsWith("NBT-"));
}

function normalizeRinEntry(raw: unknown): RinEntry | null {
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
    has_value_today:
      row.has_value_today === 1 || row.has_value_today === true ? 1 : 0,
    last_success_date:
      typeof row.last_success_date === "string" ? row.last_success_date : null,
    last_success:
      typeof row.last_success === "string" ? row.last_success : null,
  };
}

/**
 * The API is the source of truth, but normalising the payload here keeps the
 * render tree safe: a slow/partial response can never make `.map()` explode.
 */
function normalizeProviders(payload: unknown): Provider[] {
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
        ? row.components.filter(
            (component): component is string =>
              component === "bundled" || component === "unbundled",
          )
        : [],
    });
  }
  return providers;
}

function normalizeDashboard(
  payload: unknown,
  fallbackProvider: string,
  fallbackComponent: Component | null,
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

/**
 * Clipboard writes can be rejected (permissions, non-secure context), so the
 * legacy textarea path is kept as a fallback for the copy-to-Excel workflow.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path below.
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const succeeded = document.execCommand("copy");
    document.body.removeChild(area);
    return succeeded;
  } catch {
    return false;
  }
}

function sortValue(entry: RinEntry, column: SortColumn): string {
  switch (column) {
    case "rin":
      return entry.rin;
    case "tariff":
      return entry.tariff ?? "";
    case "enrollment":
      return entry.enrollment_codes.join(", ");
    case "last_success":
      return entry.last_success_date ?? "";
  }
}

/**
 * Locale-aware sort for the visible rows. Empty values (no tariff / never
 * published) always sink to the bottom, regardless of the direction, so the
 * actionable rows stay at the top.
 */
function sortEntries(entries: RinEntry[], sort: Sort): RinEntry[] {
  const factor = sort.direction === "asc" ? 1 : -1;

  return [...entries].sort((a, b) => {
    const left = sortValue(a, sort.column);
    const right = sortValue(b, sort.column);
    if (!left && !right) {
      return a.rin.localeCompare(b.rin) * factor;
    }
    if (!left) {
      return 1;
    }
    if (!right) {
      return -1;
    }
    return (
      left.localeCompare(right, undefined, {
        numeric: true,
        sensitivity: "base",
      }) * factor
    );
  });
}

/** RIN \t Tariff \t Enrollment Codes \t Last Success, one row per line. */
function rowsToTsv(rows: RinEntry[]): string {
  return rows
    .map((entry) => {
      const codes = entry.enrollment_codes.join(", ");
      const lastSuccess =
        entry.last_success ?? entry.last_success_date ?? "";
      return `${entry.rin}\t${entry.tariff ?? ""}\t${codes}\t${lastSuccess}`;
    })
    .join("\n");
}

export default function Page() {
  const [providersState, setProvidersState] = useState<ProvidersState>({
    status: "loading",
  });
  const [providerId, setProviderId] = useState<string>(DEFAULT_PROVIDER_ID);
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
  const [dashboardState, setDashboardState] = useState<DashboardState>({
    status: "loading",
  });
  const [providersReloadToken, setProvidersReloadToken] = useState(0);
  const [dashboardReloadToken, setDashboardReloadToken] = useState(0);

  const providers =
    providersState.status === "ready" ? providersState.providers : [];
  const activeProvider =
    providers.find((provider) => provider.id === providerId) ?? null;
  // Only PG&E advertises a bundled/unbundled split in /api/providers.
  const showComponentToggle = (activeProvider?.components.length ?? 0) > 0;
  const requestComponent: Component | null = showComponentToggle
    ? component
    : null;

  // Tabs are driven by the API: a new CCA in the spreadsheet gets a tab
  // without a frontend release.
  useEffect(() => {
    const controller = new AbortController();
    setProvidersState({ status: "loading" });

    async function loadProviders() {
      try {
        const response = await fetch(PROVIDERS_URL, {
          signal: controller.signal,
          cache: "no-store",
          headers: { Accept: "application/json" },
        });

        if (!response.ok) {
          throw new Error(`Request failed (HTTP ${response.status}).`);
        }

        const list = normalizeProviders(await response.json());
        setProvidersState({ status: "ready", providers: list });
        setProviderId((current) => {
          if (list.some((provider) => provider.id === current)) {
            return current;
          }
          return (
            list.find((provider) => provider.id === DEFAULT_PROVIDER_ID)?.id ??
            list[0]?.id ??
            current
          );
        });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        setProvidersState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not load provider tabs.",
        });
      }
    }

    void loadProviders();
    return () => controller.abort();
  }, [providersReloadToken]);

  const dashboardUrl = useMemo(() => {
    if (providersState.status !== "ready") {
      return null;
    }
    const provider = providersState.providers.find(
      (candidate) => candidate.id === providerId,
    );
    if (!provider) {
      return null;
    }
    const query =
      provider.components.length > 0 ? `?component=${component}` : "";
    return `${DASHBOARD_URL}/${encodeURIComponent(providerId)}${query}`;
  }, [providersState, providerId, component]);

  useEffect(() => {
    const url = dashboardUrl;
    if (!url) {
      return;
    }
    const controller = new AbortController();
    setDashboardState({ status: "loading" });

    async function loadDashboard(target: string) {
      try {
        const response = await fetch(target, {
          signal: controller.signal,
          cache: "no-store",
          headers: { Accept: "application/json" },
        });

        if (!response.ok) {
          let detail = `Request failed (HTTP ${response.status}).`;
          try {
            const body = (await response.json()) as { detail?: unknown };
            if (typeof body.detail === "string") {
              detail = body.detail;
            }
          } catch {
            // Body was empty or not JSON; keep the generic status message.
          }
          throw new Error(detail);
        }

        const payload = await response.json();
        setDashboardState({
          status: "ready",
          data: normalizeDashboard(payload, providerId, requestComponent),
        });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        setDashboardState({
          status: "error",
          message:
            error instanceof Error ? error.message : "Could not load RIN data.",
        });
      }
    }

    void loadDashboard(url);
    return () => controller.abort();
  }, [dashboardUrl, providerId, requestComponent, dashboardReloadToken]);

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

  const readyData =
    dashboardState.status === "ready" ? dashboardState.data : null;
  const dashboardMatchesSelection =
    readyData !== null &&
    readyData.provider === providerId &&
    (!showComponentToggle || readyData.component === component);
  const data = dashboardMatchesSelection ? readyData : null;

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
      if (category === "nbt") {
        // NBT is a program, detected from the enrollment codes. The table
        // groups the result by segment rather than filtering it.
        if (!isNbt(entry)) {
          return false;
        }
      } else if (category !== "all" && entry.category !== category) {
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
  }, [viewEntries, category, searchQuery, sort]);

  // "All" (every segment) and NBT (every segment, NBT only) stay grouped; a
  // single segment chip is a flat list.
  const grouped = category === "all" || category === "nbt";

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
    if (category === "all") {
      return {
        total: data.total,
        withValue: data.has_value_count,
        withoutValue: data.no_value_count,
      };
    }
    const inCategory = [...data.failed_rins, ...data.successful_rins].filter(
      (entry) => {
        if (category === "nbt") {
          return isNbt(entry);
        }
        return entry.category === category;
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
  }, [data, category]);

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

  useEffect(() => {
    if (!data) {
      return;
    }
    if (category !== "all" && categoryCounts[category] === 0) {
      setCategory("all");
    }
  }, [data, category, categoryCounts]);

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
  const providersLoading = providersState.status === "loading";
  const dashboardLoading =
    dashboardState.status === "loading" ||
    (dashboardState.status === "ready" && !dashboardMatchesSelection);
  const isLoading = providersLoading || dashboardLoading;
  const lastChecked = data?.last_checked ?? null;
  const categoryLabel =
    category === "all" ? null : CATEGORY_LABELS[category].group;
  const emptyMessage =
    searchQuery.trim().length > 0
      ? "No RINs match your search."
      : categoryLabel && categoryCounts[category] > 0
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
          onRetry={() => setProvidersReloadToken((token) => token + 1)}
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

          {data ? (
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
              onRetry={() => setDashboardReloadToken((token) => token + 1)}
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

function ProviderTabs({
  providers,
  activeId,
  onSelect,
}: {
  providers: Provider[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav
      aria-label="Providers"
      className="mb-4 flex gap-6 overflow-x-auto border-b border-gray-200"
    >
      {providers.map((provider) => {
        const isActive = provider.id === activeId;
        return (
          <button
            key={provider.id}
            type="button"
            onClick={() => onSelect(provider.id)}
            aria-current={isActive ? "page" : undefined}
            className={`whitespace-nowrap text-sm pb-3 ${
              isActive
                ? "border-b-2 border-blue-600 text-gray-900 font-medium -mb-px"
                : "text-gray-500 hover:text-gray-700 transition-colors"
            }`}
          >
            {provider.label}
          </button>
        );
      })}
    </nav>
  );
}

function ComponentToggle({
  component,
  onChange,
}: {
  component: Component;
  onChange: (component: Component) => void;
}) {
  return (
    <div className="mb-4">
      <div
        role="group"
        aria-label="PG&E component"
        className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5 shadow-sm"
      >
        {(["bundled", "unbundled"] as const).map((option) => {
          const isActive = option === component;
          return (
            <button
              key={option}
              type="button"
              onClick={() => onChange(option)}
              aria-pressed={isActive}
              className={`rounded-md px-3 py-1 text-xs font-medium capitalize transition-colors ${
                isActive
                  ? "bg-gray-900 text-white shadow-sm"
                  : "text-gray-600 hover:text-gray-900"
              }`}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Shared chip button for the category filter row. */
function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  const activeClassName = "border-gray-900 bg-gray-900 text-white";
  const idleClassName =
    "border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:text-gray-900";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active ? activeClassName : idleClassName
      }`}
    >
      {label}
      <span
        className={`tabular-nums ${
          active ? "text-white/70" : "text-gray-400"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function CategoryChips({
  chips,
  active,
  onChange,
}: {
  chips: CategoryChip[];
  active: CategoryFilter;
  onChange: (category: CategoryFilter) => void;
}) {
  return (
    <div className="mb-6">
      <div
        role="group"
        aria-label="Filter by category"
        className="flex flex-wrap items-center gap-2"
      >
        {chips.map((chip) => (
          <FilterChip
            key={chip.id}
            label={chip.label}
            count={chip.count}
            active={chip.id === active}
            onClick={() => onChange(chip.id)}
          />
        ))}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  valueClassName,
  subtext,
  icon,
  active = false,
  activeRingClassName = "ring-blue-500",
  onClick,
}: {
  label: string;
  value: number;
  valueClassName: string;
  subtext?: string;
  icon?: ReactNode;
  active?: boolean;
  activeRingClassName?: string;
  onClick?: () => void;
}) {
  const cardClassName = [
    "bg-white border rounded-xl p-6 shadow-sm transition-all cursor-pointer",
    active
      ? `border-transparent ring-2 ${activeRingClassName}`
      : "border-gray-200 hover:shadow-md",
  ].join(" ");

  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
          {label}
        </span>
        {icon}
      </div>
      <p
        className={`${valueClassName} font-semibold mt-2 mb-1 tabular-nums leading-none`}
      >
        {value}
      </p>
      {subtext ? <p className="text-sm text-gray-500">{subtext}</p> : null}
    </>
  );

  if (!onClick) {
    return <div className={cardClassName}>{content}</div>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`${cardClassName} text-left`}
    >
      {content}
    </button>
  );
}

function SortableHeader({
  label,
  column,
  sort,
  onSort,
  align = "left",
}: {
  label: string;
  column: SortColumn;
  sort: Sort;
  onSort: (column: SortColumn) => void;
  align?: "left" | "right";
}) {
  const isActive = sort.column === column;
  const isDescending = sort.direction === "desc";

  return (
    <th
      scope="col"
      aria-sort={
        isActive ? (isDescending ? "descending" : "ascending") : "none"
      }
      className={`px-3 py-3 ${align === "right" ? "text-right" : ""}`}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-1.5 uppercase tracking-wide transition-colors ${
          align === "right" ? "flex-row-reverse" : ""
        } ${isActive ? "text-gray-900" : "text-gray-500 hover:text-gray-700"}`}
      >
        {label}
        {isActive ? (
          isDescending ? (
            <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
          )
        ) : (
          <ChevronsUpDown
            className="h-3.5 w-3.5 text-gray-300"
            aria-hidden="true"
          />
        )}
      </button>
    </th>
  );
}

function RinTable({
  viewMode,
  grouped,
  rows,
  groups,
  copyRows,
  sort,
  onSort,
  checkedRins,
  onToggleRow,
  onToggleAll,
  collapsedGroups,
  onToggleGroup,
  searchQuery,
  onSearchChange,
  emptyMessage,
}: {
  viewMode: ViewMode;
  grouped: boolean;
  rows: RinEntry[];
  groups: RinGroup[];
  copyRows: RinEntry[];
  sort: Sort;
  onSort: (column: SortColumn) => void;
  checkedRins: Set<string>;
  onToggleRow: (rin: string) => void;
  onToggleAll: () => void;
  collapsedGroups: Set<Segment>;
  onToggleGroup: (group: Segment) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  emptyMessage: string;
}) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const selectAllRef = useRef<HTMLInputElement>(null);

  const isFailed = viewMode === "failed";
  const title = isFailed ? "Failed RINs — needs follow-up" : "Successful RINs";
  const badgeClassName = isFailed
    ? "bg-red-50 text-red-700"
    : "bg-green-50 text-green-700";

  const allSelected =
    rows.length > 0 && rows.every((entry) => checkedRins.has(entry.rin));
  const someSelected =
    !allSelected && rows.some((entry) => checkedRins.has(entry.rin));

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelected;
    }
  }, [someSelected]);

  useEffect(() => {
    if (copyStatus === "idle") {
      return;
    }
    const timer = setTimeout(() => setCopyStatus("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copyStatus]);

  async function handleCopy() {
    if (copyRows.length === 0) {
      return;
    }
    const succeeded = await copyToClipboard(rowsToTsv(copyRows));
    setCopyStatus(succeeded ? "copied" : "error");
  }

  const copyLabel =
    copyStatus === "copied"
      ? "Copied"
      : copyStatus === "error"
        ? "Copy failed"
        : "Copy selected";

  return (
    <section className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
      <div className="flex flex-col gap-4 px-6 py-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums ${badgeClassName}`}
          >
            {rows.length}
          </span>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search RIN, tariff, or code…"
              aria-label="Search RINs"
              className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-9 pr-8 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500/30 sm:w-64"
            />
            {searchQuery ? (
              <button
                type="button"
                onClick={() => onSearchChange("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 transition-colors hover:text-gray-600"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </div>

          <button
            type="button"
            onClick={handleCopy}
            disabled={copyRows.length === 0}
            title={
              checkedRins.size > 0
                ? "Copy checked RINs"
                : "Copy all visible RINs"
            }
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 flex items-center justify-center gap-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            {copyStatus === "copied" ? (
              <Check className="w-4 h-4" aria-hidden="true" />
            ) : (
              <Copy className="w-4 h-4" aria-hidden="true" />
            )}
            {copyLabel}
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 border-y border-gray-200 text-xs uppercase text-gray-500 font-semibold">
            <tr>
              <th scope="col" className="w-12 px-6 py-3">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  checked={allSelected}
                  onChange={onToggleAll}
                  disabled={rows.length === 0}
                  aria-label="Select all visible RINs"
                  className="h-4 w-4 rounded border-gray-300 accent-blue-600 cursor-pointer disabled:cursor-not-allowed"
                />
              </th>
              <SortableHeader
                label="RIN"
                column="rin"
                sort={sort}
                onSort={onSort}
              />
              <SortableHeader
                label="Tariff"
                column="tariff"
                sort={sort}
                onSort={onSort}
              />
              <SortableHeader
                label="Enrollment Codes"
                column="enrollment"
                sort={sort}
                onSort={onSort}
              />
              <SortableHeader
                label="Last Success"
                column="last_success"
                sort={sort}
                onSort={onSort}
                align="right"
              />
            </tr>
          </thead>

          {rows.length === 0 ? (
            <tbody>
              <tr>
                <td
                  colSpan={5}
                  className="px-6 py-10 text-center text-sm text-gray-500"
                >
                  {emptyMessage}
                </td>
              </tr>
            </tbody>
          ) : grouped ? (
            groups.map((group) => {
              const isCollapsed = collapsedGroups.has(group.category);
              return (
                <tbody key={group.category} className="border-t border-gray-100">
                  <tr className="bg-gray-50/70">
                    <th
                      scope="colgroup"
                      colSpan={5}
                      className="px-6 py-2.5 text-left"
                    >
                      <button
                        type="button"
                        onClick={() => onToggleGroup(group.category)}
                        aria-expanded={!isCollapsed}
                        className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-600 transition-colors hover:text-gray-900"
                      >
                        {isCollapsed ? (
                          <ChevronRight
                            className="h-3.5 w-3.5"
                            aria-hidden="true"
                          />
                        ) : (
                          <ChevronDown
                            className="h-3.5 w-3.5"
                            aria-hidden="true"
                          />
                        )}
                        {group.label}
                        <span className="rounded-full border border-gray-200 bg-white px-2 py-0.5 text-[11px] font-semibold tabular-nums text-gray-500">
                          {group.rows.length}
                        </span>
                      </button>
                    </th>
                  </tr>
                  {isCollapsed
                    ? null
                    : group.rows.map((entry) => (
                        <RinRow
                          key={entry.rin}
                          entry={entry}
                          checked={checkedRins.has(entry.rin)}
                          onToggle={onToggleRow}
                        />
                      ))}
                </tbody>
              );
            })
          ) : (
            <tbody className="divide-y divide-gray-100">
              {rows.map((entry) => (
                <RinRow
                  key={entry.rin}
                  entry={entry}
                  checked={checkedRins.has(entry.rin)}
                  onToggle={onToggleRow}
                />
              ))}
            </tbody>
          )}
        </table>
      </div>
    </section>
  );
}

function RinRow({
  entry,
  checked,
  onToggle,
}: {
  entry: RinEntry;
  checked: boolean;
  onToggle: (rin: string) => void;
}) {
  const lastSuccess = entry.last_success ?? entry.last_success_date ?? "—";

  return (
    <tr className="transition-colors hover:bg-gray-50">
      <td className="w-12 px-6 py-3">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(entry.rin)}
          aria-label={`Select ${entry.rin}`}
          className="h-4 w-4 rounded border-gray-300 accent-blue-600 cursor-pointer"
        />
      </td>
      <td className="px-3 py-3 font-mono text-gray-900 whitespace-nowrap">
        {entry.rin}
      </td>
      <td className="px-3 py-3 text-gray-600 whitespace-nowrap">
        {entry.tariff ?? "—"}
      </td>
      <td className="px-3 py-3">
        <div className="flex flex-wrap gap-1">
          {entry.enrollment_codes.length === 0 ? (
            <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
              no codes
            </span>
          ) : (
            entry.enrollment_codes.map((code) => (
              <span
                key={code}
                className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600"
              >
                {code}
              </span>
            ))
          )}
        </div>
      </td>
      <td className="px-3 py-3 pr-6 text-right text-gray-500 whitespace-nowrap">
        {lastSuccess}
      </td>
    </tr>
  );
}

function DashboardSkeleton() {
  return (
    <div role="status" aria-live="polite" className="animate-pulse">
      <span className="sr-only">Loading RIN status…</span>

      <div className="mb-6 flex flex-wrap gap-2">
        {[0, 1, 2, 3, 4].map((chip) => (
          <div key={chip} className="h-6 w-20 rounded-full bg-gray-200" />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 sm:gap-6 mb-6">
        {[0, 1, 2].map((card) => (
          <div
            key={card}
            className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm"
          >
            <div className="h-3 w-24 rounded bg-gray-200" />
            <div className="mt-4 h-10 w-16 rounded bg-gray-200" />
            <div className="mt-4 h-3 w-40 max-w-full rounded bg-gray-200" />
          </div>
        ))}
      </div>

      <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
        <div className="flex flex-col gap-4 px-6 py-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="h-4 w-52 rounded bg-gray-200" />
            <div className="h-4 w-7 rounded-full bg-gray-200" />
          </div>
          <div className="flex items-center gap-3">
            <div className="h-9 w-64 rounded-lg bg-gray-200" />
            <div className="h-9 w-36 rounded-lg bg-gray-200" />
          </div>
        </div>

        <div className="bg-gray-50 border-y border-gray-200 px-6 py-3">
          <div className="flex items-center gap-8">
            <div className="h-3 w-4 rounded bg-gray-200" />
            <div className="h-3 w-10 rounded bg-gray-200" />
            <div className="h-3 w-14 rounded bg-gray-200" />
            <div className="h-3 w-32 rounded bg-gray-200" />
            <div className="ml-auto h-3 w-24 rounded bg-gray-200" />
          </div>
        </div>

        {[0, 1, 2, 3, 4].map((row) => (
          <div
            key={row}
            className={`flex items-center gap-8 px-6 py-4 ${
              row % 2 === 0 ? "bg-white" : "bg-gray-50/50"
            }`}
          >
            <div className="h-4 w-4 rounded bg-gray-200" />
            <div className="h-3 w-48 rounded bg-gray-200" />
            <div className="h-3 w-12 rounded bg-gray-200" />
            <div className="h-3 w-40 rounded bg-gray-200" />
            <div className="ml-auto h-3 w-24 rounded bg-gray-200" />
          </div>
        ))}
      </div>
    </div>
  );
}

function ErrorPanel({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const isUnknownProvider = message.toLowerCase().includes("unknown provider");

  return (
    <section
      role="alert"
      className="bg-white border border-red-200 rounded-xl shadow-sm p-6"
    >
      <h2 className="text-base font-semibold text-red-700">
        Could not load RIN data
      </h2>
      <p className="mt-2 text-sm text-red-700">{message}</p>

      {isUnknownProvider ? (
        <p className="mt-2 text-sm text-gray-500">
          No RIN data is being collected for this provider yet.
        </p>
      ) : (
        <p className="mt-2 text-sm text-gray-500">
          Make sure the API is running:{" "}
          <code className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono text-xs text-gray-800">
            uvicorn main:app --reload --port 8000
          </code>
        </p>
      )}

      <button
        type="button"
        onClick={onRetry}
        className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
      >
        Try again
      </button>
    </section>
  );
}
