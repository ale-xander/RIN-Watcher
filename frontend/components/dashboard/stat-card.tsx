import type { ReactNode } from "react";

export function StatCard({
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
