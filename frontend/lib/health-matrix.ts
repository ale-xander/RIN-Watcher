// Pure builders for the health matrices rendered by the dashboard.
//
// The backend returns one flat `RinEntry[]` for `?component=all`; this module
// turns it into the pre-computed cells Steps 5-6 render. Nothing here touches
// React, `fetch` or the DOM: every function is a pure transform of its input, so
// the matrices can be memoised or unit-tested by the caller.
//
// Every cell classifies itself from its own counts (see `ragLevelFor`). The
// builders reconcile their totals and throw on a mismatch: that is a dev-time
// bug detector (a filtered-out or double-counted RIN), never an expected
// runtime state.
//
// A cell's RAG level is judged against its ACTIVE RINs only (missing + healthy):
// RINs MIDAS has no status row for yet ("not-yet-live") are counted and shown,
// but they cannot fail a fetch they were never part of.

import { getVintage } from "./nbt-vintage";
import type { NbtVintage } from "./nbt-vintage";
import type { Component, RinEntry } from "./types";

/** Traffic-light classification of a MatrixCell. */
export type RagLevel = "green" | "amber" | "red" | "empty";

/** The backend's three-way per-RIN status; see `_status_kind` in main.py. */
export type StatusKind = "healthy" | "missing" | "not_in_midas";

/** Status roll-up for one matrix cell. */
export interface MatrixCell {
  /** status_kind === "missing" */
  missing: number;
  /** status_kind === "healthy" */
  healthy: number;
  /** status_kind === "not_in_midas": informational, never actionable. */
  notInMidas: number;
  /** missing + healthy + notInMidas: every RIN that landed in this cell. */
  total: number;
  /** Subset of `missing` with no last_success_date: never priced. */
  never: number;
  rag: RagLevel;
}

/** Segments the main matrix breaks out; `other` RINs are not part of it. */
export const SEGMENT_KEYS = ["ag", "non_res", "resid"] as const;
export type MatrixSegment = (typeof SEGMENT_KEYS)[number];

/** PG&E components that carry a segment; HFP is tracked separately. */
export const COMPONENT_KEYS = ["bundled", "unbundled"] as const;
export type MatrixComponent = (typeof COMPONENT_KEYS)[number];

/** The fixed NBT column set. Vintages with no RINs stay in the grid, empty. */
export const NBT_VINTAGES: NbtVintage[] = [
  "2023",
  "2024",
  "2025",
  "2026",
  "2027",
  "floating",
];

export interface MainMatrix {
  rows: {
    ag: { bundled: MatrixCell; unbundled: MatrixCell; all: MatrixCell };
    non_res: { bundled: MatrixCell; unbundled: MatrixCell; all: MatrixCell };
    resid: { bundled: MatrixCell; unbundled: MatrixCell; all: MatrixCell };
  };
  colTotals: {
    bundled: MatrixCell;
    unbundled: MatrixCell;
    all: MatrixCell;
  };
  grandTotal: MatrixCell;
}

/** One NBT row: a cell per vintage column plus the row's "all" cell. */
export type NbtRow = { [v in NbtVintage]: MatrixCell } & { all: MatrixCell };

export interface NbtMatrix {
  rows: {
    "bundled-ag": NbtRow;
    "bundled-non_res": NbtRow;
    "bundled-resid": NbtRow;
    "unbundled-ag": NbtRow;
    "unbundled-non_res": NbtRow;
    "unbundled-resid": NbtRow;
  };
  colTotals: { [v in NbtVintage]: MatrixCell } & { all: MatrixCell };
  grandTotal: MatrixCell;
}

export type NbtRowKey = keyof NbtMatrix["rows"];

/**
 * Render order for the NBT rows: segment first (Residential, Non-Res, AG), then
 * component (bundled before unbundled). `satisfies` keeps the list in lockstep
 * with `NbtMatrix["rows"]`.
 */
export const NBT_ROW_KEYS = [
  "bundled-resid",
  "unbundled-resid",
  "bundled-non_res",
  "unbundled-non_res",
  "bundled-ag",
  "unbundled-ag",
] as const satisfies readonly NbtRowKey[];

export interface HfpStrip {
  total: number;
  missing: number;
  healthy: number;
  /** HFP RINs MIDAS has no status row for: awaiting the feed, not failing. */
  notInMidas: number;
  never: number;
  rag: RagLevel;
}

/**
 * Amber below 10% missing, red at or above it: 9.99% is amber, exactly 10% is
 * red. The boundary is inclusive on purpose (`>=`, never `>`).
 */
const RED_MISSING_RATIO = 0.1;

/**
 * Traffic light for a (missing, actionableTotal) pair. `actionableTotal` 0 is
 * `empty`; the caller resolves the "only not-yet-live RINs" case to green.
 */
export function ragLevelFor(
  missing: number,
  actionableTotal: number,
): RagLevel {
  if (actionableTotal === 0) return "empty";
  if (missing === 0) return "green";
  return missing / actionableTotal >= RED_MISSING_RATIO ? "red" : "amber";
}

/**
 * Resolve one RIN's three-way status. Payloads that predate `status_kind` fall
 * back to `has_value_today`, so an unknown status is never read as healthy.
 */
function statusKindOf(rin: RinEntry): StatusKind {
  const kind: StatusKind | undefined = rin.status_kind;
  if (kind === "healthy" || kind === "missing" || kind === "not_in_midas") {
    return kind;
  }
  return rin.has_value_today === 1 ? "healthy" : "missing";
}

/**
 * Assemble a cell from its counts. RAG uses (missing / (missing + healthy)) —
 * the ACTIONABLE denominator. `notInMidas` is informational: a RIN MIDAS has
 * never heard of is a data gap, not a fetch failure, so it does not contribute
 * to the failure %. A cell that is *only* not-yet-live is green: no action.
 */
function buildCell(counts: {
  missing: number;
  healthy: number;
  notInMidas: number;
  never: number;
}): MatrixCell {
  const { missing, healthy, notInMidas, never } = counts;
  const actionableTotal = missing + healthy;
  const rag =
    actionableTotal === 0
      ? notInMidas === 0
        ? "empty"
        : "green" // all not-yet-live: nothing is live yet, so nothing to fix
      : ragLevelFor(missing, actionableTotal);

  return {
    missing,
    healthy,
    notInMidas,
    total: actionableTotal + notInMidas,
    never,
    rag,
  };
}

/**
 * Roll a flat RIN array up into one cell. RINs that are not explicitly
 * `healthy` count as `missing` (when their status is unknown), so a partial or
 * pre-`status_kind` payload can never be mistaken for a healthy RIN.
 */
export function cellFromRins(rins: RinEntry[]): MatrixCell {
  let missing = 0;
  let healthy = 0;
  let notInMidas = 0;
  let never = 0;

  for (const rin of rins) {
    const kind = statusKindOf(rin);
    if (kind === "healthy") {
      healthy += 1;
      continue;
    }
    if (kind === "not_in_midas") {
      notInMidas += 1;
      continue;
    }
    missing += 1;
    // No stored success date means the RIN has never returned a price.
    if (!rin.last_success_date) never += 1;
  }

  return buildCell({ missing, healthy, notInMidas, never });
}

/** Sum cells, re-deriving the ratio. Used for "all" columns and totals. */
function mergeCells(cells: MatrixCell[]): MatrixCell {
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

  return buildCell({ missing, healthy, notInMidas, never });
}

function assertEqual(label: string, expected: number, actual: number): void {
  if (expected !== actual) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

/** Field-by-field comparison used by the dev fixture's hand-checked cells. */
function assertCell(label: string, expected: MatrixCell, actual: MatrixCell): void {
  assertEqual(`${label}: missing`, expected.missing, actual.missing);
  assertEqual(`${label}: healthy`, expected.healthy, actual.healthy);
  assertEqual(`${label}: notInMidas`, expected.notInMidas, actual.notInMidas);
  assertEqual(`${label}: total`, expected.total, actual.total);
  assertEqual(`${label}: never`, expected.never, actual.never);
  if (expected.rag !== actual.rag) {
    throw new Error(`${label}: rag expected ${expected.rag}, got ${actual.rag}`);
  }
}

function isMatrixComponent(
  value: RinEntry["component"],
): value is MatrixComponent {
  return value === "bundled" || value === "unbundled";
}

function isMatrixSegment(value: RinEntry["category"]): value is MatrixSegment {
  return value === "ag" || value === "non_res" || value === "resid";
}

type ComponentBuckets = Record<MatrixComponent, RinEntry[]>;
type MainBuckets = Record<MatrixSegment, ComponentBuckets>;

function emptyComponentBuckets(): ComponentBuckets {
  return { bundled: [], unbundled: [] };
}

/**
 * 3 segments x 2 components. HFP (own component), CCA-owned RINs (component
 * null) and `other` RINs are deliberately left out: the main matrix covers the
 * PG&E delivery split only.
 */
function bucketMainRins(rins: RinEntry[]): MainBuckets {
  const buckets: MainBuckets = {
    ag: emptyComponentBuckets(),
    non_res: emptyComponentBuckets(),
    resid: emptyComponentBuckets(),
  };

  for (const rin of rins) {
    if (!isMatrixComponent(rin.component) || !isMatrixSegment(rin.category)) {
      continue;
    }
    buckets[rin.category][rin.component].push(rin);
  }

  return buckets;
}

function mainRow(
  buckets: MainBuckets,
  segment: MatrixSegment,
): { bundled: MatrixCell; unbundled: MatrixCell; all: MatrixCell } {
  const bundled = cellFromRins(buckets[segment].bundled);
  const unbundled = cellFromRins(buckets[segment].unbundled);
  return { bundled, unbundled, all: mergeCells([bundled, unbundled]) };
}

/** Build the 3x2 segment/component matrix plus its totals. */
export function buildMainMatrix(rins: RinEntry[]): MainMatrix {
  const buckets = bucketMainRins(rins);

  const rows: MainMatrix["rows"] = {
    ag: mainRow(buckets, "ag"),
    non_res: mainRow(buckets, "non_res"),
    resid: mainRow(buckets, "resid"),
  };

  const colTotals: MainMatrix["colTotals"] = {
    bundled: mergeCells(SEGMENT_KEYS.map((segment) => rows[segment].bundled)),
    unbundled: mergeCells(SEGMENT_KEYS.map((segment) => rows[segment].unbundled)),
    all: mergeCells(SEGMENT_KEYS.map((segment) => rows[segment].all)),
  };

  const grandTotal = mergeCells(
    COMPONENT_KEYS.map((component) => colTotals[component]),
  );

  // Dev-time bug detector: the same RINs counted two ways must agree.
  const componentSum = colTotals.bundled.total + colTotals.unbundled.total;
  const segmentSum = SEGMENT_KEYS.reduce(
    (sum, segment) => sum + rows[segment].all.total,
    0,
  );
  assertEqual(
    "main matrix: grandTotal vs bundled + unbundled",
    grandTotal.total,
    componentSum,
  );
  assertEqual(
    "main matrix: grandTotal vs segment rows",
    grandTotal.total,
    segmentSum,
  );

  return { rows, colTotals, grandTotal };
}

type VintageBuckets = Record<NbtVintage, RinEntry[]>;
type NbtBuckets = Record<NbtRowKey, VintageBuckets>;

function emptyVintageBuckets(): VintageBuckets {
  return {
    "2023": [],
    "2024": [],
    "2025": [],
    "2026": [],
    "2027": [],
    floating: [],
  };
}

/**
 * 6 rows x fixed vintage columns. Only NBT RINs (a `NBT-YYYY` enrollment code)
 * inside the main matrix's segment/component universe are kept.
 */
function bucketNbtRins(rins: RinEntry[]): NbtBuckets {
  const buckets: NbtBuckets = {
    "bundled-ag": emptyVintageBuckets(),
    "bundled-non_res": emptyVintageBuckets(),
    "bundled-resid": emptyVintageBuckets(),
    "unbundled-ag": emptyVintageBuckets(),
    "unbundled-non_res": emptyVintageBuckets(),
    "unbundled-resid": emptyVintageBuckets(),
  };

  for (const rin of rins) {
    if (!isMatrixComponent(rin.component) || !isMatrixSegment(rin.category)) {
      continue;
    }
    const vintage = getVintage(rin.enrollment_codes);
    if (vintage === null) {
      continue;
    }
    const key: NbtRowKey = `${rin.component}-${rin.category}`;
    buckets[key][vintage].push(rin);
  }

  return buckets;
}

function nbtRow(buckets: NbtBuckets, key: NbtRowKey): NbtRow {
  const bucketsForRow = buckets[key];
  const cells = {
    "2023": cellFromRins(bucketsForRow["2023"]),
    "2024": cellFromRins(bucketsForRow["2024"]),
    "2025": cellFromRins(bucketsForRow["2025"]),
    "2026": cellFromRins(bucketsForRow["2026"]),
    "2027": cellFromRins(bucketsForRow["2027"]),
    floating: cellFromRins(bucketsForRow.floating),
  };
  return {
    ...cells,
    all: mergeCells(NBT_VINTAGES.map((vintage) => cells[vintage])),
  };
}

/** Build the 6x6 NBT vintage matrix plus its totals. */
export function buildNbtMatrix(rins: RinEntry[]): NbtMatrix {
  const buckets = bucketNbtRins(rins);

  const rows: NbtMatrix["rows"] = {
    "bundled-ag": nbtRow(buckets, "bundled-ag"),
    "bundled-non_res": nbtRow(buckets, "bundled-non_res"),
    "bundled-resid": nbtRow(buckets, "bundled-resid"),
    "unbundled-ag": nbtRow(buckets, "unbundled-ag"),
    "unbundled-non_res": nbtRow(buckets, "unbundled-non_res"),
    "unbundled-resid": nbtRow(buckets, "unbundled-resid"),
  };

  const colTotals: NbtMatrix["colTotals"] = {
    "2023": mergeCells(NBT_ROW_KEYS.map((key) => rows[key]["2023"])),
    "2024": mergeCells(NBT_ROW_KEYS.map((key) => rows[key]["2024"])),
    "2025": mergeCells(NBT_ROW_KEYS.map((key) => rows[key]["2025"])),
    "2026": mergeCells(NBT_ROW_KEYS.map((key) => rows[key]["2026"])),
    "2027": mergeCells(NBT_ROW_KEYS.map((key) => rows[key]["2027"])),
    floating: mergeCells(NBT_ROW_KEYS.map((key) => rows[key].floating)),
    all: mergeCells(NBT_ROW_KEYS.map((key) => rows[key].all)),
  };

  const grandTotal = mergeCells(
    NBT_VINTAGES.map((vintage) => colTotals[vintage]),
  );

  // Dev-time bug detector: every cell, every column and every row must agree.
  const everyCell = NBT_ROW_KEYS.reduce(
    (sum, key) =>
      sum +
      NBT_VINTAGES.reduce(
        (rowSum, vintage) => rowSum + rows[key][vintage].total,
        0,
      ),
    0,
  );
  const allColumnSum = NBT_VINTAGES.reduce(
    (sum, vintage) => sum + colTotals[vintage].total,
    0,
  );
  const allRowSum = NBT_ROW_KEYS.reduce(
    (sum, key) => sum + rows[key].all.total,
    0,
  );
  assertEqual(
    "nbt matrix: grandTotal vs every cell",
    grandTotal.total,
    everyCell,
  );
  assertEqual(
    "nbt matrix: grandTotal vs vintage columns",
    grandTotal.total,
    allColumnSum,
  );
  assertEqual(
    "nbt matrix: grandTotal vs row totals",
    grandTotal.total,
    allRowSum,
  );

  return { rows, colTotals, grandTotal };
}

/** HFP is a single summary strip: every `component === "hfp"` RIN. */
export function buildHfpStrip(rins: RinEntry[]): HfpStrip {
  const cell = cellFromRins(rins.filter((rin) => rin.component === "hfp"));
  return {
    total: cell.total,
    missing: cell.missing,
    healthy: cell.healthy,
    notInMidas: cell.notInMidas,
    never: cell.never,
    rag: cell.rag,
  };
}

// ---------------------------------------------------------------------------
// Dev fixture
// ---------------------------------------------------------------------------
//
// `__devFixture()` is a hand-checkable smoke test for the builders above: it
// runs three synthetic payloads through them, and the expectation blocks below
// spell out the exact MatrixCell each bucket must produce. Nothing calls it at
// runtime; a dev page or a console snippet can import it and `console.table`
// the result.
//
// The amber/red cells deliberately hold 20 RINs so the boundaries can be hit
// exactly: 1/20 = 5% (amber), 5/20 = 25% (red) and 1/10 = 10% (red).

const RIN_PREFIX: Record<MatrixComponent, string> = {
  bundled: "PGPG",
  unbundled: "PGXX",
};

type FixtureRinInput = {
  rin: string;
  category: RinEntry["category"];
  component: Component | null;
  healthy: boolean;
  /** Overrides the status derived from `healthy`; used for not_in_midas RINs. */
  statusKind?: StatusKind;
  lastSuccessDate: string | null;
  enrollmentCodes?: string[];
};

function fixtureRin(input: FixtureRinInput): RinEntry {
  const statusKind: StatusKind =
    input.statusKind ?? (input.healthy ? "healthy" : "missing");
  return {
    rin: input.rin,
    rate_name: null,
    tariff: null,
    enrollment_codes: input.enrollmentCodes ?? [],
    category: input.category,
    component: input.component,
    has_value_today: statusKind === "healthy" ? 1 : 0,
    status_kind: statusKind,
    last_success_date: input.lastSuccessDate,
    last_success: null,
  };
}

type FixtureCellInput = {
  tag: string;
  category: MatrixSegment;
  component: MatrixComponent;
  healthy: number;
  missing?: number;
  missingNever?: number;
};

/** `healthy` priced RINs + `missing` unpriced ones, `missingNever` of them never. */
function fixtureCell(input: FixtureCellInput): RinEntry[] {
  const missing = input.missing ?? 0;
  const missingNever = input.missingNever ?? 0;
  const count = input.healthy + missing;

  return Array.from({ length: count }, (_, index) => {
    const isMissing = index >= input.healthy;
    const isNever = isMissing && index - input.healthy < missingNever;
    const lastSuccessDate = isMissing
      ? isNever
        ? null
        : "2026-09-15"
      : "2026-11-18";
    return fixtureRin({
      rin: `USCA-${RIN_PREFIX[input.component]}-${input.tag}-${String(
        index + 1,
      ).padStart(3, "0")}`,
      category: input.category,
      component: input.component,
      healthy: !isMissing,
      lastSuccessDate,
    });
  });
}

type FixtureStatusCellInput = {
  tag: string;
  category: MatrixSegment;
  component: MatrixComponent;
  healthy?: number;
  missing?: number;
  notInMidas?: number;
};

/** Explicit status counts, including not_in_midas RINs (no status row at all). */
function fixtureStatusCell(input: FixtureStatusCellInput): RinEntry[] {
  const healthy = input.healthy ?? 0;
  const missing = input.missing ?? 0;
  const notInMidas = input.notInMidas ?? 0;
  const statuses: StatusKind[] = [
    ...Array.from({ length: healthy }, (): StatusKind => "healthy"),
    ...Array.from({ length: missing }, (): StatusKind => "missing"),
    ...Array.from({ length: notInMidas }, (): StatusKind => "not_in_midas"),
  ];

  return statuses.map((statusKind, index) =>
    fixtureRin({
      rin: `USCA-${RIN_PREFIX[input.component]}-${input.tag}-${String(
        index + 1,
      ).padStart(3, "0")}`,
      category: input.category,
      component: input.component,
      healthy: statusKind === "healthy",
      statusKind,
      // A not_in_midas RIN has no status row, hence no success date either.
      // A `missing` one is a known RIN that priced before today.
      lastSuccessDate:
        statusKind === "not_in_midas" ? null : "2026-11-18",
    }),
  );
}

function fixtureNbtRin(
  component: MatrixComponent,
  category: MatrixSegment,
  tag: string,
  code: string,
  healthy: boolean,
  lastSuccessDate: string | null,
): RinEntry {
  return fixtureRin({
    rin: `USCA-${RIN_PREFIX[component]}-${tag}-${code}`,
    category,
    component,
    healthy,
    lastSuccessDate,
    // "NBT" plus the vintage code is the shape the importer writes.
    enrollmentCodes: ["NBT", code],
  });
}

/*
 * Hand-computed expectations for `main` (m = missing, h = healthy, t = total,
 * n = never):
 *
 *                     bundled            unbundled           all
 *   ag             m1 h19 t20 n1 amber  m1 h9  t10 n0 red  m2 h28 t30 n1 amber
 *   non_res        m5 h15 t20 n2 red    m0 h0  t0  n0 empty m5 h15 t20 n2 red
 *   resid          m0 h5  t5  n0 green  m0 h4  t4  n0 green m0 h9  t9  n0 green
 *   colTotals      m6 h39 t45 n3 red    m1 h13 t14 n0 amber m7 h52 t59 n3 red
 *   grandTotal     m7 h52 t59 n3 red
 *
 * Reconciliation: 45 + 14 = 59 (components), 30 + 20 + 9 = 59 (rows).
 */
function fixtureMainRins(): RinEntry[] {
  return [
    // bundled/ag: 19 priced + 1 missing and never priced.
    ...fixtureCell({
      tag: "BAG",
      category: "ag",
      component: "bundled",
      healthy: 19,
      missing: 1,
      missingNever: 1,
    }),
    // bundled/non_res: 15 priced + 5 missing, 2 of them never priced.
    ...fixtureCell({
      tag: "BNR",
      category: "non_res",
      component: "bundled",
      healthy: 15,
      missing: 5,
      missingNever: 2,
    }),
    // bundled/resid: 5 priced -> green.
    ...fixtureCell({
      tag: "BRS",
      category: "resid",
      component: "bundled",
      healthy: 5,
    }),
    // unbundled/ag: 9 priced + 1 missing that was priced before -> exactly 10%.
    ...fixtureCell({
      tag: "UAG",
      category: "ag",
      component: "unbundled",
      healthy: 9,
      missing: 1,
    }),
    // unbundled/non_res: no RINs at all -> empty cell.
    // unbundled/resid: 4 priced -> green.
    ...fixtureCell({
      tag: "URS",
      category: "resid",
      component: "unbundled",
      healthy: 4,
    }),
  ];
}

/*
 * Hand-computed expectations for `nbt` (empty vintages 2024, 2025, 2027 and the
 * empty rows bundled-non_res, bundled-resid, unbundled-ag, unbundled-resid all
 * stay `m0 h0 t0 n0 empty`):
 *
 *   bundled-ag       2023 m0 h1 t1 n0 green | 2026 m1 h0 t1 n1 red
 *                    floating m0 h1 t1 n0 green | all m1 h2 t3 n1 red
 *   unbundled-non_res 2026 m0 h1 t1 n0 green | floating m1 h0 t1 n0 red
 *                    all m1 h1 t2 n0 red
 *   colTotals        2023 m0 h1 t1 n0 green | 2026 m1 h1 t2 n1 red
 *                    floating m1 h1 t2 n0 red | all m2 h3 t5 n1 red
 *   grandTotal       m2 h3 t5 n1 red
 */
function fixtureNbtRins(): RinEntry[] {
  return [
    // bundled/ag: 2023 priced, 2026 missing and never priced, 0000 floating.
    fixtureNbtRin("bundled", "ag", "BAG", "NBT-2023", true, "2026-11-18"),
    fixtureNbtRin("bundled", "ag", "BAG", "NBT-2026", false, null),
    fixtureNbtRin("bundled", "ag", "BAG", "NBT-0000", true, "2026-11-18"),
    // unbundled/non_res: 2026 priced, 9999 floating and missing but priced before.
    fixtureNbtRin(
      "unbundled",
      "non_res",
      "UNR",
      "NBT-2026",
      true,
      "2026-11-18",
    ),
    fixtureNbtRin(
      "unbundled",
      "non_res",
      "UNR",
      "NBT-9999",
      false,
      "2026-04-02",
    ),
    // Not NBT (no NBT-YYYY code): buildNbtMatrix must ignore it.
    fixtureRin({
      rin: "USCA-PGPG-BNB-NBT-2026", // rin text is irrelevant, codes are what count
      category: "ag",
      component: "bundled",
      healthy: true,
      lastSuccessDate: "2026-11-18",
    }),
  ];
}

/*
 * Hand-computed expectations for `hfp`: total 4, missing 1, healthy 3, never 1,
 * rag red (1/4 = 25%). The bundled RIN in the array is filtered out.
 */
function fixtureHfpRins(): RinEntry[] {
  return [
    // Three priced HFP RINs and one missing that was never priced.
    fixtureRin({
      rin: "USCA-PGPG-3801",
      category: "other",
      component: "hfp",
      healthy: true,
      lastSuccessDate: "2026-11-18",
    }),
    fixtureRin({
      rin: "USCA-PGPG-3802",
      category: "other",
      component: "hfp",
      healthy: true,
      lastSuccessDate: "2026-11-18",
    }),
    fixtureRin({
      rin: "USCA-PGXX-3803",
      category: "other",
      component: "hfp",
      healthy: true,
      lastSuccessDate: "2026-11-18",
    }),
    fixtureRin({
      rin: "USCA-PGXX-3804",
      category: "other",
      component: "hfp",
      healthy: false,
      lastSuccessDate: null,
    }),
    // Not HFP: buildHfpStrip must ignore it.
    fixtureRin({
      rin: "USCA-PGPG-9901",
      category: "ag",
      component: "bundled",
      healthy: false,
      lastSuccessDate: null,
    }),
  ];
}

/*
 * Two standalone cells pinning the not_in_midas rules (m = missing, h = healthy,
 * nym = not_in_midas, t = total):
 *
 *   all-notInMidas  m0 h0 nym5 t5 n0 green  (nothing actionable -> green)
 *   mixed           m2 h3 nym4 t9 n2 red    (2/5 = 40% of actionable -> red)
 *
 * The mixed cell's `never` is 0: both missing RINs returned a price before. Its
 * total is 9 because not-in-MIDAS RINs still occupy a row in the matrix, but
 * only 5 of them can fail, which is the denominator RAG uses.
 */
function fixtureAllNotInMidasRins(): RinEntry[] {
  return fixtureStatusCell({
    tag: "NIM",
    category: "ag",
    component: "bundled",
    notInMidas: 5,
  });
}

function fixtureMixedStatusRins(): RinEntry[] {
  return fixtureStatusCell({
    tag: "MIX",
    category: "non_res",
    component: "bundled",
    healthy: 3,
    missing: 2,
    notInMidas: 4,
  });
}

/*
 * Legacy payload: no `status_kind` column at all, only `has_value_today`. Pins
 * the fallback in `statusKindOf` -- the priced RIN must read as healthy, the
 * unpriced one as missing (1 missing of 2 actionable = 50% -> red).
 */
function fixtureLegacyStatusRins(): RinEntry[] {
  const base = {
    rate_name: null,
    tariff: null,
    enrollment_codes: [],
    category: "ag" as const,
    component: "bundled" as const,
    last_success_date: null,
    last_success: null,
  };
  return [
    { ...base, rin: "USCA-PGPG-LEGACY-001", has_value_today: 1 },
    { ...base, rin: "USCA-PGPG-LEGACY-002", has_value_today: 0 },
  ];
}

/**
 * Smoke-test fixture: runs the builders over the three synthetic payloads below.
 * Each payload documents the cells it must produce, so a dev can eyeball the
 * output of `console.table(__devFixture().main.rows)` without a live API.
 *
 * The two not_in_midas cells are asserted here because they are not part of a
 * matrix: they pin `cellFromRins`'s actionable-denominator rule directly.
 */
export function __devFixture(): {
  main: MainMatrix;
  nbt: NbtMatrix;
  hfp: HfpStrip;
  allNotInMidas: MatrixCell;
  mixed: MatrixCell;
  legacy: MatrixCell;
} {
  const allNotInMidas = cellFromRins(fixtureAllNotInMidasRins());
  assertCell(
    "fixture all-notInMidas",
    { missing: 0, healthy: 0, notInMidas: 5, total: 5, never: 0, rag: "green" },
    allNotInMidas,
  );

  const mixed = cellFromRins(fixtureMixedStatusRins());
  assertCell(
    "fixture mixed",
    { missing: 2, healthy: 3, notInMidas: 4, total: 9, never: 0, rag: "red" },
    mixed,
  );

  // No status_kind: has_value_today=1 must classify as healthy, not missing.
  const legacy = cellFromRins(fixtureLegacyStatusRins());
  assertCell(
    "fixture legacy payload (no status_kind)",
    { missing: 1, healthy: 1, notInMidas: 0, total: 2, never: 1, rag: "red" },
    legacy,
  );

  return {
    main: buildMainMatrix(fixtureMainRins()),
    nbt: buildNbtMatrix(fixtureNbtRins()),
    hfp: buildHfpStrip(fixtureHfpRins()),
    allNotInMidas,
    mixed,
    legacy,
  };
}

