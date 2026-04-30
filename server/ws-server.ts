// WebSocket multi-port registry. Each `ws-endpoint` node in a project
// becomes a path on a Bun.serve listening at the node's chosen port. As
// with rest-server, multiple nodes sharing a port share a Bun.serve.
//
// Each WS event (open / message / close) fires the project's graph via
// runGraphFromTrigger with the same trigger node id, carrying:
//   { event, connectionId, client: { ip, userAgent }, data, isBinary }
//
// `data` is a UTF-8 string for text frames; for binary frames it's the
// base64-encoded payload with `isBinary=true`. The graph picks the
// `event` it cares about (e.g. only react to "message").
//
// Sending back: `ws-send` module calls `wsSend(connectionId, data)` from
// the graph runtime. `connectionId === "*"` broadcasts to every open
// connection on the same path.
//
// Public API:
//   syncWsEndpoints(routes)       — replace the whole routing table
//   tearDownAllWsEndpoints()
//   wsSend(connectionId, data)
//   wsBroadcast(path, port, data)

import type { ServerWebSocket } from "bun";
import { randomUUID } from "node:crypto";
import { runGraphFromTrigger } from "./graph-runtime.ts";

type Server = ReturnType<typeof Bun.serve>;

export type WsRouteSpec = {
  projectId: string;
  nodeId: string;
  port: number;
  hostname: string;
  path: string;
  secret?: string;
};

type CompiledRoute = WsRouteSpec & {
  pathRe: RegExp;
  pathKeys: string[];
};

type ConnectionData = {
  connectionId: string;
  ip: string;
  userAgent: string;
  route: CompiledRoute;
  pathParams: Record<string, string>;
};

type ServerEntry = {
  server: Server;
  hostname: string;
  routes: CompiledRoute[];
};

const servers = new Map<number, ServerEntry>();
const connections = new Map<string, ServerWebSocket<ConnectionData>>();

function compileRoute(r: WsRouteSpec): CompiledRoute {
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

function fireEvent(
  data: ConnectionData,
  event: "open" | "message" | "close",
  payload: string | null,
  isBinary = false,
): void {
  runGraphFromTrigger(data.route.projectId, data.route.nodeId, {
    event,
    connectionId: data.connectionId,
    client: { ip: data.ip, userAgent: data.userAgent },
    data: payload,
    isBinary,
    path: data.route.path,
    params: data.pathParams,
  }).catch((e: any) =>
    console.warn(`[n2n] ws ${data.route.nodeId} ${event}: ${e?.message || e}`),
  );
}

function ensureServer(port: number, hostname: string): ServerEntry {
  const existing = servers.get(port);
  if (existing) {
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
    fetch: (req, server) => {
      const url = new URL(req.url);
      // Match against route table.
      for (const route of entry.routes) {
        const m = route.pathRe.exec(url.pathname);
        if (!m) continue;
        if (route.secret && !checkSecret(req, url, route.secret)) {
          return new Response("unauthorized", {
            status: 401,
            headers: { "WWW-Authenticate": "Bearer" },
          });
        }
        const params: Record<string, string> = {};
        route.pathKeys.forEach((k, i) => {
          params[k] = decodeURIComponent(m[i + 1] ?? "");
        });
        const ip =
          req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
          req.headers.get("x-real-ip") ||
          server.requestIP?.(req)?.address ||
          "";
        const userAgent = req.headers.get("user-agent") || "";
        const data: ConnectionData = {
          connectionId: randomUUID(),
          ip,
          userAgent,
          route,
          pathParams: params,
        };
        if (server.upgrade(req, { data })) {
          return undefined; // upgraded → no Response
        }
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return new Response(`No ws route matches ${url.pathname}`, {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    },
    websocket: {
      open(ws) {
        const d = ws.data as ConnectionData;
        connections.set(d.connectionId, ws as ServerWebSocket<ConnectionData>);
        fireEvent(d, "open", null);
      },
      message(ws, message) {
        const d = ws.data as ConnectionData;
        if (typeof message === "string") {
          fireEvent(d, "message", message, false);
        } else {
          fireEvent(d, "message", Buffer.from(message).toString("base64"), true);
        }
      },
      close(ws) {
        const d = ws.data as ConnectionData;
        connections.delete(d.connectionId);
        fireEvent(d, "close", null);
      },
    },
    error(e: any) {
      console.warn(`[n2n] ws server :${port} error:`, e?.message || e);
      return new Response("internal error", { status: 500 });
    },
  });
  servers.set(port, entry);
  console.log(`[n2n] WebSocket listening on ws://${hostname}:${port}`);
  return entry;
}

export function syncWsEndpoints(routes: WsRouteSpec[]): void {
  const byPort = new Map<number, WsRouteSpec[]>();
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
      console.log(`[n2n] WebSocket closed on :${port}`);
    }
  }
  // Spawn / refresh each kept port
  for (const [port, rs] of byPort) {
    const hostname = rs[0].hostname || "0.0.0.0";
    const entry = ensureServer(port, hostname);
    entry.routes = rs.map(compileRoute);
  }
}

export function tearDownAllWsEndpoints(): void {
  for (const e of servers.values()) {
    try { e.server.stop(); } catch {}
  }
  servers.clear();
  connections.clear();
}

/**
 * Send a string (or base64-encoded binary if `isBinary`) to a specific
 * connection. Returns true if the connection was found AND the message
 * was queued. `connectionId === "*"` means broadcast to ALL open
 * connections; restrict by node via `nodeId` or by path via `path`.
 */
export function wsSend(
  connectionId: string,
  data: string,
  options: { isBinary?: boolean; nodeId?: string; path?: string } = {},
): { sent: number; misses: number } {
  if (connectionId === "*") {
    let sent = 0;
    for (const [, ws] of connections) {
      const d = ws.data as ConnectionData;
      if (options.nodeId && d.route.nodeId !== options.nodeId) continue;
      if (options.path && d.route.path !== options.path) continue;
      try {
        if (options.isBinary) ws.sendBinary(Buffer.from(data, "base64"));
        else ws.send(data);
        sent++;
      } catch {}
    }
    return { sent, misses: 0 };
  }
  const ws = connections.get(connectionId);
  if (!ws) return { sent: 0, misses: 1 };
  try {
    if (options.isBinary) ws.sendBinary(Buffer.from(data, "base64"));
    else ws.send(data);
    return { sent: 1, misses: 0 };
  } catch {
    return { sent: 0, misses: 1 };
  }
}

/**
 * Close a WebSocket connection. `connectionId === "*"` closes every open
 * connection (filterable by `nodeId` / `path`). RFC 6455: code 1000 is a
 * normal closure; reason must fit in 123 UTF-8 bytes.
 */
export function wsClose(
  connectionId: string,
  code: number = 1000,
  reason: string = "",
  options: { nodeId?: string; path?: string } = {},
): { closed: number; misses: number } {
  const safeCode = Number.isFinite(code) ? code : 1000;
  if (connectionId === "*") {
    let closed = 0;
    for (const [, ws] of [...connections]) {
      const d = ws.data as ConnectionData;
      if (options.nodeId && d.route.nodeId !== options.nodeId) continue;
      if (options.path && d.route.path !== options.path) continue;
      try { ws.close(safeCode, reason); closed++; } catch {}
    }
    return { closed, misses: 0 };
  }
  const ws = connections.get(connectionId);
  if (!ws) return { closed: 0, misses: 1 };
  try { ws.close(safeCode, reason); return { closed: 1, misses: 0 }; }
  catch { return { closed: 0, misses: 1 }; }
}

/** Snapshot of who's currently connected — useful for debug endpoints. */
export function listWsConnections(): Array<{
  connectionId: string;
  ip: string;
  userAgent: string;
  nodeId: string;
  path: string;
  port: number;
}> {
  return [...connections].map(([id, ws]) => {
    const d = ws.data as ConnectionData;
    return {
      connectionId: id,
      ip: d.ip,
      userAgent: d.userAgent,
      nodeId: d.route.nodeId,
      path: d.route.path,
      port: d.route.port,
    };
  });
}
