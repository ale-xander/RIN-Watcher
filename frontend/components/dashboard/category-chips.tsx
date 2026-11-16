import type { CategoryChip, CategoryFilter } from "@/lib/types";

import { FilterChip } from "./filter-chip";

export function CategoryChips({
  chips,
  active,
  onChange,
}: {
  chips: CategoryChip[];
  active: CategoryFilter;
  onChange: (category: CategoryFilter) => void;
}) {
  return (
    <div className="mb-6">
      <div
        role="group"
        aria-label="Filter by category"
        className="flex flex-wrap items-center gap-2"
      >
        {chips.map((chip) => (
          <FilterChip
            key={chip.id}
            label={chip.label}
            count={chip.count}
            active={chip.id === active}
            onClick={() => onChange(chip.id)}
          />
        ))}
      </div>
    </div>
  );
}
