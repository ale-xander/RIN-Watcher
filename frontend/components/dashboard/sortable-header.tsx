import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

import type { Sort, SortColumn } from "@/lib/types";

export function SortableHeader({
  label,
  column,
  sort,
  onSort,
  align = "left",
}: {
  label: string;
  column: SortColumn;
  sort: Sort;
  onSort: (column: SortColumn) => void;
  align?: "left" | "right";
}) {
  const isActive = sort.column === column;
  const isDescending = sort.direction === "desc";

  return (
    <th
      scope="col"
      aria-sort={
        isActive ? (isDescending ? "descending" : "ascending") : "none"
      }
      className={`px-3 py-3 ${align === "right" ? "text-right" : ""}`}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-1.5 uppercase tracking-wide transition-colors ${
          align === "right" ? "flex-row-reverse" : ""
        } ${isActive ? "text-gray-900" : "text-gray-500 hover:text-gray-700"}`}
      >
        {label}
        {isActive ? (
          isDescending ? (
            <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
          )
        ) : (
          <ChevronsUpDown
            className="h-3.5 w-3.5 text-gray-300"
            aria-hidden="true"
          />
        )}
      </button>
    </th>
  );
}
