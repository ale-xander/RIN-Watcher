export function ErrorPanel({
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
