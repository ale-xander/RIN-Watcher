/** Shared chip button for the category filter row. */
export function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  const activeClassName = "border-gray-900 bg-gray-900 text-white";
  const idleClassName =
    "border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:text-gray-900";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active ? activeClassName : idleClassName
      }`}
    >
      {label}
      <span
        className={`tabular-nums ${
          active ? "text-white/70" : "text-gray-400"
        }`}
      >
        {count}
      </span>
    </button>
  );
}
