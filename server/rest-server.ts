// REST-endpoint multi-port registry. Each `rest-endpoint` node in a
// project becomes a route in a Bun.serve listening on the node's chosen
// port. Multiple nodes sharing the same `port` share a single Bun.serve;
// changing only a non-port attribute swaps routes in place without
// restarting the server.
//
// Two response modes per route:
//   - "immediate" (legacy): render the templated response_body and reply
//     instantly; the graph runs in the background.
//   - "deferred":  hold the response open until a `rest-end` node fires
//     in the graph (or the timeout elapses). A `rest-send` node may push
//     chunks before `rest-end` to stream progressively. The deferred
//     bookkeeping lives in `http-defer.ts` and is shared with
//     webhook-receive.
//
// Public API:
//   syncRestEndpoints(routes)  — replace the entire route table
//   tearDownAllRestEndpoints()

import { randomUUID } from "node:crypto";
import { runGraphFromTrigger } from "./graph-runtime.ts";
import { registerDeferredHttp } from "./http-defer.ts";

type Server = ReturnType<typeof Bun.serve>;

export type RestRouteSpec = {
  projectId: string;
  nodeId: string;
  port: number;
  hostname: string;
  method: string;
  path: string;
  mode: "immediate" | "deferred";
  timeoutMs: number;
  response: {
    status: string;
    contentType: string;
    body: string;
    headers: Record<string, string>;
  };
  secret?: string;
};

type CompiledRoute = RestRouteSpec & {
  pathRe: RegExp;
  pathKeys: string[];
};

type ServerEntry = {
  server: Server;
  hostname: string;
  routes: CompiledRoute[];
};

const servers = new Map<number, ServerEntry>();

function compileRoute(r: RestRouteSpec): CompiledRoute {
  const keys: string[] = [];
  const re = new RegExp(
    "^" +
      r.path.replace(/:([a-zA-Z0-9_]+)/g, (_, k) => {
        keys.push(k);
        return "([^/]+)";
      }) +
      "$",
  );
  return { ...r, pathRe: re, pathKeys: keys };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function checkSecret(req: Request, url: URL, secret: string): boolean {
  if (!secret) return true;
  const auth = req.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    if (constantTimeEqual(auth.slice(7).trim(), secret)) return true;
  }
  const headerKey =
    req.headers.get("x-api-key") || req.headers.get("x-rest-secret") || "";
  if (headerKey && constantTimeEqual(headerKey, secret)) return true;
  const qk = url.searchParams.get("key") || url.searchParams.get("token") || "";
  if (qk && constantTimeEqual(qk, secret)) return true;
  return false;
}

/**
 * Same `{var.0.path}` substitution semantics as webhooks. Hyphens allowed
 * in keys (Content-Type style), and arrays support numeric indexing.
 */
function substitute(s: string, vars: Record<string, any>): string {
  if (typeof s !== "string") return s as any;
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

function methodAllows(routeMethod: string, reqMethod: string): boolean {
  const m = routeMethod.toUpperCase();
  if (!m || m === "ANY" || m === "*") return true;
  return m === reqMethod.toUpperCase();
}

async function dispatch(entry: ServerEntry, req: Request): Promise<Response> {
  const url = new URL(req.url);
  // OPTIONS preflight: surface the CORS dance for any /path so a browser
  // can call the API directly without the user wiring an explicit OPTIONS
  // route per path.
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key, X-Rest-Secret",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  for (const route of entry.routes) {
    if (!methodAllows(route.method, req.method)) continue;
    const m = route.pathRe.exec(url.pathname);
    if (!m) continue;

    if (route.secret && !checkSecret(req, url, route.secret)) {
      return new Response("unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": "Bearer" },
      });
    }

    const params: Record<string, string> = {};
    route.pathKeys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1] ?? ""); });

    const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
    const query = Object.fromEntries(url.searchParams.entries());
    const headers = Object.fromEntries(req.headers.entries());
    let parsed: any = null;
    try { parsed = body ? JSON.parse(body) : null; } catch {}
    const ip =
      headers["x-forwarded-for"]?.split(",")[0].trim() ||
      headers["x-real-ip"] ||
      entry.server.requestIP?.(req)?.address ||
      "";
    const userAgent = headers["user-agent"] || "";
    const connectionId = randomUUID();
    const requestData = {
      method: req.method,
      body,
      json: parsed,
      query,
      headers,
      path: url.pathname,
      params,
      // Each request gets a fresh UUID. HTTP is stateless so "is it the
      // same client?" is the user's job (compare ip + UA, or a session
      // cookie they set themselves).
      connectionId,
      client: { ip, userAgent },
    };

    if (route.mode === "deferred") {
      const respPromise = registerDeferredHttp({
        connectionId,
        projectId: route.projectId,
        nodeId: route.nodeId,
        source: "rest",
        status: parseInt(String(route.response?.status ?? "200"), 10) || 200,
        contentType: String(route.response?.contentType ?? "application/json") || "application/json",
        headers: { ...(route.response?.headers ?? {}) },
        timeoutMs: route.timeoutMs,
        abortSignal: req.signal,
      });
      queueMicrotask(() => {
        runGraphFromTrigger(route.projectId, route.nodeId, requestData).catch((e: any) =>
          console.warn(`[n2n] rest ${route.nodeId}: ${e?.message || e}`),
        );
      });
      return respPromise;
    }

    // ---- Immediate (legacy) mode: substitute the templated response and
    // schedule the graph after replying so callers don't wait. ----
    const vars = { request: requestData };
    const r = route.response || ({} as RestRouteSpec["response"]);
    const status = parseInt(substitute(String(r.status ?? "200"), vars), 10) || 200;
    const contentType = substitute(String(r.contentType ?? "application/json"), vars) || "application/json";
    const responseBody = substitute(String(r.body ?? ""), vars);
    const respHeaders: Record<string, string> = {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
    };
    for (const [k, v] of Object.entries(r.headers || {})) {
      const key = substitute(String(k), vars);
      const val = substitute(String(v), vars);
      if (key) respHeaders[key] = val;
    }

    queueMicrotask(() => {
      runGraphFromTrigger(route.projectId, route.nodeId, requestData).catch((e: any) =>
        console.warn(`[n2n] rest ${route.nodeId}: ${e?.message || e}`),
      );
    });

    return new Response(responseBody, { status, headers: respHeaders });
  }
  return new Response(`No route matches ${req.method} ${url.pathname}`, {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function ensureServer(port: number, hostname: string): ServerEntry {
  const existing = servers.get(port);
  if (existing) {
    // Hostname changed → recreate. Otherwise reuse.
    if (existing.hostname !== hostname) {
      try { existing.server.stop(); } catch {}
    } else {
      return existing;
    }
  }
  const entry: ServerEntry = {
    hostname,
    routes: [],
    server: undefined as unknown as Server,
  };
  entry.server = Bun.serve({
    port,
    hostname,
    idleTimeout: 255,
    fetch: (req: Request) => dispatch(entry, req),
    error(e: any) {
      console.warn(`[n2n] rest server :${port} error:`, e?.message || e);
      return new Response("internal error", { status: 500 });
    },
  });
  servers.set(port, entry);
  console.log(`[n2n] REST API listening on http://${hostname}:${port}`);
  return entry;
}

export function syncRestEndpoints(routes: RestRouteSpec[]): void {
  // Group by port
  const byPort = new Map<number, RestRouteSpec[]>();
  for (const r of routes) {
    if (!Number.isFinite(r.port) || r.port < 1 || r.port > 65535) continue;
    if (!byPort.has(r.port)) byPort.set(r.port, []);
    byPort.get(r.port)!.push(r);
  }
  // Stop servers no longer needed
  for (const port of [...servers.keys()]) {
    if (!byPort.has(port)) {
      try { servers.get(port)!.server.stop(); } catch {}
      servers.delete(port);
      console.log(`[n2n] REST API closed on :${port}`);
    }
  }
  // Spawn / refresh routes for each remaining port
  for (const [port, rs] of byPort) {
    const hostname = rs[0].hostname || "0.0.0.0";
    const entry = ensureServer(port, hostname);
    entry.routes = rs.map(compileRoute);
  }
}

export function tearDownAllRestEndpoints(): void {
  for (const e of servers.values()) {
    try { e.server.stop(); } catch {}
  }
  servers.clear();
}
