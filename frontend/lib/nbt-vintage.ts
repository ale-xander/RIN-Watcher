// Pure helpers for parsing NBT vintage information out of enrollment codes.
// NBT is a program marker ("NBT"); the vintage is carried by "NBT-YYYY".
// "NBT-0000" and "NBT-9999" are placeholders mapped to "floating".

export type Vintage =
  | "2023"
  | "2024"
  | "2025"
  | "2026"
  | "2027"
  | "floating"
  | null;

const VINTAGE_RE = /^NBT-(\d{4})$/;

/**
 * Returns the NBT vintage for a RIN, or null if it has no NBT vintage.
 * 0000 / 9999 (and any non-2023..2027 year) map to "floating".
 */
export function getVintage(
  enrollmentCodes: string[] | null | undefined,
): Vintage {
  if (!enrollmentCodes || enrollmentCodes.length === 0) return null;
  for (const code of enrollmentCodes) {
    const m = VINTAGE_RE.exec(code);
    if (!m) continue;
    const year = m[1];
    if (
      year === "2023" ||
      year === "2024" ||
      year === "2025" ||
      year === "2026" ||
      year === "2027"
    ) {
      return year as Vintage;
    }
    // 0000, 9999, and any future unknown year fall into floating
    return "floating";
  }
  return null;
}

/**
 * Strips the bare "NBT" code when a vintage code is present.
 * NBT alone carries no information once a vintage is known.
 */
export function stripRedundantNbt(
  enrollmentCodes: string[] | null | undefined,
): string[] {
  if (!enrollmentCodes || enrollmentCodes.length === 0) return [];
  const hasVintage = enrollmentCodes.some((c) => VINTAGE_RE.test(c));
  if (!hasVintage) return [...enrollmentCodes];
  return enrollmentCodes.filter((c) => c !== "NBT");
}
