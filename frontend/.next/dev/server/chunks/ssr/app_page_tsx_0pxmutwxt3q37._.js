module.exports = [
"[project]/app/page.tsx [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([]);
"use client";
const DASHBOARD_URL = "http://localhost:8000/api/dashboard";
const PROVIDERS = [
    {
        code: "pge",
        label: "PG&E"
    },
    {
        code: "sce",
        label: "SCE"
    },
    {
        code: "sdge",
        label: "SDG&E"
    },
    {
        code: "cca",
        label: "CCAs"
    }
];
/**
 * The API is the source of truth, but normalising the payload here keeps the
 * render tree safe: a slow/partial response can never make `.map()` explode.
 */ function normalizeDashboard(payload, fallbackProvider) {
    const raw = payload ?? {};
    return {
        provider: typeof raw.provider === "string" ? raw.provider : fallbackProvider,
        last_checked: raw.last_checked ?? null,
        total_rins: typeof raw.total_rins === "number" ? raw.total_rins : 0,
        success_count: typeof raw.success_count === "number" ? raw.success_count : 0,
        failed_count: typeof raw.failed_count === "number" ? raw.failed_count : 0,
        failed_rins: Array.isArray(raw.failed_rins) ? raw.failed_rins : [],
        successful_rins: Array.isArray(raw.successful_rins) ? raw.successful_rins : []
    };
}
/**
 * Clipboard writes can be rejected (permissions, non-secure context), so the
 * legacy textarea path is kept as a fallback for the copy-to-Excel workflow.
 */ async function copyToClipboard(text) {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch  {
    // Fall through to the legacy path below.
    }
    try {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.top = "-1000px";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const succeeded = document.execCommand("copy");
        document.body.removeChild(area);
        return succeeded;
    } catch  {
        return false;
    }
}
;
}),
];

//# sourceMappingURL=app_page_tsx_0pxmutwxt3q37._.js.map