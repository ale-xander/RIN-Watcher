// Pure drill selection for the dashboard's matrices.
//
// A `Drill` records which matrix cell (or provider-wide view) the user opened.
// `drillBaselineRins` resolves that cell back to the RINs the cell was built
// from, and the helpers below turn that baseline into the list the affected
// table renders: drop the healthy RINs, apply the clicked attribute chips, sort
// the stalest first. Nothing here touches React, `fetch` or the DOM, so the page
// can memoise every step and the rules stay unit-testable.

import { classifyAttributes } from "./attribute-groups";
import { CCA_HFP_RATE_NAME } from "./constants";
import type { NbtRowKey as NbtBodyRowKey } from "./health-matrix";
import { getVintage } from "./nbt-vintage";
import type { NbtVintage } from "./nbt-vintage";
import type { RinEntry } from "./types";

/** Segment rows of the main matrix; `all` is the total row. */
export type MainRowKey = "ag" | "non_res" | "resid" | "all";
/** Component columns of the main matrix; `all` is the total column. */
export type MainColKey = "bundled" | "unbundled" | "all";
/** Segment/component rows of the NBT matrix; `all` is the total row. */
export type NbtRowKey = NbtBodyRowKey | "all";
/** Vintage columns of the NBT matrix; `all` is the total column. */
export type NbtColKey = NbtVintage | "all";

/** One open drill: the matrix cell (or provider view) the user clicked. */
export type Drill =
  /** One cell of the segment x component matrix. */
  | { kind: "main"; row: MainRowKey; col: MainColKey }
  /** One cell of the segment/component x NBT vintage matrix. */
  | { kind: "nbt"; row: NbtRowKey; col: NbtColKey }
  /**
   * The Master RIN List: a provider-wide list scoped to one PG&E component,
   * with no segment restriction. HFP is absent on purpose — the `hfp` drill
   * below already is the HFP-wide universe.
   */
  | { kind: "component"; component: "bundled" | "unbundled" }
  /** The HFP strip: PG&E HFP RINs, CCA-owned HFP excluded. */
  | { kind: "hfp" }
  /** Provider-wide list, used for providers without a component split. */
  | { kind: "provider" };

/** True when two drills point at the same cell (used to ignore re-clicks). */
export function sameDrill(a: Drill, b: Drill): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  switch (a.kind) {
    case "main":
      return b.kind === "main" && a.row === b.row && a.col === b.col;
    case "nbt":
      return b.kind === "nbt" && a.row === b.row && a.col === b.col;
    case "component":
      return b.kind === "component" && a.component === b.component;
    default:
      return true;
  }
}

/** The `NbtRowKey` is `<component>-<segment>`; neither part contains a dash. */
function splitNbtRow(row: NbtBodyRowKey): {
  component: "bundled" | "unbundled";
  segment: "ag" | "non_res" | "resid";
} {
  const dash = row.indexOf("-");
  return {
    component: row.slice(0, dash) as "bundled" | "unbundled",
    segment: row.slice(dash + 1) as "ag" | "non_res" | "resid",
  };
}

/** RINs the main matrix can place: a PG&E component and a real segment. */
function isMatrixRin(rin: RinEntry): boolean {
  return (
    (rin.component === "bundled" || rin.component === "unbundled") &&
    (rin.category === "ag" ||
      rin.category === "non_res" ||
      rin.category === "resid")
  );
}

/**
 * Every RIN behind a drill, before the failure filter: the "engine" of the
 * matrix cell. Uses the same rules as `buildMainMatrix` / `buildNbtMatrix` /
 * `buildHfpStrip`, so a cell's `total` and the baseline length agree.
 */
export function drillBaselineRins(rins: RinEntry[], drill: Drill): RinEntry[] {
  switch (drill.kind) {
    case "provider":
      return rins;
    case "hfp":
      return rins.filter(
        (rin) =>
          rin.component === "hfp" && rin.rate_name !== CCA_HFP_RATE_NAME,
      );
    case "main":
      return rins.filter(
        (rin) =>
          isMatrixRin(rin) &&
          (drill.row === "all" || rin.category === drill.row) &&
          (drill.col === "all" || rin.component === drill.col),
      );
    case "nbt": {
      const row = drill.row === "all" ? null : splitNbtRow(drill.row);
      return rins.filter((rin) => {
        if (!isMatrixRin(rin)) {
          return false;
        }
        if (row && (rin.component !== row.component || rin.category !== row.segment)) {
          return false;
        }
        const vintage = getVintage(rin.enrollment_codes);
        return (
          vintage !== null && (drill.col === "all" || vintage === drill.col)
        );
      });
    }
    case "component":
      // The Master RIN List: every RIN of the chosen component, whatever its
      // segment, so the table can show it all without a matrix cell.
      return rins.filter((rin) => rin.component === drill.component);
  }
}

/**
 * The drill's affected RINs: everything that failed today's publication.
 * `not_in_midas` RINs are informational, so they only join when asked for.
 */
export function affectedRins(
  rins: RinEntry[],
  showNotYetLive: boolean,
): RinEntry[] {
  return rins.filter(
    (rin) =>
      rin.status_kind === "missing" ||
      (showNotYetLive && rin.status_kind === "not_in_midas"),
  );
}

/** A pattern chip matches its own code and any parameterised variant. */
function carriesAttribute(rin: RinEntry, attribute: string): boolean {
  if (attribute === "other") {
    return classifyAttributes(rin.enrollment_codes).other.length > 0;
  }
  return rin.enrollment_codes.some(
    (code) => code === attribute || code.startsWith(`${attribute}-`),
  );
}

/** AND the active pattern chips together; no chips means no filtering. */
export function filterByAttributes(
  rins: RinEntry[],
  attributes: Set<string>,
): RinEntry[] {
  if (attributes.size === 0) {
    return rins;
  }
  const wanted = [...attributes];
  return rins.filter((rin) =>
    wanted.every((attribute) => carriesAttribute(rin, attribute)),
  );
}

/**
 * Stalest first, never-published RINs at the very top (they are the worst
 * case), RIN as the deterministic tie-breaker. `last_success_date` is ISO, so a
 * lexicographic compare is a chronological one.
 */
export function sortByStaleness(rins: RinEntry[]): RinEntry[] {
  return [...rins].sort((a, b) => {
    const left = a.last_success_date;
    const right = b.last_success_date;
    if (left === right) {
      return a.rin.localeCompare(b.rin, undefined, { numeric: true });
    }
    if (left === null) {
      return -1;
    }
    if (right === null) {
      return 1;
    }
    return left < right ? -1 : 1;
  });
}
