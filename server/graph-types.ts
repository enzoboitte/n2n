// Shared types for the graph runtime. Kept in their own file so node
// runners (sql, mcp, http handlers, …) can import them without pulling in
// the whole graph engine.

export type GraphNode = {
  id: string;
  moduleId: string;
  params?: Record<string, unknown>;
  pinned?: Record<string, unknown> | null;
};

export type GraphEdge = {
  id: string;
  source: string;
  sourceSocket: string;
  target: string;
};

export type RunResult =
  | { ok: true; outputs: Record<string, unknown> }
  | { ok: false; error: string }
  | { skipped: true };

export type RunCtx = {
  projectId: string;
  nodesById: Map<string, GraphNode>;
  edges: GraphEdge[];
  manifests: Map<string, any>;
  cache: Map<string, Promise<RunResult>>;
  triggerData: Map<string, any>; // nodeId → webhook request data
  env: Record<string, string>;   // mutable env scoped to this run
  persistEnv: boolean;            // top-level runs persist __env__ writes
  emit: boolean;                  // top-level runs broadcast nodeRun events
  /**
   * The connectionId of whatever trigger fired this run, if any. Used as
   * the implicit fallback for rest-send / rest-end / ws-send / ws-close
   * so users don't have to wire the connectionId by hand for the common
   * "respond to the request that started this run" case.
   */
  triggerConnectionId?: string;
};
