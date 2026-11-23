// Grouping helper for the dashboard's HFP health card.
//
// HFP is not a segment x component grid: its RINs carry no tariff segment, and
// MIDAS publishes them as five separate feeds. The RIN series tells the feeds
// apart (the HFP sheet's bucket columns map onto fixed series), so the card can
// score each feed on its own instead of hiding a broken feed inside one
// provider-wide "HFP" number.
//
// Nothing here touches React, `fetch` or the DOM: `buildHfpBuckets` is a pure
// transform of the payload, exactly like the builders in health-matrix.ts.

import { cellFromRins } from "./health-matrix";
import type { MatrixCell } from "./health-matrix";
import type { RinEntry } from "./types";

/** One HFP feed; the CCA price feed is the only one MIDAS fills separately. */
export type HfpBucket =
  | "bundled-secondary"
  | "bundled-primary"
  | "bundled-transmission"
  | "rep-circuit"
  | "cca";

/** Render order and labels of the five HFP feeds. */
export const HFP_BUCKETS: {
  key: HfpBucket;
  label: string;
  isCca?: boolean;
}[] = [
  { key: "bundled-secondary", label: "Bundled Secondary" },
  { key: "bundled-primary", label: "Bundled Primary" },
  { key: "bundled-transmission", label: "Bundled Transmission" },
  { key: "rep-circuit", label: "Rep Circuit" },
  { key: "cca", label: "CCA Prices", isCca: true },
];

/**
 * The HFP feed a RIN belongs to, or `null` when it is not an HFP RIN.
 *
 * RINs are `USCA-<prefix>-<series>-<sequence>`:
 *   PGPG 3800/3801/3802 -> bundled secondary/primary/transmission
 *   PGXX 3800           -> representative circuit
 *   XX.. 3800           -> CCA price feed (XXMB, XXSJ, XXPC, ...)
 * The sequence is optional here so the short fixture RINs (`USCA-PGPG-3801`)
 * still classify.
 */
export function hfpBucketOf(rin: string): HfpBucket | null {
  const parts = rin.toUpperCase().split("-");
  if (parts.length < 3 || parts[0] !== "USCA") {
    return null;
  }
  const prefix = parts[1];
  const series = parts[2];

  if (prefix === "PGPG") {
    switch (series) {
      case "3800":
        return "bundled-secondary";
      case "3801":
        return "bundled-primary";
      case "3802":
        return "bundled-transmission";
      default:
        return null;
    }
  }
  if (prefix === "PGXX") {
    return series === "3800" ? "rep-circuit" : null;
  }
  // A CCA prefix (XXMB, XXSJ, ...) has no PG&E delivery half: its 3800 rows are
  // the CCA price feed.
  if (prefix.startsWith("XX")) {
    return series === "3800" ? "cca" : null;
  }
  return null;
}

/**
 * Roll every HFP RIN up into its feed. Each bucket gets a `MatrixCell`, so the
 * card renders the exact red/amber/green cell the matrices use.
 */
export function buildHfpBuckets(
  rins: RinEntry[],
): Record<HfpBucket, MatrixCell> {
  const grouped: Record<HfpBucket, RinEntry[]> = {
    "bundled-secondary": [],
    "bundled-primary": [],
    "bundled-transmission": [],
    "rep-circuit": [],
    cca: [],
  };

  for (const rin of rins) {
    if (rin.component !== "hfp") {
      continue;
    }
    const bucket = hfpBucketOf(rin.rin);
    if (bucket !== null) {
      grouped[bucket].push(rin);
    }
  }

  return {
    "bundled-secondary": cellFromRins(grouped["bundled-secondary"]),
    "bundled-primary": cellFromRins(grouped["bundled-primary"]),
    "bundled-transmission": cellFromRins(grouped["bundled-transmission"]),
    "rep-circuit": cellFromRins(grouped["rep-circuit"]),
    cca: cellFromRins(grouped.cca),
  };
}
