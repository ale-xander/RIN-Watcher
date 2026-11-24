// 3x3 pricing-health matrix: segment x PG&E component, plus the row/column
// totals. Pure presentation over `buildMainMatrix`; the parent owns whichever
// cell is selected and decides what a click drills into.
//
// The parent also passes the active category chip. A segment chip scopes the
// payload to that segment, so rendering the other rows would fill them with
// `—` dashes that read as "missing data" instead of "filtered out": those rows
// are not rendered at all, and neither is the totals footer, which would just
// repeat the one segment left on screen. A dash inside a rendered row still
// means "0 RINs in this bucket", which is exactly what a missing NBT vintage is.

import { buildMainMatrix, segmentForCategory } from "@/lib/health-matrix";
import type { MatrixCell } from "@/lib/health-matrix";
import type { CategoryFilter, RinEntry } from "@/lib/types";

import { MatrixCellView, MatrixHeadline } from "./matrix-cell";

export type MainRowKey = "ag" | "non_res" | "resid" | "all";
export type MainColKey = "bundled" | "unbundled" | "all";

export interface MainMatrixSelection {
  row: MainRowKey;
  col: MainColKey;
}

/** Segment rows in render order; the `all` row is the total row, appended. */
const SEGMENT_ROWS: { key: Exclude<MainRowKey, "all">; label: string }[] = [
  { key: "ag", label: "AG" },
  { key: "non_res", label: "Non-Res" },
  { key: "resid", label: "Residential" },
];

const COLUMNS: { key: MainColKey; label: string }[] = [
  { key: "bundled", label: "Bundled" },
  { key: "unbundled", label: "Unbundled" },
  { key: "all", label: "All" },
];

const HEADER_LABEL_CLASS =
  "px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500";
const ROW_LABEL_CLASS =
  "whitespace-nowrap px-3 py-2 align-top text-sm font-medium text-gray-700";

export function HealthMatrix({
  rins,
  activeCategory = "all",
  onCellClick,
  selected,
}: {
  rins: RinEntry[];
  /** Active category chip; a segment hides the other segment rows. */
  activeCategory?: CategoryFilter;
  onCellClick?: (cell: MatrixCell, sel: MainMatrixSelection) => void;
  selected?: MainMatrixSelection | null;
}) {
  const matrix = buildMainMatrix(rins);

  // Only the chip's own segment renders. The columns (and their `—` dashes for
  // empty buckets) stay; the totals footer would only repeat the single visible
  // row, so it is rendered in the unscoped view alone.
  const segment = segmentForCategory(activeCategory);
  const segmentRows =
    segment === null
      ? SEGMENT_ROWS
      : SEGMENT_ROWS.filter((row) => row.key === segment);

  // `all` on either axis reads from the pre-computed totals.
  function cellFor(row: MainRowKey, col: MainColKey): MatrixCell {
    if (row === "all") {
      return matrix.colTotals[col];
    }
    return matrix.rows[row][col];
  }

  function renderCells(row: MainRowKey) {
    return COLUMNS.map((column) => {
      const cell = cellFor(row, column.key);
      const selection: MainMatrixSelection = { row, col: column.key };
      const isSelected =
        selected?.row === row && selected?.col === column.key;

      return (
        <td key={column.key} className="px-3 py-2 align-top">
          <MatrixCellView
            cell={cell}
            isSelected={isSelected}
            onClick={
              onCellClick ? () => onCellClick(cell, selection) : undefined
            }
          />
        </td>
      );
    });
  }

  return (
    <section className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="border-b border-gray-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-900">
          Pricing Health by Segment
        </h2>
        {/* PG&E bundled + unbundled only; HFP has its own bucket card. */}
        <MatrixHeadline cell={matrix.grandTotal} />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th scope="col" className={HEADER_LABEL_CLASS}>
                Segment
              </th>
              {COLUMNS.map((column) => (
                <th key={column.key} scope="col" className={HEADER_LABEL_CLASS}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {segmentRows.map((row) => (
              <tr key={row.key} className="border-b border-gray-100">
                <th scope="row" className={ROW_LABEL_CLASS}>
                  {row.label}
                </th>
                {renderCells(row.key)}
              </tr>
            ))}

            {/* With one segment visible the totals row would print the same
                numbers twice, so it renders in the unscoped view alone. */}
            {segment === null ? (
              <tr className="bg-gray-50/40 border-t border-gray-200">
                <th
                  scope="row"
                  className="whitespace-nowrap px-3 py-2 align-top text-sm font-bold text-gray-900"
                >
                  All segments
                </th>
                {renderCells("all")}
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
