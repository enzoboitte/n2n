const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const fsSync = require("fs");
const { watch: fsWatch } = require("fs");
const http = require("http");
const os = require("os");
const { spawn } = require("child_process");

const N2N_DIR = path.join(os.homedir(), ".n2n");
const MODULES_DIR = path.join(N2N_DIR, "modules");
const ENV_PATH = path.join(N2N_DIR, "env.json");
const PROJECTS_DIR = path.join(N2N_DIR, "projects");
const STATE_PATH = path.join(N2N_DIR, "state.json");
const HISTORY_PATH = path.join(N2N_DIR, "history.jsonl");
const HISTORY_MAX_LINES = 5000;
const WEBHOOK_PORT = parseInt(process.env.N2N_WEBHOOK_PORT || "9999", 10);
const MCP_SERVERS_PATH = path.join(N2N_DIR, "mcp-servers.json");
const BUNDLED_MODULES_DIR = path.join(__dirname, "..", "assets", "modules");
const DEV_URL = "http://localhost:3000";
const PYTHON = process.env.N2N_PYTHON || "python3";
const LLAMA_URL =
  process.env.N2N_LLAMA_URL || "http://localhost:8080/v1/chat/completions";

// Modules removed from the bundle in past versions — wipe them on startup so
// they don't linger as broken stubs in the user's folder.
const DEPRECATED_MODULES = [
  "bool-source",
  "bool-and",
  "bool-or",
  "bool-not",
  "bool-xor",
  "branch",
  "branch-length",
  "branch-contains",
  "branch-equals",
  "code",
];

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const sp = path.join(src, entry.name);
    const dp = path.join(dst, entry.name);
    if (entry.isDirectory()) await copyDir(sp, dp);
    else await fs.copyFile(sp, dp);
  }
}

async function readManifest(dir) {
  try {
    return JSON.parse(
      await fs.readFile(path.join(dir, "manifest.json"), "utf8"),
    );
  } catch {
    return null;
  }
}

// Sync one bundled module: install if missing, replace if the bundled
// `version` field changed (so updates land), keep if unchanged.
async function syncModule(srcDir, dstDir) {
  if (!(await exists(dstDir))) {
    await copyDir(srcDir, dstDir);
    return;
  }
  const src = await readManifest(srcDir);
  const dst = await readManifest(dstDir);
  const same = src && dst && src.version && src.version === dst.version;
  if (same) return;
  await fs.rm(dstDir, { recursive: true, force: true });
  await copyDir(srcDir, dstDir);
}

async function ensureModulesDir() {
  await fs.mkdir(MODULES_DIR, { recursive: true });

  // Strip deprecated modules left over from earlier versions
  for (const id of DEPRECATED_MODULES) {
    const dir = path.join(MODULES_DIR, id);
    if (await exists(dir)) {
      await fs.rm(dir, { recursive: true, force: true });
      console.log(`[n2n] removed deprecated module: ${id}`);
    }
  }

  if (!(await exists(BUNDLED_MODULES_DIR))) return;
  for (const entry of await fs.readdir(BUNDLED_MODULES_DIR, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    await syncModule(
      path.join(BUNDLED_MODULES_DIR, entry.name),
      path.join(MODULES_DIR, entry.name),
    );
  }
}

async function listModules() {
  await ensureModulesDir();
  const out = [];
  for (const entry of await fs.readdir(MODULES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(MODULES_DIR, entry.name, "manifest.json");
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      out.push(manifest);
    } catch (err) {
      console.warn(`[n2n] skip ${entry.name}: ${err.message}`);
    }
  }
  return out;
}

// Stream Server-Sent Events from a llama.cpp / OpenAI-compatible endpoint.
// Each delta token is forwarded to the renderer via `ai:chunk:<id>`.
// Active streams are tracked so the renderer can abort them.
const activeStreams = new Map();

async function chatStream(event, { id, messages, options }) {
  const url = (options && options.url) || LLAMA_URL;
  const controller = new AbortController();
  activeStreams.set(id, controller);

  const body = {
    model: (options && options.model) || "local",
    messages,
    stream: true,
    temperature: (options && options.temperature) ?? 0.7,
  };
  if (options && Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = options.tool_choice || "auto";
  }
  // chat_template_kwargs.enable_thinking — supported by reasoning models
  // (Qwen-3, etc.) to toggle the <think>...</think> phase. We disable it
  // mid tool-calling loop so the model doesn't re-think between each call.
  if (options && typeof options.enable_thinking === "boolean") {
    body.chat_template_kwargs = {
      ...(body.chat_template_kwargs || {}),
      enable_thinking: options.enable_thinking,
    };
  }

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    activeStreams.delete(id);
    if (err.name === "AbortError") return { ok: true, aborted: true };
    return { ok: false, error: `fetch: ${err.message || err}` };
  }
  if (!resp.ok) {
    activeStreams.delete(id);
    let body = "";
    try {
      body = await resp.text();
    } catch {}
    return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 500)}` };
  }
  if (!resp.body) {
    activeStreams.delete(id);
    return { ok: false, error: "Pas de corps de réponse" };
  }

  const reader = resp.body.getReader();
  controller.signal.addEventListener("abort", () => {
    reader.cancel().catch(() => {});
  });
  const decoder = new TextDecoder();
  let buffer = "";
  let inReasoning = false;
  let finishReason = null;
  // Tool calls are streamed: id arrives once, function.name once, and
  // function.arguments arrives in pieces. We accumulate by index.
  const toolCallsByIndex = new Map();
  const send = (text) => event.sender.send(`ai:chunk:${id}`, text);

  try {
    while (true) {
      if (controller.signal.aborted) return { ok: true, aborted: true };
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
          if (inReasoning) {
            send("</think>");
            inReasoning = false;
          }
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
            if (!inReasoning) {
              send("<think>");
              inReasoning = true;
            }
            send(reasoning);
          }
          if (content) {
            if (inReasoning) {
              send("</think>");
              inReasoning = false;
            }
            send(content);
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              let acc = toolCallsByIndex.get(idx);
              if (!acc) {
                acc = {
                  id: "",
                  type: "function",
                  function: { name: "", arguments: "" },
                };
                toolCallsByIndex.set(idx, acc);
              }
              if (tc.id) acc.id = tc.id;
              if (tc.type) acc.type = tc.type;
              if (tc.function?.name) acc.function.name = tc.function.name;
              if (tc.function?.arguments)
                acc.function.arguments += tc.function.arguments;
            }
          }
        } catch {
          // ignore malformed lines
        }
      }
    }
    if (inReasoning) {
      send("</think>");
      inReasoning = false;
    }
    return finalize();
  } catch (err) {
    if (err.name === "AbortError") return { ok: true, aborted: true };
    return { ok: false, error: `stream: ${err.message || err}` };
  } finally {
    activeStreams.delete(id);
  }

  function finalize() {
    const toolCalls = Array.from(toolCallsByIndex.values()).filter(
      (tc) => tc.function && tc.function.name,
    );
    return { ok: true, toolCalls, finishReason };
  }
}

function abortStream(id) {
  const c = activeStreams.get(id);
  if (c) c.abort();
}

// Sandbox a relative path inside a module folder. Throws if it escapes.
function moduleFilePath(id, file) {
  if (!/^[a-z0-9._-]+$/i.test(id)) throw new Error(`Module id invalide: ${id}`);
  const dir = path.join(MODULES_DIR, id);
  const target = path.resolve(dir, file || "");
  const dirReal = path.resolve(dir);
  if (target !== dirReal && !target.startsWith(dirReal + path.sep)) {
    throw new Error("Chemin hors du module");
  }
  return target;
}

async function createModule({ id, manifest, code }) {
  if (!/^[a-z0-9._-]+$/i.test(id)) {
    throw new Error("ID invalide (a-z, 0-9, ., _, -)");
  }
  const dir = path.join(MODULES_DIR, id);
  if (await exists(dir)) throw new Error(`Module ${id} existe déjà`);
  await fs.mkdir(dir, { recursive: true });
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
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(finalManifest, null, 2),
  );
  await fs.writeFile(
    path.join(dir, "module.py"),
    code || defaultModuleCode(id),
  );
  return { id };
}

function defaultModuleCode(id) {
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

async function deleteModule(id) {
  const dir = moduleFilePath(id, "");
  await fs.rm(dir, { recursive: true, force: true });
}

async function listModuleFiles(id) {
  const dir = moduleFilePath(id, "");
  if (!(await exists(dir))) throw new Error(`Module ${id} introuvable`);
  const out = [];
  const walk = async (cur, rel) => {
    const entries = await fs.readdir(cur, { withFileTypes: true });
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push({ path: r, kind: "dir" });
        await walk(path.join(cur, e.name), r);
      } else {
        out.push({ path: r, kind: "file" });
      }
    }
  };
  await walk(dir, "");
  return out;
}

async function readModuleFile(id, file) {
  const p = moduleFilePath(id, file);
  return fs.readFile(p, "utf8");
}

async function writeModuleFile(id, file, content) {
  const p = moduleFilePath(id, file);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content ?? "");
}

async function deleteModuleFile(id, file) {
  const p = moduleFilePath(id, file);
  await fs.rm(p, { recursive: true, force: true });
}

// ---------- PROJETS ----------

const { randomUUID } = require("crypto");

function projectFile(id) {
  if (!/^[a-z0-9._-]+$/i.test(id)) throw new Error(`ID projet invalide: ${id}`);
  return path.join(PROJECTS_DIR, `${id}.json`);
}

async function listProjects() {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
  const files = await fs.readdir(PROJECTS_DIR);
  const out = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(PROJECTS_DIR, f), "utf8");
      const p = JSON.parse(raw);
      if (p && p.id) {
        out.push({
          id: p.id,
          name: p.name || "(sans nom)",
          createdAt: p.createdAt || 0,
          updatedAt: p.updatedAt || 0,
        });
      }
    } catch {
      // skip malformed file
    }
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function loadProject(id) {
  const raw = await fs.readFile(projectFile(id), "utf8");
  return JSON.parse(raw);
}

async function saveProjectFile(project) {
  if (!project || !project.id) throw new Error("Projet sans id");
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
  await fs.writeFile(projectFile(project.id), JSON.stringify(project, null, 2));
  return { id: project.id };
}

async function createProject(name) {
  const id = randomUUID();
  const now = Date.now();
  const project = {
    id,
    name: name || "Untitled",
    createdAt: now,
    updatedAt: now,
    nodes: [],
    edges: [],
  };
  await saveProjectFile(project);
  return project;
}

async function deleteProject(id) {
  await fs.rm(projectFile(id), { force: true });
}

async function renameProject(id, name) {
  const project = await loadProject(id);
  project.name = String(name || "Untitled");
  project.updatedAt = Date.now();
  await saveProjectFile(project);
  return { id, name: project.name };
}

async function duplicateProject(id) {
  const src = await loadProject(id);
  const newId = randomUUID();
  const now = Date.now();
  const dup = {
    ...src,
    id: newId,
    name: `${src.name} (copie)`,
    createdAt: now,
    updatedAt: now,
  };
  await saveProjectFile(dup);
  return dup;
}

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_PATH, "utf8")) || {};
  } catch {
    return {};
  }
}

async function saveState(state) {
  await fs.mkdir(N2N_DIR, { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state || {}, null, 2));
}

async function getActiveProjectId() {
  const state = await loadState();
  return state.activeProjectId || null;
}

async function setActiveProjectId(id) {
  const state = await loadState();
  state.activeProjectId = id;
  await saveState(state);
}

async function exportProjectToFile(win, id) {
  const project = await loadProject(id);
  const result = await dialog.showSaveDialog(win, {
    title: "Exporter le projet",
    defaultPath: `${project.name.replace(/[^a-z0-9._-]+/gi, "_")}.n2n.json`,
    filters: [{ name: "n2n JSON", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.writeFile(result.filePath, JSON.stringify(project, null, 2));
  return { canceled: false, path: result.filePath };
}

async function importProjectFromFile(win) {
  const result = await dialog.showOpenDialog(win, {
    title: "Importer un projet",
    properties: ["openFile"],
    filters: [
      { name: "n2n JSON", extensions: ["json"] },
      { name: "Tous", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const raw = await fs.readFile(result.filePaths[0], "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { canceled: false, error: `JSON invalide: ${err.message}` };
  }
  // Tolerate a bare {nodes, edges} payload too
  const id = randomUUID();
  const now = Date.now();
  const project = {
    id,
    name:
      typeof parsed.name === "string" && parsed.name.trim()
        ? parsed.name + " (importé)"
        : path.basename(result.filePaths[0], ".json") + " (importé)",
    createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : now,
    updatedAt: now,
    nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
    edges: Array.isArray(parsed.edges) ? parsed.edges : [],
  };
  await saveProjectFile(project);
  return { canceled: false, project };
}

// ---------- CRON ----------

const cronTimers = new Map(); // nodeId -> NodeJS.Timeout

function parseInterval(s) {
  const m = String(s || "").match(/^\s*(\d+)\s*(ms|s|m|h|d)?\s*$/i);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || "s").toLowerCase();
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
  return n * (mult || 1000);
}

function cronRegister(win, id, intervalMs) {
  cronUnregister(id);
  if (!intervalMs || intervalMs < 100) return;
  const handle = setInterval(() => {
    if (win && !win.isDestroyed()) win.webContents.send("cron:tick", { id });
  }, intervalMs);
  cronTimers.set(id, handle);
}

function cronUnregister(id) {
  const h = cronTimers.get(id);
  if (h) {
    clearInterval(h);
    cronTimers.delete(id);
  }
}

function cronUnregisterAll() {
  for (const h of cronTimers.values()) clearInterval(h);
  cronTimers.clear();
}

// ---------- WEBHOOK ----------

const webhookRoutes = new Map(); // path -> { nodeId, response }
let webhookServer = null;
let webhookWin = null;

// Mirrors `substituteString` from src/lib/template.ts so the server can
// render its response synchronously without round-tripping the renderer.
function substituteRequestVars(s, vars) {
  if (typeof s !== "string") return s;
  return s.replace(
    /\{([a-zA-Z_$][a-zA-Z0-9_$-]*(?:\.[a-zA-Z0-9_$-]+)*)\}/g,
    (match, expr) => {
      const parts = expr.split(".");
      const root = parts[0];
      if (!(root in vars)) return match;
      let cur = vars[root];
      for (let i = 1; i < parts.length; i++) {
        if (cur === null || cur === undefined) return match;
        const seg = parts[i];
        if (Array.isArray(cur)) {
          const idx = Number(seg);
          cur = Number.isFinite(idx) ? cur[idx] : undefined;
        } else if (typeof cur === "object") {
          cur = cur[seg];
        } else {
          return match;
        }
      }
      if (cur === null || cur === undefined) return match;
      if (typeof cur === "object") return JSON.stringify(cur);
      return String(cur);
    },
  );
}

function ensureWebhookServer() {
  if (webhookServer) return;
  webhookServer = http.createServer((req, res) => {
    const u = new URL(req.url, `http://localhost:${WEBHOOK_PORT}`);
    if (!u.pathname.startsWith("/webhook/")) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    const route = u.pathname.slice("/webhook/".length).replace(/\/+$/, "");
    const target = webhookRoutes.get(route);
    if (!target) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`no webhook registered for "${route}"`);
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      body += c;
      if (body.length > 5_000_000) req.destroy();
    });
    req.on("end", async () => {
      const query = Object.fromEntries(u.searchParams.entries());
      const headers = req.headers;
      let parsedBody = null;
      try {
        parsedBody = body ? JSON.parse(body) : null;
      } catch {
        parsedBody = null;
      }
      const requestData = {
        method: req.method,
        body,
        json: parsedBody,
        query,
        headers,
        path: route,
      };

      // Build response from the user's config, with substitution against
      // both the incoming request and the global env.
      const env = await loadEnv();
      const vars = { request: requestData, ...env };
      const r = target.response || {};
      const statusStr = substituteRequestVars(
        String(r.status ?? "200"),
        vars,
      );
      const status = parseInt(statusStr, 10) || 200;
      const contentType =
        substituteRequestVars(String(r.contentType ?? "application/json"), vars) ||
        "application/json";
      const responseBody = substituteRequestVars(
        String(r.body ?? '{"ok":true}'),
        vars,
      );
      const respHeaders = { "Content-Type": contentType };
      const userHeaders = r.headers || {};
      for (const [k, v] of Object.entries(userHeaders)) {
        const key = substituteRequestVars(String(k), vars);
        const val = substituteRequestVars(String(v), vars);
        if (key) respHeaders[key] = val;
      }

      res.writeHead(status, respHeaders);
      res.end(responseBody);

      // Fire the workflow trigger AFTER responding (don't block the caller).
      if (webhookWin && !webhookWin.isDestroyed()) {
        webhookWin.webContents.send("webhook:fired", {
          nodeId: target.nodeId,
          path: route,
          data: requestData,
        });
      }
    });
  });
  webhookServer.on("error", (err) => {
    console.warn(`[n2n] webhook server error: ${err.message}`);
  });
  webhookServer.listen(WEBHOOK_PORT, "127.0.0.1", () => {
    console.log(`[n2n] webhook server on http://localhost:${WEBHOOK_PORT}/webhook/<path>`);
  });
}

function webhookRegister(win, nodeId, path, response) {
  webhookWin = win;
  ensureWebhookServer();
  if (!path) return;
  // If multiple nodes registered the same path, last one wins.
  webhookRoutes.set(path, { nodeId, response: response || null });
}

function webhookUnregister(nodeId) {
  for (const [path, r] of webhookRoutes) {
    if (r.nodeId === nodeId) webhookRoutes.delete(path);
  }
}

function webhookUnregisterAll() {
  webhookRoutes.clear();
}

// ---------- HISTORY ----------

async function appendHistory(entry) {
  await fs.mkdir(N2N_DIR, { recursive: true });
  const line = JSON.stringify(entry) + "\n";
  await fs.appendFile(HISTORY_PATH, line);
  // Periodic trim — every 100th call roughly
  if (Math.random() < 0.01) await trimHistory();
}

async function trimHistory() {
  try {
    const content = await fs.readFile(HISTORY_PATH, "utf8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length > HISTORY_MAX_LINES) {
      const kept = lines.slice(-HISTORY_MAX_LINES).join("\n") + "\n";
      await fs.writeFile(HISTORY_PATH, kept);
    }
  } catch {}
}

async function readHistory(limit = 200) {
  try {
    const content = await fs.readFile(HISTORY_PATH, "utf8");
    const lines = content.split("\n").filter(Boolean);
    const tail = lines.slice(-Math.max(1, limit)).reverse();
    return tail
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function clearHistory() {
  try {
    await fs.unlink(HISTORY_PATH);
  } catch {}
}

// ---------- MCP (Model Context Protocol) ----------
//
// Each registered MCP server is spawned as a child process and we speak
// JSON-RPC over its stdio per the MCP spec (initialize → tools/list →
// tools/call). We hand-roll the protocol to avoid a heavy SDK dependency.

const mcpClients = new Map(); // name -> McpClient
let mcpConfigCache = null; // { servers: { name: { command, args, env } } }
let mcpReadyWin = null; // window to notify on (re)connection / errors

class McpClient {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.proc = null;
    this.tools = [];
    this.connected = false;
    this.error = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
  }

  start() {
    return new Promise((resolve) => {
      try {
        this.proc = spawn(
          this.config.command,
          this.config.args || [],
          {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, ...(this.config.env || {}) },
          },
        );
      } catch (err) {
        this.error = `spawn: ${err.message || err}`;
        return resolve(false);
      }

      this.proc.stdout.setEncoding("utf8");
      this.proc.stdout.on("data", (chunk) => {
        this.buffer += chunk;
        let nl;
        while ((nl = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (!line) continue;
          this._handleMessage(line);
        }
      });

      this.proc.on("error", (err) => {
        this.error = err.message;
        this.connected = false;
        this._failPending(err);
      });
      this.proc.on("exit", (code) => {
        this.connected = false;
        if (code !== 0 && !this.error) {
          this.error = `Process exited (code ${code})`;
        }
        this._failPending(new Error(this.error || "Process exited"));
      });

      // Initialize handshake
      this._request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "n2n", version: "0.1.0" },
      })
        .then(() => {
          this._notify("notifications/initialized");
          return this._request("tools/list", {});
        })
        .then((result) => {
          this.tools = result?.tools || [];
          this.connected = true;
          this.error = null;
          resolve(true);
        })
        .catch((err) => {
          this.error = String(err.message || err);
          this.connected = false;
          resolve(false);
        });
    });
  }

  _handleMessage(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) {
        reject(
          new Error(msg.error.message || JSON.stringify(msg.error)),
        );
      } else {
        resolve(msg.result);
      }
    }
  }

  _failPending(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  _send(msg) {
    if (!this.proc || this.proc.killed) {
      throw new Error(`MCP "${this.name}" non démarré`);
    }
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  _request(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this._send({ jsonrpc: "2.0", id, method, params: params ?? {} });
      } catch (err) {
        this.pending.delete(id);
        reject(err);
        return;
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }

  _notify(method, params) {
    try {
      this._send({ jsonrpc: "2.0", method, params: params ?? {} });
    } catch {}
  }

  callTool(name, args) {
    return this._request("tools/call", {
      name,
      arguments: args || {},
    });
  }

  stop() {
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill();
      } catch {}
    }
    this.proc = null;
    this.connected = false;
    this._failPending(new Error("MCP arrêté"));
  }
}

async function loadMcpConfig() {
  if (mcpConfigCache) return mcpConfigCache;
  try {
    const raw = await fs.readFile(MCP_SERVERS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    mcpConfigCache =
      parsed && typeof parsed === "object" && parsed.servers
        ? parsed
        : { servers: {} };
  } catch {
    mcpConfigCache = { servers: {} };
  }
  return mcpConfigCache;
}

async function saveMcpConfig() {
  if (!mcpConfigCache) mcpConfigCache = { servers: {} };
  await fs.mkdir(N2N_DIR, { recursive: true });
  await fs.writeFile(
    MCP_SERVERS_PATH,
    JSON.stringify(mcpConfigCache, null, 2),
  );
}

function notifyMcpChange() {
  if (mcpReadyWin && !mcpReadyWin.isDestroyed()) {
    mcpReadyWin.webContents.send("mcp:changed");
  }
}

async function startMcpServer(name, config) {
  const existing = mcpClients.get(name);
  if (existing) existing.stop();
  const client = new McpClient(name, config);
  mcpClients.set(name, client);
  await client.start();
  notifyMcpChange();
}

async function stopMcpServer(name) {
  const c = mcpClients.get(name);
  if (c) c.stop();
  mcpClients.delete(name);
  notifyMcpChange();
}

async function startAllMcpServers(win) {
  mcpReadyWin = win;
  const cfg = await loadMcpConfig();
  for (const [name, server] of Object.entries(cfg.servers || {})) {
    await startMcpServer(name, server);
  }
}

function stopAllMcpServers() {
  for (const c of mcpClients.values()) c.stop();
  mcpClients.clear();
}

function listMcpState() {
  const cfg = mcpConfigCache?.servers || {};
  const out = [];
  for (const [name, config] of Object.entries(cfg)) {
    const client = mcpClients.get(name);
    out.push({
      name,
      command: config.command,
      args: config.args || [],
      env: config.env || {},
      connected: !!client?.connected,
      error: client?.error || null,
      tools: client
        ? client.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema || { type: "object", properties: {} },
          }))
        : [],
    });
  }
  return out;
}

async function callMcpToolByName(server, tool, args) {
  const c = mcpClients.get(server);
  if (!c) throw new Error(`MCP "${server}" non enregistré`);
  if (!c.connected) {
    throw new Error(`MCP "${server}" non connecté: ${c.error || "?"}`);
  }
  return c.callTool(tool, args);
}

async function loadEnv() {
  try {
    const raw = await fs.readFile(ENV_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // file missing or unreadable — empty env
  }
  return {};
}

async function saveEnv(env) {
  await fs.mkdir(N2N_DIR, { recursive: true });
  await fs.writeFile(ENV_PATH, JSON.stringify(env || {}, null, 2));
}

function runModule({ id, inputs, params, letters, env }) {
  return new Promise((resolve) => {
    const dir = path.join(MODULES_DIR, id);
    const manifestPath = path.join(dir, "manifest.json");

    fs.readFile(manifestPath, "utf8")
      .then((raw) => {
        const manifest = JSON.parse(raw);
        const entry = path.join(dir, manifest.entry || "module.py");
        const child = spawn(PYTHON, [entry], { cwd: dir });

        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d.toString()));
        child.stderr.on("data", (d) => (stderr += d.toString()));
        child.on("error", (err) =>
          resolve({ ok: false, error: `spawn: ${err.message}` }),
        );
        child.on("close", (code) => {
          if (code !== 0) {
            resolve({
              ok: false,
              error: stderr.trim() || `exit ${code}`,
            });
            return;
          }
          try {
            const outputs = stdout.trim() ? JSON.parse(stdout) : {};
            resolve({ ok: true, outputs });
          } catch (err) {
            resolve({
              ok: false,
              error: `JSON output invalide: ${err.message}\n${stdout}`,
            });
          }
        });

        child.stdin.write(
          JSON.stringify({
            inputs: inputs || {},
            params: params || {},
            letters: letters || {},
            env: env || {},
          }),
        );
        child.stdin.end();
      })
      .catch((err) =>
        resolve({ ok: false, error: `manifest: ${err.message}` }),
      );
  });
}

// Watch ~/.n2n/modules for changes and notify the renderer (debounced).
function attachMcpStartup(win) {
  // Fire-and-forget: if a server is misconfigured we still start the app
  // and surface the error in the UI rather than blocking.
  startAllMcpServers(win).catch((err) =>
    console.warn(`[n2n] MCP startup failed: ${err.message}`),
  );
}

function attachModuleWatcher(win) {
  let timer = null;
  let watcher;
  try {
    watcher = fsWatch(MODULES_DIR, { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (!win.isDestroyed()) win.webContents.send("modules:changed");
      }, 200);
    });
  } catch (err) {
    console.warn(`[n2n] module watcher disabled: ${err.message}`);
    return;
  }
  win.on("closed", () => {
    if (watcher) {
      try {
        watcher.close();
      } catch {}
    }
    if (timer) clearTimeout(timer);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#0f172a",
    icon: path.join(__dirname, "..", "assets", "icon.svg"),
    title: "n2n",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (!app.isPackaged) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(path.join(__dirname, "..", "out", "index.html"));
  }

  attachModuleWatcher(win);
  attachMcpStartup(win);
}

app.whenReady().then(async () => {
  ipcMain.handle("modules:list", () => listModules());
  ipcMain.handle("module:run", (_e, args) => runModule(args));
  ipcMain.handle("modules:openFolder", async () => {
    await ensureModulesDir();
    return shell.openPath(MODULES_DIR);
  });
  ipcMain.handle("env:load", () => loadEnv());
  ipcMain.handle("env:save", (_e, env) => saveEnv(env));
  ipcMain.handle("ai:chat", (e, args) => chatStream(e, args));
  ipcMain.handle("ai:abort", (_e, { id }) => {
    abortStream(id);
  });

  ipcMain.handle("projects:list", () => listProjects());
  ipcMain.handle("projects:load", (_e, { id }) => loadProject(id));
  ipcMain.handle("projects:save", (_e, project) => saveProjectFile(project));
  ipcMain.handle("projects:create", (_e, { name } = {}) =>
    createProject(name),
  );
  ipcMain.handle("projects:rename", (_e, { id, name }) =>
    renameProject(id, name),
  );
  ipcMain.handle("projects:delete", (_e, { id }) => deleteProject(id));
  ipcMain.handle("projects:duplicate", (_e, { id }) => duplicateProject(id));
  ipcMain.handle("projects:getActive", () => getActiveProjectId());
  ipcMain.handle("projects:setActive", (_e, { id }) => setActiveProjectId(id));
  ipcMain.handle("projects:exportToFile", (e, { id }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return exportProjectToFile(win, id);
  });
  ipcMain.handle("projects:importFromFile", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return importProjectFromFile(win);
  });

  ipcMain.handle("cron:register", (e, { id, intervalMs }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    cronRegister(win, id, intervalMs);
  });
  ipcMain.handle("cron:unregister", (_e, { id }) => cronUnregister(id));
  ipcMain.handle("cron:unregisterAll", () => cronUnregisterAll());

  ipcMain.handle("webhook:register", (e, { nodeId, path, response }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    webhookRegister(win, nodeId, path, response);
  });
  ipcMain.handle("webhook:unregister", (_e, { nodeId }) =>
    webhookUnregister(nodeId),
  );
  ipcMain.handle("webhook:unregisterAll", () => webhookUnregisterAll());
  ipcMain.handle("webhook:port", () => WEBHOOK_PORT);

  ipcMain.handle("mcp:list", async () => {
    await loadMcpConfig();
    return listMcpState();
  });
  ipcMain.handle("mcp:save", async (_e, { name, config }) => {
    if (!name || !/^[a-z0-9_-]+$/i.test(name)) {
      throw new Error("Nom invalide (a-z, 0-9, _, -)");
    }
    await loadMcpConfig();
    mcpConfigCache.servers[name] = {
      command: String(config?.command || ""),
      args: Array.isArray(config?.args) ? config.args.map(String) : [],
      env:
        config?.env && typeof config.env === "object"
          ? Object.fromEntries(
              Object.entries(config.env).map(([k, v]) => [k, String(v)]),
            )
          : {},
    };
    await saveMcpConfig();
    await startMcpServer(name, mcpConfigCache.servers[name]);
    return { ok: true };
  });
  ipcMain.handle("mcp:delete", async (_e, { name }) => {
    await loadMcpConfig();
    delete mcpConfigCache.servers[name];
    await saveMcpConfig();
    await stopMcpServer(name);
  });
  ipcMain.handle("mcp:restart", async (_e, { name }) => {
    await loadMcpConfig();
    const cfg = mcpConfigCache.servers[name];
    if (cfg) await startMcpServer(name, cfg);
  });
  ipcMain.handle("mcp:callTool", (_e, { server, tool, args }) =>
    callMcpToolByName(server, tool, args),
  );

  ipcMain.handle("history:append", (_e, entry) => appendHistory(entry));
  ipcMain.handle("history:read", (_e, { limit } = {}) =>
    readHistory(limit ?? 200),
  );
  ipcMain.handle("history:clear", () => clearHistory());

  ipcMain.handle("module:create", (_e, args) => createModule(args));
  ipcMain.handle("module:delete", (_e, { id }) => deleteModule(id));
  ipcMain.handle("module:fs:list", (_e, { id }) => listModuleFiles(id));
  ipcMain.handle("module:fs:read", (_e, { id, file }) => readModuleFile(id, file));
  ipcMain.handle("module:fs:write", (_e, { id, file, content }) =>
    writeModuleFile(id, file, content),
  );
  ipcMain.handle("module:fs:delete", (_e, { id, file }) =>
    deleteModuleFile(id, file),
  );

  await ensureModulesDir();
  createWindow();
});

app.on("window-all-closed", () => {
  cronUnregisterAll();
  webhookUnregisterAll();
  stopAllMcpServers();
  if (webhookServer) {
    try {
      webhookServer.close();
    } catch {}
    webhookServer = null;
  }
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
