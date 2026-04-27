"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getApi } from "@/lib/n2n";

export function useEnv() {
  const [env, setEnvState] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const envRef = useRef(env);

  useEffect(() => {
    envRef.current = env;
  }, [env]);

  useEffect(() => {
    const api = getApi();
    if (!api) {
      setLoaded(true);
      return;
    }
    api
      .loadEnv()
      .then((data) => {
        setEnvState(data ?? {});
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const setEnv = useCallback((next: Record<string, string>) => {
    setEnvState(next);
    const api = getApi();
    api?.saveEnv(next).catch(() => undefined);
  }, []);

  return { env, envRef, setEnv, loaded };
}
