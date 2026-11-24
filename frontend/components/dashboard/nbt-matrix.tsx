// 6x7 NBT pricing-health matrix: segment/component row x NBT vintage column,
// plus the row/column totals. Pure presentation over `buildNbtMatrix`; the
// parent owns whichever cell is selected and decides what a click drills into.
//
// The parent also passes the active category chip. A segment chip scopes the
// payload to that segment, so only its two rows (bundled + unbundled) render:
// the other segments were filtered out and would print nothing but `—` dashes.
// The vintage columns and their dashes are untouched — a dash under 2023 still
// means "0 RINs of this vintage exist", which is the signal worth keeping. The
// `All NBT` footer goes with the hidden rows: with one segment visible it would
// simply repeat that segment's totals.

import type { NbtColKey, NbtRowKey } from "@/lib/drill";
import {
  NBT_ROW_KEYS,
  NBT_VINTAGES,
  buildNbtMatrix,
  segmentForCategory,
} from "@/lib/health-matrix";
import type { MatrixCell, NbtRowKey as NbtBodyRowKey } from "@/lib/health-matrix";
import type { NbtVintage } from "@/lib/nbt-vintage";
import type { CategoryFilter, RinEntry } from "@/lib/types";

import { MatrixCellView, MatrixHeadline } from "./matrix-cell";

export interface NbtMatrixSelection {
  row: NbtRowKey;
  col: NbtColKey;
}

/** Display label for each segment/component row. */
const ROW_LABELS: Record<NbtBodyRowKey, string> = {
  "bundled-resid": "Bundled · Residential",
  "unbundled-resid": "Unbundled · Residential",
  "bundled-non_res": "Bundled · Non-Res",
  "unbundled-non_res": "Unbundled · Non-Res",
  "bundled-ag": "Bundled · AG",
  "unbundled-ag": "Unbundled · AG",
};

/** Segment/component rows in render order; `all` is the total row, appended. */
const BODY_ROWS: { key: NbtBodyRowKey; label: string }[] = NBT_ROW_KEYS.map(
  (key) => ({ key, label: ROW_LABELS[key] }),
);

/** Display label per vintage: the placeholder column reads as "Floating". */
const VINTAGE_LABELS: Record<NbtVintage, string> = {
  "2023": "2023",
  "2024": "2024",
  "2025": "2025",
  "2026": "2026",
  "2027": "2027",
  floating: "Floating",
};

const COLUMNS: { key: NbtColKey; label: string }[] = [
  ...NBT_VINTAGES.map((vintage) => ({
    key: vintage,
    label: VINTAGE_LABELS[vintage],
  })),
  { key: "all", label: "All" },
];

const HEADER_LABEL_CLASS =
  "p-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500";
const ROW_LABEL_CLASS =
  "whitespace-nowrap p-2 align-top text-sm font-medium text-gray-700";

export function NbtMatrix({
  rins,
  activeCategory = "all",
  onCellClick,
  selected,
}: {
  rins: RinEntry[];
  /** Active category chip; a segment keeps only that segment's rows. */
  activeCategory?: CategoryFilter;
  onCellClick?: (cell: MatrixCell, sel: NbtMatrixSelection) => void;
  selected?: NbtMatrixSelection | null;
}) {
  const matrix = buildNbtMatrix(rins);

  // Row keys are `<component>-<segment>` and neither part contains a dash, so a
  // matching suffix is the segment. The vintage columns keep rendering either
  // way; the `All NBT` footer only renders while no segment is scoped, since it
  // would otherwise repeat the rows left on screen.
  const segment = segmentForCategory(activeCategory);
  const bodyRows =
    segment === null
      ? BODY_ROWS
      : BODY_ROWS.filter((row) => row.key.endsWith(`-${segment}`));

  // `all` on either axis reads from the pre-computed totals.
  function cellFor(row: NbtRowKey, col: NbtColKey): MatrixCell {
    if (row === "all") {
      return matrix.colTotals[col];
    }
    return matrix.rows[row][col];
  }

  function renderCells(row: NbtRowKey) {
    return COLUMNS.map((column) => {
      const cell = cellFor(row, column.key);
      const selection: NbtMatrixSelection = { row, col: column.key };
      const isSelected =
        selected?.row === row && selected?.col === column.key;

      return (
        <td key={column.key} className="p-2 align-top">
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
          NBT Pricing Health by Vintage
        </h2>
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
            {bodyRows.map((row) => (
              <tr key={row.key} className="border-b border-gray-100">
                <th scope="row" className={ROW_LABEL_CLASS}>
                  {row.label}
                </th>
                {renderCells(row.key)}
              </tr>
            ))}

            {/* With one segment visible the `All NBT` footer would print the
                same numbers twice, so it renders in the unscoped view alone. */}
            {segment === null ? (
              <tr className="bg-gray-50/40 border-t border-gray-200">
                <th
                  scope="row"
                  className="whitespace-nowrap p-2 align-top text-sm font-bold text-gray-900"
                >
                  All NBT
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
