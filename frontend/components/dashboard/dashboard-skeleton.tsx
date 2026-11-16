export function DashboardSkeleton() {
  return (
    <div role="status" aria-live="polite" className="animate-pulse">
      <span className="sr-only">Loading RIN status…</span>

      <div className="mb-6 flex flex-wrap gap-2">
        {[0, 1, 2, 3, 4].map((chip) => (
          <div key={chip} className="h-6 w-20 rounded-full bg-gray-200" />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 sm:gap-6 mb-6">
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
        <div className="flex flex-col gap-4 px-6 py-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="h-4 w-52 rounded bg-gray-200" />
            <div className="h-4 w-7 rounded-full bg-gray-200" />
          </div>
          <div className="flex items-center gap-3">
            <div className="h-9 w-64 rounded-lg bg-gray-200" />
            <div className="h-9 w-36 rounded-lg bg-gray-200" />
          </div>
        </div>

        <div className="bg-gray-50 border-y border-gray-200 px-6 py-3">
          <div className="flex items-center gap-8">
            <div className="h-3 w-4 rounded bg-gray-200" />
            <div className="h-3 w-10 rounded bg-gray-200" />
            <div className="h-3 w-14 rounded bg-gray-200" />
            <div className="h-3 w-32 rounded bg-gray-200" />
            <div className="ml-auto h-3 w-24 rounded bg-gray-200" />
          </div>
        </div>

        {[0, 1, 2, 3, 4].map((row) => (
          <div
            key={row}
            className={`flex items-center gap-8 px-6 py-4 ${
              row % 2 === 0 ? "bg-white" : "bg-gray-50/50"
            }`}
          >
            <div className="h-4 w-4 rounded bg-gray-200" />
            <div className="h-3 w-48 rounded bg-gray-200" />
            <div className="h-3 w-12 rounded bg-gray-200" />
            <div className="h-3 w-40 rounded bg-gray-200" />
            <div className="ml-auto h-3 w-24 rounded bg-gray-200" />
          </div>
        ))}
      </div>
    </div>
  );
}
