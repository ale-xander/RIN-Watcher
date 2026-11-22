import { COMPONENT_LABELS, COMPONENT_OPTIONS } from "@/lib/constants";
import type { Component } from "@/lib/types";
import type { ReactNode } from "react";

export function ComponentToggle({
  component,
  onChange,
  action,
}: {
  component: Component;
  onChange: (component: Component) => void;
  /** Optional control rendered immediately right of the toggle. */
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <div
        role="group"
        aria-label="PG&E component"
        className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5 shadow-sm"
      >
        {COMPONENT_OPTIONS.map((option) => {
          const isActive = option === component;
          return (
            <button
              key={option}
              type="button"
              onClick={() => onChange(option)}
              aria-pressed={isActive}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                isActive
                  ? "bg-gray-900 text-white shadow-sm"
                  : "text-gray-600 hover:text-gray-900"
              }`}
            >
              {COMPONENT_LABELS[option]}
            </button>
          );
        })}
      </div>
      {action}
    </div>
  );
}
