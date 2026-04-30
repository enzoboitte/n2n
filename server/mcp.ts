// Model Context Protocol — client process management, OAuth flows,
// callback proxy. Bundled here because the pieces are tightly coupled:
// the `McpClient` class drives the JSON-RPC stdio loop, scans stderr for
// OAuth markers, and shares the lifecycle with the n2n-driven manual
// OAuth flow (no listener required).
//
// Boundaries:
//   - SSE notifications routed via ./sse.ts.
//   - PATH and runtime detection from ./runtimes.ts.
//   - HTTP helpers (corsHeaders / err) from ./http-helpers.ts.
//
// Public API roughly mirrors the routes that hit it:
//   loadMcpConfig, saveMcpConfig, listMcpState
//   startMcpServer / stopMcpServer / startAllMcpServers / stopAllMcpServers
//   callMcpToolByName    (used from the graph runtime)
//   coerceMcpArgs        (graph runtime — coerces UI strings to schema types)
//   startGoogleOAuth, completeGoogleOAuth   (manual flow)
//   proxyMcpOAuth        (forwarded-callback bridge for remote n2n setups)

import { spawn, type Subprocess } from "bun";
import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { MCP_SERVERS_PATH, N2N_DIR } from "./config.ts";
import { exists } from "./fs-helpers.ts";
import { broadcast } from "./sse.ts";
import { findInPath, getExtendedPath } from "./runtimes.ts";
import { corsHeaders, err } from "./http-helpers.ts";

export type McpConfigFile = {
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
export type McpOAuthSpec = {
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

export type McpConfig = {
  command: string;
  args: string[];
  env: Record<string, string>;
  authArgs?: string[];
  configFiles?: McpConfigFile[];
  oauth?: McpOAuthSpec;
};

export type McpToolSpec = { name: string; description?: string; inputSchema?: any };

/** Coerce stringly-typed UI args into the JSON-Schema types the tool expects. */
export function coerceMcpArgs(
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
// discovery URLs that lack the actual auth params.
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

export class McpClient {
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
    } catch (e: any) {
      this.error = `spawn: ${e.message || e}`;
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
          if (this.stderrBuf.length > 8192) {
            this.stderrBuf = this.stderrBuf.slice(-4096);
          }
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
      // Don't auto-clear pendingAuth: mcp-remote routes initialize +
      // tools/list locally without auth, but tools/call still needs it.
      return true;
    } catch (e: any) {
      this.error = String(e.message || e);
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

  private failPending(e: Error): void {
    for (const { reject } of this.pending.values()) reject(e);
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
      catch (e: any) { this.pending.delete(id); reject(e); return; }
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
    // Long timeout — some MCPs (mcp-remote) intercept the first call to
    // run a browser OAuth flow that may take minutes.
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

  // ---- one-off auth subcommand flow (gongrzhe gmail-autoauth, gdrive…) ----

  authProc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  authRunning = false;

  /**
   * Spawn `command + args + authArgs` as a one-shot process. The regular
   * MCP keeps running unrelated to this; on success we restart it so it
   * picks up the fresh credentials written by the auth subcommand.
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
    } catch (e: any) {
      this.appendLog(`[auth] spawn failed: ${e?.message || e}\n`);
      this.authRunning = false;
      broadcast("mcpChanged");
      return;
    }
    this.authProc = proc;

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
        this.appendLog(`[auth] Identifiants enregistrés, redémarrage du serveur MCP…\n`);
        try { await startMcpServer(this.name, this.config); } catch {}
      }
    });
  }
}

// ---- registry & config ----

const mcpClients = new Map<string, McpClient>();
let mcpConfigCache: { servers: Record<string, McpConfig> } | null = null;

/**
 * Compat shim: auto-attach a Google OAuth spec to existing saved configs
 * matching a known preset. Keeps users from needing to delete + recreate
 * their MCP server when we add OAuth metadata to a preset shape.
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

export async function loadMcpConfig(): Promise<{ servers: Record<string, McpConfig> }> {
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

/** Read-only access to the in-memory config cache (used by routes). */
export function getMcpConfigCache(): { servers: Record<string, McpConfig> } | null {
  return mcpConfigCache;
}

export function setMcpConfigEntry(name: string, cfg: McpConfig): void {
  if (!mcpConfigCache) mcpConfigCache = { servers: {} };
  mcpConfigCache.servers[name] = cfg;
}

export function deleteMcpConfigEntry(name: string): void {
  if (!mcpConfigCache) return;
  delete mcpConfigCache.servers[name];
}

export async function saveMcpConfig(): Promise<void> {
  if (!mcpConfigCache) mcpConfigCache = { servers: {} };
  await mkdir(N2N_DIR, { recursive: true });
  await writeFile(MCP_SERVERS_PATH, JSON.stringify(mcpConfigCache, null, 2));
}

export async function startMcpServer(name: string, config: McpConfig): Promise<void> {
  const existing = mcpClients.get(name);
  if (existing) existing.stop();
  await cleanupStaleMcpAuthLocks().catch(() => undefined);
  const client = new McpClient(name, config);
  mcpClients.set(name, client);
  await client.start();
  broadcast("mcpChanged");
}

export async function stopMcpServer(name: string): Promise<void> {
  const c = mcpClients.get(name);
  if (c) c.stop();
  mcpClients.delete(name);
  broadcast("mcpChanged");
}

export async function startAllMcpServers(): Promise<void> {
  const cfg = await loadMcpConfig();
  for (const [name, server] of Object.entries(cfg.servers || {})) {
    await startMcpServer(name, server);
  }
}

export function stopAllMcpServers(): void {
  for (const c of mcpClients.values()) c.stop();
  mcpClients.clear();
}

export function getMcpClient(name: string): McpClient | undefined {
  return mcpClients.get(name);
}

export function listMcpState(): any[] {
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

export async function callMcpToolByName(server: string, tool: string, args: any): Promise<any> {
  const c = mcpClients.get(server);
  if (!c) throw new Error(`MCP "${server}" non enregistré`);
  if (!c.connected) throw new Error(`MCP "${server}" non connecté: ${c.error || "?"}`);
  return c.callTool(tool, args);
}

// ---- manual OAuth flow ----

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

export async function startGoogleOAuth(
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

export async function completeGoogleOAuth(
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
      if (e?.message?.includes("State OAuth")) throw e;
      if (e?.message?.includes("Google a renvoyé")) throw e;
      // else accept the raw code as-is
    }
  }
  if (!code) throw new Error("code OAuth manquant (colle l'URL complète ou juste le code)");

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
  if (typeof tokens.expires_in === "number" && !tokens.expiry_date) {
    tokens.expiry_date = Date.now() + tokens.expires_in * 1000;
  }
  const tokensPath = expandHomePath(session.tokensPath);
  await mkdir(dirname(tokensPath), { recursive: true });
  await writeFile(tokensPath, JSON.stringify(tokens, null, 2));
  oauthSessions.delete(sessionId);

  const cfg = mcpConfigCache?.servers[name];
  if (cfg) await startMcpServer(name, cfg);

  return { tokensPath };
}

export async function proxyMcpOAuth(req: Request, name: string, rest: string): Promise<Response> {
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
        if (!isConnectErr(e)) {
          attempt = 99;
          break;
        }
      }
    }
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
