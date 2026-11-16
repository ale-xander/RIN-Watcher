/** PG&E component tab the dashboard can request. */
export type Component = "bundled" | "unbundled" | "hfp";

export type ViewMode = "failed" | "successful";

/** The tariff segment a RIN belongs to. */
export type Segment = "ag" | "non_res" | "resid" | "other";

/** The four segments plus ``nbt``, which is a program and not a segment. */
export type Category = Segment | "nbt";

export type CategoryFilter = "all" | Category;

export type SortColumn = "rin" | "tariff" | "enrollment" | "last_success";

export type SortDirection = "asc" | "desc";

export type Sort = { column: SortColumn; direction: SortDirection };

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
  has_value_today: 0 | 1;
  last_success_date: string | null;
  last_success: string | null;
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

export type RinGroup = { category: Segment; label: string; rows: RinEntry[] };

export type CategoryChip = { id: CategoryFilter; label: string; count: number };
