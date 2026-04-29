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
const RUNTIMES_DIR = join(N2N_DIR, "runtimes");
const DATA_DIR = join(N2N_DIR, "data");
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
    const path = await getExtendedPath();
    const resolvedPython = (await findInPath(PYTHON, path)) || PYTHON;
    let child;
    try {
      child = spawn({
        cmd: [resolvedPython, entry],
        cwd: dir,
        env: { ...process.env, PATH: path } as Record<string, string>,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err: any) {
      return resolve({ ok: false, error: `spawn ${PYTHON}: ${err?.message || err}. Installe Python via l'onglet « Environnements ».` });
    }

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
  | "envChanged"
  | "runtimesChanged";

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

// ---------- external runtimes (Node, Python, …) ----------
// MCP servers spawn child processes (npx, uvx, python3, …) that need to be
// findable on PATH. Electron-launched apps inherit a minimal PATH on macOS /
// Linux desktops, so npm/uv/python installs in user dirs are invisible. We
// extend PATH with common install locations and offer a one-click installer
// for users who don't have Node/Python yet.

// String so we can mix the bundled Node/Python runtimes with optional npm
// driver packages (mysql2, oracledb, mongodb, …) under one runtime list.
type RuntimeId = string;

type RuntimeArch = "x64" | "arm64";
type RuntimePlatform = "linux" | "darwin";

const NODE_VERSION = "20.18.1";
const PY_VERSION = "3.13.1";
const PY_RELEASE = "20250115";

function detectRuntimePlatform(): { platform: RuntimePlatform; arch: RuntimeArch } | null {
  const p = process.platform;
  const a = process.arch;
  if (p !== "linux" && p !== "darwin") return null;
  if (a !== "x64" && a !== "arm64") return null;
  return { platform: p as RuntimePlatform, arch: a as RuntimeArch };
}

const N2N_NODE_DIR = join(RUNTIMES_DIR, "node");
const N2N_PY_DIR = join(RUNTIMES_DIR, "python");
// Where we install npm driver packages (mysql2, oracledb, mongodb, …)
// invoked dynamically by sql-query. Kept separate from the user's global
// node_modules so n2n can manage it via the Environnements panel.
const N2N_NPM_DIR = join(N2N_DIR, "npm");

let cachedExtPath: string | null = null;

async function listIfExists(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
  } catch { return []; }
}

async function buildExtendedPath(): Promise<string> {
  const home = homedir();
  const parts: string[] = [];

  // Our managed installs first
  parts.push(join(N2N_NODE_DIR, "bin"));
  parts.push(join(N2N_PY_DIR, "bin"));

  // Common user-local install paths
  parts.push(join(home, ".local", "bin"));
  parts.push(join(home, ".bun", "bin"));
  parts.push(join(home, ".cargo", "bin"));
  parts.push(join(home, ".volta", "bin"));
  parts.push(join(home, ".npm-global", "bin"));

  // NVM: ~/.nvm/versions/node/<version>/bin (latest first)
  const nvmDirs = (await listIfExists(join(home, ".nvm", "versions", "node")))
    .sort()
    .reverse()
    .map((d) => join(d, "bin"));
  parts.push(...nvmDirs);

  // pyenv shims
  const pyenvShims = join(home, ".pyenv", "shims");
  if (await exists(pyenvShims)) parts.push(pyenvShims);

  // System paths (Homebrew + standard)
  parts.push("/opt/homebrew/bin", "/opt/homebrew/sbin");
  parts.push("/home/linuxbrew/.linuxbrew/bin", "/home/linuxbrew/.linuxbrew/sbin");
  parts.push("/usr/local/bin", "/usr/local/sbin");
  parts.push("/usr/bin", "/usr/sbin", "/bin", "/sbin");

  // Existing PATH (last so we don't override our managed installs)
  if (process.env.PATH) parts.push(process.env.PATH);

  // De-duplicate while preserving order
  const seen = new Set<string>();
  const out: string[] = [];
  for (const segment of parts) {
    for (const p of segment.split(":")) {
      if (p && !seen.has(p)) { seen.add(p); out.push(p); }
    }
  }
  return out.join(":");
}

async function getExtendedPath(): Promise<string> {
  if (!cachedExtPath) cachedExtPath = await buildExtendedPath();
  return cachedExtPath;
}

function invalidateExtendedPath(): void {
  cachedExtPath = null;
}

async function findInPath(cmd: string, path: string): Promise<string | null> {
  if (cmd.includes("/")) {
    return (await exists(cmd)) ? cmd : null;
  }
  for (const dir of path.split(":")) {
    if (!dir) continue;
    const full = join(dir, cmd);
    if (await exists(full)) return full;
  }
  return null;
}

async function getCmdVersion(cmd: string, args: string[] = ["--version"]): Promise<string | null> {
  try {
    const path = await getExtendedPath();
    const resolved = await findInPath(cmd, path);
    if (!resolved) return null;
    const proc = spawn({
      cmd: [resolved, ...args],
      env: { ...process.env, PATH: path } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, , code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) return null;
    return out.trim() || null;
  } catch { return null; }
}

type RuntimeStatus = {
  id: RuntimeId;
  label: string;
  description: string;
  installed: boolean;
  installable: boolean;
  installing: boolean;
  error: string | null;
  log: string;
  details: { name: string; path: string | null; version: string | null }[];
};

type InstallState = {
  installing: boolean;
  error: string | null;
  log: string;
};

const installStates = new Map<RuntimeId, InstallState>();

function getInstallState(id: RuntimeId): InstallState {
  if (!installStates.has(id)) {
    installStates.set(id, { installing: false, error: null, log: "" });
  }
  return installStates.get(id)!;
}

function appendInstallLog(id: RuntimeId, line: string): void {
  const s = getInstallState(id);
  const ts = new Date().toISOString().slice(11, 19);
  s.log += `[${ts}] ${line}\n`;
  // Cap the log so it doesn't grow forever
  if (s.log.length > 16000) s.log = s.log.slice(-12000);
  broadcast("runtimesChanged");
}

async function detectNode(): Promise<RuntimeStatus["details"]> {
  const path = await getExtendedPath();
  const out: RuntimeStatus["details"] = [];
  for (const cmd of ["node", "npx"]) {
    const resolved = await findInPath(cmd, path);
    const version = resolved ? await getCmdVersion(cmd) : null;
    out.push({ name: cmd, path: resolved, version });
  }
  return out;
}

async function detectPython(): Promise<RuntimeStatus["details"]> {
  const path = await getExtendedPath();
  const out: RuntimeStatus["details"] = [];
  for (const cmd of ["python3", "uv", "uvx"]) {
    const resolved = await findInPath(cmd, path);
    const version = resolved ? await getCmdVersion(cmd) : null;
    out.push({ name: cmd, path: resolved, version });
  }
  return out;
}

/**
 * Optional npm packages used dynamically by sql-query. Surfaced in the
 * Environnements panel so the user can install them without SSH.
 */
const KNOWN_NPM_PKGS: Array<{
  id: string;
  pkg: string;
  label: string;
  description: string;
}> = [
  { id: "npm-mysql2", pkg: "mysql2", label: "MySQL / MariaDB",
    description: "Driver Node pour MySQL et MariaDB (sql-query mysql/mariadb)." },
  { id: "npm-mssql", pkg: "mssql", label: "Microsoft SQL Server",
    description: "Driver MSSQL (sql-query mssql)." },
  { id: "npm-oracledb", pkg: "oracledb", label: "Oracle DB",
    description: "Driver Oracle Thin mode 6.0+ (sql-query oracle). Pas besoin d'Instant Client." },
  { id: "npm-mongodb", pkg: "mongodb", label: "MongoDB",
    description: "Driver Mongo (sql-query mongodb : find / insert / update / aggregate…)." },
  { id: "npm-redis", pkg: "redis", label: "Redis",
    description: "Client Redis (sql-query redis : commandes brutes JSON)." },
  { id: "npm-duckdb", pkg: "@duckdb/node-api", label: "DuckDB",
    description: "Base analytique in-process (sql-query duckdb)." },
];

async function detectNpmPkg(pkg: string): Promise<RuntimeStatus["details"]> {
  // pkg can be "@scope/name" — split on / to walk into the right dir.
  const parts = pkg.split("/").filter(Boolean);
  const dir = join(N2N_NPM_DIR, "node_modules", ...parts);
  const pkgJson = join(dir, "package.json");
  try {
    const meta = JSON.parse(await readFile(pkgJson, "utf8"));
    return [{ name: pkg, path: dir, version: typeof meta.version === "string" ? meta.version : null }];
  } catch {
    return [{ name: pkg, path: null, version: null }];
  }
}

async function listRuntimes(): Promise<RuntimeStatus[]> {
  const out: RuntimeStatus[] = [];
  const platform = detectRuntimePlatform();

  for (const id of ["node", "python"] as RuntimeId[]) {
    const state = getInstallState(id);
    const details = id === "node" ? await detectNode() : await detectPython();
    const installed = id === "node"
      ? details.every((d) => d.path)
      : details[0]?.path != null;
    out.push({
      id,
      label: id === "node" ? "Node.js" : "Python",
      description: id === "node"
        ? "Required for npx-based MCP servers (filesystem, github, slack, …)."
        : "Required for python3 modules and uvx-based MCP servers (git, time, sqlite, …).",
      installed,
      installable: !!platform,
      installing: state.installing,
      error: state.error,
      log: state.log,
      details,
    });
  }

  // npm driver packages — appended after the bundled runtimes so the UI
  // groups them naturally below Node + Python.
  for (const meta of KNOWN_NPM_PKGS) {
    const state = getInstallState(meta.id);
    const details = await detectNpmPkg(meta.pkg);
    out.push({
      id: meta.id,
      label: meta.label,
      description: meta.description,
      installed: !!details[0]?.path,
      installable: true,
      installing: state.installing,
      error: state.error,
      log: state.log,
      details,
    });
  }

  return out;
}

// ---- install: download a tarball, extract via system tar ----

async function downloadFile(id: RuntimeId, url: string, target: string): Promise<void> {
  appendInstallLog(id, `Téléchargement de ${url}`);
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} sur ${url}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, buf);
  appendInstallLog(id, `Téléchargé ${(buf.length / 1024 / 1024).toFixed(1)} Mo dans ${target}`);
}

async function extractTarGz(id: RuntimeId, archive: string, dest: string, stripComponents = 1): Promise<void> {
  appendInstallLog(id, `Extraction dans ${dest}`);
  await mkdir(dest, { recursive: true });
  const proc = spawn({
    cmd: ["tar", "-xzf", archive, "-C", dest, `--strip-components=${stripComponents}`],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, errOut, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`tar a échoué (code ${code}): ${errOut.trim()}`);
}

async function installNode(): Promise<void> {
  const id: RuntimeId = "node";
  const plat = detectRuntimePlatform();
  if (!plat) throw new Error(`Plateforme non supportée: ${process.platform}/${process.arch}`);

  const arch = plat.arch === "arm64" ? "arm64" : "x64";
  const suffix = plat.platform === "darwin" ? `darwin-${arch}` : `linux-${arch}`;
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${suffix}.tar.gz`;
  const tmp = join(RUNTIMES_DIR, `node-${NODE_VERSION}.tar.gz`);

  await mkdir(RUNTIMES_DIR, { recursive: true });
  await downloadFile(id, url, tmp);
  await rm(N2N_NODE_DIR, { recursive: true, force: true });
  await extractTarGz(id, tmp, N2N_NODE_DIR, 1);
  try { await unlink(tmp); } catch {}

  invalidateExtendedPath();
  appendInstallLog(id, `Node.js v${NODE_VERSION} installé dans ${N2N_NODE_DIR}`);
}

async function installPython(): Promise<void> {
  const id: RuntimeId = "python";
  const plat = detectRuntimePlatform();
  if (!plat) throw new Error(`Plateforme non supportée: ${process.platform}/${process.arch}`);

  // python-build-standalone naming: cpython-<py>+<release>-<triplet>-install_only.tar.gz
  let triplet: string;
  if (plat.platform === "linux") {
    triplet = plat.arch === "arm64"
      ? "aarch64-unknown-linux-gnu"
      : "x86_64-unknown-linux-gnu";
  } else {
    triplet = plat.arch === "arm64"
      ? "aarch64-apple-darwin"
      : "x86_64-apple-darwin";
  }
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${PY_RELEASE}/cpython-${PY_VERSION}+${PY_RELEASE}-${triplet}-install_only.tar.gz`;
  const tmp = join(RUNTIMES_DIR, `python-${PY_VERSION}.tar.gz`);

  await mkdir(RUNTIMES_DIR, { recursive: true });
  await downloadFile(id, url, tmp);
  await rm(N2N_PY_DIR, { recursive: true, force: true });
  // The archive contains a top-level "python/" folder; strip it so bin/ ends
  // up directly under N2N_PY_DIR.
  await extractTarGz(id, tmp, N2N_PY_DIR, 1);
  try { await unlink(tmp); } catch {}

  invalidateExtendedPath();
  appendInstallLog(id, `Python ${PY_VERSION} installé dans ${N2N_PY_DIR}`);
}

async function installNpmPkg(id: string): Promise<void> {
  const meta = KNOWN_NPM_PKGS.find((p) => p.id === id);
  if (!meta) throw new Error(`Package npm inconnu: ${id}`);
  const path = await getExtendedPath();
  const npm = await findInPath("npm", path);
  if (!npm) {
    throw new Error("npm introuvable. Installe d'abord Node.js dans cet onglet.");
  }
  await mkdir(N2N_NPM_DIR, { recursive: true });
  // Bootstrap a tiny package.json so npm doesn't moan about the absent project.
  const pj = join(N2N_NPM_DIR, "package.json");
  if (!(await exists(pj))) {
    await writeFile(pj, JSON.stringify(
      { name: "n2n-runtime-deps", version: "1.0.0", private: true },
      null,
      2,
    ));
  }
  appendInstallLog(id, `$ npm install ${meta.pkg}`);
  const proc = spawn({
    cmd: [npm, "install", meta.pkg, "--no-audit", "--no-fund", "--loglevel=warn"],
    cwd: N2N_NPM_DIR,
    env: { ...process.env, PATH: path } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const drain = async (s: ReadableStream<Uint8Array>) => {
    const reader = s.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.trim()) appendInstallLog(id, text.replace(/\n$/, ""));
      }
    } catch {}
  };
  void drain(proc.stdout);
  void drain(proc.stderr);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`npm install ${meta.pkg} a échoué (code ${code}). Vois le log ci-dessus.`);
  }
  appendInstallLog(id, `Installation OK : ${join(N2N_NPM_DIR, "node_modules", meta.pkg)}`);
}

async function startRuntimeInstall(id: RuntimeId): Promise<void> {
  const state = getInstallState(id);
  if (state.installing) return;
  state.installing = true;
  state.error = null;
  state.log = "";
  broadcast("runtimesChanged");

  const isNpm = id.startsWith("npm-");
  try {
    appendInstallLog(id, `Installation de ${id} démarrée`);
    if (isNpm) await installNpmPkg(id);
    else if (id === "node") await installNode();
    else if (id === "python") await installPython();
    else throw new Error(`Runtime inconnu: ${id}`);
    appendInstallLog(id, `Installation terminée`);
  } catch (e: any) {
    state.error = e?.message || String(e);
    appendInstallLog(id, `Erreur: ${state.error}`);
  } finally {
    state.installing = false;
    invalidateExtendedPath();
    broadcast("runtimesChanged");
    // Restart MCP servers when a *core* runtime install succeeded — npm
    // packages are loaded lazily by sql-query, no MCP restart needed.
    if (!state.error && !isNpm) {
      startAllMcpServers().catch(() => undefined);
    }
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

/**
 * Normalize any value into a list of items so `for-each` works on more than
 * just arrays. Strategy by `iter`:
 *
 *   - "auto"     → array as-is, dict → entries, string → lines, number → range,
 *                  other → [value]
 *   - "list"     → array as-is, anything else → [value] (force "list of one")
 *   - "entries"  → dict / array of [k,v] pairs / array → [{key,value}, …]
 *   - "keys"     → dict → keys; array → indices
 *   - "values"   → dict → values; array → as-is
 *   - "lines"    → string → split(/\r?\n/); array → as-is
 *   - "chars"    → string → chars; array → as-is
 *   - "range"    → number → 0..n-1; string-number → same; array → indices
 *
 * `null` / `undefined` → [].
 */
function normalizeIterable(value: unknown, iter: string): unknown[] {
  if (value === null || value === undefined) return [];
  if (iter === "list") {
    return Array.isArray(value) ? value : [value];
  }
  if (Array.isArray(value)) {
    if (iter === "keys") return value.map((_, i) => i);
    if (iter === "entries") return value.map((v, i) => ({ key: i, value: v }));
    return value;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const m = iter === "auto" ? "entries" : iter;
    if (m === "keys") return Object.keys(obj);
    if (m === "values") return Object.values(obj);
    return Object.entries(obj).map(([key, val]) => ({ key, value: val }));
  }
  if (typeof value === "string") {
    const m = iter === "auto" ? "lines" : iter;
    if (m === "chars") return Array.from(value);
    if (m === "range") {
      const n = Number(value);
      if (Number.isFinite(n)) {
        const c = Math.max(0, Math.floor(n));
        return Array.from({ length: c }, (_, i) => i);
      }
      return [];
    }
    return value.split(/\r?\n/);
  }
  if (typeof value === "number") {
    const m = iter === "auto" ? "range" : iter;
    if (m === "range") {
      const c = Math.max(0, Math.floor(value));
      return Array.from({ length: c }, (_, i) => i);
    }
    return [value];
  }
  return [value];
}

// ---------- sql-query runtime ----------

/**
 * Resolve a SQLite path under the n2n data dir sandbox. Refuses absolute
 * paths outside $HOME so a workflow can't, e.g., overwrite /etc/.
 *
 *   ":memory:"          → ":memory:"
 *   "" or "/"           → ":memory:"
 *   "foo.db"            → ~/.n2n/data/foo.db
 *   "subdir/db.sqlite"  → ~/.n2n/data/subdir/db.sqlite
 *   "~/foo/bar.db"      → ~/foo/bar.db (must stay under home)
 *   "/abs/path.db"      → only allowed if under $HOME
 */
function resolveSqliteSandboxPath(input: string): string {
  const cleaned = (input || "").trim();
  if (!cleaned || cleaned === ":memory:") return ":memory:";
  let target: string;
  if (cleaned.startsWith("~/")) {
    target = join(homedir(), cleaned.slice(2));
  } else if (cleaned.startsWith("/")) {
    target = resolve(cleaned);
  } else {
    target = join(DATA_DIR, cleaned);
  }
  const resolved = resolve(target);
  const homeReal = resolve(homedir());
  if (resolved !== homeReal && !resolved.startsWith(homeReal + sep)) {
    throw new Error(`Chemin SQLite hors de $HOME refusé: ${input}`);
  }
  return resolved;
}

async function runSqlQuery(
  substituted: Record<string, unknown>,
  inputs: Record<string, unknown>,
): Promise<RunResult> {
  const driver = String(substituted.driver || "sqlite");
  const queryRaw = String(substituted.query || "").trim();
  if (!queryRaw) return { ok: false, error: "sql-query: requête vide" };

  // Parameters: prefer the input socket if it's an array, fall back to the
  // text-encoded JSON array param.
  let qparams: unknown[] = [];
  if (Array.isArray(inputs.params)) {
    qparams = inputs.params as unknown[];
  } else {
    const raw = String(substituted.parameters || "").trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) qparams = parsed;
        else return { ok: false, error: "sql-query: parameters doit être un array JSON" };
      } catch (e: any) {
        return { ok: false, error: `sql-query: parameters invalide: ${e?.message || e}` };
      }
    }
  }

  if (driver === "sqlite") {
    let dbPath: string;
    try { dbPath = resolveSqliteSandboxPath(String(substituted.connection || ":memory:")); }
    catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    const createDirs = substituted.create_dirs !== false;
    if (dbPath !== ":memory:" && createDirs) {
      try { await mkdir(dirname(dbPath), { recursive: true }); } catch {}
    }
    let mod: any;
    try { mod = await import("bun:sqlite"); }
    catch (e: any) {
      return { ok: false, error: `sqlite: bun:sqlite indisponible (${e?.message || e})` };
    }
    let db: any;
    try { db = new mod.Database(dbPath); }
    catch (e: any) { return { ok: false, error: `sqlite: open ${dbPath} → ${e?.message || e}` }; }
    try {
      const stmt = db.query(queryRaw);
      // Heuristic: SELECT/PRAGMA/WITH return rows; everything else mutates.
      const isRead = /^\s*(?:select|pragma|with|explain)\b/i.test(queryRaw);
      if (isRead) {
        const rows = stmt.all(...qparams);
        return { ok: true, outputs: { rows, affected: 0, lastInsertRowid: 0 } };
      } else {
        const info = stmt.run(...qparams);
        return {
          ok: true,
          outputs: {
            rows: [],
            affected: Number(info?.changes ?? db.totalChanges ?? 0),
            lastInsertRowid: Number(info?.lastInsertRowid ?? 0),
          },
        };
      }
    } catch (e: any) {
      return { ok: false, error: `sqlite: ${e?.message || e}` };
    } finally {
      try { db.close(); } catch {}
    }
  }

  if (driver === "postgres") {
    const url = String(substituted.connection_pg || substituted.connection || "").trim();
    if (!url) return { ok: false, error: "postgres: URL requise" };
    try {
      // Bun.sql for tagged templates; .unsafe() for arbitrary parameterised SQL.
      const sql = (Bun as any).sql ? (Bun as any).sql(url) : null;
      if (!sql) return { ok: false, error: "postgres: Bun.sql indisponible (Bun >= 1.2 requis)" };
      const rowsAny: any = await sql.unsafe(queryRaw, qparams);
      const rows = Array.isArray(rowsAny) ? rowsAny : [];
      const isRead = /^\s*(?:select|with|explain|show)\b/i.test(queryRaw);
      try { await sql.end?.(); } catch {}
      return {
        ok: true,
        outputs: {
          rows: isRead ? rows : [],
          affected: isRead ? 0 : (Number((rowsAny as any)?.count ?? rows.length ?? 0)),
          lastInsertRowid: 0,
        },
      };
    } catch (e: any) {
      return { ok: false, error: `postgres: ${e?.message || e}` };
    }
  }

  if (driver === "mysql" || driver === "mariadb") {
    const url = String(
      (driver === "mariadb" ? substituted.connection_mariadb : substituted.connection_mysql) ||
      substituted.connection ||
      "",
    ).trim();
    if (!url) return { ok: false, error: `${driver}: URL requise` };
    try {
      // mysql2 also speaks MariaDB wire protocol — same client.
      const mysql2: any = await loadOptionalPkg("mysql2/promise");
      if (!mysql2) {
        return {
          ok: false,
          error: `${driver}: dépendance 'mysql2' non installée (npm i mysql2).`,
        };
      }
      const conn = await mysql2.createConnection(url);
      try {
        const [rowsRaw, fields] = await conn.execute(queryRaw, qparams);
        void fields;
        const rows = Array.isArray(rowsRaw) ? rowsRaw : [];
        const affected = Number((rowsRaw as any)?.affectedRows ?? 0);
        const lastInsertRowid = Number((rowsRaw as any)?.insertId ?? 0);
        return { ok: true, outputs: { rows, affected, lastInsertRowid } };
      } finally {
        try { await conn.end(); } catch {}
      }
    } catch (e: any) {
      return { ok: false, error: `${driver}: ${e?.message || e}` };
    }
  }

  if (driver === "mssql") {
    const cs = String(substituted.connection_mssql || substituted.connection || "").trim();
    if (!cs) return { ok: false, error: "mssql: connection string requise" };
    try {
      const mssql: any = await loadOptionalPkg("mssql");
      if (!mssql) {
        return { ok: false, error: "mssql: dépendance 'mssql' non installée (npm i mssql)." };
      }
      const pool = await mssql.connect(cs);
      try {
        const req = pool.request();
        let q = queryRaw;
        let i = 0;
        q = q.replace(/\?/g, () => `@p${i++}`);
        qparams.forEach((p, idx) => req.input(`p${idx}`, p as any));
        const out = await req.query(q);
        const rows = out.recordset || [];
        const affected = Array.isArray(out.rowsAffected)
          ? out.rowsAffected.reduce((a: number, b: number) => a + b, 0)
          : Number(out.rowsAffected ?? 0);
        return { ok: true, outputs: { rows, affected, lastInsertRowid: 0 } };
      } finally {
        try { await pool.close(); } catch {}
      }
    } catch (e: any) {
      return { ok: false, error: `mssql: ${e?.message || e}` };
    }
  }

  if (driver === "duckdb") {
    let dbPath: string;
    try { dbPath = resolveSqliteSandboxPath(String(substituted.connection_duckdb || ":memory:")); }
    catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    if (dbPath !== ":memory:" && substituted.create_dirs !== false) {
      try { await mkdir(dirname(dbPath), { recursive: true }); } catch {}
    }
    try {
      const duck: any = await loadOptionalPkg("@duckdb/node-api");
      if (!duck) {
        return {
          ok: false,
          error: "duckdb: dépendance '@duckdb/node-api' non installée (npm i @duckdb/node-api).",
        };
      }
      const inst = await duck.DuckDBInstance.create(dbPath === ":memory:" ? ":memory:" : dbPath);
      const conn = await inst.connect();
      try {
        const reader = await conn.runAndReadAll(queryRaw, qparams);
        const rows = reader.getRowObjects();
        const isRead = /^\s*(?:select|with|pragma|describe|show)\b/i.test(queryRaw);
        return {
          ok: true,
          outputs: {
            rows: isRead ? rows : [],
            affected: isRead ? 0 : Number(rows?.length ?? 0),
            lastInsertRowid: 0,
          },
        };
      } finally {
        try { conn.disconnectSync?.(); } catch {}
      }
    } catch (e: any) {
      return { ok: false, error: `duckdb: ${e?.message || e}` };
    }
  }

  if (driver === "oracle") {
    const cs = String(substituted.connection_oracle || substituted.connection || "").trim();
    if (!cs) return { ok: false, error: "oracle: connection string requise" };
    try {
      const oracledb: any = await loadOptionalPkg("oracledb");
      if (!oracledb) {
        return {
          ok: false,
          error: "oracle: dépendance 'oracledb' non installée (npm i oracledb).",
        };
      }
      // Parse user/pass out of either oracle://user:pass@host:port/svc
      // or the legacy user/pass@host:port/svc TNS-shorthand. Else assume
      // the user provided a pre-built connectString and external auth.
      let user = "";
      let password = "";
      let connectString = cs;
      const urlMatch = cs.match(/^oracle(?:db)?:\/\/([^:]+):([^@]+)@(.+)$/i);
      if (urlMatch) {
        user = decodeURIComponent(urlMatch[1]);
        password = decodeURIComponent(urlMatch[2]);
        connectString = urlMatch[3];
      } else {
        const tnsMatch = cs.match(/^([^/]+)\/([^@]+)@(.+)$/);
        if (tnsMatch) {
          user = tnsMatch[1];
          password = tnsMatch[2];
          connectString = tnsMatch[3];
        }
      }
      // Oracle binds use :1, :2, … not ?. Rewrite for consistency with
      // SQLite/MySQL syntax that the user likely already has.
      let q = queryRaw;
      let bi = 1;
      q = q.replace(/\?/g, () => `:${bi++}`);
      const conn = await oracledb.getConnection({ user, password, connectString });
      try {
        const out = await conn.execute(q, qparams, {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
          autoCommit: true,
        });
        const rows = (out as any).rows || [];
        const affected = Number((out as any).rowsAffected ?? 0);
        return { ok: true, outputs: { rows, affected, lastInsertRowid: 0 } };
      } finally {
        try { await conn.close(); } catch {}
      }
    } catch (e: any) {
      return { ok: false, error: `oracle: ${e?.message || e}` };
    }
  }

  if (driver === "mongodb") {
    const uri = String(substituted.connection_mongo || substituted.connection || "").trim();
    if (!uri) return { ok: false, error: "mongodb: URI requise" };
    const op = String(substituted.mongo_op || "find");
    const collection = String(substituted.mongo_collection || "").trim();
    if (!collection) return { ok: false, error: "mongodb: collection requise" };
    let payload: any = {};
    const payloadRaw = String(substituted.mongo_payload || "{}").trim();
    if (payloadRaw) {
      try { payload = JSON.parse(payloadRaw); }
      catch (e: any) { return { ok: false, error: `mongodb: payload invalide: ${e?.message}` }; }
    }
    try {
      const mongodb: any = await loadOptionalPkg("mongodb");
      if (!mongodb) {
        return { ok: false, error: "mongodb: dépendance 'mongodb' non installée (npm i mongodb)." };
      }
      const client = new mongodb.MongoClient(uri);
      try {
        await client.connect();
        let dbName = "";
        try { dbName = new URL(uri.replace(/^mongodb(\+srv)?:/, "http:")).pathname.replace(/^\//, ""); }
        catch { /* uri may not parse, fall through */ }
        if (!dbName) dbName = String(payload.db ?? "test");
        const col = client.db(dbName).collection(collection);
        let rows: unknown = [];
        let affected = 0;
        switch (op) {
          case "find":
            rows = await col.find(payload.filter ?? {}, payload.options ?? {}).toArray(); break;
          case "findOne":
            rows = [await col.findOne(payload.filter ?? {}, payload.options ?? {})]; break;
          case "insertOne": {
            const r = await col.insertOne(payload.doc ?? {});
            rows = [{ insertedId: r.insertedId }]; affected = r.acknowledged ? 1 : 0; break;
          }
          case "insertMany": {
            const r = await col.insertMany(payload.docs ?? []);
            rows = [{ insertedIds: r.insertedIds }]; affected = r.insertedCount ?? 0; break;
          }
          case "updateOne": {
            const r = await col.updateOne(payload.filter ?? {}, payload.update ?? {});
            rows = [{ matched: r.matchedCount, modified: r.modifiedCount }];
            affected = r.modifiedCount ?? 0; break;
          }
          case "updateMany": {
            const r = await col.updateMany(payload.filter ?? {}, payload.update ?? {});
            rows = [{ matched: r.matchedCount, modified: r.modifiedCount }];
            affected = r.modifiedCount ?? 0; break;
          }
          case "deleteOne": {
            const r = await col.deleteOne(payload.filter ?? {});
            rows = [{ deleted: r.deletedCount }]; affected = r.deletedCount ?? 0; break;
          }
          case "deleteMany": {
            const r = await col.deleteMany(payload.filter ?? {});
            rows = [{ deleted: r.deletedCount }]; affected = r.deletedCount ?? 0; break;
          }
          case "aggregate":
            rows = await col.aggregate(payload.pipeline ?? []).toArray(); break;
          case "countDocuments":
            rows = [{ count: await col.countDocuments(payload.filter ?? {}) }]; break;
          default:
            return { ok: false, error: `mongodb: opération inconnue "${op}"` };
        }
        return { ok: true, outputs: { rows, affected, lastInsertRowid: 0 } };
      } finally {
        try { await client.close(); } catch {}
      }
    } catch (e: any) {
      return { ok: false, error: `mongodb: ${e?.message || e}` };
    }
  }

  if (driver === "redis") {
    const url = String(substituted.connection_redis || substituted.connection || "").trim();
    if (!url) return { ok: false, error: "redis: URL requise" };
    let cmd: unknown[] = [];
    try {
      const raw = String(substituted.redis_command || "[]").trim();
      cmd = JSON.parse(raw);
      if (!Array.isArray(cmd) || cmd.length === 0) {
        return { ok: false, error: "redis: commande doit être un array JSON non vide" };
      }
    } catch (e: any) { return { ok: false, error: `redis: commande invalide: ${e?.message}` }; }
    try {
      const redis: any = await loadOptionalPkg("redis");
      if (!redis) {
        return { ok: false, error: "redis: dépendance 'redis' non installée (npm i redis)." };
      }
      const client = redis.createClient({ url });
      await client.connect();
      try {
        const reply = await client.sendCommand(cmd.map((x) => String(x)));
        return { ok: true, outputs: { rows: [reply], affected: 0, lastInsertRowid: 0 } };
      } finally {
        try { await client.quit(); } catch {}
      }
    } catch (e: any) {
      return { ok: false, error: `redis: ${e?.message || e}` };
    }
  }

  return { ok: false, error: `sql-query: driver inconnu "${driver}"` };
}

/**
 * Dynamic import that doesn't fail compile if the package isn't installed.
 * Tries Node's resolution first (NODE_PATH / cwd-relative), then falls back
 * to ~/.n2n/npm/node_modules/<pkg> where we install drivers from the
 * Environnements panel. Returns null on full failure so callers can show
 * a clean "npm i <pkg>" hint.
 */
async function loadOptionalPkg(name: string): Promise<any> {
  try {
    return await (Function("n", "return import(n)")(name) as Promise<any>);
  } catch { /* fall through */ }
  try {
    const fallback = join(N2N_NPM_DIR, "node_modules", ...name.split("/"));
    return await (Function("p", "return import(p)")(fallback) as Promise<any>);
  } catch {
    return null;
  }
}

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
        const raw = (inputs.list ?? letters.a) as unknown;
        const iterMode = String(substituted.iter || "auto");
        const list = normalizeIterable(raw, iterMode);
        {
          const mode = String(substituted.mode || "item");
          const rawParams = (node.params ?? {}) as Record<string, unknown>;
          // "item" mode: emit the normalized list as-is — no per-item
          // action. Useful when for-each is used purely as an iterable
          // normalizer (dict→entries, string→lines, number→range, etc.)
          // and the downstream consumes the list directly.
          if (mode === "item") {
            result = { ok: true, outputs: { results: list } };
            emitNodeEnd(ctx, nodeId, result);
            return result;
          }
          const results: unknown[] = [];
          for (let i = 0; i < list.length; i++) {
            const item = list[i];
            // Per-iteration substitution context: lets `{item}` and `{i}`
            // resolve in args / urls / bodies on top of the usual letters
            // and env vars already substituted into `substituted`.
            const iterVars = { ...ctx.env, ...letters, item, i };

            if (mode === "subproject") {
              const childId = String(substituted.project_id || "");
              if (!childId) { results.push(null); continue; }
              const cr = await runChildProject(childId, item, ctx.env, ctx.manifests);
              if ("ok" in cr && cr.ok) {
                const outs = cr.outputs as Record<string, unknown>;
                const firstKey = Object.keys(outs)[0];
                results.push(firstKey !== undefined ? outs[firstKey] : null);
              } else {
                results.push({ error: ("error" in cr ? cr.error : null) ?? null });
              }
            } else if (mode === "mcp") {
              const targetStr = substituteString(String(rawParams.mcp_target ?? ""), iterVars).trim();
              const sep = targetStr.indexOf("::");
              const server = sep >= 0 ? targetStr.slice(0, sep) : "";
              const toolName = sep >= 0 ? targetStr.slice(sep + 2) : "";
              if (!server || !toolName) {
                results.push({ error: "for-each mcp: target requis (forme server::tool)" });
                continue;
              }
              const argsTpl = rawParams.mcp_arguments;
              let toolArgs: Record<string, unknown> = {};
              const expanded = substituteDeep(argsTpl, iterVars);
              if (expanded && typeof expanded === "object" && !Array.isArray(expanded)) {
                toolArgs = expanded as Record<string, unknown>;
              } else if (typeof expanded === "string" && expanded.trim()) {
                try {
                  const parsed = JSON.parse(expanded);
                  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    toolArgs = parsed as Record<string, unknown>;
                  }
                } catch { /* ignore */ }
              }
              try {
                const c = mcpClients.get(server);
                if (c?.connected) {
                  const tdef = c.tools.find((t) => t.name === toolName);
                  if (tdef?.inputSchema) toolArgs = coerceMcpArgs(toolArgs, tdef.inputSchema);
                }
                const callRes = await callMcpToolByName(server, toolName, toolArgs);
                results.push(callRes);
              } catch (e: any) {
                results.push({ error: String(e?.message || e) });
              }
            } else if (mode === "http") {
              const method = String(substituted.http_method || "GET").toUpperCase();
              const url = substituteString(String(rawParams.http_url ?? ""), iterVars);
              const body = substituteString(String(rawParams.http_body ?? ""), iterVars);
              const ct = String(substituted.http_content_type || "application/json");
              const hasBody = method !== "GET" && method !== "HEAD" && body.length > 0;
              try {
                const resp = await fetch(url, {
                  method,
                  headers: hasBody ? { "Content-Type": ct } : {},
                  body: hasBody ? body : undefined,
                  redirect: "follow",
                });
                const respCt = resp.headers.get("content-type") || "";
                let respBody: unknown;
                if (respCt.includes("application/json")) {
                  try { respBody = await resp.json(); } catch { respBody = await resp.text(); }
                } else {
                  respBody = await resp.text();
                }
                results.push({ status: resp.status, body: respBody });
              } catch (e: any) {
                results.push({ error: String(e?.message || e) });
              }
            } else if (mode === "sql") {
              const sqlDriver = String(substituted.sql_driver || "sqlite");
              const sqlConnection = substituteString(String(rawParams.sql_connection ?? ""), iterVars);
              const sqlQuery = substituteString(String(rawParams.sql_query ?? ""), iterVars);
              const sqlParameters = substituteString(String(rawParams.sql_parameters ?? "[]"), iterVars);
              // Build a substituted-like dict matching runSqlQuery's expected
              // shape so all per-driver branches keep working unchanged.
              const sqlSubst: Record<string, unknown> = {
                driver: sqlDriver,
                connection: sqlConnection,
                connection_pg: sqlConnection,
                connection_mysql: sqlConnection,
                connection_mariadb: sqlConnection,
                connection_mssql: sqlConnection,
                connection_oracle: sqlConnection,
                connection_duckdb: sqlConnection,
                connection_mongo: sqlConnection,
                connection_redis: sqlConnection,
                query: sqlQuery,
                parameters: sqlParameters,
                create_dirs: true,
              };
              const sub = await runSqlQuery(sqlSubst, {});
              if ("ok" in sub && sub.ok) {
                results.push(sub.outputs);
              } else {
                results.push({ error: ("error" in sub ? sub.error : null) ?? "?" });
              }
            } else {
              results.push({ error: `for-each: mode inconnu "${mode}"` });
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
      } else if (node.moduleId === "sql-query") {
        result = await runSqlQuery(substituted, inputs);
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

type McpConfigFile = {
  /** Absolute path; we expand a leading `~/` to the user's home. */
  path: string;
  description?: string;
  format?: "json" | "text";
};

/**
 * "Python-style" manual OAuth flow: n2n drives the OAuth handshake itself
 * (using the user's OAuth client JSON) and writes the resulting tokens to
 * `tokensPath` in the format the MCP expects. Then the MCP starts and
 * finds working credentials with zero `auth` subcommand or listener
 * needed. Works headless / cross-VPS without tunnels.
 */
type McpOAuthSpec = {
  provider: "google";
  /** Path of the OAuth client JSON (gcp-oauth.keys.json) on disk. */
  clientSecretFile: string;
  /** Where to write the resulting tokens (e.g. ~/.gmail-mcp/credentials.json). */
  tokensPath: string;
  /** OAuth scopes to request. */
  scopes: string[];
  /**
   * Loopback URI to use as `redirect_uri`. With OAuth Desktop clients
   * Google accepts any localhost — the URL is shown to the user even if
   * the page fails to load, and they paste it back.
   */
  redirectUri?: string;
};

type McpConfig = {
  command: string;
  args: string[];
  env: Record<string, string>;
  /**
   * Optional extra args appended to `command + args` to run the MCP's
   * one-off authentication flow (e.g. `auth` for gmail-autoauth-mcp).
   * Used by `runMcpAuth()` — the MCP regular process keeps running.
   */
  authArgs?: string[];
  /**
   * Files this MCP needs on disk before it can run (e.g. OAuth client JSON
   * for gmail-autoauth at ~/.gmail-mcp/gcp-oauth.keys.json). Listed by the
   * preset and surfaced as a textarea in the UI; written via
   * POST /api/mcp/:name/config-file. Path is sandboxed: must resolve under
   * $HOME and the saved config must declare it.
   */
  configFiles?: McpConfigFile[];
  /**
   * Manual OAuth flow metadata (see McpOAuthSpec). When set, the UI
   * exposes "Démarrer OAuth" → paste-callback workflow that mints the
   * tokens file directly.
   */
  oauth?: McpOAuthSpec;
};
type McpToolSpec = { name: string; description?: string; inputSchema?: any };

/**
 * Expand `${VAR}` placeholders in MCP args. Looks up first in the config's
 * own `env`, then in the parent process env. Unset vars expand to "" so
 * static templates ("--static-oauth-client-info" with embedded `${ID}`)
 * don't crash.
 */
function expandMcpArg(arg: string, env: Record<string, string>): string {
  return arg.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) =>
    env[key] ?? process.env[key] ?? "",
  );
}

/**
 * mcp-remote uses lockfiles in ~/.mcp-auth/ to coordinate multiple instances
 * sharing the same OAuth callback port. If a previous run crashed without
 * cleaning up, the next start sees the lockfile, treats itself as a
 * "follower" and polls the (dead) leader instead of binding the port —
 * which silently breaks the entire OAuth flow.
 *
 * Strategy: before spawning a new mcp-remote, walk ~/.mcp-auth/ and delete
 * lock.json files whose PID is dead OR older than 30 minutes (the same
 * threshold mcp-remote uses internally — but we trip it earlier so the
 * subsequent leader-detection always succeeds).
 */
async function cleanupStaleMcpAuthLocks(): Promise<void> {
  const root = join(homedir(), ".mcp-auth");
  if (!(await exists(root))) return;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      if (e.name !== "lock.json") continue;
      let parsed: { pid?: number; timestamp?: number } | null = null;
      try { parsed = JSON.parse(await readFile(p, "utf8")); } catch { /* corrupt */ }
      const age = parsed?.timestamp ? Date.now() - parsed.timestamp : Infinity;
      const pid = parsed?.pid;
      let alive = false;
      if (pid && Number.isFinite(pid)) {
        try { process.kill(pid, 0); alive = true; } catch { alive = false; }
      }
      if (!alive || age > 30 * 60_000) {
        try { await unlink(p); console.log(`[n2n] removed stale mcp-auth lock: ${p}`); } catch {}
      }
    }
  };
  await walk(root);
}

/**
 * Apply runtime tweaks to mcp-remote arg lists so users don't have to keep
 * their saved configs in sync with our defaults. Right now: bump the OAuth
 * callback timeout from 30 s (default) to 600 s — the Bun server (or even a
 * remote tunnel) often takes longer than 30 s end-to-end during a browser
 * OAuth flow, and the listener closes too early otherwise.
 */
function tweakMcpArgs(command: string, args: string[]): string[] {
  const runner = command.split("/").pop() || command;
  const usesNpxOrBunx = runner === "npx" || runner === "bunx";
  if (!usesNpxOrBunx) return args;
  const hasMcpRemote = args.some((a) => a === "mcp-remote" || a.endsWith("/mcp-remote"));
  if (!hasMcpRemote) return args;
  const hasTimeout = args.some((a) => a === "--auth-timeout");
  if (hasTimeout) return args;
  return [...args, "--auth-timeout", "600"];
}

function mcpRuntimeHint(command: string): string | null {
  const c = command.toLowerCase();
  if (c === "npx" || c === "node" || c === "npm") {
    return `Installe Node.js depuis l'onglet « Environnements » (icône à côté des paramètres).`;
  }
  if (c === "python" || c === "python3" || c === "uv" || c === "uvx") {
    return `Installe Python depuis l'onglet « Environnements » (icône à côté des paramètres).`;
  }
  return null;
}

// Patterns to spot OAuth-related output. We require both a recognised
// provider OAuth path AND a `client_id=…` query so we don't capture mere
// discovery URLs (e.g. "Discovered authorization server: accounts.google.com/")
// that lack the actual auth params.
const OAUTH_HOST_RE = /https?:\/\/(?:accounts\.google\.com\/o\/oauth2|login\.microsoftonline\.com\/[^\s/]+\/oauth2|github\.com\/login\/oauth|api\.notion\.com\/v1\/oauth|slack\.com\/oauth|appleid\.apple\.com\/auth|auth\.atlassian\.com|app\.asana\.com\/-\/oauth_authorize|api\.linear\.app\/oauth|discord\.com\/api\/oauth2|api\.dropbox\.com\/oauth2|gitlab\.com\/oauth|api\.figma\.com\/oauth)[^\s]*\?[^\s]*\bclient_id=[^\s]+/i;
// Match localhost:NNN, 127.0.0.1:NNN, plus URL-encoded variants
// (localhost%3ANNN) and human phrases like "callback port: 33222" or
// "listening on port 33222". mcp-remote uses several of these formats.
const LOCAL_LISTENER_PATTERNS: RegExp[] = [
  /(?:127\.0\.0\.1|localhost)(?::|%3A)(\d{2,5})\b/i,
  /(?:callback|listener|listening)\s+(?:on\s+)?(?:port\s*:?\s*)(\d{2,5})\b/i,
  /selected\s+callback\s+port[^\d]*(\d{2,5})\b/i,
];
function findLocalPort(s: string): number | null {
  for (const re of LOCAL_LISTENER_PATTERNS) {
    const m = s.match(re);
    if (m) {
      const port = parseInt(m[1], 10);
      if (Number.isFinite(port) && port > 0 && port < 65536) return port;
    }
  }
  return null;
}
// mcp-remote prints "Auth code received" once the OAuth callback completes
// successfully. Use that to dismiss the AuthBanner automatically.
const OAUTH_SUCCESS_RE = /Auth code received|Authorization successful|Tokens? received|authentication[- ]successful/i;

type PendingAuth = { authUrl: string; localPort: number | null };

class McpClient {
  name: string;
  config: McpConfig;
  proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  tools: McpToolSpec[] = [];
  connected = false;
  error: string | null = null;
  pendingAuth: PendingAuth | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buffer = "";
  private stderrBuf = "";
  private logs = "";
  private static MAX_LOG = 16_000;
  private logBroadcastTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleLogBroadcast(): void {
    if (this.logBroadcastTimer) return;
    this.logBroadcastTimer = setTimeout(() => {
      this.logBroadcastTimer = null;
      broadcast("mcpChanged");
    }, 400);
  }

  constructor(name: string, config: McpConfig) {
    this.name = name;
    this.config = config;
  }

  /** Combined stderr + spawn log, capped to MAX_LOG bytes. */
  recentLogs(): string { return this.logs; }

  private appendLog(chunk: string): void {
    this.logs += chunk;
    if (this.logs.length > McpClient.MAX_LOG) {
      this.logs = this.logs.slice(-Math.floor(McpClient.MAX_LOG * 0.75));
    }
  }

  /** Scan a chunk of stderr for OAuth markers. Mutates pendingAuth + emits. */
  private scanForAuth(chunk: string): void {
    let changed = false;
    if (!this.pendingAuth?.authUrl) {
      const m = chunk.match(OAUTH_HOST_RE);
      if (m) {
        // Strip trailing punctuation that often clings to URLs in logs
        const url = m[0].replace(/[)\].,;"'>]+$/g, "");
        this.pendingAuth = { authUrl: url, localPort: this.pendingAuth?.localPort ?? null };
        changed = true;
      }
    }
    if (!this.pendingAuth?.localPort) {
      const port = findLocalPort(chunk);
      if (port) {
        this.pendingAuth = {
          authUrl: this.pendingAuth?.authUrl ?? "",
          localPort: port,
        };
        changed = true;
      }
    }
    // Auto-dismiss when we see a success marker (e.g. mcp-remote received
    // the OAuth callback and exchanged it for tokens).
    if (this.pendingAuth && OAUTH_SUCCESS_RE.test(chunk)) {
      this.pendingAuth = null;
      changed = true;
    }
    if (changed) broadcast("mcpChanged");
  }

  dismissAuth(): void {
    if (this.pendingAuth) {
      this.pendingAuth = null;
      broadcast("mcpChanged");
    }
  }

  async start(): Promise<boolean> {
    const path = await getExtendedPath();
    const resolved = (await findInPath(this.config.command, path)) || this.config.command;
    if (resolved === this.config.command && !this.config.command.includes("/")) {
      // We didn't find it; check if it's a runtime we know how to install.
      const guidance = mcpRuntimeHint(this.config.command);
      if (guidance) {
        this.error = `spawn: "${this.config.command}" introuvable. ${guidance}`;
        broadcast("mcpChanged");
        return false;
      }
    }
    this.logs = "";
    this.pendingAuth = null;
    const expandedArgs = tweakMcpArgs(
      this.config.command,
      (this.config.args || []).map((a) => expandMcpArg(a, this.config.env || {})),
    );
    try {
      this.proc = spawn({
        cmd: [resolved, ...expandedArgs],
        env: { ...process.env, ...(this.config.env || {}), PATH: path } as Record<string, string>,
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
    } catch (err: any) {
      this.error = `spawn: ${err.message || err}`;
      return false;
    }

    // Read stdout line-by-line (JSON-RPC messages)
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

    // Read stderr — surface logs to the UI and detect OAuth URLs.
    (async () => {
      if (!this.proc) return;
      const reader = this.proc.stderr.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          this.stderrBuf += text;
          this.appendLog(text);
          this.scanForAuth(this.stderrBuf);
          // Keep a small tail of stderr for cross-line URL matching, but cap
          // memory: if no URL has matched yet keep last 4KB, else drop.
          if (this.stderrBuf.length > 8192) {
            this.stderrBuf = this.stderrBuf.slice(-4096);
          }
          // Broadcast log update to clients (live tail), debounced to avoid
          // spamming SSE when a server is chatty.
          this.scheduleLogBroadcast();
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
      // initialize: long timeout because OAuth-needing servers stay silent
      // until the user finishes the auth flow in their browser.
      await this.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "n2n", version: "0.1.0" },
      }, 10 * 60_000);
      this.notify("notifications/initialized");
      const result = await this.request("tools/list", {});
      this.tools = result?.tools || [];
      this.connected = true;
      this.error = null;
      // Note: don't auto-clear pendingAuth here. mcp-remote routes initialize
      // and tools/list locally without authentication, but tools/call still
      // needs OAuth to succeed. The banner stays up until we observe an
      // explicit success marker on stderr (OAUTH_SUCCESS_RE) or the user
      // dismisses it.
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
    // Long timeout: OAuth-needing servers (mcp-remote) intercept the first
    // call, run a browser OAuth flow, then retry. The user may take minutes
    // to log in and consent — don't reject before mcp-remote does.
    return this.request("tools/call", { name, arguments: args || {} }, 10 * 60_000);
  }

  stop(): void {
    if (this.logBroadcastTimer) {
      clearTimeout(this.logBroadcastTimer);
      this.logBroadcastTimer = null;
    }
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill(); } catch {}
    }
    if (this.authProc && !this.authProc.killed) {
      try { this.authProc.kill(); } catch {}
    }
    this.proc = null;
    this.authProc = null;
    this.connected = false;
    this.failPending(new Error("MCP arrêté"));
  }

  // ---- one-off auth flow ----

  authProc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  authRunning = false;

  /**
   * Spawn `command + args + authArgs` as a one-shot process. Most "OAuth-y"
   * MCP servers (gmail-autoauth, gdrive…) ship a separate `auth` subcommand
   * that opens a browser, completes OAuth, writes credentials to disk, then
   * exits. The regular MCP process (if running) is left alone — it'll pick up
   * the credentials on next restart.
   */
  async runAuth(): Promise<void> {
    if (this.authRunning) return;
    const authArgs = this.config.authArgs;
    if (!authArgs || authArgs.length === 0) {
      this.appendLog("[auth] Aucune commande d'authentification configurée pour ce serveur.\n");
      broadcast("mcpChanged");
      return;
    }
    const path = await getExtendedPath();
    const resolved = (await findInPath(this.config.command, path)) || this.config.command;
    if (resolved === this.config.command && !this.config.command.includes("/")) {
      const guidance = mcpRuntimeHint(this.config.command);
      this.appendLog(`[auth] "${this.config.command}" introuvable. ${guidance ?? ""}\n`);
      broadcast("mcpChanged");
      return;
    }
    const env = this.config.env || {};
    const fullArgs = tweakMcpArgs(
      this.config.command,
      [...(this.config.args || []), ...authArgs].map((a) => expandMcpArg(a, env)),
    );
    this.appendLog(`\n[auth] $ ${this.config.command} ${fullArgs.join(" ")}\n`);
    this.pendingAuth = null;
    this.authRunning = true;
    broadcast("mcpChanged");

    let proc: Subprocess<"pipe", "pipe", "pipe">;
    try {
      proc = spawn({
        cmd: [resolved, ...fullArgs],
        env: { ...process.env, ...(this.config.env || {}), PATH: path } as Record<string, string>,
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
    } catch (err: any) {
      this.appendLog(`[auth] spawn failed: ${err?.message || err}\n`);
      this.authRunning = false;
      broadcast("mcpChanged");
      return;
    }
    this.authProc = proc;

    // Tee stdout + stderr into the existing log + URL scanner. Some MCPs
    // print the auth URL on stdout, others on stderr — handle both.
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          this.stderrBuf += text;
          this.appendLog(text);
          this.scanForAuth(this.stderrBuf);
          if (this.stderrBuf.length > 8192) this.stderrBuf = this.stderrBuf.slice(-4096);
          this.scheduleLogBroadcast();
        }
      } catch {}
    };
    void drain(proc.stdout);
    void drain(proc.stderr);

    proc.exited.then(async (code) => {
      this.appendLog(`[auth] terminé (code ${code})\n`);
      this.authRunning = false;
      this.authProc = null;
      this.pendingAuth = null;
      broadcast("mcpChanged");
      if (code === 0) {
        // Credentials saved — restart the main MCP so it reloads them.
        this.appendLog(`[auth] Identifiants enregistrés, redémarrage du serveur MCP…\n`);
        try { await startMcpServer(this.name, this.config); } catch {}
      }
    });
  }
}

const mcpClients = new Map<string, McpClient>();
let mcpConfigCache: { servers: Record<string, McpConfig> } | null = null;

/**
 * Compat shim — auto-attach a Google OAuth spec to existing saved configs
 * that match a known preset by command/args. Saves users from having to
 * delete + recreate their MCP server when we add OAuth metadata to the
 * preset shape.
 */
const KNOWN_OAUTH_PRESETS: Array<{
  matches: (cfg: McpConfig) => boolean;
  oauth: McpOAuthSpec;
}> = [
  {
    matches: (c) =>
      c.args.some((a) => a.includes("@gongrzhe/server-gmail-autoauth-mcp")),
    oauth: {
      provider: "google",
      clientSecretFile: "~/.gmail-mcp/gcp-oauth.keys.json",
      tokensPath: "~/.gmail-mcp/credentials.json",
      scopes: [
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.settings.basic",
      ],
      redirectUri: "http://localhost:3000/oauth2callback",
    },
  },
  {
    matches: (c) =>
      c.args.some((a) => a.includes("@modelcontextprotocol/server-gdrive")),
    oauth: {
      provider: "google",
      clientSecretFile: "~/.config/mcp-gdrive/gcp-oauth.keys.json",
      tokensPath: "~/.config/mcp-gdrive/credentials.json",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      redirectUri: "http://localhost:3000/oauth2callback",
    },
  },
];
function autoAttachKnownOAuth(cfg: McpConfig): void {
  if (cfg.oauth) return;
  const preset = KNOWN_OAUTH_PRESETS.find((p) => p.matches(cfg));
  if (preset) cfg.oauth = preset.oauth;
}

async function loadMcpConfig(): Promise<{ servers: Record<string, McpConfig> }> {
  if (mcpConfigCache) return mcpConfigCache;
  try {
    const parsed = JSON.parse(await readFile(MCP_SERVERS_PATH, "utf8"));
    mcpConfigCache = parsed && typeof parsed === "object" && parsed.servers ? parsed : { servers: {} };
  } catch { mcpConfigCache = { servers: {} }; }
  for (const cfg of Object.values(mcpConfigCache!.servers)) {
    autoAttachKnownOAuth(cfg);
  }
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
  // Drop stale ~/.mcp-auth/ lockfiles so mcp-remote always becomes leader
  // and actually binds the OAuth callback port. (Required when a previous
  // mcp-remote crashed without clean shutdown.)
  await cleanupStaleMcpAuthLocks().catch(() => undefined);
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
      authArgs: config.authArgs || [],
      configFiles: config.configFiles || [],
      oauth: config.oauth || null,
      connected: !!client?.connected,
      error: client?.error || null,
      tools: client ? client.tools.map((t) => ({
        name: t.name, description: t.description,
        inputSchema: t.inputSchema || { type: "object", properties: {} },
      })) : [],
      pendingAuth: client?.pendingAuth ?? null,
      authRunning: !!client?.authRunning,
      oauthCallbackPath: `/oauth/${encodeURIComponent(name)}/`,
      logs: client?.recentLogs() ?? "",
    };
  });
}

// ---------- Manual OAuth flow ----------
//
// Drives the OAuth handshake from n2n itself (no listener needed in the
// MCP). Loosely modeled on the Python `google_auth_start` / `complete`
// pair — we generate the auth URL from the user's OAuth client JSON, the
// user opens it in their browser, completes consent, and pastes back
// either the full callback URL or just the `code` parameter. We exchange
// the code for tokens at Google's token endpoint and write a credentials
// file in the format the MCP (gongrzhe gmail-autoauth) reads on startup.

type OAuthPendingSession = {
  mcpName: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  tokenUri: string;
  scopes: string[];
  tokensPath: string;
  createdAt: number;
};
const OAUTH_SESSION_TTL_MS = 30 * 60_000;
const oauthSessions = new Map<string, OAuthPendingSession>();
function pruneExpiredOAuthSessions(): void {
  const cutoff = Date.now() - OAUTH_SESSION_TTL_MS;
  for (const [k, s] of oauthSessions) {
    if (s.createdAt < cutoff) oauthSessions.delete(k);
  }
}

function expandHomePath(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function startGoogleOAuth(
  name: string,
  overrides?: { redirectUri?: string },
): Promise<{
  sessionId: string;
  authUrl: string;
  redirectUri: string;
}> {
  const cfg = mcpConfigCache?.servers[name];
  if (!cfg?.oauth) throw new Error(`OAuth non configuré pour "${name}"`);
  const spec = cfg.oauth;
  const clientFile = expandHomePath(spec.clientSecretFile);
  if (!(await exists(clientFile))) {
    throw new Error(
      `OAuth client JSON introuvable à ${clientFile}. ` +
      `Colle ton gcp-oauth.keys.json dans la modal du serveur d'abord.`,
    );
  }
  let parsed: any;
  try { parsed = JSON.parse(await readFile(clientFile, "utf8")); }
  catch (e: any) { throw new Error(`OAuth client JSON invalide: ${e?.message || e}`); }
  const inner = parsed.installed || parsed.web || parsed;
  const clientId = String(inner.client_id || "");
  const clientSecret = String(inner.client_secret || "");
  if (!clientId || !clientSecret) throw new Error("client_id / client_secret manquants dans le JSON OAuth");
  const tokenUri = String(inner.token_uri || "https://oauth2.googleapis.com/token");
  const authUri = String(inner.auth_uri || "https://accounts.google.com/o/oauth2/v2/auth");

  // Loopback redirect_uri: works with Desktop OAuth clients without
  // pre-registration. The browser will fail to load (no local listener)
  // but the URL bar still has ?code=… for the user to copy. The user can
  // override it from the UI to match whatever they registered in Google
  // Cloud Console (Web-type OAuth clients require an exact match).
  const redirectUri =
    (overrides?.redirectUri && overrides.redirectUri.trim()) ||
    spec.redirectUri ||
    "http://localhost:3000/oauth2callback";

  const codeVerifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const challengeBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)),
  );
  const codeChallenge = base64UrlEncode(challengeBytes);
  const state = randomUUID();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: spec.scopes.join(" "),
    state,
    access_type: "offline",
    prompt: "consent",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    include_granted_scopes: "true",
  });
  const authUrl = `${authUri}?${params.toString()}`;

  const sessionId = randomUUID();
  pruneExpiredOAuthSessions();
  oauthSessions.set(sessionId, {
    mcpName: name,
    state,
    codeVerifier,
    redirectUri,
    clientId,
    clientSecret,
    tokenUri,
    scopes: spec.scopes,
    tokensPath: spec.tokensPath,
    createdAt: Date.now(),
  });
  return { sessionId, authUrl, redirectUri };
}

async function completeGoogleOAuth(
  name: string,
  sessionId: string,
  args: { code?: string; callbackUrl?: string },
): Promise<{ tokensPath: string }> {
  pruneExpiredOAuthSessions();
  const session = oauthSessions.get(sessionId);
  if (!session) throw new Error("Session OAuth inconnue ou expirée — relance « Démarrer OAuth »");
  if (session.mcpName !== name) throw new Error("Session OAuth liée à un autre MCP");

  let code = (args.code || "").trim();
  if (args.callbackUrl) {
    try {
      const u = new URL(args.callbackUrl);
      const errParam = u.searchParams.get("error");
      if (errParam) throw new Error(`Google a renvoyé une erreur: ${errParam}`);
      const cbCode = u.searchParams.get("code");
      const cbState = u.searchParams.get("state");
      if (cbCode) code = cbCode;
      if (cbState && cbState !== session.state) {
        throw new Error("State OAuth invalide (la callback ne correspond pas à la session)");
      }
    } catch (e: any) {
      // Throw if it's not a URL parse error
      if (e?.message?.includes("State OAuth")) throw e;
      if (e?.message?.includes("Google a renvoyé")) throw e;
      // else accept the raw code as-is
    }
  }
  if (!code) throw new Error("code OAuth manquant (colle l'URL complète ou juste le code)");

  // Exchange code for tokens
  const tokenResp = await fetch(session.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: session.clientId,
      client_secret: session.clientSecret,
      code,
      code_verifier: session.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: session.redirectUri,
    }).toString(),
  });
  if (!tokenResp.ok) {
    const t = await tokenResp.text();
    throw new Error(`Échec exchange Google (${tokenResp.status}): ${t}`);
  }
  const tokens = (await tokenResp.json()) as Record<string, any>;
  // Match google-auth-library format expected by gongrzhe (and most
  // node-google clients): include expiry_date in ms epoch.
  if (typeof tokens.expires_in === "number" && !tokens.expiry_date) {
    tokens.expiry_date = Date.now() + tokens.expires_in * 1000;
  }
  const tokensPath = expandHomePath(session.tokensPath);
  await mkdir(dirname(tokensPath), { recursive: true });
  await writeFile(tokensPath, JSON.stringify(tokens, null, 2));
  oauthSessions.delete(sessionId);

  // Restart the MCP so it loads the freshly-minted credentials.
  const cfg = mcpConfigCache?.servers[name];
  if (cfg) await startMcpServer(name, cfg);

  return { tokensPath };
}

async function proxyMcpOAuth(req: Request, name: string, rest: string): Promise<Response> {
  const client = mcpClients.get(name);
  if (!client) return err(`MCP "${name}" non enregistré`, 404);
  const port = client.pendingAuth?.localPort;
  if (!port) {
    return new Response(
      `Cette URL est une callback OAuth — elle n'est pas faite pour être visitée directement.\n\n` +
      `Pour authentifier le MCP "${name}":\n` +
      `1. Ouvre l'app n2n.\n` +
      `2. Dans le panneau MCP, clique « Lancer OAuth » sur la carte du serveur (ou invoque un de ses outils via un nœud / le chat).\n` +
      `3. Une bannière OAuth apparaîtra avec un lien Google/GitHub/etc.\n` +
      `4. Clic sur ce lien → consent → Google redirigera ici automatiquement.\n`,
      { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }
  const incoming = new URL(req.url);
  const headers: Record<string, string> = {};
  for (const [k, v] of req.headers) {
    const lk = k.toLowerCase();
    if (lk === "host" || lk === "connection" || lk === "content-length") continue;
    headers[k] = v;
  }
  let body: ArrayBuffer | undefined = undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await req.arrayBuffer();
  }
  // Some Node servers bind on ::: (dual-stack) and `fetch` to 127.0.0.1
  // resolves only IPv4 — try IPv4, then IPv6 loopback. Plus a small retry
  // window in case mcp-remote is between two listen() calls (rare race).
  const hosts = ["127.0.0.1", "[::1]"];
  let lastErr: any = null;
  const isConnectErr = (e: any) => {
    const code = e?.code || e?.cause?.code || "";
    const msg = String(e?.message || e || "");
    return (
      code === "ECONNREFUSED" ||
      /ECONNREFUSED|refused|unable to connect|connection|fetch failed|ENOTFOUND/i.test(msg)
    );
  };
  for (let attempt = 0; attempt < 6; attempt++) {
    for (const host of hosts) {
      const target = `http://${host}:${port}/${rest}${incoming.search}`;
      try {
        const resp = await fetch(target, {
          method: req.method,
          headers,
          body,
          redirect: "manual",
        });
        const outHeaders = new Headers();
        resp.headers.forEach((v, k) => {
          const lk = k.toLowerCase();
          if (lk === "transfer-encoding" || lk === "connection") return;
          outHeaders.set(k, v);
        });
        for (const [k, v] of Object.entries(corsHeaders())) outHeaders.set(k, v);
        return new Response(resp.body, { status: resp.status, headers: outHeaders });
      } catch (e: any) {
        lastErr = e;
        // Bubble up non-connect errors; otherwise we'll retry.
        if (!isConnectErr(e)) {
          attempt = 99;
          break;
        }
      }
    }
    // brief backoff between retry rounds (0, 200, 400, 800, 1600, 3200 ms)
    if (attempt < 5) await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
  }
  const msg = lastErr?.message || String(lastErr);
  const refused = isConnectErr(lastErr);
  console.warn(
    `[n2n] OAuth proxy failed for "${name}" → http://*:${port}${rest ? "/" + rest : ""} ` +
    `after retries — ${refused ? "connection refused" : msg}`,
  );
  return new Response(
    refused
      ? `Le MCP "${name}" n'écoute pas sur localhost:${port}.\n\n` +
        `Erreur réseau : ${msg}\n\n` +
        `Causes les plus probables :\n` +
        `• mcp-remote n'a pas (encore) déclenché son flux OAuth — clique « Lancer OAuth » d'abord.\n` +
        `• Sa fenêtre d'attente est expirée (mcp-remote ferme son listener après quelques minutes).\n` +
        `• Le sous-processus mcp-remote a quitté — vérifie le journal du serveur dans l'app.\n\n` +
        `Diagnostic : lance sur le VPS \`ss -lntp | grep ${port}\` ou \`lsof -i :${port}\` ` +
        `pendant que la bannière OAuth est affichée. Tu devrais voir node/npx en LISTEN.\n`
      : `Échec du proxy vers localhost:${port}: ${msg}`,
    { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
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
  route("POST", "/api/mcp/:name/auth-flow", async (_r, p) => {
    await loadMcpConfig();
    let client = mcpClients.get(p.name);
    if (!client) {
      const cfg = mcpConfigCache?.servers[p.name];
      if (!cfg) return err("MCP non trouvé", 404);
      client = new McpClient(p.name, cfg);
      mcpClients.set(p.name, client);
    }
    void client.runAuth();
    return json({ ok: true });
  }),
  route("POST", "/api/mcp/:name/dismiss-auth", async (_r, p) => {
    const client = mcpClients.get(p.name);
    client?.dismissAuth();
    return json({ ok: true });
  }),
  // Manual OAuth flow — start: generates Google auth URL, stores PKCE
  // session. Returns auth URL + sessionId for the UI to walk the user
  // through paste-the-callback.
  route("POST", "/api/mcp/:name/oauth/start", async (req, p) => {
    await loadMcpConfig();
    let body: { redirectUri?: string } = {};
    try { body = await readJson<{ redirectUri?: string }>(req); } catch {}
    return json(await startGoogleOAuth(p.name, body));
  }),
  // Manual OAuth flow — complete: takes either the full callback URL the
  // browser landed on (recommended) or just the `code`. Exchanges for
  // tokens and writes them to the MCP's expected credentials path.
  route("POST", "/api/mcp/:name/oauth/complete", async (req, p) => {
    const body = await readJson<{ sessionId: string; code?: string; callbackUrl?: string }>(req);
    if (!body?.sessionId) return err("sessionId requis", 400);
    return json(await completeGoogleOAuth(p.name, body.sessionId, body));
  }),
  // Write a config file that an MCP needs at runtime (typically an OAuth
  // client JSON the MCP reads from disk). The path *must* be one declared
  // in the saved server config under `configFiles`, and *must* resolve
  // under the user's home — the user can't just POST to /etc/passwd.
  route("POST", "/api/mcp/:name/config-file", async (req, p) => {
    await loadMcpConfig();
    const cfg = mcpConfigCache?.servers[p.name];
    if (!cfg) return err("MCP non trouvé", 404);
    const { path: rawPath, content } = await readJson<{ path: string; content: string }>(req);
    if (typeof rawPath !== "string" || typeof content !== "string") {
      return err("path et content requis", 400);
    }
    const declared = cfg.configFiles?.find((f) => f.path === rawPath);
    if (!declared) return err("Chemin non déclaré pour ce MCP", 403);
    const home = homedir();
    const expanded = rawPath.startsWith("~/")
      ? join(home, rawPath.slice(2))
      : resolve(rawPath);
    const homeReal = resolve(home);
    if (expanded !== homeReal && !expanded.startsWith(homeReal + sep)) {
      return err("Chemin hors du répertoire utilisateur", 403);
    }
    if (declared.format === "json") {
      try { JSON.parse(content); }
      catch { return err("Le contenu n'est pas un JSON valide", 400); }
    }
    await mkdir(dirname(expanded), { recursive: true });
    await writeFile(expanded, content);
    return json({ ok: true, path: expanded });
  }),
  // Fire-and-forget probe to coax mcp-remote into starting its OAuth flow
  // (which it only does after a tools/call returns 401). We send a JSON-RPC
  // request and return *immediately* — no await — so the HTTP response
  // doesn't sit open while the user signs in. mcp-remote keeps running in
  // the background and the auth URL surfaces on stderr → AuthBanner.
  route("POST", "/api/mcp/:name/probe-oauth", async (req, p) => {
    const client = mcpClients.get(p.name);
    if (!client || !client.connected) return err("MCP non connecté", 503);
    const body = await readJson<{ tool?: string }>(req);
    let toolName = body?.tool;
    if (!toolName) {
      const safe = client.tools.find((t) => /^(list|search|get)[_-]/i.test(t.name));
      toolName = safe?.name || client.tools[0]?.name;
    }
    if (!toolName) return err("Aucun outil disponible pour la probe", 400);
    // We swallow the eventual response — it's a probe.
    client.callTool(toolName, {}).catch(() => undefined);
    return json({ ok: true, probedTool: toolName });
  }),
  route("PUT", "/api/mcp/:name", async (req, p) => {
    if (!/^[a-z0-9_-]+$/i.test(p.name)) throw new Error("Nom invalide");
    const config = await readJson<any>(req);
    await loadMcpConfig();
    const cf = Array.isArray(config?.configFiles)
      ? (config.configFiles as any[])
          .filter((f) => f && typeof f.path === "string")
          .map((f) => ({
            path: String(f.path),
            description: typeof f.description === "string" ? f.description : undefined,
            format: f.format === "text" ? "text" as const : "json" as const,
          }))
      : undefined;
    let oauth: McpOAuthSpec | undefined;
    if (config?.oauth && typeof config.oauth === "object") {
      const o = config.oauth as any;
      if (
        o.provider === "google" &&
        typeof o.clientSecretFile === "string" &&
        typeof o.tokensPath === "string" &&
        Array.isArray(o.scopes)
      ) {
        oauth = {
          provider: "google",
          clientSecretFile: String(o.clientSecretFile),
          tokensPath: String(o.tokensPath),
          scopes: o.scopes.map(String),
          redirectUri: typeof o.redirectUri === "string" ? o.redirectUri : undefined,
        };
      }
    }
    mcpConfigCache!.servers[p.name] = {
      command: String(config?.command || ""),
      args: Array.isArray(config?.args) ? config.args.map(String) : [],
      env: config?.env && typeof config.env === "object"
        ? Object.fromEntries(Object.entries(config.env).map(([k, v]) => [k, String(v)]))
        : {},
      authArgs: Array.isArray(config?.authArgs) && config.authArgs.length > 0
        ? config.authArgs.map(String)
        : undefined,
      configFiles: cf && cf.length > 0 ? cf : undefined,
      oauth,
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

  // Runtimes (Node, Python, …): detect + one-click install
  route("GET", "/api/runtimes", async () => json(await listRuntimes())),
  route("POST", "/api/runtimes/:id/install", async (_r, p) => {
    const known =
      p.id === "node" ||
      p.id === "python" ||
      KNOWN_NPM_PKGS.some((k) => k.id === p.id);
    if (!known) return err("Runtime inconnu", 404);
    const state = getInstallState(p.id);
    if (state.installing) return json({ ok: true, alreadyRunning: true });
    void startRuntimeInstall(p.id);
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

  // OAuth proxy: /oauth/<server-name>/<rest> — receives OAuth provider redirects
  // and forwards them to the MCP process's localhost listener. Bypasses the
  // global API token because OAuth providers can't carry a bearer header.
  // The MCP process itself handles state/code exchange, so there's no extra
  // secret we'd want to enforce here.
  if (url.pathname.startsWith("/oauth/")) {
    const tail = url.pathname.slice("/oauth/".length);
    const slash = tail.indexOf("/");
    const name = decodeURIComponent(slash === -1 ? tail : tail.slice(0, slash));
    const rest = slash === -1 ? "" : tail.slice(slash + 1);
    if (!name) return err("Nom MCP requis", 400);
    return proxyMcpOAuth(req, name, rest);
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
    // Bun's default idle timeout is 10 s — too short for /api/ai/chat (long
    // streaming) and /api/mcp/call when an MCP runs an OAuth flow that
    // takes minutes for the user to complete in the browser. 255 is the max
    // Bun accepts; for unbounded we'd need WebSockets.
    idleTimeout: 255,
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
      idleTimeout: 255,
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
