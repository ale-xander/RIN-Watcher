// Drill breadcrumb + filter controls: "Bundled × Non-Res × Missing" pill, the
// back affordance and a "clear all" escape hatch.
//
// Stateless on purpose: segments arrive already formatted and every control
// calls back into the parent, which owns the drill's filter state. The status
// segment ("Missing" / "Healthy" / "Pending Launch") is part of the breadcrumb:
// it mirrors the affected-RINs table's active status tab, so there is no status
// switch here.

export interface FilterPillProps {
  /** Breadcrumb labels in drill order, e.g. ["Bundled", "Non-Res", "NBT"]. */
  segments: string[];
  /** Renders the back button; omit when there is nowhere to go back to. */
  onBack?: () => void;
  onClear: () => void;
}

export function FilterPill({ segments, onBack, onClear }: FilterPillProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          title="Back to the parent drill"
          aria-label="Back"
          className="rounded-md border border-gray-200 bg-white px-2 py-1 text-[12px] text-gray-600 transition hover:bg-gray-50"
        >
          ↶
        </button>
      ) : null}

      <div className="inline-flex items-center gap-2 rounded-md bg-gray-100 px-2.5 py-1 text-[12px] font-medium">
        <span className="text-gray-700">{segments.join(" × ")}</span>
        <button
          type="button"
          onClick={onClear}
          title="Remove every filter in this drill"
          aria-label="Clear filter"
          className="text-gray-400 transition hover:text-gray-700"
        >
          ✕
        </button>
      </div>

      <button
        type="button"
        onClick={onClear}
        className="ml-auto text-[11px] text-gray-400 transition hover:text-gray-700"
      >
        clear all
      </button>
    </div>
  );
}
