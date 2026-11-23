// The HFP headline: one row per HFP feed, each a click target for its own drill.
//
// HFP RINs carry no segment, so the segment x component matrices cannot place
// them. This card reports the five feeds MIDAS publishes separately instead of
// one provider-wide number: a broken feed is visible on its own row, and the row
// opens the affected-RINs table below the card, exactly like a matrix cell.
// Every number arrives pre-computed on a `MatrixCell` from `buildHfpBuckets`;
// this file only renders it.
//
// The CCA price feed is a separate MIDAS feed and is usually not live yet, so
// its row carries a muted "Awaiting feed" note and its total is grey: a green
// cell would read as "the CCA prices are fine" when nothing has been checked.

import type { KeyboardEvent } from "react";

import { HFP_BUCKETS, buildHfpBuckets } from "@/lib/hfp-buckets";
import type { HfpBucket } from "@/lib/hfp-buckets";
import { ragLevelFor } from "@/lib/health-matrix";
import type { MatrixCell } from "@/lib/health-matrix";
import type { RinEntry } from "@/lib/types";

import { MatrixCellView } from "./matrix-cell";

const HEADER_CLASS =
  "grid grid-cols-12 gap-4 bg-gray-50/50 px-5 py-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500";

const ROW_CLASS =
  "grid w-full cursor-pointer grid-cols-12 items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-gray-50";

export interface HfpBucketsProps {
  rins: RinEntry[];
  /** One row is one drill: the parent opens the bucket below the card. */
  onDrillClick: (bucket: HfpBucket, cell: MatrixCell) => void;
}

export function HfpBuckets({ rins, onDrillClick }: HfpBucketsProps) {
  const buckets = buildHfpBuckets(rins);
  const total = sumCells(HFP_BUCKETS.map((bucket) => buckets[bucket.key]));

  return (
    <section
      aria-label="HFP pricing health by bucket"
      className="overflow-hidden rounded-lg border border-gray-200 bg-white"
    >
      <div className={HEADER_CLASS}>
        <span className="col-span-4">Bucket</span>
        <span className="col-span-4">Health</span>
        <span className="col-span-4 text-right">Breakdown</span>
      </div>

      {HFP_BUCKETS.map((bucket) => {
        const cell = buckets[bucket.key];
        const open = () => onDrillClick(bucket.key, cell);

        return (
          <div
            key={bucket.key}
            role="button"
            tabIndex={0}
            onClick={open}
            onKeyDown={(event) => handleRowKeyDown(event, open)}
            className={`${ROW_CLASS} ${
              bucket.isCca
                ? "border-t-2 border-gray-200"
                : "border-t border-gray-100"
            }`}
          >
            <div className="col-span-4">
              <span className="block text-sm font-medium text-gray-900">
                {bucket.label}
              </span>
              {bucket.isCca ? (
                <span className="mt-0.5 block text-[11px] text-gray-400">
                  Awaiting feed
                </span>
              ) : null}
            </div>

            <div className="col-span-4">
              <MatrixCellView cell={cell} />
            </div>

            <div className="col-span-4">
              <Breakdown cell={cell} muted={bucket.isCca === true} />
            </div>
          </div>
        );
      })}

      <div className="grid grid-cols-12 items-center gap-4 border-t border-gray-200 bg-gray-50/40 px-5 py-3">
        <div className="col-span-4 text-sm font-bold text-gray-900">
          Total HFP
        </div>
        <div className="col-span-4">
          <MatrixCellView cell={total} />
        </div>
        <div className="col-span-4">
          <Breakdown cell={total} />
        </div>
      </div>
    </section>
  );
}

/** Rows are buttons by behaviour: Enter and Space open the drill too. */
function handleRowKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  open: () => void,
) {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }
  event.preventDefault();
  open();
}

/** The breakdown's total figure wears its cell's own colour. */
const TOTAL_TONE: Record<MatrixCell["rag"], string> = {
  green: "text-green-600",
  amber: "text-amber-600",
  red: "text-red-600",
  empty: "text-gray-400",
};

/**
 * "59 total | 47 healthy | 12 pending". `pending` is everything not healthy
 * yet: a missing RIN waiting on today's publication plus a not-yet-live RIN
 * waiting on its first one, so the three figures always reconcile.
 */
function Breakdown({
  cell,
  muted = false,
}: {
  cell: MatrixCell;
  muted?: boolean;
}) {
  if (cell.total === 0) {
    return <div className="text-right text-sm text-gray-300">—</div>;
  }

  const pending = cell.total - cell.healthy;
  const totalTone = muted ? "text-gray-400" : TOTAL_TONE[cell.rag];

  return (
    <div className="text-right text-[13px] tabular-nums text-gray-600">
      <span className={`font-semibold ${totalTone}`}>{cell.total}</span> total
      <span className="mx-1.5 text-gray-300">|</span>
      {cell.healthy} healthy
      <span className="mx-1.5 text-gray-300">|</span>
      {pending} pending
    </div>
  );
}

/**
 * Sum the five bucket cells, re-deriving the RAG level from the totals with the
 * matrix's own rules (actionable = missing + healthy; all-not-yet-live is green).
 */
function sumCells(cells: MatrixCell[]): MatrixCell {
  let missing = 0;
  let healthy = 0;
  let notInMidas = 0;
  let never = 0;

  for (const cell of cells) {
    missing += cell.missing;
    healthy += cell.healthy;
    notInMidas += cell.notInMidas;
    never += cell.never;
  }

  const actionable = missing + healthy;
  const rag =
    actionable === 0
      ? notInMidas === 0
        ? "empty"
        : "green"
      : ragLevelFor(missing, actionable);

  return {
    missing,
    healthy,
    notInMidas,
    total: actionable + notInMidas,
    never,
    rag,
  };
}
