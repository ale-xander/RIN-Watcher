"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, Check, Copy } from "lucide-react";

const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000"
).replace(/\/+$/, "");

const DASHBOARD_URL = `${API_BASE_URL}/api/dashboard`;

const PROVIDERS = [
  { code: "pge", label: "PG&E" },
  { code: "sce", label: "SCE" },
  { code: "sdge", label: "SDG&E" },
  { code: "cca", label: "CCAs" },
] as const;

type ProviderCode = (typeof PROVIDERS)[number]["code"];
type ViewMode = "failed" | "successful";

type RinEntry = {
  rin: string;
  rate_name: string | null;
  last_success: string | null;
};

type Dashboard = {
  provider: string;
  last_checked: string | null;
  total_rins: number;
  success_count: number;
  failed_count: number;
  failed_rins: RinEntry[];
  successful_rins: RinEntry[];
};

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: Dashboard };

/**
 * The API is the source of truth, but normalising the payload here keeps the
 * render tree safe: a slow/partial response can never make `.map()` explode.
 */
function normalizeDashboard(
  payload: unknown,
  fallbackProvider: ProviderCode,
): Dashboard {
  const raw = (payload ?? {}) as Partial<Dashboard>;
  return {
    provider:
      typeof raw.provider === "string" ? raw.provider : fallbackProvider,
    last_checked: raw.last_checked ?? null,
    total_rins: typeof raw.total_rins === "number" ? raw.total_rins : 0,
    success_count:
      typeof raw.success_count === "number" ? raw.success_count : 0,
    failed_count: typeof raw.failed_count === "number" ? raw.failed_count : 0,
    failed_rins: Array.isArray(raw.failed_rins) ? raw.failed_rins : [],
    successful_rins: Array.isArray(raw.successful_rins)
      ? raw.successful_rins
      : [],
  };
}

/**
 * Clipboard writes can be rejected (permissions, non-secure context), so the
 * legacy textarea path is kept as a fallback for the copy-to-Excel workflow.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path below.
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const succeeded = document.execCommand("copy");
    document.body.removeChild(area);
    return succeeded;
  } catch {
    return false;
  }
}

export default function Page() {
  const [providerCode, setProviderCode] = useState<ProviderCode>("pge");
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });

    async function loadDashboard() {
      try {
        const response = await fetch(`${DASHBOARD_URL}/${providerCode}`, {
          signal: controller.signal,
          cache: "no-store",
          headers: { Accept: "application/json" },
        });

        if (!response.ok) {
          let detail = `Request failed (HTTP ${response.status}).`;
          try {
            const body = (await response.json()) as { detail?: unknown };
            if (typeof body.detail === "string") {
              detail = body.detail;
            }
          } catch {
            // Body was empty or not JSON; keep the generic status message.
          }
          throw new Error(detail);
        }

        const payload = await response.json();
        setState({
          status: "ready",
          data: normalizeDashboard(payload, providerCode),
        });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        setState({
          status: "error",
          message:
            error instanceof Error ? error.message : "Could not load RIN data.",
        });
      }
    }

    void loadDashboard();
    return () => controller.abort();
  }, [providerCode, reloadToken]);

  const reload = () => setReloadToken((token) => token + 1);
  const lastChecked = state.status === "ready" ? state.data.last_checked : null;

  return (
    <main
      className="mx-auto max-w-5xl px-6 py-10"
      aria-busy={state.status === "loading"}
    >
      <header className="mb-6 flex items-start justify-between gap-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">RIN Watch</h1>
          <p className="text-sm text-gray-500">MIDAS rate publication monitor</p>
        </div>
        <p className="pt-1 text-sm text-gray-500">
          <span
            className="bg-green-500 w-2 h-2 rounded-full inline-block mr-2"
            aria-hidden="true"
          />
          Last checked: {lastChecked ?? "—"}
        </p>
      </header>

      <nav
        aria-label="Providers"
        className="border-b border-gray-200 mb-6 flex gap-6"
      >
        {PROVIDERS.map((provider) => {
          const isActive = provider.code === providerCode;
          return (
            <button
              key={provider.code}
              type="button"
              onClick={() => setProviderCode(provider.code)}
              aria-current={isActive ? "page" : undefined}
              className={`text-sm pb-3 ${
                isActive
                  ? "border-b-2 border-blue-600 text-gray-900 font-medium -mb-px"
                  : "text-gray-500 hover:text-gray-700 transition-colors"
              }`}
            >
              {provider.label}
            </button>
          );
        })}
      </nav>

      {state.status === "loading" ? <DashboardSkeleton /> : null}

      {state.status === "error" ? (
        <ErrorPanel message={state.message} onRetry={reload} />
      ) : null}

      {state.status === "ready" ? <DashboardView data={state.data} /> : null}
    </main>
  );
}

function DashboardView({ data }: { data: Dashboard }) {
  const [viewMode, setViewMode] = useState<ViewMode>("failed");

  const successPercentage =
    data.total_rins > 0 ? (data.success_count / data.total_rins) * 100 : 0;
  const entries =
    viewMode === "failed" ? data.failed_rins : data.successful_rins;

  return (
    <>
      <div className="grid grid-cols-3 gap-6 mb-6">
        <StatCard
          label="TOTAL RINS"
          value={data.total_rins}
          valueClassName="text-5xl text-gray-900"
        />
        <StatCard
          label="HAS VALUE TODAY"
          value={data.success_count}
          valueClassName="text-5xl text-green-600"
          subtext={`${successPercentage.toFixed(1)}% published successfully`}
          icon={
            <Check
              className="w-5 h-5 text-green-600"
              strokeWidth={2.5}
              aria-hidden="true"
            />
          }
          active={viewMode === "successful"}
          activeRingClassName="ring-green-500"
          onClick={() => setViewMode("successful")}
        />
        <StatCard
          label="NO VALUE TODAY"
          value={data.failed_count}
          valueClassName="text-6xl text-red-600"
          subtext="Requires utility follow-up"
          icon={
            <AlertTriangle
              className="w-5 h-5 text-red-600"
              strokeWidth={2.5}
              aria-hidden="true"
            />
          }
          active={viewMode === "failed"}
          activeRingClassName="ring-red-500"
          onClick={() => setViewMode("failed")}
        />
      </div>

      <RinTable entries={entries} tone={viewMode} />
    </>
  );
}

function StatCard({
  label,
  value,
  valueClassName,
  subtext,
  icon,
  active = false,
  activeRingClassName = "ring-blue-500",
  onClick,
}: {
  label: string;
  value: number;
  valueClassName: string;
  subtext?: string;
  icon?: ReactNode;
  active?: boolean;
  activeRingClassName?: string;
  onClick?: () => void;
}) {
  const cardClassName = [
    "bg-white border rounded-xl p-6 shadow-sm transition-all cursor-pointer",
    active
      ? `border-transparent ring-2 ${activeRingClassName}`
      : "border-gray-200 hover:shadow-md",
  ].join(" ");

  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
          {label}
        </span>
        {icon}
      </div>
      <p
        className={`${valueClassName} font-semibold mt-2 mb-1 tabular-nums leading-none`}
      >
        {value}
      </p>
      {subtext ? <p className="text-sm text-gray-500">{subtext}</p> : null}
    </>
  );

  if (!onClick) {
    return <div className={cardClassName}>{content}</div>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`${cardClassName} text-left`}
    >
      {content}
    </button>
  );
}

function RinTable({ entries, tone }: { entries: RinEntry[]; tone: ViewMode }) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const selectAllRef = useRef<HTMLInputElement>(null);

  const isFailed = tone === "failed";
  const title = isFailed ? "Failed RINs — needs follow-up" : "Successful RINs";
  const badgeClassName = isFailed
    ? "bg-red-50 text-red-700"
    : "bg-green-50 text-green-700";
  const emptyMessage = isFailed
    ? "Every tracked RIN published a value today."
    : "No RIN has published a value today yet.";

  // A different view (or provider) brings a different list: drop stale picks.
  useEffect(() => {
    setSelected(new Set());
    setCopyStatus("idle");
  }, [entries]);

  useEffect(() => {
    if (copyStatus === "idle") {
      return;
    }
    const timer = setTimeout(() => setCopyStatus("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copyStatus]);

  const allSelected = entries.length > 0 && selected.size === entries.length;
  const someSelected = selected.size > 0 && !allSelected;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelected;
    }
  }, [someSelected]);

  function toggleAll() {
    setSelected(
      allSelected ? new Set() : new Set(entries.map((entry) => entry.rin)),
    );
  }

  function toggleRow(rin: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(rin)) {
        next.delete(rin);
      } else {
        next.add(rin);
      }
      return next;
    });
  }

  async function handleCopy() {
    // Nothing checked means "copy the whole table".
    const rows =
      selected.size === 0
        ? entries
        : entries.filter((entry) => selected.has(entry.rin));
    if (rows.length === 0) {
      return;
    }
    const tsv = rows
      .map((entry) => `${entry.rin}\t${entry.rate_name ?? ""}`)
      .join("\n");
    const succeeded = await copyToClipboard(tsv);
    setCopyStatus(succeeded ? "copied" : "error");
  }

  const copyLabel =
    copyStatus === "copied"
      ? "Copied"
      : copyStatus === "error"
        ? "Copy failed"
        : "Copy selected";

  return (
    <section className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
      <div className="flex items-center justify-between gap-4 px-6 py-5">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums ${badgeClassName}`}
          >
            {entries.length}
          </span>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          disabled={entries.length === 0}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 flex items-center gap-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          {copyStatus === "copied" ? (
            <Check className="w-4 h-4" aria-hidden="true" />
          ) : (
            <Copy className="w-4 h-4" aria-hidden="true" />
          )}
          {copyLabel}
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 border-y border-gray-200 text-xs uppercase text-gray-500 font-semibold">
            <tr>
              <th scope="col" className="w-12 px-6 py-3">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={entries.length === 0}
                  aria-label="Select all RINs"
                  className="h-4 w-4 rounded border-gray-300 accent-blue-600 cursor-pointer disabled:cursor-not-allowed"
                />
              </th>
              <th scope="col" className="px-3 py-3">
                RIN
              </th>
              <th scope="col" className="px-3 py-3">
                Rate Name
              </th>
              <th scope="col" className="px-3 py-3 text-right">
                Last Success
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-6 py-10 text-center text-sm text-gray-500"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              entries.map((entry, index) => (
                <tr
                  key={entry.rin}
                  className={`transition-colors ${
                    index % 2 === 0 ? "bg-white" : "bg-gray-50/50"
                  } hover:bg-gray-100`}
                >
                  <td className="w-12 px-6 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(entry.rin)}
                      onChange={() => toggleRow(entry.rin)}
                      aria-label={`Select ${entry.rin}`}
                      className="h-4 w-4 rounded border-gray-300 accent-blue-600 cursor-pointer"
                    />
                  </td>
                  <td className="px-3 py-3 font-mono text-gray-900 whitespace-nowrap">
                    {entry.rin}
                  </td>
                  <td className="px-3 py-3 text-gray-600">
                    {entry.rate_name ?? "—"}
                  </td>
                  <td className="px-3 py-3 text-right text-gray-500 whitespace-nowrap">
                    {entry.last_success ?? "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DashboardSkeleton() {
  return (
    <div role="status" aria-live="polite" className="animate-pulse">
      <span className="sr-only">Loading RIN status…</span>

      <div className="grid grid-cols-3 gap-6 mb-6">
        {[0, 1, 2].map((card) => (
          <div
            key={card}
            className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm"
          >
            <div className="h-3 w-24 rounded bg-gray-200" />
            <div className="mt-4 h-10 w-16 rounded bg-gray-200" />
            <div className="mt-4 h-3 w-40 max-w-full rounded bg-gray-200" />
          </div>
        ))}
      </div>

      <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
        <div className="flex items-center justify-between gap-4 px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="h-4 w-52 rounded bg-gray-200" />
            <div className="h-4 w-7 rounded-full bg-gray-200" />
          </div>
          <div className="h-9 w-36 rounded-lg bg-gray-200" />
        </div>

        <div className="bg-gray-50 border-y border-gray-200 px-6 py-3">
          <div className="flex items-center gap-10">
            <div className="h-3 w-4 rounded bg-gray-200" />
            <div className="h-3 w-10 rounded bg-gray-200" />
            <div className="h-3 w-20 rounded bg-gray-200" />
            <div className="ml-auto h-3 w-24 rounded bg-gray-200" />
          </div>
        </div>

        {[0, 1, 2, 3, 4].map((row) => (
          <div
            key={row}
            className={`flex items-center gap-10 px-6 py-4 ${
              row % 2 === 0 ? "bg-white" : "bg-gray-50/50"
            }`}
          >
            <div className="h-4 w-4 rounded bg-gray-200" />
            <div className="h-3 w-48 rounded bg-gray-200" />
            <div className="h-3 w-32 rounded bg-gray-200" />
            <div className="ml-auto h-3 w-24 rounded bg-gray-200" />
          </div>
        ))}
      </div>
    </div>
  );
}

function ErrorPanel({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const isUnknownProvider = message.toLowerCase().includes("unknown provider");

  return (
    <section
      role="alert"
      className="bg-white border border-red-200 rounded-xl shadow-sm p-6"
    >
      <h2 className="text-base font-semibold text-red-700">
        Could not load RIN data
      </h2>
      <p className="mt-2 text-sm text-red-700">{message}</p>

      {isUnknownProvider ? (
        <p className="mt-2 text-sm text-gray-500">
          No RIN data is being collected for this provider yet.
        </p>
      ) : (
        <p className="mt-2 text-sm text-gray-500">
          Make sure the API is running:{" "}
          <code className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono text-xs text-gray-800">
            uvicorn main:app --reload --port 8000
          </code>
        </p>
      )}

      <button
        type="button"
        onClick={onRetry}
        className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
      >
        Try again
      </button>
    </section>
  );
}
