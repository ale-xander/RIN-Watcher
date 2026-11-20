"use client";

// DEV PREVIEW — temporary page from Steps 5-6, removed in Step 7.
// Pulls the full `?component=all` payload from the deployed API and renders
// both matrices so the cell styling and click payloads can be eyeballed.

import { useEffect, useState } from "react";

import { HealthMatrix } from "@/components/dashboard/health-matrix";
import type { MainMatrixSelection } from "@/components/dashboard/health-matrix";
import { NbtMatrix } from "@/components/dashboard/nbt-matrix";
import type { NbtMatrixSelection } from "@/components/dashboard/nbt-matrix";
import type { Dashboard, RinEntry } from "@/lib/types";

/** The deployed API already returns every component in one payload. */
const DEV_DASHBOARD_URL =
  "https://rin-watch-api-alex.fly.dev/api/dashboard/pge?component=all";

export default function DevMatrixPage() {
  const [rins, setRins] = useState<RinEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mainSel, setMainSel] = useState<MainMatrixSelection | null>(null);
  const [nbtSel, setNbtSel] = useState<NbtMatrixSelection | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(DEV_DASHBOARD_URL)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json() as Promise<Dashboard>;
      })
      .then((data) => {
        if (cancelled) return;
        setRins([...(data.failed_rins ?? []), ...(data.successful_rins ?? [])]);
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

  return (
    <main className="p-8 max-w-6xl mx-auto space-y-6">
      <div className="text-xs text-gray-400 mb-4">
        DEV PREVIEW — this page is temporary and will be removed in Step 7.
        Click cells to see selection state. View console for click payload.
      </div>

      <HealthMatrix
        rins={rins}
        selected={mainSel}
        onCellClick={(cell, sel) => {
          console.log("main cell click:", sel, cell);
          setMainSel(sel);
        }}
      />

      <NbtMatrix
        rins={rins}
        selected={nbtSel}
        onCellClick={(cell, sel) => {
          console.log("nbt cell click:", sel, cell);
          setNbtSel(sel);
        }}
      />

      <div className="text-xs text-gray-500 pt-4 border-t">
        Selected (main): {mainSel ? `${mainSel.row} × ${mainSel.col}` : "—"}
        <br />
        Selected (nbt):&nbsp;{nbtSel ? `${nbtSel.row} × ${nbtSel.col}` : "—"}
      </div>
    </main>
  );
}
