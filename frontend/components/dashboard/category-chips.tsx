// Two chip groups, not one: the segment chips partition the RINs (All = AG +
// Non-Res + Residential + Other), while a program chip like NBT cuts across
// those segments. Rendering them in a single row makes NBT read as a fourth
// segment whose count does not add up, so the program group gets its own
// divider and label.

import type { CategoryChip, CategoryFilter } from "@/lib/types";

import { FilterChip } from "./filter-chip";

export function CategoryChips({
  segments,
  programs = [],
  active,
  onChange,
}: {
  segments: CategoryChip[];
  programs?: CategoryChip[];
  active: CategoryFilter;
  onChange: (category: CategoryFilter) => void;
}) {
  function renderChip(chip: CategoryChip) {
    return (
      <FilterChip
        key={chip.id}
        label={chip.label}
        count={chip.count}
        active={chip.id === active}
        onClick={() => onChange(chip.id)}
      />
    );
  }

  return (
    <div className="mb-6 flex flex-wrap items-center gap-2">
      <div
        role="group"
        aria-label="Filter by segment"
        className="flex flex-wrap items-center gap-2"
      >
        {segments.map(renderChip)}
      </div>

      {programs.length > 0 ? (
        <div
          role="group"
          aria-label="Filter by program"
          className="flex flex-wrap items-center gap-2"
        >
          <span
            aria-hidden="true"
            className="mx-1 h-4 w-px self-center bg-gray-300"
          />
          <span className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
            Programs
          </span>
          {programs.map(renderChip)}
        </div>
      ) : null}
    </div>
  );
}
