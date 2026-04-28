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
  cronRegister: (id: string, intervalMs: number) => Promise<void>;
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
    secret?: string,
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
};

declare global {
  interface Window {
    n2n?: N2nApi;
  }
}

// ---------- HTTP client ----------

// Server profiles — the user can save several n2n backends (local desktop,
// staging VPS, prod, …) and switch between them. The active profile drives
// every fetch + the SSE event channel. A single legacy `n2n:apiUrl` is
// migrated into a profile on first read so existing installs keep working.
//
// Resolution order for the active base URL:
//   1. active profile in localStorage["n2n:servers" / "n2n:activeServer"]
//   2. NEXT_PUBLIC_N2N_API at build time
//   3. window.__N2N_API__ injected at runtime (e.g. by an Apache rewrite)
//   4. http://localhost:9999
const PROFILES_KEY = "n2n:servers";
const ACTIVE_KEY = "n2n:activeServer";
const LEGACY_URL_KEY = "n2n:apiUrl";

export type ServerProfile = {
  id: string;
  label: string;
  url: string;
  /** Optional bearer token sent as `Authorization: Bearer <token>`. */
  token?: string;
};

function readProfilesRaw(): ServerProfile[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PROFILES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((p) => p && typeof p.url === "string")
          .map((p) => ({
            id: String(p.id || `srv-${Math.random().toString(36).slice(2, 8)}`),
            label: String(p.label || p.url),
            url: String(p.url).replace(/\/+$/, ""),
            token: p.token ? String(p.token) : undefined,
          }));
      }
    }
    // Migrate legacy single-URL setting to a profile.
    const legacy = window.localStorage.getItem(LEGACY_URL_KEY);
    if (legacy) {
      const url = legacy.replace(/\/+$/, "");
      const seed: ServerProfile[] = [
        { id: "legacy", label: url, url },
      ];
      window.localStorage.setItem(PROFILES_KEY, JSON.stringify(seed));
      window.localStorage.setItem(ACTIVE_KEY, "legacy");
      window.localStorage.removeItem(LEGACY_URL_KEY);
      return seed;
    }
  } catch {}
  return [];
}

function writeProfiles(list: ServerProfile[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PROFILES_KEY, JSON.stringify(list));
  } catch {}
}

export function listServerProfiles(): ServerProfile[] {
  return readProfilesRaw();
}

export function getActiveProfileId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const id = window.localStorage.getItem(ACTIVE_KEY);
    if (id) return id;
  } catch {}
  return null;
}

export function getActiveProfile(): ServerProfile | null {
  const profiles = readProfilesRaw();
  if (profiles.length === 0) return null;
  const id = getActiveProfileId();
  if (id) {
    const found = profiles.find((p) => p.id === id);
    if (found) return found;
  }
  return profiles[0] ?? null;
}

function generateProfileId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `srv-${Math.random().toString(36).slice(2, 10)}`;
}

export function upsertServerProfile(input: {
  id?: string;
  label?: string;
  url: string;
  token?: string;
}): ServerProfile {
  const list = readProfilesRaw();
  const url = input.url.trim().replace(/\/+$/, "");
  const token = (input.token || "").trim() || undefined;
  const label = (input.label || "").trim() || url;
  if (input.id) {
    const i = list.findIndex((p) => p.id === input.id);
    if (i >= 0) {
      list[i] = { ...list[i], label, url, token };
      writeProfiles(list);
      return list[i];
    }
  }
  const profile: ServerProfile = { id: generateProfileId(), label, url, token };
  list.push(profile);
  writeProfiles(list);
  return profile;
}

export function removeServerProfile(id: string): void {
  const list = readProfilesRaw().filter((p) => p.id !== id);
  writeProfiles(list);
  const active = getActiveProfileId();
  if (active === id) {
    const next = list[0]?.id;
    if (typeof window !== "undefined") {
      try {
        if (next) window.localStorage.setItem(ACTIVE_KEY, next);
        else window.localStorage.removeItem(ACTIVE_KEY);
      } catch {}
    }
  }
}

/** Switch the active server. Pass `null` to clear. The SSE channel is
 * recycled if any listeners are subscribed. */
export function setActiveProfile(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id) window.localStorage.setItem(ACTIVE_KEY, id);
    else window.localStorage.removeItem(ACTIVE_KEY);
  } catch {}
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

export function getApiBase(): string {
  if (typeof window !== "undefined") {
    const active = getActiveProfile();
    if (active?.url) return active.url;
    const injected = (window as unknown as { __N2N_API__?: string }).__N2N_API__;
    if (injected) return injected.replace(/\/+$/, "");
  }
  if (typeof process !== "undefined" && process.env.NEXT_PUBLIC_N2N_API) {
    return process.env.NEXT_PUBLIC_N2N_API.replace(/\/+$/, "");
  }
  return "http://localhost:9999";
}

export function getApiToken(): string | null {
  if (typeof window === "undefined") return null;
  const active = getActiveProfile();
  return active?.token?.trim() || null;
}

export type ServerInfo = {
  name: string;
  version: string;
  apiPort: number;
  webhookPort: number;
  host: string;
  /** Whether the server requires an Authorization: Bearer token. */
  authRequired?: boolean;
};

export async function pingServer(
  url: string,
  options?: { token?: string; signal?: AbortSignal },
): Promise<ServerInfo> {
  const clean = url.trim().replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  const token = options?.token?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${clean}/api/info`, {
    headers,
    signal: options?.signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Same as pingServer but also pings /api/health WITH the token, so the
 * caller can know the token is valid even if /api/info is public. */
export async function probeAuth(
  url: string,
  token: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number }> {
  const clean = url.trim().replace(/\/+$/, "");
  const res = await fetch(`${clean}/api/health`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  return { ok: res.ok, status: res.status };
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
  const token = getApiToken();
  if (token && !headers.Authorization) headers.Authorization = `Bearer ${token}`;
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
};

const listeners: EventListeners = {
  modulesChanged: new Set(),
  cronTick: new Set(),
  webhookFired: new Set(),
  mcpChanged: new Set(),
};

let eventSource: EventSource | null = null;
let eventReconnect: ReturnType<typeof setTimeout> | null = null;

function ensureEventSource(): void {
  if (eventSource || typeof window === "undefined") return;
  try {
    // EventSource can't set headers, so we authenticate via ?token=… when a
    // token is configured. The server checks both the header and the query.
    const token = getApiToken();
    const eventUrl =
      `${getApiBase()}/api/events` +
      (token ? `?token=${encodeURIComponent(token)}` : "");
    const es = new EventSource(eventUrl);
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
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        };
        const token = getApiToken();
        if (token) headers.Authorization = `Bearer ${token}`;
        res = await fetch(`${getApiBase()}/api/ai/chat`, {
          method: "POST",
          headers,
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
      const token = getApiToken();
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(
        `${getApiBase()}/api/projects/${encodeURIComponent(id)}/export`,
        { headers },
      );
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

  cronRegister: async (id, intervalMs) => {
    await http("POST", "/api/cron/register", { id, intervalMs });
  },
  cronUnregister: async (id) => {
    await http("POST", "/api/cron/unregister", { id });
  },
  cronUnregisterAll: async () => {
    await http("POST", "/api/cron/unregisterAll");
  },
  onCronTick: (cb) => subscribe("cronTick", cb),

  webhookRegister: async (nodeId, path, response, secret) => {
    await http("POST", "/api/webhooks/register", { nodeId, path, response, secret });
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
};

export function getApi(): N2nApi | null {
  if (typeof window === "undefined") return null;
  // Prefer Electron preload bridge if present (back-compat); fall back to HTTP.
  if (window.n2n) return window.n2n;
  return api;
}
