"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@/components/canvas/Canvas";
import { ChatPanel } from "@/components/ui/ChatPanel";
import { ConfigModal } from "@/components/ui/ConfigModal";
import { ContextMenu, type MenuItem } from "@/components/ui/ContextMenu";
import { EnvModal } from "@/components/ui/EnvModal";
import { McpModal } from "@/components/ui/McpModal";
import { ModulePalette } from "@/components/ui/ModulePalette";
import { ProjectMenu } from "@/components/ui/ProjectMenu";
import { PromptModal } from "@/components/ui/PromptModal";
import { StatusBar } from "@/components/ui/StatusBar";
import { Toolbar } from "@/components/ui/Toolbar";
import { EnvContext } from "@/contexts/EnvContext";
import { McpContext } from "@/contexts/McpContext";
import { useConnect } from "@/hooks/useConnect";
import { useEdges } from "@/hooks/useEdges";
import { useEnv } from "@/hooks/useEnv";
import { useMcpServers } from "@/hooks/useMcpServers";
import { useModules } from "@/hooks/useModules";
import { useNodes } from "@/hooks/useNodes";
import { usePanZoom } from "@/hooks/usePanZoom";
import { useProjects } from "@/hooks/useProjects";
import { autoLayout } from "@/lib/layout";
import { indexToLetter } from "@/lib/letters";
import { getApi } from "@/lib/n2n";
import { substituteDeep } from "@/lib/template";
import { SYSTEM_PROMPT, TOOLS } from "@/lib/tools";
import type { CanvasNode, Edge, ModuleManifest, RunResult } from "@/lib/types";

function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// Convert templated string values back to the primitive types declared in
// the MCP tool's JSON Schema (numbers, booleans, parsed JSON for arrays/objects).
// Strings stay strings. Anything that fails coercion is kept as-is.
function coerceMcpArgs(
  args: Record<string, unknown>,
  schema: unknown,
): Record<string, unknown> {
  const properties =
    (schema as { properties?: Record<string, { type?: string }> })
      ?.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    const propType = properties[k]?.type;
    if (typeof v !== "string" || !propType) {
      out[k] = v;
      continue;
    }
    const trimmed = v.trim();
    if (trimmed === "") continue;
    if (propType === "number" || propType === "integer") {
      const n = Number(trimmed);
      out[k] = Number.isFinite(n) ? n : v;
    } else if (propType === "boolean") {
      const lower = trimmed.toLowerCase();
      out[k] = lower === "true" || lower === "1" || lower === "yes";
    } else if (propType === "array" || propType === "object") {
      try {
        out[k] = JSON.parse(trimmed);
      } catch {
        out[k] = v;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

function parseHumanInterval(s: string): number {
  const m = String(s || "").match(/^\s*(\d+)\s*(ms|s|m|h|d)?\s*$/i);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || "s").toLowerCase();
  const mult: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return n * (mult[unit] ?? 1000);
}

function downstreamLeaves(startId: string, edges: Edge[]): string[] {
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

type ContextState =
  | { kind: "node"; x: number; y: number; nodeId: string }
  | { kind: "canvas"; x: number; y: number };

export default function Home() {
  const {
    viewport,
    isPanning,
    isSpaceDown,
    containerRef,
    onMouseDown,
    zoomIn,
    zoomOut,
    reset,
  } = usePanZoom();

  const {
    nodes,
    selectedIds,
    addAt,
    move,
    setAllNodes,
    setPositions,
    select,
    selectMany,
    remove,
    duplicate,
    setParam,
    setParams,
    setResult,
    setPinned,
  } = useNodes();
  const {
    edges,
    add: addEdge,
    remove: removeEdge,
    removeForNodes: removeEdgesForNodes,
    setAllEdges,
  } = useEdges();

  const projectsApi = useProjects();
  const {
    projects,
    activeId: activeProjectId,
    loadedGraph,
    switchTo: switchProject,
    create: createProject,
    rename: renameProject,
    remove: deleteProject,
    duplicate: duplicateProject,
    exportToFile: exportProject,
    importFromFile: importProject,
  } = projectsApi;
  const [renameTarget, setRenameTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const { modules, loading, error } = useModules();
  const mcp = useMcpServers();
  const { env, envRef, setEnv } = useEnv();
  const [runningIds, setRunningIds] = useState<ReadonlySet<string>>(new Set());
  const [configuringId, setConfiguringId] = useState<string | null>(null);
  const [envOpen, setEnvOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [context, setContext] = useState<ContextState | null>(null);

  const modulesById = useMemo(() => {
    const m = new Map<string, ModuleManifest>();
    for (const mod of modules) m.set(mod.id, mod);
    return m;
  }, [modules]);

  const handleConnect = useCallback(
    (source: string, sourceSocket: string, target: string) => {
      addEdge(source, sourceSocket, target);
    },
    [addEdge],
  );

  const { pending, start: startConnect } = useConnect({
    containerRef,
    viewport,
    onConnect: handleConnect,
  });

  const removeNodes = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      removeEdgesForNodes(ids);
      remove(ids);
    },
    [remove, removeEdgesForNodes],
  );

  const addModuleAtCenter = useCallback(
    (module: ModuleManifest) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const sx = rect.width / 2;
      const sy = rect.height / 2;
      const worldX = (sx - viewport.x) / viewport.scale;
      const worldY = (sy - viewport.y) / viewport.scale;
      addAt(module, worldX, worldY);
    },
    [containerRef, viewport, addAt],
  );

  const nodesRef = useRef<CanvasNode[]>(nodes);
  const edgesRef = useRef<Edge[]>(edges);
  const selectedIdsRef = useRef<ReadonlySet<string>>(selectedIds);
  const loadedProjectIdRef = useRef<string | null>(null);

  // Hydrate the canvas whenever a project is (re)loaded.
  useEffect(() => {
    if (!loadedGraph) return;
    setAllNodes(loadedGraph.nodes as CanvasNode[]);
    setAllEdges(loadedGraph.edges as Edge[]);
    loadedProjectIdRef.current = loadedGraph.id;
  }, [loadedGraph, setAllNodes, setAllEdges]);

  // Autosave the active project's graph (debounced) once hydration matches.
  useEffect(() => {
    if (!activeProjectId) return;
    if (loadedProjectIdRef.current !== activeProjectId) return;
    const t = setTimeout(() => {
      const meta = projects.find((p) => p.id === activeProjectId);
      if (!meta) return;
      const api = getApi();
      if (!api) return;
      api
        .saveProject({
          ...meta,
          updatedAt: Date.now(),
          nodes,
          edges,
        })
        .catch((err) => console.warn("[n2n] saveProject failed", err));
    }, 500);
    return () => clearTimeout(t);
  }, [nodes, edges, activeProjectId, projects]);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);
  useEffect(() => {
    selectedIdsRef.current = selectedIds;
  }, [selectedIds]);

  const markRunning = useCallback((id: string, on: boolean) => {
    setRunningIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // Webhook payloads keyed by nodeId — populated by the IPC listener below
  // and consumed by the runtime when a webhook node is run.
  const webhookDataRef = useRef<Map<string, Record<string, unknown>>>(
    new Map(),
  );

  const runNode = useCallback(
    async (id: string): Promise<RunResult | undefined> => {
      const api = getApi();
      if (!api) return;

      const cache = new Map<string, Promise<RunResult>>();

      const exec = (nodeId: string): Promise<RunResult> => {
        const cached = cache.get(nodeId);
        if (cached) return cached;

        const promise = (async (): Promise<RunResult> => {
          const node = nodesRef.current.find((n) => n.id === nodeId);
          if (!node) return { ok: false, error: "Nœud introuvable" };

          // Pinned data short-circuits everything: the runtime returns the
          // user-frozen outputs without running predecessors or the module.
          if (node.pinned && typeof node.pinned === "object") {
            const r: RunResult = {
              ok: true,
              outputs: node.pinned as Record<string, unknown>,
            };
            setResult(nodeId, r);
            return r;
          }

          const incoming = edgesRef.current.filter(
            (e) => e.target === nodeId,
          );
          const manifest = modulesById.get(node.moduleId);

          const upstreams = await Promise.all(
            incoming.map((e) => exec(e.source)),
          );

          const inputs: Record<string, unknown> = {};
          const letters: Record<string, unknown> = {};
          let receivedSignal = incoming.length === 0;

          for (let i = 0; i < incoming.length; i++) {
            const edge = incoming[i];
            const upstream = upstreams[i];

            if ("skipped" in upstream) continue;
            if (!upstream.ok) {
              const r: RunResult = {
                ok: false,
                error: `amont: ${upstream.error}`,
              };
              setResult(nodeId, r);
              return r;
            }

            const value = upstream.outputs[edge.sourceSocket];
            if (value === null || value === undefined) continue;

            const namedSlot = manifest?.inputs[i] ?? manifest?.inputs[0];
            if (namedSlot) inputs[namedSlot.name] = value;
            letters[indexToLetter(i)] = value;
            receivedSignal = true;
          }

          if (!receivedSignal) {
            const r: RunResult = { skipped: true };
            setResult(nodeId, r);
            return r;
          }

          markRunning(nodeId, true);
          const startedAt = Date.now();
          try {
            const currentEnv = envRef.current;
            const vars = { ...currentEnv, ...letters };
            const substituted = substituteDeep(node.params, vars) as Record<
              string,
              unknown
            >;

            // Modules handled directly by the runtime (no Python).
            let result: RunResult;
            if (node.moduleId === "cron-tick") {
              const ms = Date.now();
              result = {
                ok: true,
                outputs: { epoch_ms: ms, iso: new Date(ms).toISOString() },
              };
            } else if (node.moduleId === "webhook-receive") {
              const data = webhookDataRef.current.get(nodeId);
              if (!data) {
                result = { skipped: true };
              } else {
                let parsed: unknown = null;
                try {
                  parsed =
                    typeof data.body === "string" && data.body
                      ? JSON.parse(data.body as string)
                      : null;
                } catch {
                  parsed = null;
                }
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
                false,
              );
            } else if (node.moduleId === "mcp-tool") {
              const target = String(substituted.target || "").trim();
              const sep = target.indexOf("::");
              const server = sep >= 0 ? target.slice(0, sep) : "";
              const toolName = sep >= 0 ? target.slice(sep + 2) : "";
              const argsParam = substituted.arguments;
              let toolArgs: Record<string, unknown> = {};
              // The form-driven editor stores a dict (preferred). Fall back
              // to a raw JSON string for backward compat with v0.2.0 nodes.
              if (
                argsParam &&
                typeof argsParam === "object" &&
                !Array.isArray(argsParam)
              ) {
                toolArgs = argsParam as Record<string, unknown>;
              } else if (typeof argsParam === "string" && argsParam.trim()) {
                try {
                  const parsed = JSON.parse(argsParam);
                  if (
                    parsed &&
                    typeof parsed === "object" &&
                    !Array.isArray(parsed)
                  ) {
                    toolArgs = parsed as Record<string, unknown>;
                  }
                } catch {
                  // ignore
                }
              } else if (
                inputs.args &&
                typeof inputs.args === "object" &&
                !Array.isArray(inputs.args)
              ) {
                toolArgs = inputs.args as Record<string, unknown>;
              }
              // Coerce string values to the schema's expected primitive type
              // so MCP servers receive proper numbers/booleans/objects rather
              // than the templated strings produced by `{a}` substitution.
              if (server && toolName) {
                const srv = mcp.servers.find((s) => s.name === server);
                const tdef = srv?.tools.find((t) => t.name === toolName);
                if (tdef) {
                  toolArgs = coerceMcpArgs(toolArgs, tdef.inputSchema);
                }
              }
              if (!server || !toolName) {
                result = {
                  ok: false,
                  error: "mcp-tool: server et tool requis",
                };
              } else {
                try {
                  const callResult = await api.mcpCallTool(
                    server,
                    toolName,
                    toolArgs,
                  );
                  const content = callResult.content ?? [];
                  const textParts = Array.isArray(content)
                    ? content
                        .filter((c) => c?.type === "text" && typeof c?.text === "string")
                        .map((c) => c.text as string)
                    : [];
                  result = {
                    ok: true,
                    outputs: {
                      content,
                      text: textParts.join("\n"),
                      isError: !!callResult.isError,
                    },
                  };
                } catch (err) {
                  result = {
                    ok: false,
                    error: `mcp: ${(err as Error).message}`,
                  };
                }
              }
            } else if (node.moduleId === "for-each") {
              const list = (inputs.list ?? letters.a) as unknown;
              if (!Array.isArray(list)) {
                result = {
                  ok: false,
                  error: "for-each: l'entrée n'est pas une liste",
                };
              } else {
                const childId = String(substituted.project_id || "");
                const results: unknown[] = [];
                for (const item of list) {
                  const childResult = await runChildProject(
                    childId,
                    item,
                    false,
                  );
                  if ("ok" in childResult && childResult.ok) {
                    const outs = childResult.outputs as Record<string, unknown>;
                    const firstKey = Object.keys(outs)[0];
                    results.push(
                      firstKey !== undefined ? outs[firstKey] : null,
                    );
                  } else {
                    results.push(null);
                  }
                }
                result = { ok: true, outputs: { results } };
              }
            } else {
              result = await api.runModule(
                node.moduleId,
                inputs,
                substituted,
                letters,
                currentEnv,
              );
            }

            let cleaned = result;
            if ("ok" in result && result.ok) {
              const outs = result.outputs as Record<string, unknown>;
              const writes = outs.__env__;
              if (
                writes &&
                typeof writes === "object" &&
                !Array.isArray(writes)
              ) {
                const stringWrites: Record<string, string> = {};
                for (const [k, v] of Object.entries(
                  writes as Record<string, unknown>,
                )) {
                  stringWrites[k] = stringifyValue(v);
                }
                setEnv({ ...envRef.current, ...stringWrites });
                const { __env__: _drop, ...rest } = outs;
                cleaned = { ok: true, outputs: rest };
              }
            }

            setResult(nodeId, cleaned);

            // Append to execution history (fire-and-forget, no UI blocking).
            const durationMs = Date.now() - startedAt;
            const ok = "ok" in cleaned ? cleaned.ok : false;
            api
              .appendHistory({
                timestamp: startedAt,
                projectId: activeProjectId,
                nodeId,
                moduleId: node.moduleId,
                durationMs,
                ok,
                error:
                  "ok" in cleaned && !cleaned.ok ? cleaned.error : undefined,
                outputs:
                  "ok" in cleaned && cleaned.ok
                    ? (cleaned.outputs as Record<string, unknown>)
                    : undefined,
              })
              .catch(() => undefined);

            return cleaned;
          } finally {
            markRunning(nodeId, false);
          }
        })();

        cache.set(nodeId, promise);
        return promise;
      };

      // ----- helper for sub-workflow execution -----
      // Runs a project's graph in isolation. Sets `__input__` env var to the
      // provided input value. Returns the result of the project's last leaf.
      async function runChildProject(
        projectId: string,
        inputValue: unknown,
        _isolated: boolean,
      ): Promise<RunResult> {
        if (!projectId) {
          return { ok: false, error: "subworkflow: project_id manquant" };
        }
        let child;
        try {
          child = await api!.loadProject(projectId);
        } catch (err) {
          return {
            ok: false,
            error: `subworkflow: ${(err as Error).message}`,
          };
        }
        const childCache = new Map<string, Promise<RunResult>>();
        const childEnv = {
          ...envRef.current,
          __input__: stringifyValue(inputValue),
        };

        const childExec = (childNodeId: string): Promise<RunResult> => {
          const c = childCache.get(childNodeId);
          if (c) return c;
          const p = (async (): Promise<RunResult> => {
            const cn = child.nodes.find((n) => n.id === childNodeId);
            if (!cn) return { ok: false, error: "Nœud enfant introuvable" };
            if (cn.pinned && typeof cn.pinned === "object") {
              return {
                ok: true,
                outputs: cn.pinned as Record<string, unknown>,
              };
            }
            const cIn = child.edges.filter((e) => e.target === childNodeId);
            const cManifest = modulesById.get(cn.moduleId);
            const cUps = await Promise.all(cIn.map((e) => childExec(e.source)));
            const cInputs: Record<string, unknown> = {};
            const cLetters: Record<string, unknown> = {};
            let signal = cIn.length === 0;
            for (let i = 0; i < cIn.length; i++) {
              const edge = cIn[i];
              const up = cUps[i];
              if ("skipped" in up) continue;
              if (!up.ok) return { ok: false, error: `amont: ${up.error}` };
              const v = up.outputs[edge.sourceSocket];
              if (v === null || v === undefined) continue;
              const slot = cManifest?.inputs[i] ?? cManifest?.inputs[0];
              if (slot) cInputs[slot.name] = v;
              cLetters[indexToLetter(i)] = v;
              signal = true;
            }
            if (!signal) return { skipped: true };
            const cVars = { ...childEnv, ...cLetters };
            const cSubst = substituteDeep(cn.params, cVars) as Record<
              string,
              unknown
            >;
            // Special modules inside subworkflows: only honour those that
            // don't recurse for now (avoid sub-sub-workflows for simplicity).
            if (cn.moduleId === "cron-tick") {
              const ms = Date.now();
              return {
                ok: true,
                outputs: { epoch_ms: ms, iso: new Date(ms).toISOString() },
              };
            }
            return api!.runModule(
              cn.moduleId,
              cInputs,
              cSubst,
              cLetters,
              childEnv,
            );
          })();
          childCache.set(childNodeId, p);
          return p;
        };

        const leaves = child.nodes.filter(
          (n) => !child.edges.some((e) => e.source === n.id),
        );
        if (leaves.length === 0) {
          return { ok: false, error: "subworkflow: aucune feuille" };
        }
        return childExec(leaves[leaves.length - 1].id);
      }

      return exec(id);
    },
    [
      modulesById,
      envRef,
      markRunning,
      setEnv,
      setResult,
      activeProjectId,
      mcp.servers,
    ],
  );

  const runNodeRef = useRef(runNode);
  useEffect(() => {
    runNodeRef.current = runNode;
  }, [runNode]);

  // Cron + webhook registration: when nodes change, sync the registry
  // in the main process. Each cron-tick node gets its own scheduler;
  // each webhook-receive node gets its own /webhook/<path> route.
  useEffect(() => {
    const api = getApi();
    if (!api) return;
    const cronNodes = nodes.filter((n) => n.moduleId === "cron-tick");
    const webhookNodes = nodes.filter((n) => n.moduleId === "webhook-receive");

    for (const n of cronNodes) {
      const intervalMs = parseHumanInterval(String(n.params.interval ?? ""));
      if (intervalMs > 0) api.cronRegister(n.id, intervalMs);
    }
    for (const n of webhookNodes) {
      const p = String(n.params.path ?? "").trim();
      if (!p) continue;
      const headers =
        n.params.response_headers &&
        typeof n.params.response_headers === "object" &&
        !Array.isArray(n.params.response_headers)
          ? (Object.fromEntries(
              Object.entries(
                n.params.response_headers as Record<string, unknown>,
              ).map(([k, v]) => [k, String(v ?? "")]),
            ) as Record<string, string>)
          : {};
      api.webhookRegister(n.id, p, {
        status: String(n.params.response_status ?? "200"),
        contentType: String(
          n.params.response_content_type ?? "application/json",
        ),
        body: String(n.params.response_body ?? '{"ok":true}'),
        headers,
      });
    }

    return () => {
      for (const n of cronNodes) api.cronUnregister(n.id);
      for (const n of webhookNodes) api.webhookUnregister(n.id);
    };
  }, [nodes]);

  // Subscribe to cron and webhook events: on fire, run downstream leaves
  // exactly like env-watch does.
  useEffect(() => {
    const api = getApi();
    if (!api) return;
    const offCron = api.onCronTick(({ id }) => {
      runNodeRef.current(id);
      const leaves = downstreamLeaves(id, edgesRef.current);
      for (const leafId of leaves) runNodeRef.current(leafId);
    });
    const offWebhook = api.onWebhookFired(({ nodeId, data }) => {
      webhookDataRef.current.set(nodeId, data);
      runNodeRef.current(nodeId);
      const leaves = downstreamLeaves(nodeId, edgesRef.current);
      for (const leafId of leaves) runNodeRef.current(leafId);
    });
    return () => {
      offCron();
      offWebhook();
    };
  }, []);

  const prevEnvRef = useRef<Record<string, string> | null>(null);
  useEffect(() => {
    if (prevEnvRef.current === null) {
      prevEnvRef.current = env;
      return;
    }
    const prev = prevEnvRef.current;
    const changed = new Set<string>();
    for (const k of new Set([...Object.keys(prev), ...Object.keys(env)])) {
      if (prev[k] !== env[k]) changed.add(k);
    }
    prevEnvRef.current = env;
    if (changed.size === 0) return;

    const triggered = new Set<string>();
    for (const node of nodesRef.current) {
      if (node.moduleId !== "env-watch") continue;
      const watched = String(node.params.var ?? "");
      if (!watched || !changed.has(watched)) continue;
      const leaves = downstreamLeaves(node.id, edgesRef.current);
      for (const leafId of leaves) {
        if (triggered.has(leafId)) continue;
        triggered.add(leafId);
        runNodeRef.current(leafId);
      }
    }
  }, [env]);

  const openFolder = useCallback(() => {
    const api = getApi();
    api?.openModulesFolder();
  }, []);

  const runAutoLayout = useCallback(() => {
    const positions = autoLayout(nodesRef.current, edgesRef.current);
    if (positions.size === 0) return;
    setPositions(positions);
  }, [setPositions]);

  // Tool executor for the AI: maps tool name → app action.
  const selectedModuleRef = useRef<string | null>(null);

  const executor = useCallback(
    async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      const api = getApi();
      switch (name) {
        case "list_available_modules": {
          return modules.map((m) => ({
            id: m.id,
            name: m.name,
            description: m.description,
            color: m.color,
            inputs: m.inputs,
            outputs: m.outputs,
            params: m.params,
          }));
        }
        case "list_nodes": {
          return {
            nodes: nodesRef.current.map((n) => ({
              id: n.id,
              module_id: n.moduleId,
              x: n.x,
              y: n.y,
              params: n.params,
              result: n.result,
            })),
            edges: edgesRef.current.map((e) => ({
              id: e.id,
              source: e.source,
              source_socket: e.sourceSocket,
              target: e.target,
            })),
          };
        }
        case "get_node": {
          const id = String(args.id || "");
          const node = nodesRef.current.find((n) => n.id === id);
          if (!node) throw new Error(`Nœud ${id} introuvable`);
          const manifest = modulesById.get(node.moduleId);
          return { ...node, manifest };
        }
        case "add_node": {
          const moduleId = String(args.module_id || "");
          const manifest = modulesById.get(moduleId);
          if (!manifest) throw new Error(`Module ${moduleId} introuvable`);
          const x = typeof args.x === "number" ? args.x : 0;
          const y = typeof args.y === "number" ? args.y : 0;
          const newId = addAt(manifest, x, y);
          if (args.params && typeof args.params === "object") {
            setParams(newId, args.params as Record<string, unknown>);
          }
          return { id: newId, module_id: moduleId };
        }
        case "remove_node": {
          const id = String(args.id || "");
          removeNodes([id]);
          return { removed: id };
        }
        case "update_node": {
          const id = String(args.id || "");
          if (args.params && typeof args.params === "object") {
            setParams(id, args.params as Record<string, unknown>);
          }
          if (typeof args.x === "number" || typeof args.y === "number") {
            const node = nodesRef.current.find((n) => n.id === id);
            if (node) {
              const dx =
                typeof args.x === "number" ? args.x - node.x : 0;
              const dy =
                typeof args.y === "number" ? args.y - node.y : 0;
              if (dx || dy) move([id], dx, dy);
            }
          }
          return { ok: true };
        }
        case "connect_nodes": {
          addEdge(
            String(args.source || ""),
            String(args.source_socket || ""),
            String(args.target || ""),
          );
          return { ok: true };
        }
        case "disconnect_edge": {
          removeEdge(String(args.id || ""));
          return { ok: true };
        }
        case "clear_graph": {
          const ids = nodesRef.current.map((n) => n.id);
          removeNodes(ids);
          return { removed: ids.length };
        }
        case "auto_layout": {
          runAutoLayout();
          return { ok: true };
        }
        case "run_node": {
          const id = String(args.id || "");
          const result = await runNode(id);
          return result ?? null;
        }
        case "replace_all_nodes": {
          const newNodes =
            (args.nodes as Array<{
              id: string;
              module_id: string;
              params?: Record<string, unknown>;
            }>) ?? [];
          const newEdges =
            (args.edges as Array<{
              source: string;
              source_socket: string;
              target: string;
            }>) ?? [];

          // Clear current graph (state update is queued)
          removeNodes(nodesRef.current.map((n) => n.id));

          // Create nodes — addAt returns the freshly-generated id synchronously,
          // so we don't need to wait for React to re-render between iterations.
          const idMap = new Map<string, string>();
          for (const spec of newNodes) {
            const manifest = modulesById.get(spec.module_id);
            if (!manifest) continue;
            const newId = addAt(manifest, 0, 0);
            idMap.set(spec.id, newId);
            if (spec.params) setParams(newId, spec.params);
          }

          // Wire edges using the freshly-mapped ids
          let edgesCreated = 0;
          for (const e of newEdges) {
            const src = idMap.get(e.source);
            const tgt = idMap.get(e.target);
            if (!src || !tgt) continue;
            addEdge(src, e.source_socket, tgt);
            edgesCreated++;
          }

          // Compute layout from the spec (synthesize CanvasNode/Edge objects)
          // and apply via setPositions — independent of React re-render timing.
          const synthNodes: CanvasNode[] = newNodes
            .filter((s) => idMap.has(s.id))
            .map((spec) => ({
              id: idMap.get(spec.id)!,
              moduleId: spec.module_id,
              x: 0,
              y: 0,
              width: 200,
              height: 110,
              params: spec.params ?? {},
              result: null,
            }));
          const synthEdges: Edge[] = [];
          for (let i = 0; i < newEdges.length; i++) {
            const e = newEdges[i];
            const src = idMap.get(e.source);
            const tgt = idMap.get(e.target);
            if (!src || !tgt) continue;
            synthEdges.push({
              id: `tmp-${i}`,
              source: src,
              sourceSocket: e.source_socket,
              target: tgt,
            });
          }
          const positions = autoLayout(synthNodes, synthEdges);
          setPositions(positions);

          return { nodes: idMap.size, edges: edgesCreated };
        }
        case "list_env": {
          return envRef.current;
        }
        case "get_env": {
          const key = String(args.key || "");
          return { key, value: envRef.current[key] ?? null };
        }
        case "set_env": {
          setEnv({
            ...envRef.current,
            [String(args.key)]: String(args.value ?? ""),
          });
          return { ok: true };
        }
        case "delete_env": {
          const key = String(args.key || "");
          const next = { ...envRef.current };
          delete next[key];
          setEnv(next);
          return { ok: true, removed: key };
        }
        case "select_module": {
          selectedModuleRef.current = String(args.module_id || "");
          return { selected: selectedModuleRef.current };
        }
        case "create_module": {
          if (!api) throw new Error("API indisponible");
          const id = String(args.id || "");
          await api.createModule({
            id,
            manifest: (args.manifest as Partial<ModuleManifest>) ?? undefined,
            code: typeof args.code === "string" ? args.code : undefined,
          });
          selectedModuleRef.current = id;
          return { id };
        }
        case "delete_module": {
          if (!api) throw new Error("API indisponible");
          await api.deleteModule(String(args.id || ""));
          return { ok: true };
        }
        case "list_module_files": {
          if (!api) throw new Error("API indisponible");
          const id = String(args.module_id || selectedModuleRef.current || "");
          if (!id) throw new Error("Aucun module sélectionné");
          return await api.listModuleFiles(id);
        }
        case "read_module_file": {
          if (!api) throw new Error("API indisponible");
          const id = String(args.module_id || selectedModuleRef.current || "");
          if (!id) throw new Error("Aucun module sélectionné");
          return await api.readModuleFile(id, String(args.file || ""));
        }
        case "write_module_file": {
          if (!api) throw new Error("API indisponible");
          const id = String(args.module_id || selectedModuleRef.current || "");
          if (!id) throw new Error("Aucun module sélectionné");
          await api.writeModuleFile(
            id,
            String(args.file || ""),
            String(args.content ?? ""),
          );
          return { ok: true };
        }
        case "delete_module_file": {
          if (!api) throw new Error("API indisponible");
          const id = String(args.module_id || selectedModuleRef.current || "");
          if (!id) throw new Error("Aucun module sélectionné");
          await api.deleteModuleFile(id, String(args.file || ""));
          return { ok: true };
        }
        default: {
          // MCP tools are surfaced to the AI as `mcp__<server>__<tool>`.
          // We look up the original (server, tool) pair and route the call.
          const target = mcp.mcpLookup.get(name);
          if (target) {
            if (!api) throw new Error("API indisponible");
            return await api.mcpCallTool(target.server, target.tool, args);
          }
          throw new Error(`Outil inconnu: ${name}`);
        }
      }
    },
    [
      modules,
      modulesById,
      addAt,
      addEdge,
      removeEdge,
      removeNodes,
      runNode,
      runAutoLayout,
      setParams,
      setPositions,
      setEnv,
      envRef,
      move,
      mcp.mcpLookup,
    ],
  );

  // Combine bundled tools with the dynamic MCP tools so the AI can call them
  // straight from the chat without any extra plumbing per server.
  const aiTools = useMemo(() => [...TOOLS, ...mcp.mcpTools], [mcp.mcpTools]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = document.activeElement;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA")) return;

      const meta = e.metaKey || e.ctrlKey;
      const sel = selectedIdsRef.current;

      if (e.key === "Delete" || e.key === "Backspace") {
        if (sel.size === 0) return;
        e.preventDefault();
        removeNodes(Array.from(sel));
        return;
      }

      if (meta && e.key.toLowerCase() === "d") {
        if (sel.size === 0) return;
        e.preventDefault();
        duplicate(Array.from(sel));
        return;
      }

      if (meta && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectMany(nodesRef.current.map((n) => n.id));
        return;
      }

      if (e.key === "Escape") {
        select(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [removeNodes, duplicate, selectMany, select]);

  const configuringNode = configuringId
    ? nodes.find((n) => n.id === configuringId)
    : null;
  const configuringModule = configuringNode
    ? modulesById.get(configuringNode.moduleId)
    : null;

  // Build context menu items based on the current context state.
  const contextMenuItems = useMemo<MenuItem[]>(() => {
    if (!context) return [];
    const sel = Array.from(selectedIds);
    if (context.kind === "node") {
      const node = nodes.find((n) => n.id === context.nodeId);
      const manifest = node ? modulesById.get(node.moduleId) : undefined;
      const single = sel.length === 1;
      const hasParams =
        single && (manifest?.params.length ?? 0) > 0;
      const isPinned = !!node?.pinned;
      const hasResult =
        node?.result && "ok" in node.result && node.result.ok;
      return [
        {
          label: "Exécuter",
          shortcut: "▶",
          onClick: () => {
            for (const id of sel) runNode(id);
          },
        },
        {
          label: "Configurer",
          shortcut: "↵↵",
          onClick: () => setConfiguringId(context.nodeId),
          disabled: !hasParams,
        },
        { divider: true },
        isPinned
          ? {
              label: "Désépingler les sorties",
              onClick: () => setPinned(context.nodeId, null),
            }
          : {
              label: "Épingler le résultat actuel",
              disabled: !hasResult,
              onClick: () => {
                if (
                  node?.result &&
                  "ok" in node.result &&
                  node.result.ok
                ) {
                  setPinned(
                    context.nodeId,
                    node.result.outputs as Record<string, unknown>,
                  );
                }
              },
            },
        {
          label: `Dupliquer${sel.length > 1 ? ` (${sel.length})` : ""}`,
          shortcut: "⌘D",
          onClick: () => duplicate(sel.length ? sel : [context.nodeId]),
        },
        { divider: true },
        {
          label: `Supprimer${sel.length > 1 ? ` (${sel.length})` : ""}`,
          shortcut: "⌫",
          danger: true,
          onClick: () => removeNodes(sel.length ? sel : [context.nodeId]),
        },
      ];
    }
    return [
      {
        label: "Tout sélectionner",
        shortcut: "⌘A",
        onClick: () => selectMany(nodes.map((n) => n.id)),
        disabled: nodes.length === 0,
      },
      {
        label: "Désélectionner",
        shortcut: "Esc",
        onClick: () => select(null),
        disabled: selectedIds.size === 0,
      },
    ];
  }, [
    context,
    nodes,
    selectedIds,
    modulesById,
    runNode,
    duplicate,
    removeNodes,
    selectMany,
    select,
  ]);

  return (
    <EnvContext.Provider value={env}>
      <McpContext.Provider value={mcp.servers}>
      <div className="flex h-full flex-col">
        <Toolbar
          zoomPercent={Math.round(viewport.scale * 100)}
          chatOpen={chatOpen}
          onToggleChat={() => setChatOpen((v) => !v)}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onReset={reset}
          onAutoLayout={runAutoLayout}
          projectSlot={
            <ProjectMenu
              projects={projects}
              activeId={activeProjectId}
              onSwitch={(id) => {
                void switchProject(id);
              }}
              onCreate={() => {
                void createProject("Nouveau projet");
              }}
              onImport={() => {
                void importProject().catch((err) =>
                  console.warn("[n2n] import failed", err),
                );
              }}
              onExport={(id) => {
                void exportProject(id);
              }}
              onDuplicate={(id) => {
                void duplicateProject(id);
              }}
              onRename={(id, name) => setRenameTarget({ id, name })}
              onDelete={(id) => {
                if (
                  typeof window !== "undefined" &&
                  !window.confirm("Supprimer ce projet ?")
                )
                  return;
                void deleteProject(id);
              }}
            />
          }
        />
        <div className="relative flex min-h-0 flex-1">
          <ModulePalette
            modules={modules}
            loading={loading}
            error={error}
            onAdd={addModuleAtCenter}
            onOpenFolder={openFolder}
            onOpenEnv={() => setEnvOpen(true)}
            onOpenMcp={() => setMcpOpen(true)}
          />
          <Canvas
            viewport={viewport}
            isPanning={isPanning}
            isSpaceDown={isSpaceDown}
            containerRef={containerRef}
            onPanMouseDown={onMouseDown}
            nodes={nodes}
            edges={edges}
            pending={pending}
            selectedIds={selectedIds}
            modulesById={modulesById}
            runningIds={runningIds}
            onSelect={select}
            onSelectMany={selectMany}
            onMove={move}
            onStartConnect={startConnect}
            onRemoveEdge={removeEdge}
            onSetParam={setParam}
            onRun={runNode}
            onConfigure={setConfiguringId}
            onNodeContextMenu={(x, y, nodeId) =>
              setContext({ kind: "node", x, y, nodeId })
            }
            onCanvasContextMenu={(x, y) =>
              setContext({ kind: "canvas", x, y })
            }
          />
          {chatOpen && (
            <ChatPanel
              onClose={() => setChatOpen(false)}
              systemPrompt={SYSTEM_PROMPT}
              tools={aiTools}
              executor={executor}
            />
          )}
        </div>
        <StatusBar
          viewport={viewport}
          nodeCount={nodes.length}
          edgeCount={edges.length}
        />
        {configuringNode && configuringModule && (
          <ConfigModal
            module={configuringModule}
            initialParams={configuringNode.params}
            onSave={(params) => setParams(configuringNode.id, params)}
            onClose={() => setConfiguringId(null)}
          />
        )}
        {envOpen && (
          <EnvModal
            initial={env}
            onSave={setEnv}
            onClose={() => setEnvOpen(false)}
          />
        )}
        {mcpOpen && <McpModal onClose={() => setMcpOpen(false)} />}
        {context && (
          <ContextMenu
            x={context.x}
            y={context.y}
            items={contextMenuItems}
            onClose={() => setContext(null)}
          />
        )}
        {renameTarget && (
          <PromptModal
            title="Renommer le projet"
            initialValue={renameTarget.name}
            onSave={(name) => {
              if (name.trim()) void renameProject(renameTarget.id, name.trim());
            }}
            onClose={() => setRenameTarget(null)}
          />
        )}
      </div>
      </McpContext.Provider>
    </EnvContext.Provider>
  );
}
