import type { CanvasNode, Edge, ModuleManifest, RunResult } from "./types";

export type ProjectMeta = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

export type Project = ProjectMeta & {
  nodes: CanvasNode[];
  edges: Edge[];
};

export type ImportResult =
  | { canceled: true }
  | { canceled: false; project: Project }
  | { canceled: false; error: string };

export type ExportResult = { canceled: true } | { canceled: false; path: string };

export type WebhookEvent = {
  nodeId: string;
  path: string;
  data: {
    method: string;
    body: string;
    query: Record<string, string>;
    headers: Record<string, string>;
  };
};

export type McpToolSpec = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type McpServerState = {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  connected: boolean;
  error: string | null;
  tools: McpToolSpec[];
};

export type McpServerConfig = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export type McpCallResult = {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  [k: string]: unknown;
};

export type HistoryEntry = {
  timestamp: number;
  projectId: string | null;
  nodeId: string;
  moduleId: string;
  durationMs: number;
  ok: boolean;
  error?: string;
  outputs?: Record<string, unknown>;
};

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatOptions = {
  url?: string;
  model?: string;
  temperature?: number;
  tools?: ToolDefinition[];
  tool_choice?: "auto" | "none" | "required";
  enable_thinking?: boolean;
};

export type ChatResult =
  | { ok: true; aborted?: boolean; toolCalls?: ToolCall[]; finishReason?: string | null }
  | { ok: false; error: string };

export type ChatHandle = {
  promise: Promise<ChatResult>;
  abort: () => void;
};

export type ModuleFileEntry = { path: string; kind: "file" | "dir" };

export type NodeRunningPayload = { projectId: string; nodeId: string };
export type NodeResultPayload = {
  projectId: string;
  nodeId: string;
  result: RunResult;
  durationMs: number;
  moduleId: string;
};
export type EnvChangedPayload = { changed: string[] };

type N2nApi = {
  listModules: () => Promise<ModuleManifest[]>;
  runModule: (
    id: string,
    inputs: Record<string, unknown>,
    params: Record<string, unknown>,
    letters: Record<string, unknown>,
    env: Record<string, unknown>,
  ) => Promise<RunResult>;
  openModulesFolder: () => Promise<void>;
  onModulesChanged: (callback: () => void) => () => void;
  loadEnv: () => Promise<Record<string, string>>;
  saveEnv: (env: Record<string, string>) => Promise<void>;
  chatStream: (
    messages: ChatMessage[],
    onChunk: (chunk: string) => void,
    options?: ChatOptions,
  ) => ChatHandle;
  createModule: (args: {
    id: string;
    manifest?: Partial<ModuleManifest>;
    code?: string;
  }) => Promise<{ id: string }>;
  deleteModule: (id: string) => Promise<void>;
  listModuleFiles: (id: string) => Promise<ModuleFileEntry[]>;
  readModuleFile: (id: string, file: string) => Promise<string>;
  writeModuleFile: (id: string, file: string, content: string) => Promise<void>;
  deleteModuleFile: (id: string, file: string) => Promise<void>;
  listProjects: () => Promise<ProjectMeta[]>;
  loadProject: (id: string) => Promise<Project>;
  saveProject: (project: Project) => Promise<{ id: string }>;
  createProject: (name?: string) => Promise<Project>;
  renameProject: (id: string, name: string) => Promise<{ id: string; name: string }>;
  deleteProject: (id: string) => Promise<void>;
  duplicateProject: (id: string) => Promise<Project>;
  getActiveProjectId: () => Promise<string | null>;
  setActiveProjectId: (id: string) => Promise<void>;
  exportProjectToFile: (id: string) => Promise<ExportResult>;
  importProjectFromFile: () => Promise<ImportResult>;
  cronRegister: (id: string, intervalMs: number, projectId?: string | null) => Promise<void>;
  cronUnregister: (id: string) => Promise<void>;
  cronUnregisterAll: () => Promise<void>;
  onCronTick: (callback: (payload: { id: string }) => void) => () => void;
  webhookRegister: (
    nodeId: string,
    path: string,
    response?: {
      status?: string | number;
      contentType?: string;
      body?: string;
      headers?: Record<string, string>;
    },
    projectId?: string | null,
  ) => Promise<void>;
  webhookUnregister: (nodeId: string) => Promise<void>;
  webhookUnregisterAll: () => Promise<void>;
  webhookPort: () => Promise<number>;
  onWebhookFired: (callback: (event: WebhookEvent) => void) => () => void;
  appendHistory: (entry: HistoryEntry) => Promise<void>;
  readHistory: (limit?: number) => Promise<HistoryEntry[]>;
  clearHistory: () => Promise<void>;
  mcpList: () => Promise<McpServerState[]>;
  mcpSave: (name: string, config: McpServerConfig) => Promise<{ ok: true }>;
  mcpDelete: (name: string) => Promise<void>;
  mcpRestart: (name: string) => Promise<void>;
  mcpCallTool: (
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<McpCallResult>;
  onMcpChanged: (callback: () => void) => () => void;
  onNodeRunning: (callback: (payload: NodeRunningPayload) => void) => () => void;
  onNodeResult: (callback: (payload: NodeResultPayload) => void) => () => void;
  onEnvChanged: (callback: (payload: EnvChangedPayload) => void) => () => void;
  runProjectNode: (projectId: string, nodeId: string) => Promise<RunResult>;
};

declare global {
  interface Window {
    n2n?: N2nApi;
  }
}

// ---------- HTTP client ----------

// API base resolution order:
//   1. localStorage["n2n:apiUrl"]            — set by the in-app Settings modal
//   2. NEXT_PUBLIC_N2N_API at build time     — for dev / pre-baked deployments
//   3. window.__N2N_API__ injected at runtime (e.g. by an Apache rewrite)
//   4. http://localhost:9999                 — sane default for local dev
//
// Resolved lazily so that updates to localStorage take effect on the next
// request without reloading the page.
const API_STORAGE_KEY = "n2n:apiUrl";

export function getApiBase(): string {
  if (typeof window !== "undefined") {
    try {
      const stored = window.localStorage.getItem(API_STORAGE_KEY);
      if (stored) return stored.replace(/\/+$/, "");
    } catch {}
    const injected = (window as unknown as { __N2N_API__?: string }).__N2N_API__;
    if (injected) return injected.replace(/\/+$/, "");
  }
  if (typeof process !== "undefined" && process.env.NEXT_PUBLIC_N2N_API) {
    return process.env.NEXT_PUBLIC_N2N_API.replace(/\/+$/, "");
  }
  return "http://localhost:9999";
}

export function setApiBase(url: string): void {
  if (typeof window === "undefined") return;
  const clean = url.trim().replace(/\/+$/, "");
  try {
    if (clean) window.localStorage.setItem(API_STORAGE_KEY, clean);
    else window.localStorage.removeItem(API_STORAGE_KEY);
  } catch {}
  // Force the SSE channel to reconnect against the new base. We close the
  // existing EventSource and reopen one immediately if there are any active
  // listeners (so the UI keeps receiving cron/webhook/module events without
  // having to re-subscribe).
  if (eventSource) {
    try { eventSource.close(); } catch {}
    eventSource = null;
  }
  const hasListeners =
    listeners.modulesChanged.size +
      listeners.cronTick.size +
      listeners.webhookFired.size +
      listeners.mcpChanged.size >
    0;
  if (hasListeners) ensureEventSource();
}

export type ServerInfo = {
  name: string;
  version: string;
  apiPort: number;
  webhookPort: number;
  host: string;
};

export async function pingServer(url: string, signal?: AbortSignal): Promise<ServerInfo> {
  const clean = url.trim().replace(/\/+$/, "");
  const res = await fetch(`${clean}/api/info`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function http<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  init: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = { ...((init.headers as Record<string, string>) || {}) };
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
    payload = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await fetch(`${getApiBase()}${path}`, { method, headers, body: payload, ...init });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      msg = (data && (data.error || data.message)) || msg;
    } catch {}
    throw new Error(msg);
  }
  const ct = res.headers.get("Content-Type") || "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

// ---------- shared event-bus (single SSE for all push channels) ----------

type EventListeners = {
  modulesChanged: Set<() => void>;
  cronTick: Set<(p: { id: string }) => void>;
  webhookFired: Set<(p: WebhookEvent) => void>;
  mcpChanged: Set<() => void>;
  nodeRunning: Set<(p: NodeRunningPayload) => void>;
  nodeResult: Set<(p: NodeResultPayload) => void>;
  envChanged: Set<(p: EnvChangedPayload) => void>;
};

const listeners: EventListeners = {
  modulesChanged: new Set(),
  cronTick: new Set(),
  webhookFired: new Set(),
  mcpChanged: new Set(),
  nodeRunning: new Set(),
  nodeResult: new Set(),
  envChanged: new Set(),
};

let eventSource: EventSource | null = null;
let eventReconnect: ReturnType<typeof setTimeout> | null = null;

function ensureEventSource(): void {
  if (eventSource || typeof window === "undefined") return;
  try {
    const es = new EventSource(`${getApiBase()}/api/events`);
    eventSource = es;
    es.addEventListener("modulesChanged", () => listeners.modulesChanged.forEach((cb) => cb()));
    es.addEventListener("cronTick", (e) => {
      try {
        const p = JSON.parse((e as MessageEvent).data);
        listeners.cronTick.forEach((cb) => cb(p));
      } catch {}
    });
    es.addEventListener("webhookFired", (e) => {
      try {
        const p = JSON.parse((e as MessageEvent).data);
        listeners.webhookFired.forEach((cb) => cb(p));
      } catch {}
    });
    es.addEventListener("mcpChanged", () => listeners.mcpChanged.forEach((cb) => cb()));
    es.addEventListener("nodeRunning", (e) => {
      try {
        const p = JSON.parse((e as MessageEvent).data);
        listeners.nodeRunning.forEach((cb) => cb(p));
      } catch {}
    });
    es.addEventListener("nodeResult", (e) => {
      try {
        const p = JSON.parse((e as MessageEvent).data);
        listeners.nodeResult.forEach((cb) => cb(p));
      } catch {}
    });
    es.addEventListener("envChanged", (e) => {
      try {
        const p = JSON.parse((e as MessageEvent).data);
        listeners.envChanged.forEach((cb) => cb(p));
      } catch {}
    });
    es.onerror = () => {
      es.close();
      eventSource = null;
      if (!eventReconnect) {
        eventReconnect = setTimeout(() => {
          eventReconnect = null;
          ensureEventSource();
        }, 2000);
      }
    };
  } catch {}
}

function subscribe<K extends keyof EventListeners>(
  ev: K,
  cb: EventListeners[K] extends Set<infer F> ? F : never,
): () => void {
  ensureEventSource();
  (listeners[ev] as Set<unknown>).add(cb as unknown);
  return () => (listeners[ev] as Set<unknown>).delete(cb as unknown);
}

// ---------- API implementation ----------

const api: N2nApi = {
  listModules: () => http("GET", "/api/modules"),
  runModule: (id, inputs, params, letters, env) =>
    http("POST", `/api/modules/${encodeURIComponent(id)}/run`, { inputs, params, letters, env }),
  openModulesFolder: async () => {
    /* server-side dialog not applicable for web; no-op */
  },
  onModulesChanged: (cb) => subscribe("modulesChanged", cb),

  loadEnv: () => http("GET", "/api/env"),
  saveEnv: async (env) => {
    await http("PUT", "/api/env", env);
  },

  chatStream: (messages, onChunk, options) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const controller = new AbortController();

    const promise: Promise<ChatResult> = (async () => {
      let res: Response;
      try {
        res = await fetch(`${getApiBase()}/api/ai/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
          body: JSON.stringify({ id, messages, options }),
          signal: controller.signal,
        });
      } catch (e) {
        const err = e as Error;
        if (err.name === "AbortError") return { ok: true, aborted: true };
        return { ok: false, error: `fetch: ${err.message}` };
      }
      if (!res.ok || !res.body) {
        return { ok: false, error: `HTTP ${res.status}: ${await res.text().catch(() => "")}` };
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let final: ChatResult = { ok: false, error: "stream incomplete" };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() || "";
          for (const block of blocks) {
            const lines = block.split("\n");
            let evName = "message";
            const dataLines: string[] = [];
            for (const line of lines) {
              if (line.startsWith("event:")) evName = line.slice(6).trim();
              else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
            }
            if (dataLines.length === 0) continue;
            const raw = dataLines.join("\n");
            if (evName === "chunk") {
              try { onChunk(JSON.parse(raw)); } catch {}
            } else if (evName === "done") {
              try { final = JSON.parse(raw); } catch {}
            }
          }
        }
      } catch (e) {
        const err = e as Error;
        if (err.name === "AbortError") return { ok: true, aborted: true };
        return { ok: false, error: `stream: ${err.message}` };
      }
      return final;
    })();

    return {
      promise,
      abort: () => {
        controller.abort();
        // best-effort server-side abort too
        http("POST", "/api/ai/abort", { id }).catch(() => {});
      },
    };
  },

  createModule: (args) => http("POST", "/api/modules", args),
  deleteModule: async (id) => {
    await http("DELETE", `/api/modules/${encodeURIComponent(id)}`);
  },
  listModuleFiles: (id) => http("GET", `/api/modules/${encodeURIComponent(id)}/files`),
  readModuleFile: (id, file) =>
    http("GET", `/api/modules/${encodeURIComponent(id)}/file?path=${encodeURIComponent(file)}`),
  writeModuleFile: async (id, file, content) => {
    await http("PUT", `/api/modules/${encodeURIComponent(id)}/file?path=${encodeURIComponent(file)}`, content, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
  deleteModuleFile: async (id, file) => {
    await http("DELETE", `/api/modules/${encodeURIComponent(id)}/file?path=${encodeURIComponent(file)}`);
  },

  listProjects: () => http("GET", "/api/projects"),
  loadProject: (id) => http("GET", `/api/projects/${encodeURIComponent(id)}`),
  saveProject: (project) => http("PUT", `/api/projects/${encodeURIComponent(project.id)}`, project),
  createProject: (name) => http("POST", "/api/projects", { name }),
  renameProject: (id, name) => http("POST", `/api/projects/${encodeURIComponent(id)}/rename`, { name }),
  deleteProject: async (id) => {
    await http("DELETE", `/api/projects/${encodeURIComponent(id)}`);
  },
  duplicateProject: (id) => http("POST", `/api/projects/${encodeURIComponent(id)}/duplicate`),
  getActiveProjectId: async () => {
    const { id } = await http<{ id: string | null }>("GET", "/api/projects/active");
    return id;
  },
  setActiveProjectId: async (id) => {
    await http("PUT", "/api/projects/active", { id });
  },

  exportProjectToFile: async (id) => {
    if (typeof window === "undefined") return { canceled: true } as const;
    try {
      const res = await fetch(`${getApiBase()}/api/projects/${encodeURIComponent(id)}/export`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") || "";
      const m = /filename="?([^";]+)"?/.exec(cd);
      const filename = m ? m[1] : `${id}.n2n.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      return { canceled: false, path: filename };
    } catch {
      return { canceled: true };
    }
  },

  importProjectFromFile: () => {
    if (typeof window === "undefined") return Promise.resolve({ canceled: true } as ImportResult);
    return new Promise<ImportResult>((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return resolve({ canceled: true });
        const text = await file.text();
        try {
          const result = await http<ImportResult>(
            "POST",
            `/api/projects/import?filename=${encodeURIComponent(file.name)}`,
            text,
            { headers: { "Content-Type": "text/plain; charset=utf-8" } },
          );
          resolve(result);
        } catch (e) {
          resolve({ canceled: false, error: (e as Error).message });
        }
      };
      // Cancel detection: if focus comes back without a file, treat as cancel.
      const onFocus = () => {
        setTimeout(() => {
          if (!input.files?.length) resolve({ canceled: true });
          window.removeEventListener("focus", onFocus);
        }, 300);
      };
      window.addEventListener("focus", onFocus);
      input.click();
    });
  },

  cronRegister: async (id, intervalMs, projectId) => {
    await http("POST", "/api/cron/register", { id, intervalMs, projectId });
  },
  cronUnregister: async (id) => {
    await http("POST", "/api/cron/unregister", { id });
  },
  cronUnregisterAll: async () => {
    await http("POST", "/api/cron/unregisterAll");
  },
  onCronTick: (cb) => subscribe("cronTick", cb),

  webhookRegister: async (nodeId, path, response, projectId) => {
    await http("POST", "/api/webhooks/register", { nodeId, path, response, projectId });
  },
  webhookUnregister: async (nodeId) => {
    await http("POST", "/api/webhooks/unregister", { nodeId });
  },
  webhookUnregisterAll: async () => {
    await http("POST", "/api/webhooks/unregisterAll");
  },
  webhookPort: async () => {
    const { port } = await http<{ port: number }>("GET", "/api/webhooks/port");
    return port;
  },
  onWebhookFired: (cb) => subscribe("webhookFired", cb),

  appendHistory: async (entry) => {
    await http("POST", "/api/history", entry);
  },
  readHistory: (limit) => http("GET", `/api/history${limit !== undefined ? `?limit=${limit}` : ""}`),
  clearHistory: async () => {
    await http("DELETE", "/api/history");
  },

  mcpList: () => http("GET", "/api/mcp"),
  mcpSave: (name, config) => http("PUT", `/api/mcp/${encodeURIComponent(name)}`, config),
  mcpDelete: async (name) => {
    await http("DELETE", `/api/mcp/${encodeURIComponent(name)}`);
  },
  mcpRestart: async (name) => {
    await http("POST", `/api/mcp/${encodeURIComponent(name)}/restart`);
  },
  mcpCallTool: (server, tool, args) =>
    http("POST", "/api/mcp/call", { server, tool, args }),
  onMcpChanged: (cb) => subscribe("mcpChanged", cb),
  onNodeRunning: (cb) => subscribe("nodeRunning", cb),
  onNodeResult: (cb) => subscribe("nodeResult", cb),
  onEnvChanged: (cb) => subscribe("envChanged", cb),
  runProjectNode: (projectId, nodeId) =>
    http("POST", `/api/projects/${encodeURIComponent(projectId)}/run/${encodeURIComponent(nodeId)}`),
};

export function getApi(): N2nApi | null {
  if (typeof window === "undefined") return null;
  // Prefer Electron preload bridge if present (back-compat); fall back to HTTP.
  if (window.n2n) return window.n2n;
  return api;
}
