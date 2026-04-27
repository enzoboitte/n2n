"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getApi,
  type McpServerState,
  type ToolDefinition,
} from "@/lib/n2n";

function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40);
}

export function mcpToolSlug(server: string, tool: string): string {
  return `mcp__${slugify(server)}__${slugify(tool)}`;
}

export function useMcpServers() {
  const [servers, setServers] = useState<McpServerState[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const api = getApi();
    if (!api) {
      setLoading(false);
      return;
    }
    try {
      const list = await api.mcpList();
      setServers(list);
    } catch {
      setServers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const api = getApi();
    if (!api) return;
    const off = api.onMcpChanged(() => refresh());
    return off;
  }, [refresh]);

  // Tool definitions to inject into the AI's tools list. Each MCP tool
  // becomes a `mcp__<server>__<tool>` function with the tool's schema.
  // A lookup map lets the executor route a function call back to MCP.
  const { mcpTools, mcpLookup } = useMemo(() => {
    const tools: ToolDefinition[] = [];
    const lookup = new Map<string, { server: string; tool: string }>();
    for (const s of servers) {
      if (!s.connected) continue;
      for (const t of s.tools) {
        const slug = mcpToolSlug(s.name, t.name);
        lookup.set(slug, { server: s.name, tool: t.name });
        tools.push({
          type: "function",
          function: {
            name: slug,
            description: `[MCP/${s.name}] ${t.description ?? t.name}`,
            parameters:
              (t.inputSchema as Record<string, unknown>) ?? {
                type: "object",
                properties: {},
              },
          },
        });
      }
    }
    return { mcpTools: tools, mcpLookup: lookup };
  }, [servers]);

  return { servers, loading, refresh, mcpTools, mcpLookup };
}
