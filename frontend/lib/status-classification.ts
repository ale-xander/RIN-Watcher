// Display-only status classification for the drill's affected-RINs table.
//
// The backend's three-way `status_kind` lumps every RIN MIDAS has no status row
// for into `not_in_midas`. That single bucket hides a real distinction:
//
//   * "Pending launch"  - an NBT RIN for a vintage that has not started yet
//                         (e.g. NBT-2027 while the current year is 2026).
//                         Nothing is wrong; there is simply nothing to priced
//                         until the vintage launches.
//   * "Not in MIDAS"    - a current/past vintage, no vintage at all, or a
//                         floating vintage. That is a data-quality issue worth
//                         investigating.
//
// The matrix keeps its coarse notInMidas count (unchanged); this module is what
// the drill uses to disambiguate it row by row.

import { getVintage } from "./nbt-vintage";
import type { RinEntry } from "./types";

export type RinDisplayStatus =
  | "healthy"
  | "no_price"
  | "not_in_midas"
  | "pending_launch";

/** Classify one RIN for display in the affected-RINs table's Status column. */
export function classifyDisplayStatus(rin: RinEntry): RinDisplayStatus {
  if (rin.status_kind === "healthy") return "healthy";
  if (rin.status_kind === "missing") return "no_price";
  if (rin.status_kind === "not_in_midas") {
    const vintage = getVintage(rin.enrollment_codes);
    if (vintage !== null && vintage !== "floating") {
      const year = parseInt(vintage, 10);
      if (year > new Date().getUTCFullYear()) return "pending_launch";
    }
    return "not_in_midas";
  }
  // No status_kind (legacy payload) -> fall back to has_value_today, exactly
  // like statusKindOf in health-matrix.ts.
  return rin.has_value_today === 1 ? "healthy" : "no_price";
}
