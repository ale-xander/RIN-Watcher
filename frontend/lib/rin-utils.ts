import type { RinEntry } from "@/lib/types";

/** NBT (Net Billing Tariff) is a program, detected from the enrollment codes. */
export function isNbt(entry: RinEntry): boolean {
  return entry.enrollment_codes.some((code) => code.startsWith("NBT-"));
}

