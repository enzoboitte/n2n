// n2n server — TypeScript + Bun. Replaces electron/main.cjs as the headless
// backend. Web UI (Next.js) connects via HTTP + SSE.
//
// Build a single-binary release with:
//   bun build --compile --target=bun-linux-x64 server/index.ts -o n2n-server
//
// In dev:
//   bun --watch server/index.ts        (with CORS open to localhost:3000)

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, dirname, sep } from "node:path";
import { homedir } from "node:os";

// Constants & filesystem layout — see ./config.ts
import {
  HOST, API_PORT, WEBHOOK_PORT, API_TOKEN,
} from "./config.ts";
// Disk-backed env vars — see ./env-store.ts
import { loadEnv, saveEnv } from "./env-store.ts";
// Project / state / history persistence — see ./project-store.ts
import {
  listProjects, loadProject, saveProjectFile, createProject, deleteProject,
  renameProject, duplicateProject, getActiveProjectId, setActiveProjectId,
  importProjectFromBuffer, appendHistory, readHistory, clearHistory,
} from "./project-store.ts";
// SSE event bus — see ./sse.ts
import { broadcast, eventStream } from "./sse.ts";
// External runtimes (Node, Python, npm drivers) — see ./runtimes.ts
import {
  KNOWN_NPM_PKGS, listRuntimes, startRuntimeInstall, setPostInstallHook,
} from "./runtimes.ts";
// User module CRUD + filesystem watcher — see ./modules-store.ts
import {
  listModules, createModule, deleteModule,
  listModuleFiles, readModuleFile, writeModuleFile, deleteModuleFile,
  attachModuleWatcher, detachModuleWatcher,
} from "./modules-store.ts";
// Auto-pull bundled modules into ~/.n2n/modules/ on first run — see ./fs-helpers.ts
import { ensureModulesDir } from "./fs-helpers.ts";
// Install state lookups for the runtimes panel — see ./runtimes.ts
import { getInstallState } from "./runtimes.ts";
// scheduleEnvWatchTriggers re-fires env-watch nodes on env changes
import { scheduleEnvWatchTriggers } from "./graph-runtime.ts";
// Python module runner — see ./python-runner.ts
import { runPythonModule } from "./python-runner.ts";
// Manifest cache — see ./manifest-cache.ts
import { invalidateManifestCache } from "./manifest-cache.ts";
// MCP client + OAuth flows + callback proxy — see ./mcp.ts
import {
  type McpConfig, type McpOAuthSpec,
  loadMcpConfig, saveMcpConfig, getMcpConfigCache,
  setMcpConfigEntry, deleteMcpConfigEntry,
  startMcpServer, stopMcpServer, startAllMcpServers, stopAllMcpServers,
  getMcpClient, listMcpState, callMcpToolByName,
  startGoogleOAuth, completeGoogleOAuth, proxyMcpOAuth,
} from "./mcp.ts";
// HTTP helpers (CORS, json/err, route() factory) — see ./http-helpers.ts
import {
  corsHeaders, json, err, readJson, route, type RouteMatch,
} from "./http-helpers.ts";
// SSE proxy to llama.cpp — see ./ai-chat.ts
import { aiChatStream, abortAiStream } from "./ai-chat.ts";
// Graph runtime — see ./graph-runtime.ts
import { runManualNode } from "./graph-runtime.ts";
// Cron + webhook trigger registry — see ./triggers.ts
import {
  scheduleTriggerSync, syncProjectTriggers, tearDownAllTriggers,
} from "./triggers.ts";
// /webhook/<path> handler — see ./webhooks.ts
import { handleWebhook, bearerEquals as constantTimeEqual } from "./webhooks.ts";
import { tearDownDeferredHttp } from "./http-defer.ts";


// ---------- HTTP routing ----------


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
    const cfg = getMcpConfigCache()?.servers[p.name];
    if (cfg) await startMcpServer(p.name, cfg);
    return json({ ok: true });
  }),
  route("POST", "/api/mcp/:name/auth-flow", async (_r, p) => {
    await loadMcpConfig();
    let client = getMcpClient(p.name);
    if (!client) {
      const cfg = getMcpConfigCache()?.servers[p.name];
      if (!cfg) return err("MCP non trouvé", 404);
      // Spawning a fresh client just for auth — startMcpServer would
      // restart the full stdio loop which we don't want here.
      await startMcpServer(p.name, cfg);
      client = getMcpClient(p.name);
      if (!client) return err("MCP non démarré", 500);
    }
    void client.runAuth();
    return json({ ok: true });
  }),
  route("POST", "/api/mcp/:name/dismiss-auth", async (_r, p) => {
    const client = getMcpClient(p.name);
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
    const cfg = getMcpConfigCache()?.servers[p.name];
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
    const client = getMcpClient(p.name);
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
    const newCfg: McpConfig = {
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
    setMcpConfigEntry(p.name, newCfg);
    await saveMcpConfig();
    await startMcpServer(p.name, newCfg);
    return json({ ok: true });
  }),
  route("DELETE", "/api/mcp/:name", async (_r, p) => {
    await loadMcpConfig();
    deleteMcpConfigEntry(p.name);
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
  route("GET", "/api/events", () => eventStream(corsHeaders())),

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
  attachModuleWatcher(invalidateManifestCache);
  // Hook the runtimes module: when Node or Python finishes installing,
  // re-launch any MCP that was stuck on a missing executable.
  setPostInstallHook(() => {
    startAllMcpServers().catch(() => undefined);
  });
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
  tearDownDeferredHttp();
  stopAllMcpServers();
  detachModuleWatcher();
  process.exit(0);
});

main().catch((e) => { console.error(e); process.exit(1); });
