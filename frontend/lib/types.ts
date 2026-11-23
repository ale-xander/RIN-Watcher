/** PG&E component tab the dashboard can request. */
export type Component = "bundled" | "unbundled" | "hfp";

/**
 * What the dashboard asks the API for: one component, or the provider-wide
 * snapshot (`all`). The matrices need every component at once, so that is what
 * the dashboard requests.
 */
export type ComponentQuery = Component | "all";

/** The tariff segment a RIN belongs to. */
export type Segment = "ag" | "non_res" | "resid" | "other";

/** The four segments plus ``nbt``, which is a program and not a segment. */
export type Category = Segment | "nbt";

export type CategoryFilter = "all" | Category;

export type Provider = {
  id: string;
  label: string;
  components: string[];
};

export type RinEntry = {
  rin: string;
  rate_name: string | null;
  tariff: string | null;
  enrollment_codes: string[];
  category: Segment;
  /**
   * PG&E component this RIN belongs to. `null` for CCA-owned RINs (MCE, SJCE,
   * PCE): `unbundled` is a PG&E delivery-half concept (PGXX), not a CCA's
   * generation half, so the two must not be conflated.
   */
  component: Component | null;
  has_value_today: 0 | 1;
  /**
   * Absent on payloads that predate `status_kind`; readers fall back to
   * `has_value_today` (see `statusKindOf` in health-matrix.ts).
   */
  status_kind?: "healthy" | "missing" | "not_in_midas";
  last_success_date: string | null;
  last_success: string | null;
  /**
   * ISO-8601 UTC timestamp of this RIN's last status check. The refresh poll
   * compares it lexicographically to tell when a fetch has landed; `null` (or
   * absent, on older payloads) means the RIN has never been checked.
   */
  fetched_at?: string | null;
};

export type Dashboard = {
  provider: string;
  component: string | null;
  last_checked: string | null;
  total: number;
  has_value_count: number;
  no_value_count: number;
  failed_rins: RinEntry[];
  successful_rins: RinEntry[];
};

export type ProvidersState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; providers: Provider[] };

export type DashboardState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: Dashboard };

export type CategoryChip = { id: CategoryFilter; label: string; count: number };

/**
 * Ops CSV import payloads (`POST /api/ops/preview` and `POST /api/ops/commit`).
 *
 * The backend classifies an add-only CSV three ways: rows it would add, rows
 * whose RIN already exists (conflicts, carrying the stored and CSV snapshots)
 * and rows rejected before the DB check (skipped, one message each). The
 * commit response adds the `counts` tally the success screen reports.
 */
export type OpsAddedRin = {
  rin: string;
  prefix: string;
  provider_code: string;
  /** Derived from the RIN prefix by the importer; never stored. */
  component: Component;
  tariff: string | null;
  enrollment_codes: string[];
  category: Segment;
};

/** The CSV-owned fields of a planned row. */
export type OpsCsvSnapshot = {
  tariff: string | null;
  enrollment_codes: string[];
  category: Segment;
};

/** What the database already holds for a conflicting RIN. */
export type OpsDbSnapshot = OpsCsvSnapshot & {
  is_active: 0 | 1;
  created_at: string | null;
};

export type OpsConflict = {
  rin: string;
  csv: OpsCsvSnapshot;
  db: OpsDbSnapshot;
};

export type OpsPreview = {
  added: OpsAddedRin[];
  conflicts: OpsConflict[];
  /** One human-readable reason per skipped CSV row. */
  skipped: string[];
};

export type OpsCommit = OpsPreview & {
  counts: {
    added: number;
    conflicts: number;
    skipped: number;
  };
};
