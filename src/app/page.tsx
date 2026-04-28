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
import { SettingsModal } from "@/components/ui/SettingsModal";
import { StatusBar } from "@/components/ui/StatusBar";
import { Toolbar } from "@/components/ui/Toolbar";
import { getApiBase, pingServer } from "@/lib/n2n";
import { EnvContext } from "@/contexts/EnvContext";
import { McpContext } from "@/contexts/McpContext";
import { ProjectsContext } from "@/contexts/ProjectsContext";
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
import { SYSTEM_PROMPT, TOOLS } from "@/lib/tools";
import type { CanvasNode, Edge, ModuleManifest, RunResult } from "@/lib/types";

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
  // null = closed, "user" = user clicked the gear, "required" = first-run /
  // server unreachable (modal cannot be dismissed until configured).
  const [settingsMode, setSettingsMode] = useState<null | "user" | "required">(null);

  // Boot probe: ping the configured server and force the settings modal open
  // if it cannot be reached. We only do this once on mount, not when the user
  // already has a working config.
  useEffect(() => {
    let cancelled = false;
    if (typeof window === "undefined") return;
    if (window.n2n) return; // Electron bridge: no remote server, skip probe.
    (async () => {
      try {
        await pingServer(getApiBase(), AbortSignal.timeout(2000));
      } catch {
        if (!cancelled) setSettingsMode("required");
      }
    })();
    return () => { cancelled = true; };
  }, []);
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

  // Run a node via the server (server handles full orchestration).
  const runNode = useCallback(
    async (id: string): Promise<RunResult | undefined> => {
      if (!activeProjectId) return;
      const api = getApi();
      if (!api) return;
      markRunning(id, true);
      try {
        return await api.runProjectNode(activeProjectId, id);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      } finally {
        markRunning(id, false);
      }
    },
    [activeProjectId, markRunning],
  );

  const runNodeRef = useRef(runNode);
  useEffect(() => {
    runNodeRef.current = runNode;
  }, [runNode]);

  // Reflect server-side node execution state in the UI via SSE events.
  useEffect(() => {
    const api = getApi();
    if (!api) return;
    const offRunning = api.onNodeRunning(({ nodeId }) => markRunning(nodeId, true));
    const offResult = api.onNodeResult(({ nodeId, result }) => {
      markRunning(nodeId, false);
      setResult(nodeId, result);
    });
    const offEnv = api.onEnvChanged(() => {
      // Reload env from server so the UI stays in sync after env-set runs.
      api.loadEnv().then((e) => setEnv(e)).catch(() => {});
    });
    return () => { offRunning(); offResult(); offEnv(); };
  }, [markRunning, setResult, setEnv]);

  // Cron + webhook registration: sync the registry when nodes or active project change.
  // Now passes activeProjectId so the server knows which project to run on trigger.
  useEffect(() => {
    const api = getApi();
    if (!api || !activeProjectId) return;
    const cronNodes = nodes.filter((n) => n.moduleId === "cron-tick");
    const webhookNodes = nodes.filter((n) => n.moduleId === "webhook-receive");

    for (const n of cronNodes) {
      const intervalMs = parseHumanInterval(String(n.params.interval ?? ""));
      if (intervalMs > 0) api.cronRegister(n.id, intervalMs, activeProjectId);
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
        contentType: String(n.params.response_content_type ?? "application/json"),
        body: String(n.params.response_body ?? '{"ok":true}'),
        headers,
      }, activeProjectId);
    }

    return () => {
      for (const n of cronNodes) api.cronUnregister(n.id);
      for (const n of webhookNodes) api.webhookUnregister(n.id);
    };
  }, [nodes, activeProjectId]);

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
      <ProjectsContext.Provider value={{ projects, activeId: activeProjectId }}>
      <div className="flex h-full flex-col">
        <Toolbar
          zoomPercent={Math.round(viewport.scale * 100)}
          chatOpen={chatOpen}
          onToggleChat={() => setChatOpen((v) => !v)}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onReset={reset}
          onAutoLayout={runAutoLayout}
          onOpenSettings={() => setSettingsMode("user")}
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
            availableLetters={Array.from(
              { length: edges.filter((e) => e.target === configuringNode.id).length },
              (_, i) => indexToLetter(i),
            )}
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
        {settingsMode && (
          <SettingsModal
            required={settingsMode === "required"}
            onClose={() => setSettingsMode(null)}
          />
        )}
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
      </ProjectsContext.Provider>
      </McpContext.Provider>
    </EnvContext.Provider>
  );
}
