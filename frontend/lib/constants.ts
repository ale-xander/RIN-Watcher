import type {
  Category,
  Component,
  RinEntry,
  Segment,
  Sort,
} from "@/lib/types";

export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000"
).replace(/\/+$/, "");

export const PROVIDERS_URL = `${API_BASE_URL}/api/providers`;
export const DASHBOARD_URL = `${API_BASE_URL}/api/dashboard`;

export const DEFAULT_PROVIDER_ID = "pge";
export const DEFAULT_COMPONENT: Component = "bundled";
export const DEFAULT_SORT: Sort = { column: "rin", direction: "asc" };

/** PG&E component tabs, in the order the toggle renders them. */
export const COMPONENT_OPTIONS: Component[] = ["bundled", "unbundled", "hfp"];
export const COMPONENT_LABELS: Record<Component, string> = {
  bundled: "Bundled",
  unbundled: "Unbundled",
  hfp: "HFP",
};

/** Table segments, in group order. NBT is a program, never a segment. */
export const SEGMENT_ORDER: Segment[] = ["ag", "non_res", "resid", "other"];
/** Chip order: the segments, with the NBT program chip before Other. */
export const CATEGORY_ORDER: Category[] = ["ag", "non_res", "resid", "nbt", "other"];

export const CATEGORY_LABELS: Record<Category, { chip: string; group: string }> = {
  ag: { chip: "AG", group: "AG" },
  non_res: { chip: "Non-Res", group: "Non-Residential" },
  resid: { chip: "Residential", group: "Residential" },
  nbt: { chip: "NBT", group: "NBT" },
  other: { chip: "Other", group: "Other" },
};

export const EMPTY_RINS: RinEntry[] = [];
