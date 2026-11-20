"use client";

// DEV PREVIEW — temporary page from Step 6, removed in Step 7.
// Renders the three drill building blocks (HFP strip, filter pill, pattern
// strip) against the deployed API with a mock "Bundled × Non-Res" drill, so the
// chip styling, the ↑ markers and the click wiring can be eyeballed before the
// real drill lands.

import { useEffect, useState } from "react";

import { FilterPill } from "@/components/dashboard/filter-pill";
import { HfpStrip } from "@/components/dashboard/hfp-strip";
import { PatternStrip } from "@/components/dashboard/pattern-strip";
import { normalizeRinEntry } from "@/lib/normalize";
import type { RinEntry } from "@/lib/types";

/** The deployed API already returns every component in one payload. */
const DEV_DASHBOARD_URL =
  "https://rin-watch-api-alex.fly.dev/api/dashboard/pge?component=all";

type DashboardPayload = {
  failed_rins?: unknown[];
  successful_rins?: unknown[];
};

export default function DevDrillPage() {
  const [rins, setRins] = useState<RinEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attributes, setAttributes] = useState<Set<string>>(new Set());
  const [showNotYetLive, setShowNotYetLive] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch(DEV_DASHBOARD_URL)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json() as Promise<DashboardPayload>;
      })
      .then((data) => {
        if (cancelled) return;
        const all = [
          ...(data.failed_rins ?? []),
          ...(data.successful_rins ?? []),
        ];
        // Normalise here: `status_kind` is what the drill filters on, and the
        // normaliser falls back to "missing" for a payload that lacks it.
        setRins(
          all
            .map(normalizeRinEntry)
            .filter((entry): entry is RinEntry => entry !== null),
        );
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <div className="p-8 text-gray-500">Loading…</div>;

  if (error) {
    return (
      <div className="p-8 text-red-600">
        Could not load {DEV_DASHBOARD_URL}: {error}
      </div>
    );
  }

  // Mock drill: all bundled non-res missing RINs, optionally with the ones MIDAS
  // has no status row for yet.
  const drillAffected = rins.filter(
    (rin) =>
      rin.component === "bundled" &&
      rin.category === "non_res" &&
      (rin.status_kind === "missing" ||
        (showNotYetLive && rin.status_kind === "not_in_midas")),
  );

  // Baseline: all bundled non-res, regardless of status.
  const drillBaseline = rins.filter(
    (rin) => rin.component === "bundled" && rin.category === "non_res",
  );

  // Filter by active attributes (chips): a RIN matches when it carries the code,
  // or a dash-suffixed variant of it (VOLTAGE-S also matches VOLTAGE-S-2).
  const filteredAffected =
    attributes.size === 0
      ? drillAffected
      : drillAffected.filter((rin) =>
          [...attributes].every((attribute) =>
            rin.enrollment_codes?.some(
              (code) => code === attribute || code.startsWith(attribute + "-"),
            ),
          ),
        );

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-4">
      <div className="text-xs text-gray-400">
        DEV DRILL — mock Bundled × Non-Res drill. Step 7 removes this page.
      </div>

      <HfpStrip rins={rins} onCellClick={() => {}} />

      <FilterPill
        segments={[
          "Bundled",
          "Non-Res",
          showNotYetLive ? "Missing + not-yet-live" : "Missing",
          ...Array.from(attributes),
        ]}
        onBack={undefined}
        onClear={() => setAttributes(new Set())}
        showNotYetLive={showNotYetLive}
        onToggleNotYetLive={setShowNotYetLive}
      />

      <PatternStrip
        affectedRins={filteredAffected}
        baselineRins={drillBaseline}
        onAttributeClick={(attribute) => {
          setAttributes((prev) => {
            const next = new Set(prev);
            if (next.has(attribute)) {
              next.delete(attribute);
            } else {
              next.add(attribute);
            }
            return next;
          });
        }}
        activeAttributes={attributes}
      />

      <div className="text-xs text-gray-500 pt-4 border-t">
        Mock drill: Bundled × Non-Res · {filteredAffected.length} RINs after
        attribute filter (baseline {drillBaseline.length})
      </div>
    </div>
  );
}
