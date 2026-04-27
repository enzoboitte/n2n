"use client";

import { createContext, useContext } from "react";

export const EnvContext = createContext<Record<string, string>>({});

export function useEnvVars(): Record<string, string> {
  return useContext(EnvContext);
}
