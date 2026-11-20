// "What do the failing RINs have in common" chips for a drill.
//
// `computePatterns` does all the counting and grouping (one group per PG&E
// component); this file only decides how a chip looks — default, active, or the
// collapsed 'other' tail — and reports clicks upward. The parent owns the filter
// state: clicking a chip never mutates anything here.

import { computePatterns } from "@/lib/attribute-groups";
import type { PatternChip, PatternGroup } from "@/lib/attribute-groups";
import type { RinEntry } from "@/lib/types";

export interface PatternStripProps {
  /** The drill's failing RINs (already filtered by its own segment/component). */
  affectedRins: RinEntry[];
  /** The same drill without the failure filter: what "normal" looks like. */
  baselineRins: RinEntry[];
  onAttributeClick?: (attribute: string) => void;
  /** Attributes currently applied as filters; their chips invert. */
  activeAttributes?: Set<string>;
}

const CHIP_BASE =
  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] transition";
const CHIP_DEFAULT = "border-gray-200 bg-white text-gray-700 hover:border-gray-300";
const CHIP_ACTIVE = "border-gray-900 bg-gray-900 text-white";
const CHIP_TAIL =
  "border-dashed border-gray-300 bg-white text-gray-500 hover:border-gray-400";
const GROUP_LABEL =
  "font-semibold text-[11px] uppercase tracking-wide text-gray-500";

export function PatternStrip({
  affectedRins,
  baselineRins,
  onAttributeClick,
  activeAttributes,
}: PatternStripProps) {
  const groups = computePatterns(affectedRins, baselineRins);

  // No patterns means no strip at all: an empty frame is noise in a drill.
  if (groups.length === 0) return null;

  // A single-component drill needs no section label; a mixed one does.
  const showGroupLabels = groups.length > 1;

  return (
    <div className="space-y-2">
      {groups.map((group) => (
        <PatternGroupBlock
          key={group.component}
          group={group}
          showLabel={showGroupLabels}
          activeAttributes={activeAttributes}
          onAttributeClick={onAttributeClick}
        />
      ))}
    </div>
  );
}

function PatternGroupBlock({
  group,
  showLabel,
  activeAttributes,
  onAttributeClick,
}: {
  group: PatternGroup;
  showLabel: boolean;
  activeAttributes?: Set<string>;
  onAttributeClick?: (attribute: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      {showLabel && group.label ? (
        <div className={GROUP_LABEL}>{group.label}</div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {group.patterns.map((chip) => (
          <PatternChipButton
            key={chip.attribute}
            chip={chip}
            active={activeAttributes?.has(chip.attribute) ?? false}
            onClick={onAttributeClick}
          />
        ))}
      </div>
    </div>
  );
}

function PatternChipButton({
  chip,
  active,
  onClick,
}: {
  chip: PatternChip;
  active: boolean;
  onClick?: (attribute: string) => void;
}) {
  const isTail = chip.tailNames !== undefined;
  // Active wins over the tail styling: the applied filter must stand out.
  const className = [
    CHIP_BASE,
    active ? CHIP_ACTIVE : isTail ? CHIP_TAIL : CHIP_DEFAULT,
  ].join(" ");

  const title = chip.tailNames?.length
    ? `Collapsed codes: ${chip.tailNames.join(", ")}`
    : undefined;

  return (
    <button
      type="button"
      aria-pressed={active}
      title={title}
      onClick={() => onClick?.(chip.attribute)}
      className={className}
    >
      <span className="font-medium">{chip.attribute}</span>
      <span className="text-gray-400">
        {chip.affectedCount}
        {chip.affectedPct > 0 && ` · ${Math.round(chip.affectedPct * 100)}%`}
      </span>
      {chip.overrepresented && (
        <span className="text-amber-600 font-bold">↑</span>
      )}
    </button>
  );
}
