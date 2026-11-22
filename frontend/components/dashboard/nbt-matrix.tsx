// 6x7 NBT pricing-health matrix: segment/component row x NBT vintage column,
// plus the row/column totals. Pure presentation over `buildNbtMatrix`; the
// parent owns whichever cell is selected and decides what a click drills into.

import {
  NBT_ROW_KEYS,
  NBT_VINTAGES,
  buildNbtMatrix,
} from "@/lib/health-matrix";
import type { MatrixCell, NbtRowKey as NbtBodyRowKey } from "@/lib/health-matrix";
import type { NbtVintage } from "@/lib/nbt-vintage";
import type { RinEntry } from "@/lib/types";

import { MatrixCellView, MatrixHeadline } from "./matrix-cell";

export type NbtRowKey = NbtBodyRowKey | "all";
export type NbtColKey = NbtVintage | "all";

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
  onCellClick,
  selected,
}: {
  rins: RinEntry[];
  onCellClick?: (cell: MatrixCell, sel: NbtMatrixSelection) => void;
  selected?: NbtMatrixSelection | null;
}) {
  const matrix = buildNbtMatrix(rins);

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
            {BODY_ROWS.map((row) => (
              <tr key={row.key} className="border-b border-gray-100">
                <th scope="row" className={ROW_LABEL_CLASS}>
                  {row.label}
                </th>
                {renderCells(row.key)}
              </tr>
            ))}

            <tr className="bg-gray-50/40 border-t border-gray-200">
              <th
                scope="row"
                className="whitespace-nowrap p-2 align-top text-sm font-bold text-gray-900"
              >
                All NBT
              </th>
              {renderCells("all")}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
