// n2n server — TypeScript + Bun. Replaces electron/main.cjs as the headless
// backend. Web UI (Next.js) connects via HTTP + SSE.
//
// Build a single-binary release with:
//   bun build --compile --target=bun-linux-x64 server/index.ts -o n2n-server
//
// In dev:
//   bun --watch server/index.ts        (with CORS open to localhost:3000)

import { spawn, type Subprocess } from "bun";
import { mkdir, readFile, writeFile, readdir, rm, copyFile, appendFile, access, unlink } from "node:fs/promises";
import { watch as fsWatch, type FSWatcher } from "node:fs";
import { join, resolve, dirname, basename, sep } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
// Macro: bun bundles assets/modules/ into the compiled binary as a literal.
// At dev time (bun --watch) this still runs and reads from disk, so module
// edits round-trip without an extra build step.
import { loadEmbeddedModules } from "./embed-modules.ts" with { type: "macro" };

const EMBEDDED_MODULES = loadEmbeddedModules();

// ---------- paths & env ----------

const N2N_DIR = join(homedir(), ".n2n");
const MODULES_DIR = join(N2N_DIR, "modules");
const ENV_PATH = join(N2N_DIR, "env.json");
const PROJECTS_DIR = join(N2N_DIR, "projects");
const STATE_PATH = join(N2N_DIR, "state.json");
const HISTORY_PATH = join(N2N_DIR, "history.jsonl");
const HISTORY_MAX_LINES = 5000;
const MCP_SERVERS_PATH = join(N2N_DIR, "mcp-servers.json");
const BUNDLED_MODULES_DIR = join(import.meta.dir, "..", "assets", "modules");
const PYTHON = process.env.N2N_PYTHON || "python3";
const LLAMA_URL = process.env.N2N_LLAMA_URL || "http://localhost:8080/v1/chat/completions";
const HOST = process.env.N2N_HOST || "0.0.0.0";
const API_PORT = parseInt(process.env.N2N_PORT || "9999", 10);
// If set, webhooks listen on this dedicated port; otherwise webhooks share API_PORT.
const WEBHOOK_PORT_RAW = process.env.N2N_WEBHOOK_PORT;
const WEBHOOK_PORT = WEBHOOK_PORT_RAW ? parseInt(WEBHOOK_PORT_RAW, 10) : null;
const ALLOWED_ORIGIN = process.env.N2N_CORS_ORIGIN || "*";
// Optional bearer token. When set, every /api/* call must present
// `Authorization: Bearer <token>` (or `?token=` for SSE/EventSource which
// can't set headers). Webhooks ignore this — they have their own per-route
// secret. /api/health and /api/info always stay reachable so onboarding
// clients can probe the server before authenticating.
const API_TOKEN = (process.env.N2N_API_TOKEN || "").trim();

const DEPRECATED_MODULES = [
  "bool-source", "bool-and", "bool-or", "bool-not", "bool-xor",
  "branch", "branch-length", "branch-contains", "branch-equals", "code",
];

// ---------- fs helpers ----------

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function copyDir(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const sp = join(src, entry.name);
    const dp = join(dst, entry.name);
    if (entry.isDirectory()) await copyDir(sp, dp);
    else await copyFile(sp, dp);
  }
}

async function readManifest(dir: string): Promise<any | null> {
  try { return JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")); }
  catch { return null; }
}

async function syncModule(srcDir: string, dstDir: string): Promise<void> {
  if (!(await exists(dstDir))) { await copyDir(srcDir, dstDir); return; }
  const src = await readManifest(srcDir);
  const dst = await readManifest(dstDir);
  const same = src && dst && src.version && src.version === dst.version;
  if (same) return;
  await rm(dstDir, { recursive: true, force: true });
  await copyDir(srcDir, dstDir);
}

async function syncEmbeddedModule(
  id: string,
  files: Record<string, string>,
): Promise<void> {
  const manifestRaw = files["manifest.json"];
  if (!manifestRaw) return;
  let manifest: any;
  try { manifest = JSON.parse(manifestRaw); }
  catch { return; }
  const dstDir = join(MODULES_DIR, id);
  if (await exists(dstDir)) {
    const existing = await readManifest(dstDir);
    if (existing?.version && manifest?.version && existing.version === manifest.version) return;
    await rm(dstDir, { recursive: true, force: true });
  }
  await mkdir(dstDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dstDir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

async function ensureModulesDir(): Promise<void> {
  await mkdir(MODULES_DIR, { recursive: true });
  for (const id of DEPRECATED_MODULES) {
    const dir = join(MODULES_DIR, id);
    if (await exists(dir)) {
      await rm(dir, { recursive: true, force: true });
      console.log(`[n2n] removed deprecated module: ${id}`);
    }
  }
  // Prefer the on-disk bundle when running from source — keeps `bun --watch`
  // hot-reloads honest. The compiled binary has no assets/ folder, so it
  // falls back to the EMBEDDED_MODULES literal inlined at build time.
  if (await exists(BUNDLED_MODULES_DIR)) {
    for (const entry of await readdir(BUNDLED_MODULES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      await syncModule(join(BUNDLED_MODULES_DIR, entry.name), join(MODULES_DIR, entry.name));
    }
    return;
  }
  for (const [id, files] of Object.entries(EMBEDDED_MODULES)) {
    await syncEmbeddedModule(id, files);
  }
}

// ---------- modules ----------

async function listModules(): Promise<any[]> {
  await ensureModulesDir();
  const out: any[] = [];
  for (const entry of await readdir(MODULES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      out.push(JSON.parse(await readFile(join(MODULES_DIR, entry.name, "manifest.json"), "utf8")));
    } catch (err: any) {
      console.warn(`[n2n] skip ${entry.name}: ${err.message}`);
    }
  }
  return out;
}

function moduleFilePath(id: string, file: string): string {
  if (!/^[a-z0-9._-]+$/i.test(id)) throw new Error(`Module id invalide: ${id}`);
  const dir = join(MODULES_DIR, id);
  const target = resolve(dir, file || "");
  const dirReal = resolve(dir);
  if (target !== dirReal && !target.startsWith(dirReal + sep)) {
    throw new Error("Chemin hors du module");
  }
  return target;
}

async function createModule(args: { id: string; manifest?: any; code?: string }): Promise<{ id: string }> {
  const { id, manifest, code } = args;
  if (!/^[a-z0-9._-]+$/i.test(id)) throw new Error("ID invalide (a-z, 0-9, ., _, -)");
  const dir = join(MODULES_DIR, id);
  if (await exists(dir)) throw new Error(`Module ${id} existe déjà`);
  await mkdir(dir, { recursive: true });
  const finalManifest = {
    id,
    name: manifest?.name || id,
    description: manifest?.description || "",
    version: manifest?.version || "0.1.0",
    color: manifest?.color || "#64748b",
    entry: "module.py",
    inputs: manifest?.inputs || [],
    outputs: manifest?.outputs || [{ name: "value", label: "Valeur", type: "any" }],
    params: manifest?.params || [],
    ...(manifest?.configurable ? { configurable: true } : {}),
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(finalManifest, null, 2));
  await writeFile(join(dir, "module.py"), code || defaultModuleCode(id));
  return { id };
}

function defaultModuleCode(id: string): string {
  return `"""Module ${id} — squelette généré."""

import json
import sys
import traceback


def run(inputs: dict, params: dict, letters: dict, env: dict) -> dict:
    # TODO: implémenter
    return {"value": (letters or {}).get("a")}


if __name__ == "__main__":
    payload = json.loads(sys.stdin.read() or "{}")
    try:
        result = run(
            payload.get("inputs") or {},
            payload.get("params") or {},
            payload.get("letters") or {},
            payload.get("env") or {},
        )
        sys.stdout.write(json.dumps(result, default=str))
    except Exception:
        sys.stderr.write(traceback.format_exc())
        sys.exit(1)
`;
}

async function deleteModule(id: string): Promise<void> {
  const dir = moduleFilePath(id, "");
  await rm(dir, { recursive: true, force: true });
}

async function listModuleFiles(id: string): Promise<{ path: string; kind: "file" | "dir" }[]> {
  const dir = moduleFilePath(id, "");
  if (!(await exists(dir))) throw new Error(`Module ${id} introuvable`);
  const out: { path: string; kind: "file" | "dir" }[] = [];
  const walk = async (cur: string, rel: string) => {
    for (const e of await readdir(cur, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push({ path: r, kind: "dir" });
        await walk(join(cur, e.name), r);
      } else {
        out.push({ path: r, kind: "file" });
      }
    }
  };
  await walk(dir, "");
  return out;
}

async function readModuleFile(id: string, file: string): Promise<string> {
  return readFile(moduleFilePath(id, file), "utf8");
}

async function writeModuleFile(id: string, file: string, content: string): Promise<void> {
  const p = moduleFilePath(id, file);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content ?? "");
}

async function deleteModuleFile(id: string, file: string): Promise<void> {
  await rm(moduleFilePath(id, file), { recursive: true, force: true });
}

function runPythonModule(args: {
  id: string;
  inputs?: any; params?: any; letters?: any; env?: any;
}): Promise<{ ok: boolean; outputs?: any; error?: string }> {
  return new Promise(async (resolve) => {
    const dir = join(MODULES_DIR, args.id);
    let manifest: any;
    try {
      manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
    } catch (err: any) {
      return resolve({ ok: false, error: `manifest: ${err.message}` });
    }
    const entry = join(dir, manifest.entry || "module.py");
    const child = spawn({
      cmd: [PYTHON, entry],
      cwd: dir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    child.stdin.write(JSON.stringify({
      inputs: args.inputs || {},
      params: args.params || {},
      letters: args.letters || {},
      env: args.env || {},
    }));
    child.stdin.end();

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) {
      return resolve({ ok: false, error: stderr.trim() || `exit ${exitCode}` });
    }
    try {
      const outputs = stdout.trim() ? JSON.parse(stdout) : {};
      resolve({ ok: true, outputs });
    } catch (err: any) {
      resolve({ ok: false, error: `JSON output invalide: ${err.message}\n${stdout}` });
    }
  });
}

// ---------- env ----------

async function loadEnv(): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(ENV_PATH, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}
  return {};
}

async function saveEnv(env: Record<string, string>): Promise<void> {
  await mkdir(N2N_DIR, { recursive: true });
  await writeFile(ENV_PATH, JSON.stringify(env || {}, null, 2));
}

// ---------- projects ----------

function projectFile(id: string): string {
  if (!/^[a-z0-9._-]+$/i.test(id)) throw new Error(`ID projet invalide: ${id}`);
  return join(PROJECTS_DIR, `${id}.json`);
}

async function listProjects(): Promise<any[]> {
  await mkdir(PROJECTS_DIR, { recursive: true });
  const files = await readdir(PROJECTS_DIR);
  const out: any[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const p = JSON.parse(await readFile(join(PROJECTS_DIR, f), "utf8"));
      if (p && p.id) out.push({
        id: p.id, name: p.name || "(sans nom)",
        createdAt: p.createdAt || 0, updatedAt: p.updatedAt || 0,
      });
    } catch {}
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function loadProject(id: string): Promise<any> {
  return JSON.parse(await readFile(projectFile(id), "utf8"));
}

async function saveProjectFile(project: any): Promise<{ id: string }> {
  if (!project || !project.id) throw new Error("Projet sans id");
  await mkdir(PROJECTS_DIR, { recursive: true });
  await writeFile(projectFile(project.id), JSON.stringify(project, null, 2));
  return { id: project.id };
}

async function createProject(name?: string): Promise<any> {
  const id = randomUUID();
  const now = Date.now();
  const project = { id, name: name || "Untitled", createdAt: now, updatedAt: now, nodes: [], edges: [] };
  await saveProjectFile(project);
  return project;
}

async function deleteProject(id: string): Promise<void> {
  await rm(projectFile(id), { force: true });
}

async function renameProject(id: string, name: string): Promise<{ id: string; name: string }> {
  const p = await loadProject(id);
  p.name = String(name || "Untitled");
  p.updatedAt = Date.now();
  await saveProjectFile(p);
  return { id, name: p.name };
}

async function duplicateProject(id: string): Promise<any> {
  const src = await loadProject(id);
  const newId = randomUUID();
  const now = Date.now();
  const dup = { ...src, id: newId, name: `${src.name} (copie)`, createdAt: now, updatedAt: now };
  await saveProjectFile(dup);
  return dup;
}

async function loadState(): Promise<any> {
  try { return JSON.parse(await readFile(STATE_PATH, "utf8")) || {}; } catch { return {}; }
}

async function saveState(state: any): Promise<void> {
  await mkdir(N2N_DIR, { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state || {}, null, 2));
}

async function getActiveProjectId(): Promise<string | null> {
  return (await loadState()).activeProjectId || null;
}

async function setActiveProjectId(id: string): Promise<void> {
  const s = await loadState();
  s.activeProjectId = id;
  await saveState(s);
}

async function importProjectFromBuffer(filename: string, raw: string): Promise<{ canceled: false; project: any } | { canceled: false; error: string }> {
  let parsed: any;
  try { parsed = JSON.parse(raw); }
  catch (err: any) { return { canceled: false, error: `JSON invalide: ${err.message}` }; }
  const id = randomUUID();
  const now = Date.now();
  const project = {
    id,
    name: typeof parsed.name === "string" && parsed.name.trim()
      ? parsed.name + " (importé)"
      : basename(filename || "imported", ".json") + " (importé)",
    createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : now,
    updatedAt: now,
    nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
    edges: Array.isArray(parsed.edges) ? parsed.edges : [],
  };
  await saveProjectFile(project);
  return { canceled: false, project };
}

// ---------- history ----------

async function appendHistory(entry: any): Promise<void> {
  await mkdir(N2N_DIR, { recursive: true });
  await appendFile(HISTORY_PATH, JSON.stringify(entry) + "\n");
  if (Math.random() < 0.01) await trimHistory();
}

async function trimHistory(): Promise<void> {
  try {
    const content = await readFile(HISTORY_PATH, "utf8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length > HISTORY_MAX_LINES) {
      await writeFile(HISTORY_PATH, lines.slice(-HISTORY_MAX_LINES).join("\n") + "\n");
    }
  } catch {}
}

async function readHistory(limit = 200): Promise<any[]> {
  try {
    const content = await readFile(HISTORY_PATH, "utf8");
    const lines = content.split("\n").filter(Boolean);
    return lines.slice(-Math.max(1, limit)).reverse()
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

async function clearHistory(): Promise<void> {
  try { await unlink(HISTORY_PATH); } catch {}
}

// ---------- event bus (SSE) ----------

type EventName =
  | "modulesChanged"
  | "mcpChanged"
  | "nodeRunStart"
  | "nodeRunEnd"
  | "envChanged";

const eventClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const sseEncoder = new TextEncoder();

function broadcast(event: EventName, data?: any): void {
  const payload = sseEncoder.encode(
    `event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`,
  );
  for (const c of eventClients) {
    try { c.enqueue(payload); } catch {}
  }
}

function eventStream(): Response {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      eventClients.add(controller);
      // Initial comment to flush headers and keep proxies alive
      controller.enqueue(sseEncoder.encode(": connected\n\n"));
    },
    cancel() {
      if (controllerRef) eventClients.delete(controllerRef);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      ...corsHeaders(),
    },
  });
}

// ---------- module watcher ----------

let moduleWatcher: FSWatcher | null = null;
function attachModuleWatcher(): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    moduleWatcher = fsWatch(MODULES_DIR, { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        invalidateManifestCache();
        broadcast("modulesChanged");
      }, 200);
    });
  } catch (err: any) {
    console.warn(`[n2n] module watcher disabled: ${err.message}`);
  }
}

// ---------- runtime helpers ----------
// These are server-side ports of the graph-execution helpers that used to
// live in the client. The server is now authoritative for execution so that
// "automatic" workflows (cron-tick, webhook-receive, env-watch) can run with
// no UI connected.

function indexToLetter(i: number): string {
  let n = i;
  let s = "";
  while (true) {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return s;
}

function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const VAR_RE = /\{([a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z0-9_$]+)*)\}/g;

function getPath(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (Number.isFinite(idx)) { cur = cur[idx]; continue; }
      return undefined;
    }
    if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[seg];
      continue;
    }
    return undefined;
  }
  return cur;
}

function substituteString(s: string, vars: Record<string, unknown>): string {
  return s.replace(VAR_RE, (match, expr: string) => {
    const parts = expr.split(".");
    const root = parts[0];
    if (!(root in vars)) return match;
    const value =
      parts.length === 1 ? vars[root] : getPath(vars[root], parts.slice(1));
    if (value === undefined || value === null) return match;
    return stringifyValue(value);
  });
}

function substituteDeep(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === "string") return substituteString(value, vars);
  if (Array.isArray(value)) return value.map((v) => substituteDeep(v, vars));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteDeep(v, vars);
    }
    return out;
  }
  return value;
}

function parseHumanInterval(s: string): number {
  const m = String(s || "").match(/^\s*(\d+)\s*(ms|s|m|h|d)?\s*$/i);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || "s").toLowerCase();
  const mult: Record<string, number> = {
    ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000,
  };
  return n * (mult[unit] ?? 1000);
}

type GraphNode = {
  id: string;
  moduleId: string;
  params?: Record<string, unknown>;
  pinned?: Record<string, unknown> | null;
};

type GraphEdge = {
  id: string;
  source: string;
  sourceSocket: string;
  target: string;
};

function downstreamLeaves(startId: string, edges: GraphEdge[]): string[] {
  const reachable = new Set<string>([startId]);
  const queue: string[] = [startId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of edges) {
      if (e.source === cur && !reachable.has(e.target)) {
        reachable.add(e.target);
        queue.push(e.target);
      }
    }
  }
  return Array.from(reachable).filter(
    (id) => !edges.some((e) => e.source === id && reachable.has(e.target)),
  );
}

function coerceMcpArgs(
  args: Record<string, unknown>,
  schema: unknown,
): Record<string, unknown> {
  const properties =
    (schema as { properties?: Record<string, { type?: string }> })?.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    const propType = properties[k]?.type;
    if (typeof v !== "string" || !propType) { out[k] = v; continue; }
    const trimmed = v.trim();
    if (trimmed === "") continue;
    if (propType === "number" || propType === "integer") {
      const n = Number(trimmed);
      out[k] = Number.isFinite(n) ? n : v;
    } else if (propType === "boolean") {
      const lower = trimmed.toLowerCase();
      out[k] = lower === "true" || lower === "1" || lower === "yes";
    } else if (propType === "array" || propType === "object") {
      try { out[k] = JSON.parse(trimmed); } catch { out[k] = v; }
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---------- manifest cache ----------

let manifestCache: Map<string, any> | null = null;

async function getManifests(): Promise<Map<string, any>> {
  if (manifestCache) return manifestCache;
  const list = await listModules();
  manifestCache = new Map(list.map((m) => [m.id, m]));
  return manifestCache;
}

function invalidateManifestCache(): void {
  manifestCache = null;
}

// ---------- graph runtime ----------

type RunResult =
  | { ok: true; outputs: Record<string, unknown> }
  | { ok: false; error: string }
  | { skipped: true };

type RunCtx = {
  projectId: string;
  nodesById: Map<string, GraphNode>;
  edges: GraphEdge[];
  manifests: Map<string, any>;
  cache: Map<string, Promise<RunResult>>;
  triggerData: Map<string, any>; // nodeId → webhook request data
  env: Record<string, string>;   // mutable env scoped to this run
  persistEnv: boolean;            // top-level runs persist __env__ writes
  emit: boolean;                  // top-level runs broadcast nodeRun events
};

function emitNodeStart(ctx: RunCtx, nodeId: string): void {
  if (!ctx.emit) return;
  broadcast("nodeRunStart", { projectId: ctx.projectId, nodeId });
}

function emitNodeEnd(ctx: RunCtx, nodeId: string, result: RunResult): void {
  if (!ctx.emit) return;
  broadcast("nodeRunEnd", { projectId: ctx.projectId, nodeId, result });
}

async function runNodeInCtx(ctx: RunCtx, nodeId: string): Promise<RunResult> {
  const cached = ctx.cache.get(nodeId);
  if (cached) return cached;

  const promise = (async (): Promise<RunResult> => {
    const node = ctx.nodesById.get(nodeId);
    if (!node) return { ok: false, error: "Nœud introuvable" };

    if (node.pinned && typeof node.pinned === "object") {
      const r: RunResult = { ok: true, outputs: node.pinned as Record<string, unknown> };
      emitNodeEnd(ctx, nodeId, r);
      return r;
    }

    const incoming = ctx.edges.filter((e) => e.target === nodeId);
    const manifest = ctx.manifests.get(node.moduleId);

    const upstreams = await Promise.all(
      incoming.map((e) => runNodeInCtx(ctx, e.source)),
    );

    const inputs: Record<string, unknown> = {};
    const letters: Record<string, unknown> = {};
    let receivedSignal = incoming.length === 0;

    for (let i = 0; i < incoming.length; i++) {
      const edge = incoming[i];
      const upstream = upstreams[i];
      if ("skipped" in upstream) continue;
      if (!upstream.ok) {
        const r: RunResult = { ok: false, error: `amont: ${upstream.error}` };
        emitNodeEnd(ctx, nodeId, r);
        return r;
      }
      const value = (upstream.outputs as Record<string, unknown>)[edge.sourceSocket];
      if (value === null || value === undefined) continue;
      const namedSlot = manifest?.inputs?.[i] ?? manifest?.inputs?.[0];
      if (namedSlot?.name) inputs[namedSlot.name] = value;
      letters[indexToLetter(i)] = value;
      receivedSignal = true;
    }

    if (!receivedSignal) {
      const r: RunResult = { skipped: true };
      emitNodeEnd(ctx, nodeId, r);
      return r;
    }

    emitNodeStart(ctx, nodeId);
    const startedAt = Date.now();

    const params = (node.params ?? {}) as Record<string, unknown>;
    const vars = { ...ctx.env, ...letters };
    const substituted = substituteDeep(params, vars) as Record<string, unknown>;

    let result: RunResult;
    try {
      if (node.moduleId === "cron-tick") {
        const ms = Date.now();
        result = { ok: true, outputs: { epoch_ms: ms, iso: new Date(ms).toISOString() } };
      } else if (node.moduleId === "webhook-receive") {
        const data = ctx.triggerData.get(nodeId);
        if (!data) {
          result = { skipped: true };
        } else {
          let parsed: unknown = null;
          try {
            parsed = typeof data.body === "string" && data.body
              ? JSON.parse(data.body) : null;
          } catch { parsed = null; }
          result = {
            ok: true,
            outputs: {
              method: data.method,
              body: data.body,
              json: parsed,
              query: data.query,
              headers: data.headers,
            },
          };
        }
      } else if (node.moduleId === "subworkflow") {
        result = await runChildProject(
          String(substituted.project_id || ""),
          inputs.value ?? letters.a ?? null,
          ctx.env,
          ctx.manifests,
        );
      } else if (node.moduleId === "for-each") {
        const list = (inputs.list ?? letters.a) as unknown;
        if (!Array.isArray(list)) {
          result = { ok: false, error: "for-each: l'entrée n'est pas une liste" };
        } else {
          const childId = String(substituted.project_id || "");
          const results: unknown[] = [];
          for (const item of list) {
            const cr = await runChildProject(childId, item, ctx.env, ctx.manifests);
            if ("ok" in cr && cr.ok) {
              const outs = cr.outputs as Record<string, unknown>;
              const firstKey = Object.keys(outs)[0];
              results.push(firstKey !== undefined ? outs[firstKey] : null);
            } else {
              results.push(null);
            }
          }
          result = { ok: true, outputs: { results } };
        }
      } else if (node.moduleId === "mcp-tool") {
        const target = String(substituted.target || "").trim();
        const sep = target.indexOf("::");
        const server = sep >= 0 ? target.slice(0, sep) : "";
        const toolName = sep >= 0 ? target.slice(sep + 2) : "";
        const argsParam = substituted.arguments;
        let toolArgs: Record<string, unknown> = {};
        if (argsParam && typeof argsParam === "object" && !Array.isArray(argsParam)) {
          toolArgs = argsParam as Record<string, unknown>;
        } else if (typeof argsParam === "string" && argsParam.trim()) {
          try {
            const parsed = JSON.parse(argsParam);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              toolArgs = parsed as Record<string, unknown>;
            }
          } catch { /* ignore */ }
        } else if (
          inputs.args && typeof inputs.args === "object" && !Array.isArray(inputs.args)
        ) {
          toolArgs = inputs.args as Record<string, unknown>;
        }
        if (!server || !toolName) {
          result = { ok: false, error: "mcp-tool: server et tool requis" };
        } else {
          const c = mcpClients.get(server);
          if (c?.connected) {
            const tdef = c.tools.find((t) => t.name === toolName);
            if (tdef?.inputSchema) toolArgs = coerceMcpArgs(toolArgs, tdef.inputSchema);
          }
          try {
            const callResult = await callMcpToolByName(server, toolName, toolArgs);
            const content = callResult?.content ?? [];
            const textParts = Array.isArray(content)
              ? content
                  .filter((c: any) => c?.type === "text" && typeof c?.text === "string")
                  .map((c: any) => c.text as string)
              : [];
            result = {
              ok: true,
              outputs: {
                content,
                text: textParts.join("\n"),
                isError: !!callResult?.isError,
              },
            };
          } catch (err: any) {
            result = { ok: false, error: `mcp: ${err?.message || err}` };
          }
        }
      } else if (node.moduleId === "env-watch") {
        // Emits the current value of the watched env var. The downstream
        // re-trigger on env change is handled by scheduleEnvWatchTriggers.
        const key = String(substituted.var || params.var || "");
        const value = key ? ctx.env[key] : "";
        result = { ok: true, outputs: { value: value ?? "" } };
      } else {
        const py = await runPythonModule({
          id: node.moduleId,
          inputs,
          params: substituted,
          letters,
          env: ctx.env,
        });
        if (py.ok) result = { ok: true, outputs: py.outputs ?? {} };
        else result = { ok: false, error: py.error || "erreur inconnue" };
      }

      // __env__ side-effect: only top-level runs persist + broadcast.
      if ("ok" in result && result.ok) {
        const outs = result.outputs as Record<string, unknown>;
        const writes = outs.__env__;
        if (writes && typeof writes === "object" && !Array.isArray(writes)) {
          const stringWrites: Record<string, string> = {};
          for (const [k, v] of Object.entries(writes as Record<string, unknown>)) {
            stringWrites[k] = stringifyValue(v);
          }
          if (ctx.persistEnv) {
            const oldEnv = await loadEnv();
            const newEnv = { ...oldEnv, ...stringWrites };
            await saveEnv(newEnv);
            ctx.env = newEnv;
            broadcast("envChanged", newEnv);
            const changed = new Set<string>();
            for (const [k, v] of Object.entries(stringWrites)) {
              if (oldEnv[k] !== v) changed.add(k);
            }
            if (changed.size) {
              scheduleEnvWatchTriggers(changed).catch(() => undefined);
            }
          } else {
            ctx.env = { ...ctx.env, ...stringWrites };
          }
          const { __env__: _drop, ...rest } = outs;
          result = { ok: true, outputs: rest };
        }
      }
    } catch (err: any) {
      result = { ok: false, error: err?.message || String(err) };
    }

    emitNodeEnd(ctx, nodeId, result);

    const durationMs = Date.now() - startedAt;
    const ok = "ok" in result ? result.ok : false;
    appendHistory({
      timestamp: startedAt,
      projectId: ctx.projectId,
      nodeId,
      moduleId: node.moduleId,
      durationMs,
      ok,
      error: "ok" in result && !result.ok ? result.error : undefined,
      outputs: "ok" in result && result.ok
        ? (result.outputs as Record<string, unknown>) : undefined,
    }).catch(() => undefined);

    return result;
  })();

  ctx.cache.set(nodeId, promise);
  return promise;
}

async function runChildProject(
  projectId: string,
  inputValue: unknown,
  parentEnv: Record<string, string>,
  manifests: Map<string, any>,
): Promise<RunResult> {
  if (!projectId) return { ok: false, error: "subworkflow: project_id manquant" };
  let child: any;
  try { child = await loadProject(projectId); }
  catch (err: any) {
    return { ok: false, error: `subworkflow: ${err?.message || err}` };
  }
  if (!Array.isArray(child?.nodes) || !Array.isArray(child?.edges)) {
    return { ok: false, error: "subworkflow: projet invalide" };
  }
  const ctx: RunCtx = {
    projectId,
    nodesById: new Map(child.nodes.map((n: GraphNode) => [n.id, n])),
    edges: child.edges as GraphEdge[],
    manifests,
    cache: new Map(),
    triggerData: new Map(),
    env: { ...parentEnv, __input__: stringifyValue(inputValue) },
    persistEnv: false,
    emit: false,
  };
  const leaves = (child.nodes as GraphNode[]).filter(
    (n) => !(child.edges as GraphEdge[]).some((e) => e.source === n.id),
  );
  if (leaves.length === 0) return { ok: false, error: "subworkflow: aucune feuille" };
  return runNodeInCtx(ctx, leaves[leaves.length - 1].id);
}

async function buildRunCtx(
  projectId: string,
  options: { triggerData?: { nodeId: string; data: any }; emit?: boolean } = {},
): Promise<{ ctx: RunCtx; project: any } | null> {
  let project: any;
  try { project = await loadProject(projectId); }
  catch { return null; }
  if (!Array.isArray(project?.nodes) || !Array.isArray(project?.edges)) return null;
  const manifests = await getManifests();
  const triggerData = new Map<string, any>();
  if (options.triggerData) {
    triggerData.set(options.triggerData.nodeId, options.triggerData.data);
  }
  const ctx: RunCtx = {
    projectId,
    nodesById: new Map((project.nodes as GraphNode[]).map((n) => [n.id, n])),
    edges: project.edges as GraphEdge[],
    manifests,
    cache: new Map(),
    triggerData,
    env: await loadEnv(),
    persistEnv: true,
    emit: options.emit ?? true,
  };
  return { ctx, project };
}

async function runGraphFromTrigger(
  projectId: string,
  triggerNodeId: string,
  triggerData: any | null,
): Promise<void> {
  const built = await buildRunCtx(projectId, {
    triggerData: triggerData ? { nodeId: triggerNodeId, data: triggerData } : undefined,
    emit: true,
  });
  if (!built) return;
  const { ctx, project } = built;
  const leaves = downstreamLeaves(triggerNodeId, project.edges as GraphEdge[]);
  // If the trigger has no descendants, leaves === [triggerNodeId]; otherwise
  // running leaves walks back up to the trigger via the cache. Either way the
  // trigger node executes exactly once.
  const targets = leaves.length ? leaves : [triggerNodeId];
  await Promise.all(targets.map((id) => runNodeInCtx(ctx, id)));
}

async function runManualNode(
  projectId: string,
  nodeId: string,
): Promise<RunResult> {
  const built = await buildRunCtx(projectId, { emit: true });
  if (!built) return { ok: false, error: "Projet introuvable" };
  const { ctx, project } = built;
  const result = await runNodeInCtx(ctx, nodeId);
  // Also evaluate downstream leaves so side-effects (env writes, http calls,
  // etc.) reach the bottom of the graph — same as the client's old behavior.
  const leaves = downstreamLeaves(nodeId, project.edges as GraphEdge[]);
  await Promise.all(
    leaves.filter((id) => id !== nodeId).map((id) => runNodeInCtx(ctx, id)),
  );
  return result;
}

async function scheduleEnvWatchTriggers(changedKeys: Set<string>): Promise<void> {
  await mkdir(PROJECTS_DIR, { recursive: true });
  let files: string[];
  try { files = await readdir(PROJECTS_DIR); } catch { return; }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    let p: any;
    try { p = JSON.parse(await readFile(join(PROJECTS_DIR, f), "utf8")); } catch { continue; }
    if (!p?.id || !Array.isArray(p.nodes) || !Array.isArray(p.edges)) continue;
    const triggered = new Set<string>();
    for (const node of p.nodes as GraphNode[]) {
      if (node.moduleId !== "env-watch") continue;
      const watched = String((node.params as any)?.var ?? "");
      if (!watched || !changedKeys.has(watched)) continue;
      const leaves = downstreamLeaves(node.id, p.edges as GraphEdge[]);
      for (const leafId of leaves) {
        if (triggered.has(leafId)) continue;
        triggered.add(leafId);
        runGraphFromTrigger(p.id, leafId, null).catch(() => undefined);
      }
    }
  }
}

// ---------- trigger registry ----------
// Scans every project on disk and (re-)installs cron timers and webhook
// routes for each cron-tick / webhook-receive node. Cron timers are
// preserved across syncs when the interval hasn't changed, so editing
// unrelated parts of a project doesn't reset the countdown.

type CronEntry = {
  projectId: string;
  nodeId: string;
  intervalMs: number;
  timer: ReturnType<typeof setInterval>;
};

type WebhookRoute = { nodeId: string; response: any; secret?: string };

const cronTriggers = new Map<string, CronEntry>(); // nodeId → entry
const webhookRoutes = new Map<string, WebhookRoute>(); // path → route
const webhookProjects = new Map<string, string>(); // nodeId → projectId

let triggerSyncInFlight: Promise<void> | null = null;
let triggerSyncQueued = false;

function scheduleTriggerSync(): void {
  if (triggerSyncInFlight) { triggerSyncQueued = true; return; }
  triggerSyncInFlight = (async () => {
    try { await syncProjectTriggers(); }
    catch (e: any) { console.warn(`[n2n] trigger sync: ${e?.message || e}`); }
    finally {
      triggerSyncInFlight = null;
      if (triggerSyncQueued) { triggerSyncQueued = false; scheduleTriggerSync(); }
    }
  })();
}

async function syncProjectTriggers(): Promise<void> {
  type DesiredCron = { projectId: string; nodeId: string; intervalMs: number };
  type DesiredWebhook = {
    projectId: string;
    nodeId: string;
    path: string;
    response: any;
    secret?: string;
  };
  const desiredCrons = new Map<string, DesiredCron>();
  const desiredWebhooks: DesiredWebhook[] = [];

  await mkdir(PROJECTS_DIR, { recursive: true });
  let files: string[];
  try { files = await readdir(PROJECTS_DIR); } catch { files = []; }

  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    let p: any;
    try { p = JSON.parse(await readFile(join(PROJECTS_DIR, f), "utf8")); } catch { continue; }
    if (!p?.id || !Array.isArray(p.nodes)) continue;

    for (const node of p.nodes as GraphNode[]) {
      const params = (node.params ?? {}) as Record<string, unknown>;
      if (node.moduleId === "cron-tick") {
        const intervalMs = parseHumanInterval(String(params.interval ?? ""));
        if (intervalMs < 100) continue;
        desiredCrons.set(node.id, {
          projectId: p.id, nodeId: node.id, intervalMs,
        });
      } else if (node.moduleId === "webhook-receive") {
        const path = String(params.path ?? "").trim();
        if (!path) continue;
        const headersRaw = params.response_headers;
        const headers =
          headersRaw && typeof headersRaw === "object" && !Array.isArray(headersRaw)
            ? Object.fromEntries(
                Object.entries(headersRaw as Record<string, unknown>).map(
                  ([k, v]) => [k, String(v ?? "")],
                ),
              )
            : {};
        desiredWebhooks.push({
          projectId: p.id,
          nodeId: node.id,
          path,
          response: {
            status: String(params.response_status ?? "200"),
            contentType: String(params.response_content_type ?? "application/json"),
            body: String(params.response_body ?? '{"ok":true}'),
            headers,
          },
          secret: String(params.secret ?? "").trim() || undefined,
        });
      }
    }
  }

  // Cron diff: keep timers whose interval is unchanged; replace the rest.
  for (const [nodeId, current] of [...cronTriggers]) {
    const next = desiredCrons.get(nodeId);
    if (
      !next ||
      next.intervalMs !== current.intervalMs ||
      next.projectId !== current.projectId
    ) {
      clearInterval(current.timer);
      cronTriggers.delete(nodeId);
    }
  }
  for (const [nodeId, next] of desiredCrons) {
    if (cronTriggers.has(nodeId)) continue;
    const timer = setInterval(() => {
      runGraphFromTrigger(next.projectId, nodeId, null).catch((e: any) =>
        console.warn(`[n2n] cron ${nodeId}: ${e?.message || e}`),
      );
    }, next.intervalMs);
    cronTriggers.set(nodeId, {
      projectId: next.projectId,
      nodeId: next.nodeId,
      intervalMs: next.intervalMs,
      timer,
    });
  }

  // Webhooks: full rebuild — no timer state to preserve.
  webhookRoutes.clear();
  webhookProjects.clear();
  for (const w of desiredWebhooks) {
    webhookRoutes.set(w.path, {
      nodeId: w.nodeId,
      response: w.response,
      secret: w.secret,
    });
    webhookProjects.set(w.nodeId, w.projectId);
  }
}

function tearDownAllTriggers(): void {
  for (const t of cronTriggers.values()) clearInterval(t.timer);
  cronTriggers.clear();
  webhookRoutes.clear();
  webhookProjects.clear();
}

// ---------- webhooks ----------

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function checkWebhookSecret(req: Request, url: URL, secret: string): boolean {
  if (!secret) return true;
  const auth = req.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    if (constantTimeEqual(auth.slice(7).trim(), secret)) return true;
  }
  const headerKey =
    req.headers.get("x-webhook-secret") || req.headers.get("x-api-key") || "";
  if (headerKey && constantTimeEqual(headerKey, secret)) return true;
  const queryKey = url.searchParams.get("key") || url.searchParams.get("token") || "";
  if (queryKey && constantTimeEqual(queryKey, secret)) return true;
  return false;
}

function substituteRequestVars(s: any, vars: Record<string, any>): any {
  if (typeof s !== "string") return s;
  return s.replace(
    /\{([a-zA-Z_$][a-zA-Z0-9_$-]*(?:\.[a-zA-Z0-9_$-]+)*)\}/g,
    (match, expr: string) => {
      const parts = expr.split(".");
      const root = parts[0];
      if (!(root in vars)) return match;
      let cur: any = vars[root];
      for (let i = 1; i < parts.length; i++) {
        if (cur === null || cur === undefined) return match;
        const seg = parts[i];
        if (Array.isArray(cur)) {
          const idx = Number(seg);
          cur = Number.isFinite(idx) ? cur[idx] : undefined;
        } else if (typeof cur === "object") {
          cur = cur[seg];
        } else return match;
      }
      if (cur === null || cur === undefined) return match;
      if (typeof cur === "object") return JSON.stringify(cur);
      return String(cur);
    },
  );
}

async function handleWebhook(req: Request, route: string): Promise<Response> {
  const target = webhookRoutes.get(route);
  if (!target) {
    return new Response(`no webhook registered for "${route}"`, { status: 404 });
  }
  const url = new URL(req.url);
  if (target.secret && !checkWebhookSecret(req, url, target.secret)) {
    return new Response("unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": "Bearer" },
    });
  }
  const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
  const query = Object.fromEntries(url.searchParams.entries());
  const headers = Object.fromEntries(req.headers.entries());
  let parsedBody: any = null;
  try { parsedBody = body ? JSON.parse(body) : null; } catch {}
  const requestData = { method: req.method, body, json: parsedBody, query, headers, path: route };

  const env = await loadEnv();
  const vars = { request: requestData, ...env };
  const r = target.response || {};
  const status = parseInt(substituteRequestVars(String(r.status ?? "200"), vars), 10) || 200;
  const contentType = substituteRequestVars(String(r.contentType ?? "application/json"), vars) || "application/json";
  const responseBody = substituteRequestVars(String(r.body ?? '{"ok":true}'), vars);
  const respHeaders: Record<string, string> = { "Content-Type": contentType };
  for (const [k, v] of Object.entries(r.headers || {})) {
    const key = substituteRequestVars(String(k), vars);
    const val = substituteRequestVars(String(v), vars);
    if (key) respHeaders[key] = val;
  }

  // Schedule the graph run AFTER the response is ready so the caller doesn't
  // wait for module execution. Errors are logged, not propagated.
  const projectId = webhookProjects.get(target.nodeId);
  if (projectId) {
    queueMicrotask(() => {
      runGraphFromTrigger(projectId, target.nodeId, requestData).catch((e: any) =>
        console.warn(`[n2n] webhook ${target.nodeId}: ${e?.message || e}`),
      );
    });
  }

  return new Response(responseBody, { status, headers: respHeaders });
}

// ---------- MCP (Model Context Protocol) ----------

type McpConfig = { command: string; args: string[]; env: Record<string, string> };
type McpToolSpec = { name: string; description?: string; inputSchema?: any };

class McpClient {
  name: string;
  config: McpConfig;
  proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  tools: McpToolSpec[] = [];
  connected = false;
  error: string | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buffer = "";

  constructor(name: string, config: McpConfig) {
    this.name = name;
    this.config = config;
  }

  async start(): Promise<boolean> {
    try {
      this.proc = spawn({
        cmd: [this.config.command, ...(this.config.args || [])],
        env: { ...process.env, ...(this.config.env || {}) } as Record<string, string>,
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
    } catch (err: any) {
      this.error = `spawn: ${err.message || err}`;
      return false;
    }

    // Read stdout line-by-line
    (async () => {
      if (!this.proc) return;
      const reader = this.proc.stdout.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          this.buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            if (line) this.handleMessage(line);
          }
        }
      } catch {}
    })();

    // Watch exit
    this.proc.exited.then((code) => {
      this.connected = false;
      if (code !== 0 && !this.error) this.error = `Process exited (code ${code})`;
      this.failPending(new Error(this.error || "Process exited"));
    });

    try {
      await this.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "n2n", version: "0.1.0" },
      });
      this.notify("notifications/initialized");
      const result = await this.request("tools/list", {});
      this.tools = result?.tools || [];
      this.connected = true;
      this.error = null;
      return true;
    } catch (err: any) {
      this.error = String(err.message || err);
      this.connected = false;
      return false;
    }
  }

  private handleMessage(line: string): void {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }

  private failPending(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  private send(msg: any): void {
    if (!this.proc || this.proc.killed) throw new Error(`MCP "${this.name}" non démarré`);
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  private request(method: string, params: any, timeoutMs = 30000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.send({ jsonrpc: "2.0", id, method, params: params ?? {} }); }
      catch (err: any) { this.pending.delete(id); reject(err); return; }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }

  private notify(method: string, params?: any): void {
    try { this.send({ jsonrpc: "2.0", method, params: params ?? {} }); } catch {}
  }

  callTool(name: string, args: any): Promise<any> {
    return this.request("tools/call", { name, arguments: args || {} });
  }

  stop(): void {
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill(); } catch {}
    }
    this.proc = null;
    this.connected = false;
    this.failPending(new Error("MCP arrêté"));
  }
}

const mcpClients = new Map<string, McpClient>();
let mcpConfigCache: { servers: Record<string, McpConfig> } | null = null;

async function loadMcpConfig(): Promise<{ servers: Record<string, McpConfig> }> {
  if (mcpConfigCache) return mcpConfigCache;
  try {
    const parsed = JSON.parse(await readFile(MCP_SERVERS_PATH, "utf8"));
    mcpConfigCache = parsed && typeof parsed === "object" && parsed.servers ? parsed : { servers: {} };
  } catch { mcpConfigCache = { servers: {} }; }
  return mcpConfigCache!;
}

async function saveMcpConfig(): Promise<void> {
  if (!mcpConfigCache) mcpConfigCache = { servers: {} };
  await mkdir(N2N_DIR, { recursive: true });
  await writeFile(MCP_SERVERS_PATH, JSON.stringify(mcpConfigCache, null, 2));
}

async function startMcpServer(name: string, config: McpConfig): Promise<void> {
  const existing = mcpClients.get(name);
  if (existing) existing.stop();
  const client = new McpClient(name, config);
  mcpClients.set(name, client);
  await client.start();
  broadcast("mcpChanged");
}

async function stopMcpServer(name: string): Promise<void> {
  const c = mcpClients.get(name);
  if (c) c.stop();
  mcpClients.delete(name);
  broadcast("mcpChanged");
}

async function startAllMcpServers(): Promise<void> {
  const cfg = await loadMcpConfig();
  for (const [name, server] of Object.entries(cfg.servers || {})) {
    await startMcpServer(name, server);
  }
}

function stopAllMcpServers(): void {
  for (const c of mcpClients.values()) c.stop();
  mcpClients.clear();
}

function listMcpState(): any[] {
  const cfg = mcpConfigCache?.servers || {};
  return Object.entries(cfg).map(([name, config]) => {
    const client = mcpClients.get(name);
    return {
      name, command: config.command, args: config.args || [], env: config.env || {},
      connected: !!client?.connected,
      error: client?.error || null,
      tools: client ? client.tools.map((t) => ({
        name: t.name, description: t.description,
        inputSchema: t.inputSchema || { type: "object", properties: {} },
      })) : [],
    };
  });
}

async function callMcpToolByName(server: string, tool: string, args: any): Promise<any> {
  const c = mcpClients.get(server);
  if (!c) throw new Error(`MCP "${server}" non enregistré`);
  if (!c.connected) throw new Error(`MCP "${server}" non connecté: ${c.error || "?"}`);
  return c.callTool(tool, args);
}

// ---------- AI chat (SSE proxy to llama-server) ----------

const activeStreams = new Map<string, AbortController>();

function aiChatStream(args: { id: string; messages: any[]; options?: any }): Response {
  const { id, messages, options } = args;
  const url = options?.url || LLAMA_URL;
  const controller = new AbortController();
  activeStreams.set(id, controller);

  const body: any = {
    model: options?.model || "local",
    messages,
    stream: true,
    temperature: options?.temperature ?? 0.7,
  };
  if (Array.isArray(options?.tools) && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = options?.tool_choice || "auto";
  }
  if (typeof options?.enable_thinking === "boolean") {
    body.chat_template_kwargs = { ...(body.chat_template_kwargs || {}), enable_thinking: options.enable_thinking };
  }

  // Tool calls accumulator (streamed in pieces by the model)
  const toolCallsByIndex = new Map<number, any>();
  let inReasoning = false;
  let finishReason: string | null = null;
  const enc = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const sendChunk = (text: string) => {
        ctrl.enqueue(enc.encode(`event: chunk\ndata: ${JSON.stringify(text)}\n\n`));
      };
      const sendDone = (result: any) => {
        ctrl.enqueue(enc.encode(`event: done\ndata: ${JSON.stringify(result)}\n\n`));
        ctrl.close();
      };

      let resp: Response;
      try {
        resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err: any) {
        activeStreams.delete(id);
        if (err.name === "AbortError") return sendDone({ ok: true, aborted: true });
        return sendDone({ ok: false, error: `fetch: ${err.message || err}` });
      }
      if (!resp.ok) {
        activeStreams.delete(id);
        let errBody = "";
        try { errBody = await resp.text(); } catch {}
        return sendDone({ ok: false, error: `HTTP ${resp.status}: ${errBody.slice(0, 500)}` });
      }
      if (!resp.body) {
        activeStreams.delete(id);
        return sendDone({ ok: false, error: "Pas de corps de réponse" });
      }

      const reader = resp.body.getReader();
      controller.signal.addEventListener("abort", () => { reader.cancel().catch(() => {}); });
      const decoder = new TextDecoder();
      let buffer = "";

      const finalize = () => {
        const toolCalls = Array.from(toolCallsByIndex.values()).filter((tc) => tc.function?.name);
        sendDone({ ok: true, toolCalls, finishReason });
        activeStreams.delete(id);
      };

      try {
        while (true) {
          if (controller.signal.aborted) {
            sendDone({ ok: true, aborted: true });
            activeStreams.delete(id);
            return;
          }
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const raw of lines) {
            const line = raw.trim();
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              if (inReasoning) { sendChunk("</think>"); inReasoning = false; }
              return finalize();
            }
            try {
              const json = JSON.parse(data);
              const choice = json?.choices?.[0];
              if (!choice) continue;
              if (choice.finish_reason) finishReason = choice.finish_reason;
              const delta = choice.delta;
              if (!delta) continue;
              const reasoning = delta.reasoning_content;
              const content = delta.content;
              if (reasoning) {
                if (!inReasoning) { sendChunk("<think>"); inReasoning = true; }
                sendChunk(reasoning);
              }
              if (content) {
                if (inReasoning) { sendChunk("</think>"); inReasoning = false; }
                sendChunk(content);
              }
              if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  let acc = toolCallsByIndex.get(idx);
                  if (!acc) {
                    acc = { id: "", type: "function", function: { name: "", arguments: "" } };
                    toolCallsByIndex.set(idx, acc);
                  }
                  if (tc.id) acc.id = tc.id;
                  if (tc.type) acc.type = tc.type;
                  if (tc.function?.name) acc.function.name = tc.function.name;
                  if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
                }
              }
            } catch {}
          }
        }
        if (inReasoning) { sendChunk("</think>"); inReasoning = false; }
        finalize();
      } catch (err: any) {
        if (err.name === "AbortError") { sendDone({ ok: true, aborted: true }); }
        else { sendDone({ ok: false, error: `stream: ${err.message || err}` }); }
        activeStreams.delete(id);
      }
    },
    cancel() {
      controller.abort();
      activeStreams.delete(id);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      ...corsHeaders(),
    },
  });
}

function abortAiStream(id: string): void {
  const c = activeStreams.get(id);
  if (c) c.abort();
}

// ---------- HTTP routing ----------

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Stream-Id",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data: any, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...extra },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

async function readJson<T = any>(req: Request): Promise<T> {
  const text = await req.text();
  if (!text) return {} as T;
  try { return JSON.parse(text); }
  catch { throw new Error("Body JSON invalide"); }
}

type RouteMatch = { pattern: RegExp; method: string; handler: (req: Request, params: Record<string, string>) => Promise<Response> | Response };

function route(method: string, pattern: string, handler: RouteMatch["handler"]): RouteMatch {
  // /api/projects/:id/rename → captures :id
  const re = new RegExp("^" + pattern.replace(/:[a-zA-Z]+/g, "([^/]+)").replace(/\*$/, "(.*)") + "$");
  const keys = (pattern.match(/:[a-zA-Z]+/g) || []).map((s) => s.slice(1));
  if (pattern.endsWith("*")) keys.push("rest");
  return {
    pattern: re,
    method,
    handler: async (req, _p) => {
      const m = re.exec(new URL(req.url).pathname);
      const params: Record<string, string> = {};
      if (m) keys.forEach((k, i) => { params[k] = m[i + 1]; });
      return handler(req, params);
    },
  };
}

const ROUTES: RouteMatch[] = [
  // Modules
  route("GET", "/api/modules", async () => json(await listModules())),
  route("POST", "/api/modules", async (req) => json(await createModule(await readJson(req)))),
  route("DELETE", "/api/modules/:id", async (_r, p) => { await deleteModule(p.id); return json({ ok: true }); }),
  route("POST", "/api/modules/:id/run", async (req, p) => {
    const args = await readJson<any>(req);
    return json(await runPythonModule({ id: p.id, ...args }));
  }),
  route("GET", "/api/modules/:id/files", async (_r, p) => json(await listModuleFiles(p.id))),
  route("GET", "/api/modules/:id/file", async (req, p) => {
    const file = new URL(req.url).searchParams.get("path") || "";
    return new Response(await readModuleFile(p.id, file), {
      headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders() },
    });
  }),
  route("PUT", "/api/modules/:id/file", async (req, p) => {
    const file = new URL(req.url).searchParams.get("path") || "";
    await writeModuleFile(p.id, file, await req.text());
    return json({ ok: true });
  }),
  route("DELETE", "/api/modules/:id/file", async (req, p) => {
    const file = new URL(req.url).searchParams.get("path") || "";
    await deleteModuleFile(p.id, file);
    return json({ ok: true });
  }),

  // Env
  route("GET", "/api/env", async () => json(await loadEnv())),
  route("PUT", "/api/env", async (req) => {
    const next = await readJson<Record<string, string>>(req);
    const old = await loadEnv();
    await saveEnv(next || {});
    const changed = new Set<string>();
    for (const k of new Set([...Object.keys(old), ...Object.keys(next || {})])) {
      if (old[k] !== (next || {})[k]) changed.add(k);
    }
    broadcast("envChanged", next || {});
    if (changed.size) scheduleEnvWatchTriggers(changed).catch(() => undefined);
    return json({ ok: true });
  }),

  // Projects
  route("GET", "/api/projects", async () => json(await listProjects())),
  route("POST", "/api/projects", async (req) => {
    const out = await createProject((await readJson<any>(req)).name);
    scheduleTriggerSync();
    return json(out);
  }),
  route("GET", "/api/projects/active", async () => json({ id: await getActiveProjectId() })),
  route("PUT", "/api/projects/active", async (req) => {
    const { id } = await readJson<{ id: string }>(req);
    await setActiveProjectId(id);
    return json({ ok: true });
  }),
  route("POST", "/api/projects/import", async (req) => {
    const url = new URL(req.url);
    const filename = url.searchParams.get("filename") || "imported.json";
    const raw = await req.text();
    const out = await importProjectFromBuffer(filename, raw);
    scheduleTriggerSync();
    return json(out);
  }),
  route("GET", "/api/projects/:id", async (_r, p) => json(await loadProject(p.id))),
  route("PUT", "/api/projects/:id", async (req, p) => {
    const project = await readJson<any>(req);
    if (!project.id) project.id = p.id;
    const out = await saveProjectFile(project);
    scheduleTriggerSync();
    return json(out);
  }),
  route("DELETE", "/api/projects/:id", async (_r, p) => {
    await deleteProject(p.id);
    scheduleTriggerSync();
    return json({ ok: true });
  }),
  route("POST", "/api/projects/:id/rename", async (req, p) => {
    const { name } = await readJson<{ name: string }>(req);
    return json(await renameProject(p.id, name));
  }),
  route("POST", "/api/projects/:id/duplicate", async (_r, p) => {
    const out = await duplicateProject(p.id);
    scheduleTriggerSync();
    return json(out);
  }),
  route("POST", "/api/projects/:id/runNode", async (req, p) => {
    const { nodeId } = await readJson<{ nodeId: string }>(req);
    if (!nodeId) return err("nodeId requis", 400);
    return json(await runManualNode(p.id, nodeId));
  }),
  route("GET", "/api/projects/:id/export", async (_r, p) => {
    const project = await loadProject(p.id);
    const safeName = String(project.name || "project").replace(/[^a-z0-9._-]+/gi, "_");
    return new Response(JSON.stringify(project, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${safeName}.n2n.json"`,
        ...corsHeaders(),
      },
    });
  }),

  // Webhooks: cron + webhook routes are derived from project state and
  // managed by syncProjectTriggers() — no client-driven registration API.
  route("GET", "/api/webhooks/port", async () => json({ port: WEBHOOK_PORT ?? API_PORT })),

  // MCP
  route("GET", "/api/mcp", async () => { await loadMcpConfig(); return json(listMcpState()); }),
  route("POST", "/api/mcp/call", async (req) => {
    const { server, tool, args } = await readJson<any>(req);
    return json(await callMcpToolByName(server, tool, args));
  }),
  route("POST", "/api/mcp/:name/restart", async (_r, p) => {
    await loadMcpConfig();
    const cfg = mcpConfigCache?.servers[p.name];
    if (cfg) await startMcpServer(p.name, cfg);
    return json({ ok: true });
  }),
  route("PUT", "/api/mcp/:name", async (req, p) => {
    if (!/^[a-z0-9_-]+$/i.test(p.name)) throw new Error("Nom invalide");
    const config = await readJson<any>(req);
    await loadMcpConfig();
    mcpConfigCache!.servers[p.name] = {
      command: String(config?.command || ""),
      args: Array.isArray(config?.args) ? config.args.map(String) : [],
      env: config?.env && typeof config.env === "object"
        ? Object.fromEntries(Object.entries(config.env).map(([k, v]) => [k, String(v)]))
        : {},
    };
    await saveMcpConfig();
    await startMcpServer(p.name, mcpConfigCache!.servers[p.name]);
    return json({ ok: true });
  }),
  route("DELETE", "/api/mcp/:name", async (_r, p) => {
    await loadMcpConfig();
    delete mcpConfigCache!.servers[p.name];
    await saveMcpConfig();
    await stopMcpServer(p.name);
    return json({ ok: true });
  }),

  // History
  route("POST", "/api/history", async (req) => { await appendHistory(await readJson(req)); return json({ ok: true }); }),
  route("GET", "/api/history", async (req) => {
    const limit = parseInt(new URL(req.url).searchParams.get("limit") || "200", 10);
    return json(await readHistory(limit));
  }),
  route("DELETE", "/api/history", async () => { await clearHistory(); return json({ ok: true }); }),

  // AI
  route("POST", "/api/ai/chat", async (req) => {
    const { id, messages, options } = await readJson<any>(req);
    return aiChatStream({ id: id || `${Date.now()}`, messages, options });
  }),
  route("POST", "/api/ai/abort", async (req) => {
    const { id } = await readJson<{ id: string }>(req);
    abortAiStream(id);
    return json({ ok: true });
  }),

  // SSE event channel
  route("GET", "/api/events", () => eventStream()),

  // Health / info — the web UI calls this to validate a server URL during
  // onboarding. Both endpoints are intentionally unauthenticated so that the
  // client can probe the server before knowing whether it needs a token.
  route("GET", "/api/info", async () => json({
    name: "n2n",
    version: "0.1.0",
    apiPort: API_PORT,
    webhookPort: WEBHOOK_PORT ?? API_PORT,
    host: HOST,
    authRequired: !!API_TOKEN,
  })),
  route("GET", "/api/health", () => json({ ok: true })),
];

// Routes that stay reachable without a token.
const AUTH_BYPASS_PATHS = new Set(["/api/health", "/api/info"]);

function checkApiAuth(req: Request, url: URL): Response | null {
  if (!API_TOKEN) return null;
  if (AUTH_BYPASS_PATHS.has(url.pathname)) return null;
  // Allow EventSource (SSE) which can't set headers — accept ?token=…
  const queryToken = url.searchParams.get("token");
  if (queryToken && constantTimeEqual(queryToken, API_TOKEN)) return null;
  const auth = req.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    const tok = auth.slice(7).trim();
    if (constantTimeEqual(tok, API_TOKEN)) return null;
  }
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": "Bearer",
      ...corsHeaders(),
    },
  });
}

async function dispatchApi(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

  // Webhook fast-path: /webhook/<route> — its own per-route secret applies,
  // so it bypasses the global API token.
  if (url.pathname.startsWith("/webhook/")) {
    const route = url.pathname.slice("/webhook/".length).replace(/\/+$/, "");
    return handleWebhook(req, route);
  }

  const unauthorized = checkApiAuth(req, url);
  if (unauthorized) return unauthorized;

  for (const r of ROUTES) {
    if (r.method !== req.method) continue;
    if (r.pattern.test(url.pathname)) {
      try { return await r.handler(req, {}); }
      catch (e: any) {
        console.error(`[n2n] ${req.method} ${url.pathname}:`, e?.message || e);
        return err(e?.message || "Internal error", 500);
      }
    }
  }
  return err("Not found", 404);
}

// Dispatcher used when webhooks run on their own dedicated port.
async function dispatchWebhook(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (!url.pathname.startsWith("/webhook/")) {
    return new Response("not found", { status: 404 });
  }
  const route = url.pathname.slice("/webhook/".length).replace(/\/+$/, "");
  return handleWebhook(req, route);
}

// ---------- bootstrap ----------

async function main(): Promise<void> {
  await ensureModulesDir();
  attachModuleWatcher();
  startAllMcpServers().catch((e) => console.warn(`[n2n] MCP startup failed: ${e?.message}`));
  // Scan saved projects and install cron + webhook triggers so automatic
  // workflows run with no UI connected.
  await syncProjectTriggers().catch((e) =>
    console.warn(`[n2n] initial trigger sync: ${e?.message || e}`),
  );

  Bun.serve({
    port: API_PORT,
    hostname: HOST,
    fetch: dispatchApi,
    error(e) {
      console.error("[n2n] server error:", e);
      return err("Internal error", 500);
    },
  });

  console.log(`[n2n] API listening on http://${HOST}:${API_PORT}  (bind: ${HOST}, port: ${API_PORT})`);

  if (WEBHOOK_PORT && WEBHOOK_PORT !== API_PORT) {
    Bun.serve({
      port: WEBHOOK_PORT,
      hostname: HOST,
      fetch: dispatchWebhook,
      error(e) {
        console.error("[n2n] webhook server error:", e);
        return new Response("internal error", { status: 500 });
      },
    });
    console.log(`[n2n] webhooks on http://${HOST}:${WEBHOOK_PORT}/webhook/<path>  (dedicated)`);
  } else {
    console.log(`[n2n] webhooks on http://${HOST}:${API_PORT}/webhook/<path>  (shared with API)`);
  }
}

process.on("SIGINT", () => {
  tearDownAllTriggers();
  stopAllMcpServers();
  if (moduleWatcher) try { moduleWatcher.close(); } catch {}
  process.exit(0);
});

main().catch((e) => { console.error(e); process.exit(1); });
