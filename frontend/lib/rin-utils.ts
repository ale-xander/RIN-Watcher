import type { RinEntry, Sort, SortColumn } from "@/lib/types";

/** NBT (Net Billing Tariff) is a program, detected from the enrollment codes. */
export function isNbt(entry: RinEntry): boolean {
  return entry.enrollment_codes.some((code) => code.startsWith("NBT-"));
}

function sortValue(entry: RinEntry, column: SortColumn): string {
  switch (column) {
    case "rin":
      return entry.rin;
    case "tariff":
      return entry.tariff ?? "";
    case "enrollment":
      return entry.enrollment_codes.join(", ");
    case "last_success":
      return entry.last_success_date ?? "";
  }
}

/**
 * Locale-aware sort for the visible rows. Empty values (no tariff / never
 * published) always sink to the bottom, regardless of the direction, so the
 * actionable rows stay at the top.
 */
export function sortEntries(entries: RinEntry[], sort: Sort): RinEntry[] {
  const factor = sort.direction === "asc" ? 1 : -1;

  return [...entries].sort((a, b) => {
    const left = sortValue(a, sort.column);
    const right = sortValue(b, sort.column);
    if (!left && !right) {
      return a.rin.localeCompare(b.rin) * factor;
    }
    if (!left) {
      return 1;
    }
    if (!right) {
      return -1;
    }
    return (
      left.localeCompare(right, undefined, {
        numeric: true,
        sensitivity: "base",
      }) * factor
    );
  });
}

/** RIN \t Tariff \t Enrollment Codes \t Last Success, one row per line. */
export function rowsToTsv(rows: RinEntry[]): string {
  return rows
    .map((entry) => {
      const codes = entry.enrollment_codes.join(", ");
      const lastSuccess =
        entry.last_success ?? entry.last_success_date ?? "";
      return `${entry.rin}\t${entry.tariff ?? ""}\t${codes}\t${lastSuccess}`;
    })
    .join("\n");
}
