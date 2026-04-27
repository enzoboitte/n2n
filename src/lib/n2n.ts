import type {
  CanvasNode,
  Edge,
  ModuleManifest,
  RunResult,
} from "./types";

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

export type ExportResult =
  | { canceled: true }
  | { canceled: false; path: string };

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
  // Projets
  listProjects: () => Promise<ProjectMeta[]>;
  loadProject: (id: string) => Promise<Project>;
  saveProject: (project: Project) => Promise<{ id: string }>;
  createProject: (name?: string) => Promise<Project>;
  renameProject: (
    id: string,
    name: string,
  ) => Promise<{ id: string; name: string }>;
  deleteProject: (id: string) => Promise<void>;
  duplicateProject: (id: string) => Promise<Project>;
  getActiveProjectId: () => Promise<string | null>;
  setActiveProjectId: (id: string) => Promise<void>;
  exportProjectToFile: (id: string) => Promise<ExportResult>;
  importProjectFromFile: () => Promise<ImportResult>;
  // Cron
  cronRegister: (id: string, intervalMs: number) => Promise<void>;
  cronUnregister: (id: string) => Promise<void>;
  cronUnregisterAll: () => Promise<void>;
  onCronTick: (callback: (payload: { id: string }) => void) => () => void;
  // Webhooks
  webhookRegister: (
    nodeId: string,
    path: string,
    response?: {
      status?: string | number;
      contentType?: string;
      body?: string;
      headers?: Record<string, string>;
    },
  ) => Promise<void>;
  webhookUnregister: (nodeId: string) => Promise<void>;
  webhookUnregisterAll: () => Promise<void>;
  webhookPort: () => Promise<number>;
  onWebhookFired: (callback: (event: WebhookEvent) => void) => () => void;
  // History
  appendHistory: (entry: HistoryEntry) => Promise<void>;
  readHistory: (limit?: number) => Promise<HistoryEntry[]>;
  clearHistory: () => Promise<void>;
  // MCP
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

export function getApi(): N2nApi | null {
  if (typeof window === "undefined") return null;
  return window.n2n ?? null;
}
