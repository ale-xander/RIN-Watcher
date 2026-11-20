// Shared cell renderer for the two dashboard matrices (HealthMatrix, NbtMatrix).
//
// Purely presentational: every number arrives pre-computed on a `MatrixCell`,
// so this file only maps (rag, missing/total, never) onto the v3 mockup style.
// The big number is the cell's *missing* count — the action the matrix is about
// — and the bar fills with that same missing share.

import type { KeyboardEvent } from "react";

import type { MatrixCell, RagLevel } from "@/lib/health-matrix";

/** Big-number text colour per RAG level; `empty` is handled separately. */
const VALUE_CLASS: Record<Exclude<RagLevel, "empty">, string> = {
  green: "text-green-600",
  amber: "text-amber-600",
  red: "text-red-600",
};

/** Bar fill per RAG level; the solid hex keeps the mockup's exact palette. */
const BAR_FILL: Record<Exclude<RagLevel, "empty">, string> = {
  green: "#22c55e",
  amber: "#f59e0b",
  red: "#dc2626",
};

/** Minimum visible bar so a single missing RIN is not a sub-pixel sliver. */
const MIN_BAR_WIDTH_PX = 3;

export function MatrixCellView({
  cell,
  isSelected = false,
  onClick,
}: {
  cell: MatrixCell;
  isSelected?: boolean;
  onClick?: () => void;
}) {
  // A cell with no RINs carries no data, so it is never a click target even
  // when the parent passes a handler.
  const clickable = onClick !== undefined && cell.total > 0;

  const className = [
    "flex min-w-[100px] flex-col items-start gap-1 rounded-md px-1.5 py-1 text-left transition-colors",
    isSelected ? "ring-2 ring-gray-900" : "",
    clickable ? "cursor-pointer hover:bg-gray-50" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const content =
    cell.total === 0 ? renderEmpty() : renderValue(cell);

  if (!clickable) {
    return <div className={className}>{content}</div>;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    onClick?.();
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      className={className}
    >
      {content}
    </div>
  );
}

function renderEmpty() {
  return <span className="text-sm font-semibold text-gray-300">—</span>;
}

function renderValue(cell: MatrixCell) {
  const level = cell.rag === "empty" ? "green" : cell.rag;
  const missingShare = (cell.missing / cell.total) * 100;

  return (
    <>
      <span className={`text-sm font-semibold tabular-nums ${VALUE_CLASS[level]}`}>
        {cell.missing}
        {level === "green" ? (
          <span aria-hidden="true"> ✓</span>
        ) : null}
      </span>

      <div
        className={`h-1.5 w-full rounded-full ${
          level === "green" ? "bg-green-100" : "bg-gray-100"
        }`}
      >
        {level === "green" ? null : (
          <div
            className="h-1.5 rounded-full"
            style={{
              width: `${missingShare}%`,
              minWidth: cell.missing > 0 ? MIN_BAR_WIDTH_PX : 0,
              backgroundColor: BAR_FILL[level],
            }}
          />
        )}
      </div>

      {cell.never > 0 ? (
        <span className="text-[10px] text-gray-500">
          {cell.never} never priced
        </span>
      ) : null}
    </>
  );
}
