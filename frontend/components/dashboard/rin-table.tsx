"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, Search, X } from "lucide-react";

import { copyToClipboard } from "@/lib/clipboard";
import { rowsToTsv } from "@/lib/rin-utils";
import type {
  RinEntry,
  RinGroup,
  Segment,
  Sort,
  SortColumn,
  ViewMode,
} from "@/lib/types";

import { RinRow } from "./rin-row";
import { SortableHeader } from "./sortable-header";

export function RinTable({
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

