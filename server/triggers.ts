// Cron + webhook trigger registry. Scans every project on disk and
// (re-)installs cron timers and webhook routes for each cron-tick /
// webhook-receive node found. Cron timers are preserved across syncs when
// the interval hasn't changed, so editing unrelated parts of a project
// doesn't reset the countdown.
//
// `scheduleTriggerSync()` debounces a re-scan after any project save —
// drop it into a route handler that mutates project state and the
// triggers will catch up at the next idle tick.

import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { PROJECTS_DIR } from "./config.ts";
import type { GraphNode } from "./graph-types.ts";
import { parseHumanInterval } from "./template.ts";
import { runGraphFromTrigger } from "./graph-runtime.ts";
import {
  syncRestEndpoints, tearDownAllRestEndpoints,
  type RestRouteSpec,
} from "./rest-server.ts";
import {
  syncWsEndpoints, tearDownAllWsEndpoints,
  type WsRouteSpec,
} from "./ws-server.ts";

type CronEntry = {
  projectId: string;
  nodeId: string;
  intervalMs: number;
  timer: ReturnType<typeof setInterval>;
};

export type WebhookRoute = {
  nodeId: string;
  response: any;
  secret?: string;
  mode: "immediate" | "deferred";
  timeoutMs: number;
};

const cronTriggers = new Map<string, CronEntry>(); // nodeId → entry
const webhookRoutes = new Map<string, WebhookRoute>(); // path → route
const webhookProjects = new Map<string, string>(); // nodeId → projectId

let triggerSyncInFlight: Promise<void> | null = null;
let triggerSyncQueued = false;

export function scheduleTriggerSync(): void {
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

export async function syncProjectTriggers(): Promise<void> {
  type DesiredCron = { projectId: string; nodeId: string; intervalMs: number };
  type DesiredWebhook = {
    projectId: string;
    nodeId: string;
    path: string;
    response: any;
    secret?: string;
    mode: "immediate" | "deferred";
    timeoutMs: number;
  };
  const desiredCrons = new Map<string, DesiredCron>();
  const desiredWebhooks: DesiredWebhook[] = [];
  const desiredRest: RestRouteSpec[] = [];
  const desiredWs: WsRouteSpec[] = [];

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
        const rawMode = String(params.mode ?? "immediate").toLowerCase();
        const mode: "immediate" | "deferred" =
          rawMode === "deferred" ? "deferred" : "immediate";
        const timeoutMs = (() => {
          const n = parseInt(String(params.timeout_ms ?? ""), 10);
          return Number.isFinite(n) && n > 0 ? n : 30_000;
        })();
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
          mode,
          timeoutMs,
        });
      } else if (node.moduleId === "ws-endpoint") {
        const port = parseInt(String(params.port ?? ""), 10);
        if (!Number.isFinite(port) || port < 1 || port > 65535) continue;
        const path = String(params.path ?? "/").trim() || "/";
        desiredWs.push({
          projectId: p.id,
          nodeId: node.id,
          port,
          hostname: String(params.hostname ?? "0.0.0.0").trim() || "0.0.0.0",
          path,
          secret: String(params.secret ?? "").trim() || undefined,
        });
      } else if (node.moduleId === "rest-endpoint") {
        const port = parseInt(String(params.port ?? ""), 10);
        if (!Number.isFinite(port) || port < 1 || port > 65535) continue;
        const path = String(params.path ?? "/").trim() || "/";
        const headersRaw = params.response_headers;
        const headers =
          headersRaw && typeof headersRaw === "object" && !Array.isArray(headersRaw)
            ? Object.fromEntries(
                Object.entries(headersRaw as Record<string, unknown>).map(
                  ([k, v]) => [k, String(v ?? "")],
                ),
              )
            : {};
        // mode: "immediate" replies right away with the templated body
        // (legacy); "deferred" holds the response open for rest-send /
        // rest-end. Default to "deferred" for new nodes — the manifest
        // sets it; existing projects without the param keep "immediate".
        const rawMode = String(params.mode ?? "immediate").toLowerCase();
        const mode: "immediate" | "deferred" =
          rawMode === "deferred" ? "deferred" : "immediate";
        const timeoutMs = (() => {
          const n = parseInt(String(params.timeout_ms ?? ""), 10);
          return Number.isFinite(n) && n > 0 ? n : 30_000;
        })();
        desiredRest.push({
          projectId: p.id,
          nodeId: node.id,
          port,
          hostname: String(params.hostname ?? "0.0.0.0").trim() || "0.0.0.0",
          method: String(params.method ?? "GET"),
          path,
          mode,
          timeoutMs,
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
      mode: w.mode,
      timeoutMs: w.timeoutMs,
    });
    webhookProjects.set(w.nodeId, w.projectId);
  }

  // REST endpoints: rest-server keeps running Bun.serve instances when
  // possible, swaps route tables in place when only routes changed.
  syncRestEndpoints(desiredRest);

  // WebSocket endpoints: same pattern — server-per-port, in-place route swap.
  syncWsEndpoints(desiredWs);
}

export function tearDownAllTriggers(): void {
  for (const t of cronTriggers.values()) clearInterval(t.timer);
  cronTriggers.clear();
  webhookRoutes.clear();
  webhookProjects.clear();
  tearDownAllRestEndpoints();
  tearDownAllWsEndpoints();
}

/** Shared with webhooks.ts — read-only access to the route table. */
export function getWebhookRoute(path: string): WebhookRoute | undefined {
  return webhookRoutes.get(path);
}
export function getWebhookProjectId(nodeId: string): string | undefined {
  return webhookProjects.get(nodeId);
}
