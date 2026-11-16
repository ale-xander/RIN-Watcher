import type { Provider } from "@/lib/types";

export function ProviderTabs({
  providers,
  activeId,
  onSelect,
}: {
  providers: Provider[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav
      aria-label="Providers"
      className="mb-4 flex gap-6 overflow-x-auto border-b border-gray-200"
    >
      {providers.map((provider) => {
        const isActive = provider.id === activeId;
        return (
          <button
            key={provider.id}
            type="button"
            onClick={() => onSelect(provider.id)}
            aria-current={isActive ? "page" : undefined}
            className={`whitespace-nowrap text-sm pb-3 ${
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
  );
}
