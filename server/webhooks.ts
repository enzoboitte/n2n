// /webhook/<path> handler. Looks up the project's webhook-receive node in
// the trigger registry, optionally checks the per-route secret, then
// fires the graph via runGraphFromTrigger.
//
// Two response modes per webhook:
//   - "immediate" (default, legacy): render the templated response and
//     reply right away; the graph runs in the background.
//   - "deferred":  hold the response open until rest-end (or timeout)
//     fires in the graph. rest-send / rest-end are shared across REST
//     and webhook triggers — see http-defer.ts.

import { randomUUID } from "node:crypto";
import { loadEnv } from "./env-store.ts";
import { runGraphFromTrigger } from "./graph-runtime.ts";
import { getWebhookProjectId, getWebhookRoute } from "./triggers.ts";
import { registerDeferredHttp } from "./http-defer.ts";

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

/**
 * Webhook-specific templating. Same `{var}` / `{var.0.path}` syntax as
 * the graph engine, but allows `-` in keys (e.g. `{Content-Type}`) since
 * HTTP headers commonly contain hyphens.
 */
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

export async function handleWebhook(req: Request, route: string): Promise<Response> {
  const target = getWebhookRoute(route);
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
  const ip =
    headers["x-forwarded-for"]?.split(",")[0].trim() ||
    headers["x-real-ip"] ||
    "";
  const userAgent = headers["user-agent"] || "";
  const connectionId = randomUUID();
  const requestData = {
    method: req.method,
    body,
    json: parsedBody,
    query,
    headers,
    path: route,
    connectionId,
    client: { ip, userAgent },
  };

  const projectId = getWebhookProjectId(target.nodeId);
  const env = await loadEnv();
  const r = target.response || {};

  if (target.mode === "deferred" && projectId) {
    const respPromise = registerDeferredHttp({
      connectionId,
      projectId,
      nodeId: target.nodeId,
      source: "webhook",
      status: parseInt(String(r.status ?? "200"), 10) || 200,
      contentType: String(r.contentType ?? "application/json") || "application/json",
      headers: { ...(r.headers || {}) },
      timeoutMs: target.timeoutMs,
      abortSignal: req.signal,
    });
    queueMicrotask(() => {
      runGraphFromTrigger(projectId, target.nodeId, requestData).catch((e: any) =>
        console.warn(`[n2n] webhook ${target.nodeId}: ${e?.message || e}`),
      );
    });
    return respPromise;
  }

  // ---- Immediate (legacy) mode ----
  const vars = { request: requestData, ...env };
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
  if (projectId) {
    queueMicrotask(() => {
      runGraphFromTrigger(projectId, target.nodeId, requestData).catch((e: any) =>
        console.warn(`[n2n] webhook ${target.nodeId}: ${e?.message || e}`),
      );
    });
  }

  return new Response(responseBody, { status, headers: respHeaders });
}

/**
 * Constant-time bearer-auth helper exported for the API auth middleware
 * (route handlers in index.ts share the same primitive).
 */
export function bearerEquals(received: string, expected: string): boolean {
  return constantTimeEqual(received, expected);
}
