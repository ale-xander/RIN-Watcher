// HFP summary strip: the one HFP-shaped card above the matrices.
//
// HFP is not a segment x component grid — it is a flat list of rate-name-only
// RINs — so it renders as one row: label, a single `MatrixCellView` (built by
// `buildHfpStrip`) and the count of CCA RINs still waiting on their feed.
//
// "HFP - CCA Prices" is a separate feed from the PG&E HFP buckets, so those
// RINs are excluded from the cell and reported as a muted sub-line instead:
// folding them in would make a healthy PG&E strip look broken.

import { buildHfpStrip } from "@/lib/health-matrix";
import type { RinEntry } from "@/lib/types";

import { MatrixCellView } from "./matrix-cell";

/** The rate name CCA HFP RINs carry; not part of the PG&E HFP strip. */
const CCA_HFP_RATE_NAME = "HFP - CCA Prices";

export interface HfpStripProps {
  rins: RinEntry[];
  /** Whole strip is one click target; the parent decides what it drills into. */
  onCellClick?: () => void;
}

export function HfpStrip({ rins, onCellClick }: HfpStripProps) {
  const hfpAll = rins.filter((rin) => rin.component === "hfp");
  const ccaCount = hfpAll.filter(
    (rin) => rin.rate_name === CCA_HFP_RATE_NAME,
  ).length;
  const hfpReal = hfpAll.filter((rin) => rin.rate_name !== CCA_HFP_RATE_NAME);
  const strip = buildHfpStrip(hfpReal);

  return (
    <section className="flex items-center gap-4 rounded-lg border border-gray-200 bg-white px-5 py-3">
      <span className="w-32 text-sm font-semibold text-gray-900">HFP</span>

      {hfpReal.length === 0 ? (
        // No HFP RINs at all: render the empty marker rather than "0 of 0".
        <span className="text-sm font-semibold text-gray-300">—</span>
      ) : (
        <div className="min-w-[110px]">
          <MatrixCellView cell={strip} onClick={onCellClick} />
        </div>
      )}

      <div className="ml-auto text-right text-[11px] leading-tight text-gray-500">
        {hfpReal.length > 0 ? (
          <div>
            {strip.missing} of {strip.total}
          </div>
        ) : null}
        {ccaCount > 0 ? <div>{ccaCount} CCA RINs awaiting feed</div> : null}
      </div>
    </section>
  );
}
