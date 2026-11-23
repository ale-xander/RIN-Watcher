"use client";

// Hidden ops page for adding RINs from a CSV: `POST /api/ops/preview` is a dry
// run, `POST /api/ops/commit` inserts. The page is a one-shot wizard, separate
// from the dashboard: unlock with the shared admin password (kept in
// sessionStorage for the tab and sent as `X-Admin-Token`), drop a CSV, review
// the plan, then confirm.
//
// The browser never learns the Fly URL or any other secret: both live in the
// `/api/ops/[...path]` proxy route, which forwards the file and token. The
// backend owns the meaning of a file -- preview and commit run the same
// classifier -- so the plan shown here is exactly what the commit applies.
//
// Conflicts are expected, not an error: the importer is add-only, so a RIN that
// already exists is listed with its stored and CSV snapshots and skipped.

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ChangeEvent, DragEvent, FormEvent, ReactNode } from "react";
import { ArrowLeft, Check, FileUp, Lock } from "lucide-react";

import type { OpsCommit, OpsPreview } from "@/lib/types";

/** sessionStorage key: survives a reload, dies with the tab. */
const PASSWORD_STORAGE_KEY = "rin-watcher.admin-password";
/** Same-origin proxies for the Fly ops API (see app/api/ops/[...path]). */
const PREVIEW_URL = "/api/ops/preview";
const COMMIT_URL = "/api/ops/commit";
const ADMIN_TOKEN_HEADER = "X-Admin-Token";

type OpsStatus = "idle" | "previewing" | "committing" | "success" | "error";

const INPUT_CLASS =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus-visible:border-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900/10";
const PRIMARY_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 disabled:cursor-not-allowed disabled:bg-gray-400";
const SECONDARY_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:border-gray-300 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900";
/** Long plans scroll instead of stretching the page. */
const LIST_CLASS =
  "mt-3 max-h-72 divide-y divide-gray-200 overflow-y-auto rounded-lg border border-gray-200 bg-white";

const PANEL_TONES = {
  green: { box: "border-green-200 bg-green-50", heading: "text-green-800" },
  red: { box: "border-red-200 bg-red-50", heading: "text-red-800" },
  gray: { box: "border-gray-200 bg-gray-50", heading: "text-gray-700" },
} as const;

/** The first file of an input, after clearing it so the same file re-fires. */
function pickFile(event: ChangeEvent<HTMLInputElement>): File | null {
  const [chosen] = Array.from(event.target.files ?? []);
  event.target.value = "";
  return chosen ?? null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCodes(codes: string[]): string {
  return codes.length > 0 ? codes.join(", ") : "no codes";
}

/** One line of the DB / CSV comparison shown for a conflicting RIN. */
function describeSnapshot(snapshot: {
  tariff: string | null;
  enrollment_codes: string[];
  category: string;
}): string {
  return [
    snapshot.tariff ?? "no tariff",
    snapshot.category,
    formatCodes(snapshot.enrollment_codes),
  ].join(" · ");
}

/** FastAPI's `detail` first, then the proxy's `error` code, then the fallback. */
async function readErrorDetail(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const body = (await response.json()) as {
      detail?: unknown;
      error?: unknown;
    };
    if (typeof body.detail === "string" && body.detail.length > 0) {
      return body.detail;
    }
    if (typeof body.error === "string" && body.error.length > 0) {
      return body.error;
    }
  } catch {
    // Empty or non-JSON body; keep the status-based fallback.
  }
  return fallback;
}

/** POST the CSV through the ops proxy with the shared admin password. */
function postCsv(url: string, token: string, file: File): Promise<Response> {
  const form = new FormData();
  form.append("file", file);
  return fetch(url, {
    method: "POST",
    headers: { [ADMIN_TOKEN_HEADER]: token, Accept: "application/json" },
    body: form,
    cache: "no-store",
  });
}


/** A tinted result box: green for adds, red for conflicts, gray for skips. */
function Panel({
  tone,
  title,
  subtitle,
  children,
}: {
  tone: keyof typeof PANEL_TONES;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const styles = PANEL_TONES[tone];
  return (
    <section className={`rounded-xl border p-4 ${styles.box}`}>
      <h2 className={`text-sm font-semibold ${styles.heading}`}>{title}</h2>
      {subtitle !== undefined ? (
        <p className="mt-0.5 text-xs text-gray-600">{subtitle}</p>
      ) : null}
      {children}
    </section>
  );
}

/** The drop target. Owns its drag state so a drag never re-renders the page. */
function DropZone({
  onFile,
  disabled,
}: {
  onFile: (file: File) => void;
  disabled: boolean;
}) {
  const [dragging, setDragging] = useState(false);

  function handleDragOver(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    if (!disabled) {
      setDragging(true);
    }
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    if (disabled) {
      return;
    }
    const [dropped] = Array.from(event.dataTransfer.files);
    if (dropped !== undefined) {
      onFile(dropped);
    }
  }

  return (
    <label
      onDragOver={handleDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-16 text-center transition-colors ${
        dragging ? "border-gray-900 bg-white" : "border-gray-300 bg-white"
      } ${
        disabled
          ? "cursor-progress opacity-60"
          : "cursor-pointer hover:border-gray-400 hover:bg-gray-50"
      }`}
    >
      <input
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        disabled={disabled}
        onChange={(event) => {
          const chosen = pickFile(event);
          if (chosen !== null) {
            onFile(chosen);
          }
        }}
      />
      <FileUp
        className={`h-8 w-8 ${dragging ? "text-gray-900" : "text-gray-400"}`}
        aria-hidden="true"
      />
      <span className="text-sm font-medium text-gray-900">
        {dragging
          ? "Drop to preview"
          : "Drop a CSV here, or click to choose a file"}
      </span>
      <span className="text-xs text-gray-500">
        Columns: RIN, Tariff, Enrollment Code, Category
      </span>
    </label>
  );
}

/** `/lemons` -- unlock, preview a CSV, confirm the insert. */
export default function LemonsPage() {
  const [password, setPassword] = useState("");
  const [draft, setDraft] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<OpsPreview | null>(null);
  const [status, setStatus] = useState<OpsStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<OpsCommit | null>(null);

  // sessionStorage is client-only: read it after mount so the server render and
  // the first client render agree.
  useEffect(() => {
    setPassword(sessionStorage.getItem(PASSWORD_STORAGE_KEY) ?? "");
    setHydrated(true);
  }, []);

  function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = draft.trim();
    if (next === "") {
      setError("Enter the admin password.");
      return;
    }
    sessionStorage.setItem(PASSWORD_STORAGE_KEY, next);
    setPassword(next);
    setDraft("");
    setError(null);
    setStatus("idle");
  }

  function lock() {
    sessionStorage.removeItem(PASSWORD_STORAGE_KEY);
    setPassword("");
    setDraft("");
    setFile(null);
    setPreview(null);
    setCommitted(null);
    setError(null);
    setStatus("idle");
  }

  /** Start over with an empty drop zone but keep the password. */
  function reset() {
    setFile(null);
    setPreview(null);
    setCommitted(null);
    setError(null);
    setStatus("idle");
  }

  async function previewFile(upload: File, token: string) {
    setFile(upload);
    setPreview(null);
    setCommitted(null);
    setError(null);
    setStatus("previewing");
    try {
      const response = await postCsv(PREVIEW_URL, token, upload);
      if (!response.ok) {
        setError(
          await readErrorDetail(
            response,
            `Preview failed (HTTP ${response.status}).`,
          ),
        );
        setStatus("error");
        return;
      }
      setPreview((await response.json()) as OpsPreview);
      setStatus("idle");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not reach the preview API.",
      );
      setStatus("error");
    }
  }

  async function commit() {
    if (file === null || password === "") {
      return;
    }
    setError(null);
    setStatus("committing");
    try {
      const response = await postCsv(COMMIT_URL, password, file);
      if (!response.ok) {
        setError(
          await readErrorDetail(
            response,
            `Commit failed (HTTP ${response.status}).`,
          ),
        );
        setStatus("error");
        return;
      }
      setCommitted((await response.json()) as OpsCommit);
      setStatus("success");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not reach the commit API.",
      );
      setStatus("error");
    }
  }

  if (!hydrated) {
    return (
      <main
        className="mx-auto min-h-screen max-w-3xl px-6 py-10"
        aria-busy="true"
      />
    );
  }

  if (password === "") {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <section className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-semibold tracking-tight text-gray-900">
            Ops access
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Enter the shared admin password to add RINs.
          </p>
          <form onSubmit={unlock} className="mt-5 space-y-3">
            <label htmlFor="admin-password" className="sr-only">
              Admin password
            </label>
            <input
              id="admin-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Admin password"
              className={INPUT_CLASS}
            />
            {error !== null ? (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            ) : null}
            <button
              type="submit"
              className={`${PRIMARY_BUTTON_CLASS} w-full`}
            >
              Unlock
            </button>
          </form>
        </section>
      </main>
    );
  }

  const busy = status === "previewing" || status === "committing";
  const statusLabel =
    status === "previewing"
      ? "Reading CSV…"
      : status === "committing"
        ? "Adding RINs…"
        : status === "error"
          ? "Request failed"
          : preview === null
            ? "No preview yet"
            : "Preview ready";

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-gray-900">
            Add RINs
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Upload a CSV of new RINs. Existing RINs are never changed — they come
            back as conflicts and are skipped.
          </p>
        </div>
        <button type="button" onClick={lock} className={SECONDARY_BUTTON_CLASS}>
          <Lock className="h-3.5 w-3.5" aria-hidden="true" />
          Lock
        </button>
      </header>

      {status === "success" && committed !== null ? (
        <section className="rounded-xl border border-green-200 bg-green-50 p-6">
          <div className="flex items-center gap-2 text-green-800">
            <Check className="h-5 w-5" aria-hidden="true" />
            <h2 className="text-base font-semibold">
              Added {committed.counts.added} RIN
              {committed.counts.added === 1 ? "" : "s"}
            </h2>
          </div>
          <p className="mt-2 text-sm text-green-800">
            {committed.counts.conflicts} conflict
            {committed.counts.conflicts === 1 ? "" : "s"} and{" "}
            {committed.counts.skipped} invalid row
            {committed.counts.skipped === 1 ? "" : "s"} skipped. The dashboard
            picks the new RINs up on its next fetch.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Link href="/" className={SECONDARY_BUTTON_CLASS}>
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              Back to dashboard
            </Link>
            <button
              type="button"
              onClick={reset}
              className={SECONDARY_BUTTON_CLASS}
            >
              Upload another CSV
            </button>
          </div>
        </section>
      ) : (
        <div className="space-y-4">
          {file === null ? (
            <DropZone
              disabled={busy}
              onFile={(upload) => void previewFile(upload, password)}
            />
          ) : (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2">
              <span className="min-w-0 truncate text-sm text-gray-700">
                <span className="font-medium text-gray-900">{file.name}</span>
                <span className="ml-2 text-xs tabular-nums text-gray-500">
                  {formatBytes(file.size)}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <span className="text-xs text-gray-500">{statusLabel}</span>
                <label className={`${SECONDARY_BUTTON_CLASS} cursor-pointer`}>
                  Replace CSV
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    className="sr-only"
                    disabled={busy}
                    onChange={(event) => {
                      const chosen = pickFile(event);
                      if (chosen !== null) {
                        void previewFile(chosen, password);
                      }
                    }}
                  />
                </label>
              </span>
            </div>
          )}

          {error !== null ? (
            <section
              role="alert"
              className="rounded-xl border border-red-200 bg-red-50 p-4"
            >
              <h2 className="text-sm font-semibold text-red-800">
                Something went wrong
              </h2>
              <p className="mt-1 text-sm text-red-700">{error}</p>
              {file !== null && !busy ? (
                <button
                  type="button"
                  onClick={() => void previewFile(file, password)}
                  className="mt-3 text-xs font-medium text-red-800 underline underline-offset-2 hover:text-red-900"
                >
                  Run preview again
                </button>
              ) : null}
            </section>
          ) : null}

          {status === "previewing" ? (
            <p className="text-sm text-gray-500">
              Reading the CSV and checking it against the database…
            </p>
          ) : null}

          {preview !== null ? (
            <>
              <Panel tone="green" title={`Ready to Add (${preview.added.length})`}>
                {preview.added.length === 0 ? (
                  <p className="mt-2 text-sm text-gray-600">
                    No new RINs in this CSV.
                  </p>
                ) : (
                  <ul className={LIST_CLASS}>
                    {preview.added.map((row) => (
                      <li
                        key={row.rin}
                        className="flex items-baseline justify-between gap-3 px-3 py-2"
                      >
                        <span className="font-mono text-xs text-gray-900">
                          {row.rin}
                        </span>
                        <span className="text-right text-xs text-gray-600">
                          {row.tariff ?? "no tariff"} · {row.category} ·{" "}
                          {formatCodes(row.enrollment_codes)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              <Panel
                tone="red"
                title={`Conflicts (${preview.conflicts.length})`}
                subtitle="These RINs already exist in the DB and will be skipped."
              >
                {preview.conflicts.length === 0 ? (
                  <p className="mt-2 text-sm text-gray-600">
                    No existing RINs in this CSV.
                  </p>
                ) : (
                  <ul className={LIST_CLASS}>
                    {preview.conflicts.map((row) => (
                      <li key={row.rin} className="px-3 py-2">
                        <span className="font-mono text-xs font-medium text-gray-900">
                          {row.rin}
                        </span>
                        <dl className="mt-1 grid grid-cols-[2.5rem_1fr] gap-x-2 gap-y-0.5 text-xs">
                          <dt className="font-medium text-gray-500">DB</dt>
                          <dd className="text-gray-700">
                            {describeSnapshot(row.db)}
                            {row.db.is_active === 0 ? " · inactive" : ""}
                          </dd>
                          <dt className="font-medium text-gray-500">CSV</dt>
                          <dd className="text-gray-700">
                            {describeSnapshot(row.csv)}
                          </dd>
                        </dl>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              <Panel tone="gray" title={`Skipped (${preview.skipped.length})`}>
                {preview.skipped.length === 0 ? (
                  <p className="mt-2 text-sm text-gray-600">
                    No rows were rejected.
                  </p>
                ) : (
                  <ul className={LIST_CLASS}>
                    {preview.skipped.map((reason) => (
                      <li
                        key={reason}
                        className="px-3 py-2 text-xs text-gray-700"
                      >
                        {reason}
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              {preview.added.length > 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                  <p className="text-xs text-gray-500">
                    Add-only: conflicts and skipped rows are left untouched.
                  </p>
                  <button
                    type="button"
                    onClick={() => void commit()}
                    disabled={busy}
                    className={PRIMARY_BUTTON_CLASS}
                  >
                    {status === "committing"
                      ? "Adding…"
                      : `Confirm & Add ${preview.added.length} RIN${
                          preview.added.length === 1 ? "" : "s"
                        }`}
                  </button>
                </div>
              ) : (
                <p className="text-xs text-gray-500">
                  Nothing to commit — drop another CSV to try again.
                </p>
              )}
            </>
          ) : null}

        </div>
      )}
    </main>
  );
}

