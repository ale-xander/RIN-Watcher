// Copy control for the affected-RINs card: a primary "Copy N RINs" button plus
// a caret that opens the format menu.
//
// The default action copies TSV (paste straight into Excel); the menu also
// offers a plain RIN-per-line list for pasting into MIDAS lookups. Checked rows
// win over the whole table.

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Copy } from "lucide-react";

import { classifyAttributes } from "@/lib/attribute-groups";
import { copyToClipboard } from "@/lib/clipboard";
import { COMPONENT_LABELS } from "@/lib/constants";
import { getVintage } from "@/lib/nbt-vintage";
import type { NbtVintage } from "@/lib/nbt-vintage";
import type { RinEntry } from "@/lib/types";

/**
 * TSV for the current selection, one RIN per line, no header row:
 * RIN, Component, Tariff, Vintage, Voltage, Discount, DR, Other, Last Success.
 */
export function buildTsv(rins: RinEntry[]): string {
  return rins
    .map((rin) => {
      const attributes = classifyAttributes(rin.enrollment_codes);
      const vintage = getVintage(rin.enrollment_codes);
      return [
        rin.rin,
        rin.component === null ? "" : COMPONENT_LABELS[rin.component],
        rin.tariff ?? "",
        vintage === null ? "" : formatVintage(vintage),
        attributes.voltage ?? "",
        attributes.discount.join(", "),
        attributes.dr.join(", "),
        attributes.other.join(", "),
        rin.last_success ?? rin.last_success_date ?? "",
      ].join("\t");
    })
    .join("\n");
}

/** One RIN per line, nothing else; the format MIDAS lookups want. */
export function buildRinList(rins: RinEntry[]): string {
  return rins.map((rin) => rin.rin).join("\n");
}

function formatVintage(vintage: NbtVintage): string {
  return vintage === "floating" ? "Floating" : vintage;
}

export interface CopyButtonProps {
  /** Every row currently in the table. */
  rins: RinEntry[];
  /** Checked RINs; when non-empty they are what gets copied. */
  selectedRins: Set<string>;
}

export function CopyButton({ rins, selectedRins }: CopyButtonProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const containerRef = useRef<HTMLDivElement>(null);

  const rows =
    selectedRins.size > 0
      ? rins.filter((rin) => selectedRins.has(rin.rin))
      : rins;
  const count = rows.length;

  // Reset the label after the feedback flash.
  useEffect(() => {
    if (status === "idle") {
      return;
    }
    const timer = setTimeout(() => setStatus("idle"), 1500);
    return () => clearTimeout(timer);
  }, [status]);

  // Close the format menu on an outside click, the usual dropdown affordance.
  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    function handlePointerDown(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [menuOpen]);

  async function copy(text: string) {
    setMenuOpen(false);
    const succeeded = await copyToClipboard(text);
    setStatus(succeeded ? "copied" : "error");
  }

  const label =
    status === "copied"
      ? "Copied!"
      : status === "error"
        ? "Copy failed"
        : `Copy ${count} RIN${count === 1 ? "" : "s"}`;

  return (
    <div
      ref={containerRef}
      className="relative inline-flex"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setMenuOpen(false);
        }
      }}
    >
      <div className="inline-flex overflow-hidden rounded-md border border-gray-200 bg-white shadow-sm">
        <button
          type="button"
          onClick={() => copy(buildTsv(rows))}
          disabled={count === 0}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-300 disabled:hover:bg-white"
        >
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          {label}
        </button>

        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          disabled={count === 0}
          aria-label="Copy options"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="border-l border-gray-200 px-1.5 text-gray-500 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-300 disabled:hover:bg-white"
        >
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      {menuOpen ? (
        <div
          role="menu"
          aria-label="Copy format"
          className="absolute right-0 top-full z-20 mt-1 w-60 overflow-hidden rounded-md border border-gray-200 bg-white py-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => copy(buildTsv(rows))}
            className="block w-full px-3 py-1.5 text-left text-xs text-gray-700 transition-colors hover:bg-gray-50"
          >
            TSV — RIN, attributes, last success
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => copy(buildRinList(rows))}
            className="block w-full px-3 py-1.5 text-left text-xs text-gray-700 transition-colors hover:bg-gray-50"
          >
            RIN list — one per line
          </button>
        </div>
      ) : null}
    </div>
  );
}
