"use client";

import { createContext, useContext } from "react";
import type { McpServerState } from "@/lib/n2n";

export const McpContext = createContext<McpServerState[]>([]);

export function useMcpServersList(): McpServerState[] {
  return useContext(McpContext);
}
