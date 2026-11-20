// The drill's result list: one row per affected RIN.
//
// Columns adapt to the drill instead of rendering empty ones: Vintage only when
// the drill contains NBT RINs, Voltage/Discount/DR/Other only when at least one
// row carries that attribute. Rows are already filtered and sorted by the
// parent; this file owns rendering and the checkbox selection.

"use client";

import { useEffect, useMemo, useRef } from "react";

import { classifyAttributes } from "@/lib/attribute-groups";
import type { ClassifiedAttributes } from "@/lib/attribute-groups";
import { COMPONENT_LABELS } from "@/lib/constants";
import { getVintage } from "@/lib/nbt-vintage";
import type { NbtVintage } from "@/lib/nbt-vintage";
import type { RinEntry } from "@/lib/types";

import { CopyButton } from "./copy-button";

const HEADER_CLASS =
  "px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500";

type ColumnKey =
  | "rin"
  | "component"
  | "tariff"
  | "vintage"
  | "voltage"
  | "discount"
  | "dr"
  | "other"
  | "last_success";

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
}

export interface AffectedRinsTableProps {
  /** The drill's affected rows, already filtered by the pattern chips. */
  rins: RinEntry[];
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
      })),
    [rins],
  );

  const columns = useMemo<Column[]>(() => {
    const list: Column[] = [
      { key: "rin", label: "RIN" },
      { key: "component", label: "Component" },
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
    rows.length > 0 && rows.every((row) => selectedRins.has(row.rin.rin));
  const someSelected =
    !allSelected && rows.some((row) => selectedRins.has(row.rin.rin));

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
      for (const row of rows) {
        next.delete(row.rin.rin);
      }
    } else {
      for (const row of rows) {
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

  return (
    <section
      className="overflow-hidden rounded-lg border border-gray-200 bg-white"
      aria-label="Affected RINs"
    >
      <div className="flex items-center justify-between gap-4 border-b border-gray-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-900">Affected RINs</h2>
        {selectedRins.size > 0 ? (
          <span className="text-xs text-gray-500">
            {selectedRins.size} selected
          </span>
        ) : null}
      </div>

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
                    aria-label="Select all affected RINs"
                    className="h-3.5 w-3.5 cursor-pointer accent-gray-900"
                  />
                </th>
                {columns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className={`${HEADER_CLASS} ${
                      column.align === "center" ? "text-center" : ""
                    }`}
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((row) => (
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
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between gap-4 border-t border-gray-200 px-4 py-3">
        <span className="text-xs text-gray-500">
          {rows.length} shown
          {showNotYetLive ? " · incl. not-yet-live" : ""}
        </span>
        <CopyButton rins={rins} selectedRins={selectedRins} />
      </div>
    </section>
  );
}

function Cell({ column, row }: { column: ColumnKey; row: Row }) {
  const { rin, attributes, vintage } = row;

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
      const lastSuccess = rin.last_success ?? rin.last_success_date;
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
