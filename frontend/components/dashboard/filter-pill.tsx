// Drill breadcrumb + filter controls: "Bundled × Non-Res × Missing" pill, the
// back affordance, the not-yet-live toggle and a "clear all" escape hatch.
//
// Stateless on purpose: segments arrive already formatted and every control
// calls back into the parent, which owns the drill's filter state.

export interface FilterPillProps {
  /** Breadcrumb labels in drill order, e.g. ["Bundled", "Non-Res", "NBT"]. */
  segments: string[];
  /** Renders the back button; omit when there is nowhere to go back to. */
  onBack?: () => void;
  onClear: () => void;
  showNotYetLive: boolean;
  onToggleNotYetLive: (v: boolean) => void;
}

export function FilterPill({
  segments,
  onBack,
  onClear,
  showNotYetLive,
  onToggleNotYetLive,
}: FilterPillProps) {
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

      <label className="flex items-center gap-1.5 text-[11px] text-gray-500">
        <input
          type="checkbox"
          checked={showNotYetLive}
          onChange={(event) => onToggleNotYetLive(event.target.checked)}
          className="h-3.5 w-3.5 accent-gray-900"
        />
        show not-yet-live
      </label>

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
