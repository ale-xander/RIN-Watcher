// The regression banner: what the newest fetch changed.
//
// GET /api/regressions diffs the two newest `status_history` snapshots. Because
// `fetch_data.process` snapshots *after* it writes status, the newest window is
// the result of the two latest fetches -- a manual Refresh shows its own effect
// immediately instead of the previous run's.
//
// The banner is global (every provider, every component), so it sits above the
// provider tabs. "View" opens the regressed RINs in the affected-RINs table
// below it; it is only offered when something regressed, because that is the
// only list the drill shows. A window with no changes renders nothing: a
// permanent "all good" bar would be noise on every page load.

"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

import { REGRESSIONS_URL } from "@/lib/constants";
import { normalizeRegressions } from "@/lib/normalize";
import type { RegressionReport, RinEntry } from "@/lib/types";

export interface RegressionBannerProps {
  /** Open the affected-RINs table with the RINs that regressed. */
  onViewClick: (regressions: RinEntry[]) => void;
  /**
   * Bumped by the parent when a manual refresh lands, so the banner re-reads
   * the window instead of keeping the payload it fetched on mount.
   */
  refreshKey?: number;
}

export function RegressionBanner({
  onViewClick,
  refreshKey = 0,
}: RegressionBannerProps) {
  const [data, setData] = useState<RegressionReport | null>(null);
  const [isDismissed, setIsDismissed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      try {
        const response = await fetch(REGRESSIONS_URL, {
          signal: controller.signal,
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) {
          return;
        }
        const payload: unknown = await response.json();
        if (controller.signal.aborted) {
          return;
        }
        setData(normalizeRegressions(payload));
        // A new window is new information: bring the banner back even if the
        // previous one had been dismissed.
        setIsDismissed(false);
      } catch {
        // The banner is optional: a failed request (or the abort on unmount)
        // simply leaves it hidden.
      }
    }

    void load();
    return () => controller.abort();
  }, [refreshKey]);

  if (data === null || !data.has_data || isDismissed) {
    return null;
  }

  const regressions = data.regressions;
  const regressionCount = regressions.length;
  const recoveryCount = data.recoveries.length;

  // Nothing changed in the window: there is nothing to report or drill into.
  if (regressionCount === 0 && recoveryCount === 0) {
    return null;
  }

  // Regressions make the banner red; a window with recoveries only is green.
  const hasRegressions = regressionCount > 0;
  const summary = hasRegressions
    ? recoveryCount > 0
      ? `${regressionCount} ${pluralRins(regressionCount)} regressed, ${recoveryCount} recovered`
      : `${regressionCount} ${pluralRins(regressionCount)} regressed`
    : `${recoveryCount} ${pluralRins(recoveryCount)} recovered`;

  return (
    <div
      role="status"
      className={`mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 ${
        hasRegressions
          ? "border-red-200 bg-red-50"
          : "border-green-200 bg-green-50"
      }`}
    >
      <p
        className={`flex items-center gap-2 text-sm font-medium ${
          hasRegressions ? "text-red-800" : "text-green-800"
        }`}
      >
        <span aria-hidden="true">{hasRegressions ? "⚠️" : "✓"}</span>
        {summary}
      </p>

      <div className="flex items-center gap-1">
        {hasRegressions ? (
          <button
            type="button"
            onClick={() => onViewClick(regressions)}
            className="rounded-md px-2 py-1 text-[12px] font-medium text-red-700 transition-colors hover:bg-red-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600"
          >
            View
          </button>
        ) : null}
        <DismissButton onClick={() => setIsDismissed(true)} />
      </div>
    </div>
  );
}

/** "1 RIN" / "14 RINs": the banner reads as a sentence, not as a count. */
function pluralRins(count: number): string {
  return count === 1 ? "RIN" : "RINs";
}

/** The banner's "X": icon-only, with both a title and an accessible name. */
function DismissButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Dismiss"
      aria-label="Dismiss regression banner"
      className="rounded p-1 text-gray-400 transition-colors hover:bg-white/70 hover:text-gray-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-500"
    >
      <X className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}
