"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  DASHBOARD_URL,
  DEFAULT_PROVIDER_ID,
  PROVIDERS_URL,
} from "@/lib/constants";
import { normalizeDashboard, normalizeProviders } from "@/lib/normalize";
import type {
  Component,
  Dashboard,
  DashboardState,
  Provider,
  ProvidersState,
} from "@/lib/types";

export type UseDashboardDataResult = {
  providersState: ProvidersState;
  providers: Provider[];
  providerId: string;
  setProviderId: (id: string) => void;
  /** True when the active provider advertises a component split. */
  showComponentToggle: boolean;
  /** Component sent to the API, or null when the provider has no split. */
  requestComponent: Component | null;
  dashboardState: DashboardState;
  /** Payload for the selected provider/component, or null while stale. */
  data: Dashboard | null;
  providersLoading: boolean;
  dashboardLoading: boolean;
  reloadProviders: () => void;
  reloadDashboard: () => void;
};

/**
 * Data layer for the RIN dashboard: provider tabs, the dashboard payload for
 * the selected provider/component, and the retry handles for both requests.
 *
 * The provider id lives in the hook because it is validated against the
 * provider list; the component stays in the caller and is passed in.
 */
export function useDashboardData(component: Component): UseDashboardDataResult {
  const [providersState, setProvidersState] = useState<ProvidersState>({
    status: "loading",
  });
  const [providerId, setProviderId] = useState<string>(DEFAULT_PROVIDER_ID);
  const [dashboardState, setDashboardState] = useState<DashboardState>({
    status: "loading",
  });
  const [providersReloadToken, setProvidersReloadToken] = useState(0);
  const [dashboardReloadToken, setDashboardReloadToken] = useState(0);

  const providers =
    providersState.status === "ready" ? providersState.providers : [];
  const activeProvider =
    providers.find((provider) => provider.id === providerId) ?? null;
  // Only PG&E advertises a component split in /api/providers.
  const showComponentToggle = (activeProvider?.components.length ?? 0) > 0;
  const requestComponent: Component | null = showComponentToggle
    ? component
    : null;

  // Tabs are driven by the API: a new CCA in the spreadsheet gets a tab
  // without a frontend release.
  useEffect(() => {
    const controller = new AbortController();
    setProvidersState({ status: "loading" });

    async function loadProviders() {
      try {
        const response = await fetch(PROVIDERS_URL, {
          signal: controller.signal,
          cache: "no-store",
          headers: { Accept: "application/json" },
        });

        if (!response.ok) {
          throw new Error(`Request failed (HTTP ${response.status}).`);
        }

        const list = normalizeProviders(await response.json());
        setProvidersState({ status: "ready", providers: list });
        setProviderId((current) => {
          if (list.some((provider) => provider.id === current)) {
            return current;
          }
          return (
            list.find((provider) => provider.id === DEFAULT_PROVIDER_ID)?.id ??
            list[0]?.id ??
            current
          );
        });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        setProvidersState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not load provider tabs.",
        });
      }
    }

    void loadProviders();
    return () => controller.abort();
  }, [providersReloadToken]);

  const dashboardUrl = useMemo(() => {
    if (providersState.status !== "ready") {
      return null;
    }
    const provider = providersState.providers.find(
      (candidate) => candidate.id === providerId,
    );
    if (!provider) {
      return null;
    }
    const query =
      provider.components.length > 0 ? `?component=${component}` : "";
    return `${DASHBOARD_URL}/${encodeURIComponent(providerId)}${query}`;
  }, [providersState, providerId, component]);

  useEffect(() => {
    const url = dashboardUrl;
    if (!url) {
      return;
    }
    const controller = new AbortController();
    setDashboardState({ status: "loading" });

    async function loadDashboard(target: string) {
      try {
        const response = await fetch(target, {
          signal: controller.signal,
          cache: "no-store",
          headers: { Accept: "application/json" },
        });

        if (!response.ok) {
          let detail = `Request failed (HTTP ${response.status}).`;
          try {
            const body = (await response.json()) as { detail?: unknown };
            if (typeof body.detail === "string") {
              detail = body.detail;
            }
          } catch {
            // Body was empty or not JSON; keep the generic status message.
          }
          throw new Error(detail);
        }

        const payload = await response.json();
        setDashboardState({
          status: "ready",
          data: normalizeDashboard(payload, providerId, requestComponent),
        });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        setDashboardState({
          status: "error",
          message:
            error instanceof Error ? error.message : "Could not load RIN data.",
        });
      }
    }

    void loadDashboard(url);
    return () => controller.abort();
  }, [dashboardUrl, providerId, requestComponent, dashboardReloadToken]);

  // A payload that does not match the current selection is treated as stale,
  // so the table never renders another provider's rows.
  const data =
    dashboardState.status === "ready" &&
    dashboardState.data.provider === providerId &&
    (!showComponentToggle || dashboardState.data.component === component)
      ? dashboardState.data
      : null;

  const providersLoading = providersState.status === "loading";
  const dashboardLoading =
    dashboardState.status === "loading" ||
    (dashboardState.status === "ready" && data === null);

  const reloadProviders = useCallback(() => {
    setProvidersReloadToken((token) => token + 1);
  }, []);

  const reloadDashboard = useCallback(() => {
    setDashboardReloadToken((token) => token + 1);
  }, []);

  return {
    providersState,
    providers,
    providerId,
    setProviderId,
    showComponentToggle,
    requestComponent,
    dashboardState,
    data,
    providersLoading,
    dashboardLoading,
    reloadProviders,
    reloadDashboard,
  };
}

