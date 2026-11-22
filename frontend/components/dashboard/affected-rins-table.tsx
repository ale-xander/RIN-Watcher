// The drill's result list: one row per affected RIN.
//
// Columns adapt to the drill instead of rendering empty ones: Vintage only when
// the drill contains NBT RINs, Voltage/Discount/DR/Other only when at least one
// row carries that attribute. Rows are already filtered by the parent; this file
// owns rendering, the checkbox selection, and the table-local search, column
// filters and sorting.
//
// Search, filters and sort are pure frontend transforms computed in useMemo, so
// narrowing a long list never refetches. `drillKey` is the reset boundary: a new
// drill starts clean, while the drill's own toggles (not-yet-live, attribute
// chips) keep the user's search and filters in place.

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ListFilter, Search, X } from "lucide-react";

import { classifyAttributes } from "@/lib/attribute-groups";
import type { ClassifiedAttributes } from "@/lib/attribute-groups";
import { COMPONENT_LABELS } from "@/lib/constants";
import { getVintage } from "@/lib/nbt-vintage";
import type { NbtVintage } from "@/lib/nbt-vintage";
import { classifyDisplayStatus } from "@/lib/status-classification";
import type { RinDisplayStatus } from "@/lib/status-classification";
import type { RinEntry } from "@/lib/types";

import { CopyButton } from "./copy-button";

const HEADER_CLASS =
  "px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500";

type ColumnKey =
  | "rin"
  | "component"
  | "status"
  | "tariff"
  | "vintage"
  | "voltage"
  | "discount"
  | "dr"
  | "other"
  | "last_success";

/** The columns that get a derived multi-select filter in their header. */
type FilterKey = "tariff" | "vintage" | "voltage" | "discount" | "dr";

type SortDirection = "asc" | "desc";

interface SortState {
  column: ColumnKey | null;
  direction: SortDirection;
}

interface FilterOption {
  /** Stored value; the empty string is the "(none)" bucket. */
  value: string;
  label: string;
}

/** Selected values per filterable column; an empty set means "no filter". */
type FilterState = Record<FilterKey, Set<string>>;

interface Column {
  key: ColumnKey;
  label: string;
  align?: "center";
}

/** One RIN plus the derived values that are classified once per row. */
interface Row {
  rin: RinEntry;
  attributes: ClassifiedAttributes;
  vintage: NbtVintage | null;
  status: RinDisplayStatus;
}

const FILTER_KEYS: FilterKey[] = [
  "tariff",
  "vintage",
  "voltage",
  "discount",
  "dr",
];
const FILTER_COLUMN_SET = new Set<ColumnKey>(FILTER_KEYS);

/** RIN ascending, the order a fresh drill opens in. */
const DEFAULT_SORT: SortState = { column: "rin", direction: "asc" };

const VINTAGE_ORDER = ["2023", "2024", "2025", "2026", "2027", "floating"];
const VOLTAGE_ORDER = ["S", "P", "T"];
const COMPONENT_ORDER = ["bundled", "unbundled", "hfp"];
const DR_ORDER = ["PDP", "SR"];
const STATUS_ORDER: RinDisplayStatus[] = [
  "no_price",
  "not_in_midas",
  "pending_launch",
  "healthy",
];

function createEmptyFilters(): FilterState {
  return {
    tariff: new Set<string>(),
    vintage: new Set<string>(),
    voltage: new Set<string>(),
    discount: new Set<string>(),
    dr: new Set<string>(),
  };
}

function isFilterColumn(key: ColumnKey): key is FilterKey {
  return FILTER_COLUMN_SET.has(key);
}

/** Position of a value in a fixed display order; unknown values sort last. */
function rankOf(order: readonly string[], value: string): number {
  const index = order.indexOf(value);
  return index === -1 ? order.length : index;
}

/** Discount codes as one canonical combo, e.g. "CARE, MDBL". */
function discountValue(attributes: ClassifiedAttributes): string {
  return [...attributes.discount].sort().join(", ");
}

/** DR codes as one canonical combo; the invariant is at most one code. */
function drValue(attributes: ClassifiedAttributes): string {
  return [...attributes.dr].sort().join(", ");
}

/** The value a row contributes to a filterable column. */
function filterValue(row: Row, key: FilterKey): string {
  switch (key) {
    case "tariff":
      return row.rin.tariff ?? "";
    case "vintage":
      return row.vintage ?? "";
    case "voltage":
      return row.attributes.voltage ?? "";
    case "discount":
      return discountValue(row.attributes);
    case "dr":
      return drValue(row.attributes);
  }
}

/**
 * True when the row survives every active column filter except `exclude`.
 * Excluding a column lets that column derive its options from the rows the
 * other filters leave visible, so its own selection cannot hide its options.
 */
function matchesFilters(
  row: Row,
  filters: FilterState,
  exclude?: FilterKey,
): boolean {
  for (const key of FILTER_KEYS) {
    if (key === exclude) {
      continue;
    }
    const selected = filters[key];
    if (selected.size === 0) {
      continue;
    }
    if (!selected.has(filterValue(row, key))) {
      return false;
    }
  }
  return true;
}
function compareFilterValues(key: FilterKey, a: string, b: string): number {
  switch (key) {
    case "voltage":
      return rankOf(VOLTAGE_ORDER, a) - rankOf(VOLTAGE_ORDER, b);
    case "vintage":
      return rankOf(VINTAGE_ORDER, a) - rankOf(VINTAGE_ORDER, b);
    case "dr":
      return rankOf(DR_ORDER, a) - rankOf(DR_ORDER, b);
    default:
      return a.localeCompare(b);
  }
}

/**
 * Distinct choices for one column, derived from the rows left by the search
 * and the other filters. "(none)" appears only when at least one such row has
 * no value — which is exactly the mixed-vintage case, because an NBT-scoped
 * drill contains only rows with a vintage.
 */
function deriveFilterOptions(
  pool: Row[],
  key: FilterKey,
  selected: Set<string>,
): FilterOption[] {
  const values = new Set<string>();
  let hasNone = false;

  for (const row of pool) {
    const value = filterValue(row, key);
    if (value === "") {
      // Tariff has no "(none)": every RIN is expected to carry one.
      if (key !== "tariff") {
        hasNone = true;
      }
    } else {
      values.add(value);
    }
  }

  // Keep active selections visible even when the other filters exclude them,
  // so the only way to lose a selection is to uncheck or clear it.
  for (const value of selected) {
    if (value === "") {
      if (key !== "tariff") {
        hasNone = true;
      }
    } else {
      values.add(value);
    }
  }

  const options: FilterOption[] = [...values]
    .sort((a, b) => compareFilterValues(key, a, b))
    .map((value) => ({
      value,
      label: key === "vintage" ? formatVintage(value as NbtVintage) : value,
    }));

  if (hasNone) {
    options.push({ value: "", label: "(none)" });
  }
  return options;
}

/** The date the Last Success column shows; both fields are nullable. */
function lastSuccessOf(row: Row): string | null {
  return row.rin.last_success ?? row.rin.last_success_date;
}

/** Columns whose empty value must stay at the bottom in either direction. */
function isMissingForSort(row: Row, column: ColumnKey): boolean {
  switch (column) {
    case "component":
      return row.rin.component === null;
    case "tariff":
      return row.rin.tariff === null || row.rin.tariff === "";
    case "vintage":
      return row.vintage === null;
    case "voltage":
      return row.attributes.voltage === null;
    case "discount":
      return row.attributes.discount.length === 0;
    case "dr":
      return row.attributes.dr.length === 0;
    case "other":
      return row.attributes.other.length === 0;
    case "last_success":
      return lastSuccessOf(row) === null;
    default:
      return false;
  }
}

function compareRows(a: Row, b: Row, column: ColumnKey): number {
  switch (column) {
    case "rin":
      return a.rin.rin.localeCompare(b.rin.rin);
    case "component":
      return (
        rankOf(COMPONENT_ORDER, a.rin.component ?? "") -
        rankOf(COMPONENT_ORDER, b.rin.component ?? "")
      );
    case "status":
      return rankOf(STATUS_ORDER, a.status) - rankOf(STATUS_ORDER, b.status);
    case "tariff":
      return (a.rin.tariff ?? "").localeCompare(b.rin.tariff ?? "");
    case "vintage":
      return (
        rankOf(VINTAGE_ORDER, a.vintage ?? "") -
        rankOf(VINTAGE_ORDER, b.vintage ?? "")
      );
    case "voltage":
      return (
        rankOf(VOLTAGE_ORDER, a.attributes.voltage ?? "") -
        rankOf(VOLTAGE_ORDER, b.attributes.voltage ?? "")
      );
    case "discount":
      return discountValue(a.attributes).localeCompare(
        discountValue(b.attributes),
      );
    case "dr":
      return (
        rankOf(DR_ORDER, drValue(a.attributes)) -
        rankOf(DR_ORDER, drValue(b.attributes))
      );
    case "other": {
      const aOther = [...a.attributes.other].sort().join(", ");
      const bOther = [...b.attributes.other].sort().join(", ");
      return aOther.localeCompare(bOther);
    }
    case "last_success":
      return (lastSuccessOf(a) ?? "").localeCompare(lastSuccessOf(b) ?? "");
  }
}

/**
 * Sort for one column. Missing values stay last even when the direction flips
 * to descending, so direction is applied to the value comparison only.
 */
function compareRowsForSort(
  a: Row,
  b: Row,
  column: ColumnKey,
  direction: SortDirection,
): number {
  const aMissing = isMissingForSort(a, column);
  const bMissing = isMissingForSort(b, column);
  if (aMissing || bMissing) {
    if (aMissing && bMissing) {
      return 0;
    }
    return aMissing ? 1 : -1;
  }
  const order = direction === "asc" ? 1 : -1;
  return compareRows(a, b, column) * order;
}

export interface AffectedRinsTableProps {
  /** The drill's affected rows, already filtered by the pattern chips. */
  rins: RinEntry[];
  /** Stable identity of the open drill. A new drill resets search, filters
   *  and sort; other prop changes (status toggles, chips) keep them. */
  drillKey: string;
  showNotYetLive: boolean;
  onShowNotYetLiveChange: (value: boolean) => void;
  /** How many `not_in_midas` RINs the drill's baseline holds; hides the
   *  empty-state shortcut when turning the toggle on could not add a row. */
  notYetLiveCount?: number;
  /** Checked RINs; the copy button narrows to them. */
  selectedRins: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
}

function formatVintage(vintage: NbtVintage): string {
  return vintage === "floating" ? "Floating" : vintage;
}

export function AffectedRinsTable({
  rins,
  drillKey,
  showNotYetLive,
  onShowNotYetLiveChange,
  notYetLiveCount = 0,
  selectedRins,
  onSelectionChange,
}: AffectedRinsTableProps) {
  const rows = useMemo<Row[]>(
    () =>
      rins.map((rin) => ({
        rin,
        attributes: classifyAttributes(rin.enrollment_codes),
        vintage: getVintage(rin.enrollment_codes),
        status: classifyDisplayStatus(rin),
      })),
    [rins],
  );

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<FilterState>(createEmptyFilters);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);

  // A different cell is a new question: start with RIN ascending and no
  // narrowing. Resetting during render (rather than in an effect) means the
  // new drill never paints with the previous drill's narrowing. The drill's
  // own toggles leave `drillKey` alone, so comparing Missing with Missing +
  // not-yet-live does not force re-entering a search.
  const [lastDrillKey, setLastDrillKey] = useState(drillKey);
  if (lastDrillKey !== drillKey) {
    setLastDrillKey(drillKey);
    setSearchInput("");
    setSearch("");
    setFilters(createEmptyFilters());
    setSort(DEFAULT_SORT);
  }

  // Debounce the search so each keystroke does not re-filter a long list.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 150);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Search across the identifiers the table shows: RIN, tariff, raw enrollment
  // codes ("CARE", "NBT-2026", "VOLTAGE-S") and the last success date.
  const searchedRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle === "") {
      return rows;
    }
    return rows.filter(
      (row) =>
        row.rin.rin.toLowerCase().includes(needle) ||
        (row.rin.tariff ?? "").toLowerCase().includes(needle) ||
        row.rin.enrollment_codes.some((code) =>
          code.toLowerCase().includes(needle),
        ) ||
        (row.rin.last_success_date !== null &&
          row.rin.last_success_date.toLowerCase().includes(needle)),
    );
  }, [rows, search]);

  const visibleRows = useMemo(() => {
    const filtered = searchedRows.filter((row) => matchesFilters(row, filters));
    const column = sort.column;
    if (column === null) {
      return filtered;
    }
    return [...filtered].sort((a, b) =>
      compareRowsForSort(a, b, column, sort.direction),
    );
  }, [searchedRows, filters, sort]);

  // Options for each column come from the rows the search and the *other*
  // filters leave, so selecting one value does not remove its siblings.
  const filterOptions = useMemo<Record<FilterKey, FilterOption[]>>(() => {
    const result = {} as Record<FilterKey, FilterOption[]>;
    for (const key of FILTER_KEYS) {
      const pool = searchedRows.filter((row) =>
        matchesFilters(row, filters, key),
      );
      result[key] = deriveFilterOptions(pool, key, filters[key]);
    }
    return result;
  }, [searchedRows, filters]);

  const activeFilterCount = FILTER_KEYS.reduce(
    (count, key) => count + (filters[key].size > 0 ? 1 : 0),
    0,
  );

  // Counts for the summary strip: it disambiguates the matrix's coarse
  // notInMidas count once the not-yet-live toggle brings those RINs in. It
  // follows the visible rows so the strip and the table never disagree.
  const statusCounts = useMemo(() => {
    const counts = { noPrice: 0, notInMidas: 0, pendingLaunch: 0 };
    for (const row of visibleRows) {
      if (row.status === "no_price") {
        counts.noPrice += 1;
      } else if (row.status === "not_in_midas") {
        counts.notInMidas += 1;
      } else if (row.status === "pending_launch") {
        counts.pendingLaunch += 1;
      }
    }
    return counts;
  }, [visibleRows]);

  const showSummaryStrip =
    statusCounts.notInMidas + statusCounts.pendingLaunch > 0;

  const columns = useMemo<Column[]>(() => {
    const list: Column[] = [
      { key: "rin", label: "RIN" },
      { key: "component", label: "Component" },
      { key: "status", label: "Status" },
      { key: "tariff", label: "Tariff" },
    ];
    if (rows.some((row) => row.vintage !== null)) {
      list.push({ key: "vintage", label: "Vintage" });
    }
    if (rows.some((row) => row.attributes.voltage !== null)) {
      list.push({ key: "voltage", label: "Voltage", align: "center" });
    }
    if (rows.some((row) => row.attributes.discount.length > 0)) {
      list.push({ key: "discount", label: "Discount" });
    }
    if (rows.some((row) => row.attributes.dr.length > 0)) {
      list.push({ key: "dr", label: "DR" });
    }
    if (rows.some((row) => row.attributes.other.length > 0)) {
      list.push({ key: "other", label: "Other" });
    }
    list.push({ key: "last_success", label: "Last Success" });
    return list;
  }, [rows]);

  const allSelected =
    visibleRows.length > 0 &&
    visibleRows.every((row) => selectedRins.has(row.rin.rin));
  const someSelected =
    !allSelected && visibleRows.some((row) => selectedRins.has(row.rin.rin));

  // `indeterminate` only exists on the DOM node, not as an attribute.
  const headerCheckboxRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate = someSelected;
    }
  }, [someSelected]);

  function toggleAll() {
    const next = new Set(selectedRins);
    if (allSelected) {
      for (const row of visibleRows) {
        next.delete(row.rin.rin);
      }
    } else {
      for (const row of visibleRows) {
        next.add(row.rin.rin);
      }
    }
    onSelectionChange(next);
  }

  function toggleRow(rin: string) {
    const next = new Set(selectedRins);
    if (next.has(rin)) {
      next.delete(rin);
    } else {
      next.add(rin);
    }
    onSelectionChange(next);
  }

  /** no sort -> asc -> desc -> no sort */
  function toggleSort(column: ColumnKey) {
    setSort((current) => {
      if (current.column !== column) {
        return { column, direction: "asc" };
      }
      if (current.direction === "asc") {
        return { column, direction: "desc" };
      }
      return { column: null, direction: "asc" };
    });
  }

  function toggleFilter(key: FilterKey, value: string) {
    setFilters((current) => {
      const selected = new Set(current[key]);
      if (selected.has(value)) {
        selected.delete(value);
      } else {
        selected.add(value);
      }
      return { ...current, [key]: selected };
    });
  }

  function clearFilter(key: FilterKey) {
    setFilters((current) => ({ ...current, [key]: new Set<string>() }));
  }

  function clearSearch() {
    setSearchInput("");
    setSearch("");
  }

  function clearSearchAndFilters() {
    clearSearch();
    setFilters(createEmptyFilters());
  }

  return (
    <section
      className="overflow-hidden rounded-lg border border-gray-200 bg-white"
      aria-label="Affected RINs"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-900">Affected RINs</h2>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {selectedRins.size > 0 ? (
            <span className="text-xs text-gray-500">
              {selectedRins.size} selected
            </span>
          ) : null}

          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400"
              aria-hidden="true"
            />
            <input
              type="text"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search RIN, tariff, or attribute..."
              aria-label="Search affected RINs"
              className="w-56 rounded-md border border-gray-200 bg-white py-1.5 pl-8 pr-7 text-xs text-gray-700 placeholder:text-gray-400 focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-300 sm:w-64"
            />
            {searchInput.length > 0 ? (
              <button
                type="button"
                onClick={clearSearch}
                title="Clear search"
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 transition-colors hover:text-gray-700"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </div>

          <span className="text-xs tabular-nums text-gray-500">
            {visibleRows.length} shown
          </span>
        </div>
      </div>

      {showSummaryStrip ? (
        <div className="flex gap-3 border-b border-gray-100 bg-gray-50/50 px-5 py-3 text-xs text-gray-500">
          <span>{visibleRows.length} shown</span>
          {statusCounts.noPrice > 0 ? (
            <span>· {statusCounts.noPrice} no price</span>
          ) : null}
          {statusCounts.notInMidas > 0 ? (
            <span className="font-medium text-amber-700">
              · {statusCounts.notInMidas} not in MIDAS
            </span>
          ) : null}
          {statusCounts.pendingLaunch > 0 ? (
            <span className="text-gray-400">
              · {statusCounts.pendingLaunch} pending launch
            </span>
          ) : null}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="px-6 py-10 text-center text-sm text-gray-500">
          <p>No RINs match this filter</p>
          {!showNotYetLive && notYetLiveCount > 0 ? (
            <button
              type="button"
              onClick={() => onShowNotYetLiveChange(true)}
              className="mt-2 text-xs font-medium text-gray-600 underline underline-offset-2 transition-colors hover:text-gray-900"
            >
              Include {notYetLiveCount} not-yet-live RIN
              {notYetLiveCount === 1 ? "" : "s"}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th scope="col" className="w-10 px-3 py-2">
                  <input
                    ref={headerCheckboxRef}
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    disabled={visibleRows.length === 0}
                    aria-label="Select all shown affected RINs"
                    className="h-3.5 w-3.5 cursor-pointer accent-gray-900 disabled:cursor-not-allowed"
                  />
                </th>
                {columns.map((column) => {
                  const filterKey = isFilterColumn(column.key)
                    ? column.key
                    : null;
                  const active = sort.column === column.key;
                  return (
                    <th
                      key={column.key}
                      scope="col"
                      aria-sort={
                        active
                          ? sort.direction === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                      className={`${HEADER_CLASS} ${
                        column.align === "center" ? "text-center" : ""
                      }`}
                    >
                      <div
                        className={`flex items-center gap-0.5 ${
                          column.align === "center" ? "justify-center" : ""
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => toggleSort(column.key)}
                          title={`Sort by ${column.label}`}
                          className="inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-gray-100 hover:text-gray-900"
                        >
                          {column.label}
                          <span
                            className="w-2 text-[9px] leading-none text-gray-500"
                            aria-hidden="true"
                          >
                            {active
                              ? sort.direction === "asc"
                                ? "▲"
                                : "▼"
                              : ""}
                          </span>
                        </button>
                        {filterKey !== null ? (
                          <ColumnFilter
                            key={`${drillKey}:${filterKey}`}
                            label={column.label}
                            options={filterOptions[filterKey]}
                            selected={filters[filterKey]}
                            onToggle={(value) =>
                              toggleFilter(filterKey, value)
                            }
                            onClear={() => clearFilter(filterKey)}
                          />
                        ) : null}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visibleRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={columns.length + 1}
                    className="px-6 py-10 text-center text-sm text-gray-500"
                  >
                    <p>No RINs match this search or filter</p>
                    <button
                      type="button"
                      onClick={clearSearchAndFilters}
                      className="mt-2 text-xs font-medium text-gray-600 underline underline-offset-2 transition-colors hover:text-gray-900"
                    >
                      Clear search and filters
                    </button>
                  </td>
                </tr>
              ) : (
                visibleRows.map((row) => (
                  <tr
                    key={row.rin.rin}
                    className="transition-colors hover:bg-gray-50"
                  >
                    <td className="w-10 px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selectedRins.has(row.rin.rin)}
                        onChange={() => toggleRow(row.rin.rin)}
                        aria-label={`Select ${row.rin.rin}`}
                        className="h-3.5 w-3.5 cursor-pointer accent-gray-900"
                      />
                    </td>
                    {columns.map((column) => (
                      <Cell key={column.key} column={column.key} row={row} />
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-gray-200 px-4 py-3">
        <span className="text-xs text-gray-500">
          {visibleRows.length} shown
          {visibleRows.length !== rows.length ? ` of ${rows.length}` : ""}
          {showNotYetLive ? " · incl. not-yet-live" : ""}
          {activeFilterCount > 0 ? ` · ${activeFilterCount} filter${activeFilterCount === 1 ? "" : "s"}` : ""}
        </span>
        <CopyButton
          rins={visibleRows.map((row) => row.rin)}
          selectedRins={selectedRins}
        />
      </div>
    </section>
  );
}

function Cell({ column, row }: { column: ColumnKey; row: Row }) {
  const { rin, attributes, vintage, status } = row;

  switch (column) {
    case "rin":
      return (
        <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-gray-900">
          {rin.rin}
        </td>
      );
    case "component":
      return (
        <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-500">
          {rin.component === null ? "—" : COMPONENT_LABELS[rin.component]}
        </td>
      );
    case "status":
      return <StatusCell status={status} />;
    case "tariff":
      return (
        <td className="whitespace-nowrap px-3 py-2 text-sm text-gray-700">
          {rin.tariff ?? "—"}
        </td>
      );
    case "vintage":
      return (
        <td className="whitespace-nowrap px-3 py-2 text-sm text-gray-700">
          {vintage === null ? (
            <span className="text-gray-300">—</span>
          ) : (
            formatVintage(vintage)
          )}
        </td>
      );
    case "voltage":
      return (
        <td className="px-3 py-2 text-center text-sm text-gray-700">
          {attributes.voltage ?? <span className="text-gray-300">—</span>}
        </td>
      );
    case "discount":
      return (
        <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-700">
          {attributes.discount.length > 0 ? (
            attributes.discount.join(", ")
          ) : (
            <span className="text-gray-300">—</span>
          )}
        </td>
      );
    case "dr":
      return (
        <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-700">
          {attributes.dr.length > 0 ? (
            attributes.dr.join(", ")
          ) : (
            <span className="text-gray-300">—</span>
          )}
        </td>
      );
    case "other": {
      const names = attributes.other;
      if (names.length === 0) {
        return (
          <td className="px-3 py-2 text-xs text-gray-700">
            <span className="text-gray-300">—</span>
          </td>
        );
      }
      const shown = names.slice(0, 2).join(", ");
      const extra = names.length - 2;
      return (
        <td
          className="whitespace-nowrap px-3 py-2 text-xs text-gray-700"
          title={names.join(", ")}
        >
          {shown}
          {extra > 0 ? ` +${extra}` : ""}
        </td>
      );
    }
    case "last_success": {
      const lastSuccess = lastSuccessOf(row);
      return (
        <td className="whitespace-nowrap px-3 py-2 text-sm">
          {lastSuccess === null ? (
            <span className="text-gray-300">never</span>
          ) : (
            <span className="text-gray-700">{lastSuccess}</span>
          )}
        </td>
      );
    }
  }
}

/**
 * The Status column: the same four-way classification the summary strip counts,
 * so a row and the strip can never disagree.
 */
function StatusCell({ status }: { status: RinDisplayStatus }) {
  switch (status) {
    case "no_price":
      return (
        <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-600">
          No price
        </td>
      );
    case "not_in_midas":
      return (
        <td className="whitespace-nowrap px-3 py-2 text-xs font-medium text-amber-700">
          Not in MIDAS
        </td>
      );
    case "pending_launch":
      return (
        <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-400">
          Pending launch
        </td>
      );
    case "healthy":
      return (
        <td className="whitespace-nowrap px-3 py-2 text-xs">
          <span className="text-green-600" title="Healthy" aria-label="Healthy">
            ✓
          </span>
        </td>
      );
  }
}

/**
 * One header's multi-select filter. The panel is positioned `fixed` so the
 * table's horizontal scroll container cannot clip it; it closes on an outside
 * click, Escape, scroll or resize.
 */
function ColumnFilter({
  label,
  options,
  selected,
  onToggle,
  onClear,
}: {
  label: string;
  options: FilterOption[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    top?: number;
    bottom?: number;
    left: number;
  } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (
        buttonRef.current?.contains(target) ||
        panelRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    function handleScroll(event: Event) {
      // Scrolling inside the option list is fine; any other scroll moves the
      // anchor away and must dismiss the panel.
      const target = event.target;
      if (
        target instanceof Node &&
        panelRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
    };
  }, [open]);

  function toggleOpen() {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    const width = 232;
    const left = Math.max(
      8,
      Math.min(rect.left, window.innerWidth - width - 8),
    );
    // Flip above the header when there is no room below in the viewport.
    if (rect.bottom + 300 > window.innerHeight && rect.top > 300) {
      setPosition({ bottom: window.innerHeight - rect.top + 4, left });
    } else {
      setPosition({ top: rect.bottom + 4, left });
    }
    setOpen(true);
  }

  const count = selected.size;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleOpen}
        title={`Filter ${label}`}
        aria-label={`Filter ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`inline-flex items-center gap-0.5 rounded px-0.5 py-0.5 transition-colors hover:bg-gray-200 ${
          count > 0 ? "text-gray-900" : "text-gray-400"
        }`}
      >
        <ListFilter className="h-3 w-3" aria-hidden="true" />
        {count > 0 ? (
          <span className="rounded-full bg-gray-900 px-1 text-[9px] font-semibold leading-[14px] tabular-nums text-white">
            {count}
          </span>
        ) : null}
      </button>

      {open && position !== null ? (
        <div
          ref={panelRef}
          role="group"
          aria-label={`Filter ${label}`}
          style={{ ...position, width: 232 }}
          className="fixed z-50 overflow-hidden rounded-md border border-gray-200 bg-white text-left shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-gray-100 px-2.5 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
              Filter {label}
            </span>
            {count > 0 ? (
              <button
                type="button"
                onClick={onClear}
                className="text-[10px] text-gray-400 transition-colors hover:text-gray-700"
              >
                clear
              </button>
            ) : null}
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {options.length === 0 ? (
              <p className="px-2.5 py-1.5 text-xs text-gray-400">No values</p>
            ) : (
              options.map((option) => (
                <label
                  key={option.value === "" ? "__none" : option.value}
                  className="flex cursor-pointer items-center gap-2 px-2.5 py-1 text-xs font-normal normal-case text-gray-700 hover:bg-gray-50"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(option.value)}
                    onChange={() => onToggle(option.value)}
                    className="h-3.5 w-3.5 cursor-pointer accent-gray-900"
                  />
                  <span className="truncate">{option.label}</span>
                </label>
              ))
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
