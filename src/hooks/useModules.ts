"use client";

import { useCallback, useEffect, useState } from "react";
import { getApi } from "@/lib/n2n";
import type { ModuleManifest } from "@/lib/types";

type State = {
  modules: ModuleManifest[];
  loading: boolean;
  error: string | null;
  desktop: boolean;
};

export function useModules(): State {
  const [state, setState] = useState<State>({
    modules: [],
    loading: true,
    error: null,
    desktop: false,
  });

  const reload = useCallback(() => {
    const api = getApi();
    if (!api) return;
    api
      .listModules()
      .then((modules) =>
        setState((s) => ({
          ...s,
          modules,
          loading: false,
          error: null,
          desktop: true,
        })),
      )
      .catch((err) =>
        setState((s) => ({
          ...s,
          loading: false,
          error: String(err?.message ?? err),
          desktop: true,
        })),
      );
  }, []);

  useEffect(() => {
    const api = getApi();
    if (!api) {
      setState({
        modules: [],
        loading: false,
        error:
          "Modules indisponibles : lancez l'app desktop avec « npm run dev ».",
        desktop: false,
      });
      return;
    }
    reload();
    const unsubscribe = api.onModulesChanged?.(() => reload());
    return () => {
      unsubscribe?.();
    };
  }, [reload]);

  return state;
}
