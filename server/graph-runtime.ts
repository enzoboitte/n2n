// Graph execution engine. The single big-switch `runNodeInCtx` walks the
// dependency tree (memoised in `ctx.cache`), gathers letter-indexed inputs
// from incoming edges, applies template substitution to params, then
// dispatches by moduleId to the matching runtime: built-in nodes
// (cron-tick, webhook-receive, subworkflow, for-each, mcp-tool, env-watch,
// sql-query) → fall-through to a spawned Python module.
//
// Top-level entry points:
//   runManualNode(projectId, nodeId)              — UI "Exécuter"
//   runGraphFromTrigger(projectId, nodeId, data)  — cron / webhook / env-watch
//   runChildProject(projectId, input, env, mans)  — subworkflow recursion
//
// Side-effects: SSE broadcast of nodeRunStart/End and envChanged; history
// append per executed node.

import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { PROJECTS_DIR } from "./config.ts";
import {
  type GraphNode, type GraphEdge, type RunResult, type RunCtx,
} from "./graph-types.ts";
import {
  indexToLetter, stringifyValue, substituteString, substituteDeep,
} from "./template.ts";
import { normalizeIterable } from "./iterable.ts";
import { broadcast } from "./sse.ts";
import { runPythonModule } from "./python-runner.ts";
import { runSqlQuery } from "./sql-runtime.ts";
import {
  runFileRead, runFileWrite, runFileDelete, runFileList, runFileMkdir,
} from "./file-runtime.ts";
import { wsSend, wsClose } from "./ws-server.ts";
import { runHttpStream } from "./http-stream-runtime.ts";
import { httpSend, httpEnd, type HttpSendOpts } from "./http-defer.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function looksLikeCid(s: unknown): s is string {
  return typeof s === "string" && (s === "*" || UUID_RE.test(s));
}
function resolveConnectionId(
  inputs: Record<string, unknown>,
  substituted: Record<string, unknown>,
  ctx: RunCtx,
): string {
  // Try the wired edge first, then the (templated) param, then the
  // trigger that fired this run. Each candidate is validated against the
  // UUID / "*" shape so junk values (e.g. an upstream `client` object
  // accidentally wired into `connection_id`) fall through to the
  // sensible fallback instead of being passed to the registry as-is.
  const inputCid = inputs.connection_id;
  const paramCid = substituted.connection_id;
  if (looksLikeCid(inputCid)) return inputCid;
  if (looksLikeCid(paramCid)) return paramCid;
  if (looksLikeCid(ctx.triggerConnectionId)) return ctx.triggerConnectionId;
  // Last resort: take the param string as-is even if it doesn't match
  // the shape — preserves user overrides for edge cases (e.g. a server
  // that issues non-UUID ids).
  if (typeof paramCid === "string" && paramCid.trim()) return paramCid.trim();
  if (typeof inputCid === "string" && inputCid.trim()) return inputCid.trim();
  return "";
}
import { getManifests } from "./manifest-cache.ts";
import {
  callMcpToolByName, coerceMcpArgs, getMcpClient,
} from "./mcp.ts";
import { appendHistory, loadProject } from "./project-store.ts";
import { loadEnv, saveEnv } from "./env-store.ts";

export function downstreamLeaves(startId: string, edges: GraphEdge[]): string[] {
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

function emitNodeStart(ctx: RunCtx, nodeId: string): void {
  if (!ctx.emit) return;
  broadcast("nodeRunStart", { projectId: ctx.projectId, nodeId });
}

function emitNodeEnd(ctx: RunCtx, nodeId: string, result: RunResult): void {
  if (!ctx.emit) return;
  broadcast("nodeRunEnd", { projectId: ctx.projectId, nodeId, result });
}

/**
 * Shared dispatch for `rest-send` and `rest-end`. Both work on a deferred
 * HTTP connection (REST or webhook — same registry) and accept an
 * upstream `connection_id` edge (overrides the param) and optional
 * status / content-type / headers (only honoured if no chunk has been
 * pushed yet).
 */
const UNRESOLVED_TEMPLATE_RE = /^\s*\{[a-zA-Z_$][a-zA-Z0-9_$.]*\}\s*$/;

async function runRestSend(
  inputs: Record<string, unknown>,
  substituted: Record<string, unknown>,
  letters: Record<string, unknown>,
  isEnd: boolean,
  ctx: RunCtx,
): Promise<RunResult> {
  const cid = resolveConnectionId(inputs, substituted, ctx);
  if (!cid) {
    return { ok: false, error: `${isEnd ? "rest-end" : "rest-send"}: connection_id introuvable (pas d'arête, pas de param, pas de trigger HTTP)` };
  }
  // Priority: named input slot → templated param → first non-null
  // incoming edge value. The fallback kicks in when `data` is empty OR
  // an unresolved `{x}` template — both signal "user didn't supply
  // explicit data, just send whatever came in". Handles routers
  // (switch, bool-custom) that emit on letters other than `a`.
  let data: unknown = inputs.data;
  if (data === undefined || data === null) data = substituted.data;
  const needsFallback =
    data === undefined || data === null || data === "" ||
    (typeof data === "string" && UNRESOLVED_TEMPLATE_RE.test(data));
  if (needsFallback) {
    for (const v of Object.values(letters)) {
      if (v !== null && v !== undefined && v !== "") { data = v; break; }
    }
  }
  if (data === undefined || data === null) data = "";
  const isBinary = !!substituted.is_binary;
  const opts: HttpSendOpts = { isBinary };
  const statusRaw = substituted.status;
  if (statusRaw !== undefined && statusRaw !== "" && statusRaw !== null) {
    const n = parseInt(String(statusRaw), 10);
    if (Number.isFinite(n)) opts.status = n;
  }
  const ct = String(substituted.content_type || "").trim();
  if (ct) opts.contentType = ct;
  const hdrs = substituted.headers;
  if (hdrs && typeof hdrs === "object" && !Array.isArray(hdrs)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(hdrs as Record<string, unknown>)) {
      if (k) out[String(k)] = String(v ?? "");
    }
    if (Object.keys(out).length) opts.headers = out;
  }
  const stats = isEnd ? httpEnd(cid, data, opts) : httpSend(cid, data, opts);
  // Surface connectionId so chains (rest-in → rest-send → rest-end) can
  // forward it without the user wiring twice.
  return { ok: true, outputs: { connectionId: cid, ...stats } };
}

export async function runNodeInCtx(ctx: RunCtx, nodeId: string): Promise<RunResult> {
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
          let parsed: unknown = data.json ?? null;
          if (parsed === null) {
            try {
              parsed = typeof data.body === "string" && data.body
                ? JSON.parse(data.body) : null;
            } catch { parsed = null; }
          }
          result = {
            ok: true,
            outputs: {
              method: data.method,
              body: data.body,
              json: parsed,
              query: data.query,
              headers: data.headers,
              connectionId: data.connectionId || "",
              client: data.client || { ip: "", userAgent: "" },
            },
          };
        }
      } else if (node.moduleId === "ws-endpoint") {
        // Triggered per WebSocket event (open/message/close). Just unpack
        // the trigger data; the listener lives in ws-server.ts.
        const data = ctx.triggerData.get(nodeId);
        if (!data) {
          result = { skipped: true };
        } else {
          result = {
            ok: true,
            outputs: {
              event: data.event,
              data: data.data,
              isBinary: !!data.isBinary,
              connectionId: data.connectionId,
              client: data.client || { ip: "", userAgent: "" },
              params: data.params || {},
              path: data.path,
            },
          };
        }
      } else if (node.moduleId === "switch") {
        // Multi-case router. The case count is configurable via the
        // `case_count` param (1-12). Emits the input value on the
        // matching `caseN` socket or `default` if none match; the
        // others emit null so the runtime treats them as "branche non
        // prise".
        const value = inputs.value ?? letters.a ?? null;
        const rawParams = (node.params ?? {}) as Record<string, unknown>;
        const mode = String(substituted.mode || "equals");
        const rawCount = parseInt(String(rawParams.case_count ?? "3"), 10);
        const caseCount = Number.isFinite(rawCount)
          ? Math.max(1, Math.min(12, rawCount))
          : 3;
        let matched = 0; // 1..N = caseN, 0 = default

        if (mode === "expression") {
          const VALID_ID = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
          const scope: Record<string, unknown> = {};
          for (const [k, v] of Object.entries({ ...ctx.env, ...letters })) {
            if (VALID_ID.test(k)) scope[k] = v;
          }
          const scopeKeys = Object.keys(scope);
          const scopeVals = scopeKeys.map((k) => scope[k]);
          for (let i = 1; i <= caseCount; i++) {
            const expr = String(rawParams[`case${i}`] ?? "").trim();
            if (!expr) continue;
            try {
              const fn = new Function(
                ...scopeKeys,
                `"use strict"; return (${expr});`,
              );
              if (fn(...scopeVals)) { matched = i; break; }
            } catch (e) {
              console.warn(`[n2n] switch case${i}: ${(e as Error)?.message}`);
            }
          }
        } else {
          const cmpRaw = substituteString(
            String(rawParams.compare ?? "{a}"),
            { ...ctx.env, ...letters },
          );
          const caseSensitive = !!substituted.case_sensitive;
          const norm = (s: string) => caseSensitive ? s : s.toLowerCase();
          const cmp = norm(cmpRaw);
          for (let i = 1; i <= caseCount; i++) {
            const target = String(rawParams[`case${i}`] ?? "").trim();
            if (!target) continue;
            if (norm(target) === cmp) { matched = i; break; }
          }
        }

        const outs: Record<string, unknown> = {};
        for (let i = 1; i <= caseCount; i++) {
          outs[`case${i}`] = matched === i ? value : null;
        }
        outs.default = matched === 0 ? value : null;
        result = { ok: true, outputs: outs };
      } else if (node.moduleId === "rest-send") {
        const sendRes = await runRestSend(inputs, substituted, letters, false, ctx);
        result = sendRes;
      } else if (node.moduleId === "rest-end") {
        const sendRes = await runRestSend(inputs, substituted, letters, true, ctx);
        result = sendRes;
      } else if (node.moduleId === "ws-close") {
        const cid = resolveConnectionId(inputs, substituted, ctx);
        if (!cid) {
          result = { ok: false, error: "ws-close: connection_id requis" };
        } else {
          const code = parseInt(String(substituted.code ?? "1000"), 10);
          const reason = String(substituted.reason || "");
          const filterNodeId = String(substituted.filter_node_id || "").trim() || undefined;
          const filterPath = String(substituted.filter_path || "").trim() || undefined;
          const stats = wsClose(cid, Number.isFinite(code) ? code : 1000, reason, {
            nodeId: filterNodeId,
            path: filterPath,
          });
          result = { ok: true, outputs: { connectionId: cid, ...stats } };
        }
      } else if (node.moduleId === "ws-send") {
        // Resolution: validated edge → validated param → trigger ctx →
        // raw param/edge fallback. See resolveConnectionId.
        const cid = resolveConnectionId(inputs, substituted, ctx);
        let raw: unknown = inputs.data;
        if (raw === null || raw === undefined) raw = substituted.data;
        const payload = typeof raw === "string"
          ? raw
          : raw === null || raw === undefined
            ? ""
            : JSON.stringify(raw);
        const isBinary = !!substituted.is_binary;
        const filterNodeId = String(substituted.filter_node_id || "").trim() || undefined;
        const filterPath = String(substituted.filter_path || "").trim() || undefined;
        if (!cid) {
          result = { ok: false, error: "ws-send: connection_id requis" };
        } else {
          const stats = wsSend(cid, payload, {
            isBinary,
            nodeId: filterNodeId,
            path: filterPath,
          });
          result = { ok: true, outputs: { connectionId: cid, ...stats } };
        }
      } else if (node.moduleId === "rest-endpoint") {
        // Like webhook-receive but with path params + client info. The
        // listener+routing lives in rest-server.ts; this branch just
        // unpacks the request data the runtime received via triggerData.
        const data = ctx.triggerData.get(nodeId);
        if (!data) {
          result = { skipped: true };
        } else {
          result = {
            ok: true,
            outputs: {
              method: data.method,
              body: data.body,
              json: data.json,
              query: data.query,
              params: data.params || {},
              headers: data.headers,
              path: data.path,
              connectionId: data.connectionId || "",
              client: data.client || { ip: "", userAgent: "" },
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
                const c = getMcpClient(server);
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
          const c = getMcpClient(server);
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
          } catch (e: any) {
            result = { ok: false, error: `mcp: ${e?.message || e}` };
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
      } else if (node.moduleId === "file-read") {
        result = await runFileRead(substituted);
      } else if (node.moduleId === "file-write") {
        result = await runFileWrite(substituted, inputs);
      } else if (node.moduleId === "file-delete") {
        result = await runFileDelete(substituted);
      } else if (node.moduleId === "file-list") {
        result = await runFileList(substituted);
      } else if (node.moduleId === "file-mkdir") {
        result = await runFileMkdir(substituted);
      } else if (node.moduleId === "http-stream") {
        result = await runHttpStream(substituted, inputs);
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
    } catch (e: any) {
      result = { ok: false, error: e?.message || String(e) };
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

export async function runChildProject(
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
  const triggerConnectionId =
    options.triggerData?.data && typeof options.triggerData.data === "object"
      ? (options.triggerData.data.connectionId ?? undefined)
      : undefined;
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
    triggerConnectionId: typeof triggerConnectionId === "string" ? triggerConnectionId : undefined,
  };
  return { ctx, project };
}

export async function runGraphFromTrigger(
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

export async function runManualNode(
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

export async function scheduleEnvWatchTriggers(changedKeys: Set<string>): Promise<void> {
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
