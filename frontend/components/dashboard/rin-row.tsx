import type { RinEntry } from "@/lib/types";

export function RinRow({
  entry,
  checked,
  onToggle,
}: {
  entry: RinEntry;
  checked: boolean;
  onToggle: (rin: string) => void;
}) {
  const lastSuccess = entry.last_success ?? entry.last_success_date ?? "—";

  return (
    <tr className="transition-colors hover:bg-gray-50">
      <td className="w-12 px-6 py-3">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(entry.rin)}
          aria-label={`Select ${entry.rin}`}
          className="h-4 w-4 rounded border-gray-300 accent-blue-600 cursor-pointer"
        />
      </td>
      <td className="px-3 py-3 font-mono text-gray-900 whitespace-nowrap">
        {entry.rin}
      </td>
      <td className="px-3 py-3 text-gray-600 whitespace-nowrap">
        {entry.tariff ?? "—"}
      </td>
      <td className="px-3 py-3">
        <div className="flex flex-wrap gap-1">
          {entry.enrollment_codes.length === 0 ? (
            <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
              no codes
            </span>
          ) : (
            entry.enrollment_codes.map((code) => (
              <span
                key={code}
                className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600"
              >
                {code}
              </span>
            ))
          )}
        </div>
      </td>
      <td className="px-3 py-3 pr-6 text-right text-gray-500 whitespace-nowrap">
        {lastSuccess}
      </td>
    </tr>
  );
}
