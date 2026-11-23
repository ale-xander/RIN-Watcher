// Pure attribute classifier and failure-pattern detector for the RIN drills.
//
// The backend hands the dashboard each RIN's `enrollment_codes`;
// `classifyAttributes()` splits one RIN's codes into the four buckets the drill
// renders, and `computePatterns()` rolls a failing ("affected") set up against
// a baseline to surface overrepresented attributes (the "↑" signal), grouped by
// PG&E component so the Full Service and Direct Access columns stay separate.
// Nothing here touches React, `fetch` or the DOM: every function is a pure
// transform of its input, so callers can memoise or unit-test it.

import type { Component, RinEntry } from "./types";

/** A bill-discount enrollment code. CARE+MDBL can coexist; CARE+FERA cannot. */
export type DiscountCode = "CARE" | "FERA" | "MDBL";

/** A demand-response enrollment code. PDP and SR are mutually exclusive. */
export type DrCode = "PDP" | "SR";

/** Voltage letter carried by a `VOLTAGE-<letter>` enrollment code. */
export type VoltageLetter = "S" | "P" | "T";

/** One RIN's enrollment codes, split into the buckets the drill cares about. */
export interface ClassifiedAttributes {
  /** 0-2 codes; CARE+MDBL possible, CARE+FERA never. Discovery order kept. */
  discount: DiscountCode[];
  /** 0-1 code; PDP xor SR. Discovery order kept. */
  dr: DrCode[];
  /** At most one per RIN; malformed data with two keeps the last one seen. */
  voltage: VoltageLetter | null;
  /** Anything else, in discovery order; excludes IGNORED_CODES and NBT vintages. */
  other: string[];
}

/** The bucket a chip's attribute came from. */
type AttributeCategory = "discount" | "dr" | "voltage" | "other";

/** One row of the "what do the failing RINs have in common" list. */
export interface PatternChip {
  /** 'PDP', 'CARE', 'VOLTAGE-S', 'CUSTCRG-S', or 'other' (the tail chip). */
  attribute: string;
  category: AttributeCategory;
  /** RINs carrying the attribute in the affected subset. */
  affectedCount: number;
  /** RINs carrying the attribute in the matching baseline subset. */
  baselineCount: number;
  /** affectedCount / affected subset size; 0 when that subset is empty. */
  affectedPct: number;
  /** baselineCount / baseline subset size; 0 when that subset is empty. */
  baselinePct: number;
  /** Ratio > 1.5 OR saturation > 0.8, and at least 3 affected RINs. */
  overrepresented: boolean;
  /** affectedCount / baselineCount; 0 when the baseline has none. */
  saturation: number;
  /** Only on the collapsed 'other' chip: the attribute names it swallowed. */
  tailNames?: string[];
}

/** The chips for one component drill. `all` is a defensive fallback only. */
export interface PatternGroup {
  component: "bundled" | "unbundled" | "all";
  /** '' for 'all', else 'Full Service (Bundled)' / 'Direct Access (Unbundled)'. */
  label: string;
  /** Sorted desc by affectedCount (ties: desc saturation); 'other' last. */
  patterns: PatternChip[];
}

/** PG&E components the drills break out; HFP has its own bucket card. */
type DrillComponent = Exclude<Component, "hfp">;

const DRILL_COMPONENTS: DrillComponent[] = ["bundled", "unbundled"];

const COMPONENT_LABELS: Record<PatternGroup["component"], string> = {
  bundled: "Full Service (Bundled)",
  unbundled: "Direct Access (Unbundled)",
  all: "",
};

/** Program markers that carry no per-RIN signal for the drills. */
const IGNORED_CODES = new Set(["PGE-FS", "DA-CCA", "NBT"]);
const DISCOUNT_CODES = new Set(["CARE", "FERA", "MDBL"]);
const DR_CODES = new Set(["PDP", "SR"]);
const VOLTAGE_RE = /^VOLTAGE-([SPT])$/;
/** `NBT-YYYY` is the vintage, resolved separately by nbt-vintage.ts. */
const VINTAGE_RE = /^NBT-\d{4}$/;

/** A chip needs this many affected RINs before it can be flagged. */
const MIN_OVERREPRESENTED_COUNT = 3;
/** Affected share must beat the baseline share by this factor ... */
const OVERREPRESENTED_RATIO = 1.5;
/** ... or the attribute must cover this share of the baseline. */
const OVERREPRESENTED_SATURATION = 0.8;
/** Floor under `baselinePct` so a never-seen attribute does not divide by 0. */
const BASELINE_PCT_FLOOR = 0.01;

/** A chip below max(3, 10% of the drill) affected RINs is collapsed. */
const TAIL_MIN_COUNT = 3;
const TAIL_MIN_SHARE = 0.1;

/**
 * Splits a RIN's enrollment codes into the four drill buckets in one pass.
 * Codes are kept in discovery order: order is a display concern, not ours.
 * Null/undefined/empty input yields four empty buckets.
 */
export function classifyAttributes(
  codes: string[] | null | undefined,
): ClassifiedAttributes {
  const classified: ClassifiedAttributes = {
    discount: [],
    dr: [],
    voltage: null,
    other: [],
  };
  if (!codes) return classified;

  for (const code of codes) {
    if (IGNORED_CODES.has(code)) continue;
    if (VINTAGE_RE.test(code)) continue;
    if (DISCOUNT_CODES.has(code)) {
      classified.discount.push(code as DiscountCode);
      continue;
    }
    if (DR_CODES.has(code)) {
      classified.dr.push(code as DrCode);
      continue;
    }
    const voltage = VOLTAGE_RE.exec(code);
    if (voltage) {
      classified.voltage = voltage[1] as VoltageLetter;
      continue;
    }
    classified.other.push(code);
  }

  return classified;
}

/** One attribute as the counter sees it: display label plus bucket. */
interface AttributeLabel {
  attribute: string;
  category: AttributeCategory;
}

/**
 * The attribute labels one RIN contributes. Repeated codes collapse to one
 * label, so no RIN can push a count above its subset size. 'other' codes are
 * labelled individually (never as the array) to match the chip contract.
 */
function labelsFor(entry: RinEntry): AttributeLabel[] {
  const classified = classifyAttributes(entry.enrollment_codes);
  const labels: AttributeLabel[] = [];

  for (const code of classified.discount) {
    labels.push({ attribute: code, category: "discount" });
  }
  for (const code of classified.dr) {
    labels.push({ attribute: code, category: "dr" });
  }
  if (classified.voltage !== null) {
    labels.push({
      attribute: `VOLTAGE-${classified.voltage}`,
      category: "voltage",
    });
  }
  for (const code of classified.other) {
    labels.push({ attribute: code, category: "other" });
  }

  const seen = new Set<string>();
  return labels.filter((label) => {
    if (seen.has(label.attribute)) return false;
    seen.add(label.attribute);
    return true;
  });
}

interface AttributeCount {
  category: AttributeCategory;
  count: number;
}

/** Counts every distinct attribute across a RIN subset. */
function countAttributes(rins: RinEntry[]): Map<string, AttributeCount> {
  const counts = new Map<string, AttributeCount>();

  for (const entry of rins) {
    for (const label of labelsFor(entry)) {
      const existing = counts.get(label.attribute);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(label.attribute, { category: label.category, count: 1 });
      }
    }
  }

  return counts;
}

function baselineFor(
  component: PatternGroup["component"],
  baselineRins: RinEntry[],
): RinEntry[] {
  // 'all' should never be built by computePatterns; keep it unfiltered if it is.
  if (component === "all") return baselineRins;
  return baselineRins.filter((entry) => entry.component === component);
}

function makeChip(
  attribute: string,
  category: AttributeCategory,
  affectedCount: number,
  baselineCount: number,
  affectedTotal: number,
  baselineTotal: number,
): PatternChip {
  const affectedPct = affectedTotal > 0 ? affectedCount / affectedTotal : 0;
  const baselinePct = baselineTotal > 0 ? baselineCount / baselineTotal : 0;
  const saturation = baselineCount > 0 ? affectedCount / baselineCount : 0;
  const ratio = affectedPct / Math.max(baselinePct, BASELINE_PCT_FLOOR);

  return {
    attribute,
    category,
    affectedCount,
    baselineCount,
    affectedPct,
    baselinePct,
    // No baseline means no defensible comparison: the ratio branch is built on
    // the 0.01 floor and would flag nearly anything, so short-circuit to false.
    overrepresented:
      baselineTotal > 0 &&
      affectedCount >= MIN_OVERREPRESENTED_COUNT &&
      (ratio > OVERREPRESENTED_RATIO || saturation > OVERREPRESENTED_SATURATION),
    saturation,
  };
}

/**
 * Collapses the long tail of rare attributes into a single 'other' chip so a
 * handful of one-off codes cannot crowd out the attributes that matter.
 * Chips are already sorted desc, so the tail is always a suffix.
 */
function collapseTail(
  chips: PatternChip[],
  affectedTotal: number,
  baselineTotal: number,
): PatternChip[] {
  const cutoff = Math.max(
    TAIL_MIN_COUNT,
    Math.floor(affectedTotal * TAIL_MIN_SHARE),
  );
  const kept = chips.filter((chip) => chip.affectedCount >= cutoff);
  const tail = chips.filter((chip) => chip.affectedCount < cutoff);
  if (tail.length === 0) return kept;

  const affectedCount = tail.reduce((sum, chip) => sum + chip.affectedCount, 0);
  const baselineCount = tail.reduce((sum, chip) => sum + chip.baselineCount, 0);

  kept.push({
    attribute: "other",
    category: "other",
    affectedCount,
    baselineCount,
    affectedPct: affectedTotal > 0 ? affectedCount / affectedTotal : 0,
    baselinePct: baselineTotal > 0 ? baselineCount / baselineTotal : 0,
    overrepresented: false,
    saturation: 0,
    tailNames: tail.map((chip) => chip.attribute),
  });

  return kept;
}

/** Builds the sorted, tail-collapsed chip list for one component drill. */
function buildPatterns(
  affectedSubset: RinEntry[],
  baselineSubset: RinEntry[],
): PatternChip[] {
  if (affectedSubset.length === 0) return [];

  const affectedCounts = countAttributes(affectedSubset);
  if (affectedCounts.size === 0) return [];

  const baselineCounts = countAttributes(baselineSubset);
  const chips: PatternChip[] = [];

  for (const [attribute, counted] of affectedCounts) {
    chips.push(
      makeChip(
        attribute,
        counted.category,
        counted.count,
        baselineCounts.get(attribute)?.count ?? 0,
        affectedSubset.length,
        baselineSubset.length,
      ),
    );
  }

  chips.sort(
    (left, right) =>
      right.affectedCount - left.affectedCount ||
      right.saturation - left.saturation,
  );

  return collapseTail(chips, affectedSubset.length, baselineSubset.length);
}

function buildGroup(
  component: PatternGroup["component"],
  affectedSubset: RinEntry[],
  baselineRins: RinEntry[],
): PatternGroup {
  return {
    component,
    label: COMPONENT_LABELS[component],
    patterns: buildPatterns(affectedSubset, baselineFor(component, baselineRins)),
  };
}

/**
 * Rolls a failing RIN set up against a baseline, one group per PG&E component.
 *
 * RINs whose component is null (CCA-owned) or 'hfp' are ignored: the drills
 * this feeds are the main/NBT ones, and neither belongs to a FS/CCA column.
 * A single-component drill yields one group, a mixed drill yields bundled then
 * unbundled, and an empty affected set yields no groups at all.
 */
export function computePatterns(
  affectedRins: RinEntry[],
  baselineRins: RinEntry[],
): PatternGroup[] {
  if (affectedRins.length === 0) return [];

  const drillRins = affectedRins.filter(
    (entry) => entry.component !== null && entry.component !== "hfp",
  );
  if (drillRins.length === 0) return [];

  return DRILL_COMPONENTS.filter((component) =>
    drillRins.some((entry) => entry.component === component),
  ).map((component) =>
    buildGroup(
      component,
      drillRins.filter((entry) => entry.component === component),
      baselineRins,
    ),
  );
}

// ---------------------------------------------------------------------------
// Dev fixture
// ---------------------------------------------------------------------------
//
// `__devFixture()` is a hand-checkable smoke test for the functions above: it
// builds synthetic RinEntry arrays, runs them through computePatterns() and
// throws if a documented expectation stops holding. Nothing calls it at
// runtime; a dev can import it and `console.table` the groups it returns.
//
// The numbers pin the boundaries instead of looking realistic:
//   * 42/50 PDP (84%) against a 58% baseline is 1.45x -> NOT overrepresented,
//     even though most of the drill carries the code.
//   * the same 42/50 against an 18% baseline is 4.70x -> overrepresented.
//   * the 50-RIN drill collapses anything under max(3, 10% of 50) = 5.
//   * the 20-RIN tail drill collapses anything under max(3, 10% of 20) = 3.

const FIXTURE_PREFIX: Record<DrillComponent, string> = {
  bundled: "PGPG",
  unbundled: "PGXX",
};

/** A drill RIN; only the fields these helpers read are meaningful. */
function fixtureRin(
  rin: string,
  component: Component | null,
  codes: string[],
): RinEntry {
  return {
    rin,
    rate_name: null,
    tariff: null,
    enrollment_codes: [...codes],
    category: "other",
    component,
    has_value_today: 0,
    status_kind: "missing",
    last_success_date: null,
    last_success: null,
  };
}

/** `count` RINs of one component, all carrying the same codes. */
function fixtureRins(
  tag: string,
  component: DrillComponent,
  count: number,
  codes: string[],
): RinEntry[] {
  return Array.from({ length: count }, (_, index) => {
    const suffix = String(index + 1).padStart(3, "0");
    return fixtureRin(
      `USCA-${FIXTURE_PREFIX[component]}-${tag}-${suffix}`,
      component,
      codes,
    );
  });
}

/**
 * Affected drill: 50 bundled RINs carrying 42 PDP, 12 CARE and 8 VOLTAGE-S.
 * The overlaps are deliberate (8 RINs carry all three, 4 carry PDP+CARE), so
 * the per-attribute counts sum past 50 without any RIN being counted twice:
 * 8 + 4 + 30 = 42 PDP, 8 + 4 = 12 CARE, 8 = 8 VOLTAGE-S, 8 ignored-only.
 */
function fixtureAffectedRins(): RinEntry[] {
  return [
    ...fixtureRins("AF1", "bundled", 8, ["PDP", "CARE", "VOLTAGE-S"]),
    ...fixtureRins("AF2", "bundled", 4, ["PDP", "CARE"]),
    ...fixtureRins("AF3", "bundled", 30, ["PDP"]),
    // Dead weight: a program marker only, so these RINs add no attributes.
    ...fixtureRins("AF4", "bundled", 8, ["PGE-FS"]),
  ];
}

/** 224-RIN baseline; `pdp` of them carry PDP (130 -> 58%, 40 -> 18%). */
function fixtureBaselineRins(pdp: number): RinEntry[] {
  return [
    ...fixtureRins("BL1", "bundled", pdp, ["PDP"]),
    ...fixtureRins("BL2", "bundled", 54, ["CARE"]),
    ...fixtureRins("BL3", "bundled", 40, ["VOLTAGE-S"]),
    ...fixtureRins("BL4", "bundled", 224 - pdp - 54 - 40, ["PGE-FS"]),
  ];
}

/**
 * Mixed drill: 6 bundled PDP RINs and 5 unbundled CARE RINs. The baseline is
 * component-specific (24 bundled PDP + 6 bundled SR, 10 unbundled CARE + 30
 * unbundled FERA), so an unfiltered baseline would move baselinePct.
 */
function fixtureMixedAffectedRins(): RinEntry[] {
  return [
    ...fixtureRins("MX1", "bundled", 6, ["PDP"]),
    ...fixtureRins("MX2", "unbundled", 5, ["CARE"]),
  ];
}

function fixtureMixedBaselineRins(): RinEntry[] {
  return [
    ...fixtureRins("MB1", "bundled", 24, ["PDP"]),
    ...fixtureRins("MB2", "bundled", 6, ["SR"]),
    ...fixtureRins("MB3", "unbundled", 10, ["CARE"]),
    ...fixtureRins("MB4", "unbundled", 30, ["FERA"]),
  ];
}

/**
 * Tail drill: 20 bundled RINs whose only frequent chip is PDP (4). The five
 * 'other' codes hold 2, 2, 2, 1 and 1 RINs, all under the cutoff of 3, so they
 * must come back as one 'other' chip with 8 affected RINs and five tailNames.
 */
function fixtureTailAffectedRins(): RinEntry[] {
  return [
    ...fixtureRins("TL1", "bundled", 4, ["PDP"]),
    ...fixtureRins("TL2", "bundled", 2, ["CUSTCRG-S"]),
    ...fixtureRins("TL3", "bundled", 2, ["SPLIT-WEEK-4"]),
    ...fixtureRins("TL4", "bundled", 2, ["DEMO-A"]),
    ...fixtureRins("TL5", "bundled", 1, ["DEMO-B"]),
    ...fixtureRins("TL6", "bundled", 1, ["DEMO-C"]),
    // Eight RINs with no codes: they still count toward the drill size.
    ...fixtureRins("TL7", "bundled", 8, []),
  ];
}

/** 100-RIN tail baseline: 6 CUSTCRG-S, 3 SPLIT-WEEK-4, 1 DEMO-A, 90 bare. */
function fixtureTailBaselineRins(): RinEntry[] {
  return [
    ...fixtureRins("TB1", "bundled", 6, ["CUSTCRG-S"]),
    ...fixtureRins("TB2", "bundled", 3, ["SPLIT-WEEK-4"]),
    ...fixtureRins("TB3", "bundled", 1, ["DEMO-A"]),
    ...fixtureRins("TB4", "bundled", 90, []),
  ];
}

function assertEqual<T>(label: string, expected: T, actual: T): void {
  if (expected !== actual) {
    throw new Error(
      `${label}: expected ${String(expected)}, got ${String(actual)}`,
    );
  }
}

function assertClose(label: string, expected: number, actual: number): void {
  if (Math.abs(expected - actual) > 1e-9) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

/** Asserts the group produced exactly `expected` chips and returns it. */
function groupWithChips(
  label: string,
  group: PatternGroup | undefined,
  expected: number,
): PatternGroup {
  if (!group) throw new Error(`${label}: no group returned`);
  assertEqual(`${label}: chip count`, expected, group.patterns.length);
  return group;
}

function chipNamed(group: PatternGroup, attribute: string): PatternChip {
  const found = group.patterns.find((entry) => entry.attribute === attribute);
  if (!found) {
    throw new Error(`${group.component}: missing '${attribute}' chip`);
  }
  return found;
}

/** Classifier expectations: ignores program markers, skips NBT vintages. */
function assertClassify(): ClassifiedAttributes {
  const classified = classifyAttributes([
    "PGE-FS", // IGNORED_CODES
    "NBT-2026", // vintage, owned by nbt-vintage.ts
    "CARE",
    "MDBL",
    "PDP",
    "VOLTAGE-P",
    "CUSTCRG-S",
  ]);

  assertEqual("classify: discount", "CARE,MDBL", classified.discount.join(","));
  assertEqual("classify: dr", "PDP", classified.dr.join(","));
  assertEqual("classify: voltage", "P", classified.voltage ?? "");
  assertEqual("classify: other", "CUSTCRG-S", classified.other.join(","));

  // Duplicate discount codes are kept: the caller decides how to dedupe.
  const duplicates = classifyAttributes(["CARE", "CARE"]);
  assertEqual("classify: duplicate discount", 2, duplicates.discount.length);

  // Last voltage wins if the source data is malformed.
  assertEqual("classify: last voltage", "T", classifyAttributes([
    "VOLTAGE-S",
    "VOLTAGE-T",
  ]).voltage ?? "");

  for (const [label, empty] of [
    ["null", classifyAttributes(null)],
    ["undefined", classifyAttributes(undefined)],
    ["empty", classifyAttributes([])],
  ] as const) {
    assertEqual(`classify ${label}: discount`, 0, empty.discount.length);
    assertEqual(`classify ${label}: dr`, 0, empty.dr.length);
    assertEqual(`classify ${label}: other`, 0, empty.other.length);
    assertEqual(`classify ${label}: voltage`, null, empty.voltage);
  }

  return classified;
}

/**
 * Smoke-test fixture: runs every documented case through the helpers above.
 * Throws on the first mismatch, so running it under Node is a pass/fail check;
 * the returned groups are there for `console.table` inspection.
 */
export function __devFixture(): {
  classified: ClassifiedAttributes;
  singleBundled: PatternGroup[];
  overrepresented: PatternGroup[];
  mixed: PatternGroup[];
  tail: PatternGroup[];
  noBaseline: PatternGroup[];
  empty: PatternGroup[];
} {
  const classified = assertClassify();

  // 1. Single-component drill. 84% PDP against a 58% baseline is 1.45x, so no
  //    chip is flagged even though PDP dominates the drill.
  const singleBundled = computePatterns(
    fixtureAffectedRins(),
    fixtureBaselineRins(130),
  );
  assertEqual("single drill: group count", 1, singleBundled.length);
  const bundledGroup = groupWithChips("single drill", singleBundled[0], 3);
  assertEqual("single drill: component", "bundled", bundledGroup.component);
  assertEqual(
    "single drill: label",
    "Full Service (Bundled)",
    bundledGroup.label,
  );
  assertEqual(
    "single drill: chip order",
    "PDP,CARE,VOLTAGE-S",
    bundledGroup.patterns.map((entry) => entry.attribute).join(","),
  );

  const singlePdp = chipNamed(bundledGroup, "PDP");
  assertEqual("single drill: PDP category", "dr", singlePdp.category);
  assertEqual("single drill: PDP affected", 42, singlePdp.affectedCount);
  assertEqual("single drill: PDP baseline", 130, singlePdp.baselineCount);
  assertClose("single drill: PDP affectedPct", 0.84, singlePdp.affectedPct);
  assertClose(
    "single drill: PDP baselinePct",
    // 58% of 224 is 129.9, so the fixture uses 130/224 = 58.04%.
    130 / 224,
    singlePdp.baselinePct,
  );
  assertClose("single drill: PDP saturation", 42 / 130, singlePdp.saturation);
  assertEqual("single drill: PDP flagged", false, singlePdp.overrepresented);

  const singleCare = chipNamed(bundledGroup, "CARE");
  assertEqual("single drill: CARE category", "discount", singleCare.category);
  assertEqual("single drill: CARE affected", 12, singleCare.affectedCount);
  assertEqual("single drill: CARE baseline", 54, singleCare.baselineCount);
  assertEqual("single drill: CARE flagged", false, singleCare.overrepresented);

  const singleVoltage = chipNamed(bundledGroup, "VOLTAGE-S");
  assertEqual(
    "single drill: VOLTAGE-S category",
    "voltage",
    singleVoltage.category,
  );
  assertEqual("single drill: VOLTAGE-S affected", 8, singleVoltage.affectedCount);
  assertEqual("single drill: VOLTAGE-S baseline", 40, singleVoltage.baselineCount);
  assertEqual(
    "single drill: VOLTAGE-S flagged",
    false,
    singleVoltage.overrepresented,
  );

  // CCA-owned RINs (component null) never join a drill group.
  const ccaRins = Array.from({ length: 5 }, (_, index) =>
    fixtureRin(`USCA-XXMB-CCA-${index + 1}`, null, ["CARE"]),
  );
  const withCca = computePatterns(
    [...fixtureAffectedRins(), ...ccaRins],
    fixtureBaselineRins(130),
  );
  assertEqual("null component drill: group count", 1, withCca.length);
  assertEqual(
    "null component drill: CARE unaffected",
    12,
    chipNamed(withCca[0], "CARE").affectedCount,
  );

  // 2. Same drill, PDP baseline at 40/224 (17.86%): 0.84 / 0.1786 = 4.70x.
  const overrepresented = computePatterns(
    fixtureAffectedRins(),
    fixtureBaselineRins(40),
  );
  const flaggedGroup = groupWithChips(
    "overrepresented drill",
    overrepresented[0],
    3,
  );
  const flaggedPdp = chipNamed(flaggedGroup, "PDP");
  assertEqual("overrepresented drill: PDP baseline", 40, flaggedPdp.baselineCount);
  assertClose(
    "overrepresented drill: PDP ratio",
    0.84 / (40 / 224),
    flaggedPdp.affectedPct / flaggedPdp.baselinePct,
  );
  assertEqual(
    "overrepresented drill: PDP flagged",
    true,
    flaggedPdp.overrepresented,
  );
  // 42 affected against 40 baseline RINs: saturation passes 1 on purpose.
  assertClose("overrepresented drill: PDP saturation", 1.05, flaggedPdp.saturation);
  assertEqual(
    "overrepresented drill: CARE flagged",
    false,
    chipNamed(flaggedGroup, "CARE").overrepresented,
  );
  assertEqual(
    "overrepresented drill: VOLTAGE-S flagged",
    false,
    chipNamed(flaggedGroup, "VOLTAGE-S").overrepresented,
  );

  // 3. Mixed drill: two groups, each scored against its own baseline subset.
  const mixed = computePatterns(
    fixtureMixedAffectedRins(),
    fixtureMixedBaselineRins(),
  );
  assertEqual("mixed drill: group count", 2, mixed.length);
  assertEqual(
    "mixed drill: group order",
    "bundled,unbundled",
    mixed.map((group) => group.component).join(","),
  );
  assertEqual(
    "mixed drill: group[0] label",
    "Full Service (Bundled)",
    mixed[0].label,
  );
  assertEqual(
    "mixed drill: group[1] label",
    "Direct Access (Unbundled)",
    mixed[1].label,
  );

  const mixedBundled = groupWithChips("mixed drill bundled", mixed[0], 1);
  const mixedBundledChip = chipNamed(mixedBundled, "PDP");
  assertEqual("mixed drill bundled: affected", 6, mixedBundledChip.affectedCount);
  assertEqual("mixed drill bundled: baseline", 24, mixedBundledChip.baselineCount);
  assertClose(
    "mixed drill bundled: baselinePct",
    24 / 30,
    mixedBundledChip.baselinePct,
  );
  assertEqual(
    "mixed drill bundled: flagged",
    false,
    mixedBundledChip.overrepresented,
  );

  const mixedUnbundled = groupWithChips("mixed drill unbundled", mixed[1], 1);
  const mixedUnbundledChip = chipNamed(mixedUnbundled, "CARE");
  assertEqual(
    "mixed drill unbundled: affected",
    5,
    mixedUnbundledChip.affectedCount,
  );
  assertEqual(
    "mixed drill unbundled: baseline",
    10,
    mixedUnbundledChip.baselineCount,
  );
  // 10 / 40, not 10 / 70: the baseline was filtered to the unbundled subset.
  assertClose(
    "mixed drill unbundled: baselinePct",
    0.25,
    mixedUnbundledChip.baselinePct,
  );
  assertClose(
    "mixed drill unbundled: saturation",
    0.5,
    mixedUnbundledChip.saturation,
  );

  // 4. Tail collapse: 8 affected RINs spread over 5 rare codes become one chip.
  const tail = computePatterns(
    fixtureTailAffectedRins(),
    fixtureTailBaselineRins(),
  );
  const tailGroup = groupWithChips("tail drill", tail[0], 2);
  assertEqual("tail drill: first chip", "PDP", tailGroup.patterns[0].attribute);
  assertEqual("tail drill: PDP affected", 4, tailGroup.patterns[0].affectedCount);

  const tailChip = tailGroup.patterns[1];
  assertEqual("tail drill: collapsed attribute", "other", tailChip.attribute);
  assertEqual("tail drill: collapsed category", "other", tailChip.category);
  assertEqual("tail drill: collapsed affected", 8, tailChip.affectedCount);
  assertEqual("tail drill: collapsed baseline", 10, tailChip.baselineCount);
  assertClose("tail drill: collapsed affectedPct", 0.4, tailChip.affectedPct);
  assertClose("tail drill: collapsed baselinePct", 0.1, tailChip.baselinePct);
  assertEqual("tail drill: collapsed flagged", false, tailChip.overrepresented);
  assertEqual("tail drill: collapsed saturation", 0, tailChip.saturation);
  assertEqual(
    "tail drill: tailNames",
    "CUSTCRG-S,DEMO-A,DEMO-B,DEMO-C,SPLIT-WEEK-4",
    [...(tailChip.tailNames ?? [])].sort().join(","),
  );

  // 5. Empty affected set: no groups, no chips.
  const empty = computePatterns([], fixtureBaselineRins(130));
  assertEqual("empty drill: group count", 0, empty.length);

  // 6. Empty baseline: baselineCount/saturation stay 0 and the baselineTotal
  //    guard keeps the ratio branch out entirely, so a chip is never flagged
  //    when there is no baseline to compare it against.
  const noBaseline = computePatterns(fixtureAffectedRins(), []);
  const noBaselineGroup = groupWithChips("no baseline drill", noBaseline[0], 3);
  const noBaselinePdp = chipNamed(noBaselineGroup, "PDP");
  assertEqual("no baseline drill: PDP baseline", 0, noBaselinePdp.baselineCount);
  assertEqual("no baseline drill: PDP saturation", 0, noBaselinePdp.saturation);
  assertEqual(
    "no baseline drill: PDP flagged",
    false,
    noBaselinePdp.overrepresented,
  );

  return {
    classified,
    singleBundled,
    overrepresented,
    mixed,
    tail,
    noBaseline,
    empty,
  };
}

