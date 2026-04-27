"use client";

import { useCallback, useState } from "react";
import { NODE_BASE_HEIGHT, NODE_WIDTH } from "@/lib/layout";
import type {
  CanvasNode,
  ModuleManifest,
  ParamSpec,
  RunResult,
} from "@/lib/types";

function generateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

function defaultValue(spec: ParamSpec): unknown {
  if (spec.default !== undefined) return spec.default;
  switch (spec.type) {
    case "boolean":
      return false;
    case "kv":
      return {};
    case "mcp-arguments":
      return {};
    case "list":
      return [];
    case "select":
      return spec.options?.[0] ?? "";
    default:
      return "";
  }
}

function defaultParams(module: ModuleManifest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of module.params ?? []) {
    out[p.name] = defaultValue(p);
  }
  return out;
}

export function useNodes() {
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );

  const addAt = useCallback(
    (module: ModuleManifest, worldX: number, worldY: number): string => {
      const id = generateId();
      setNodes((current) => [
        ...current,
        {
          id,
          moduleId: module.id,
          x: worldX - NODE_WIDTH / 2,
          y: worldY - NODE_BASE_HEIGHT / 2,
          width: NODE_WIDTH,
          height: NODE_BASE_HEIGHT,
          params: defaultParams(module),
          result: null,
        },
      ]);
      setSelectedIds(new Set([id]));
      return id;
    },
    [],
  );

  const move = useCallback((ids: string[], dx: number, dy: number) => {
    if (ids.length === 0 || (dx === 0 && dy === 0)) return;
    const set = new Set(ids);
    setNodes((current) =>
      current.map((n) =>
        set.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n,
      ),
    );
  }, []);

  const setAllNodes = useCallback((next: CanvasNode[]) => {
    setNodes(next);
    setSelectedIds(new Set());
  }, []);

  const setPositions = useCallback(
    (positions: Map<string, { x: number; y: number }>) => {
      setNodes((current) =>
        current.map((n) => {
          const p = positions.get(n.id);
          return p ? { ...n, x: p.x, y: p.y } : n;
        }),
      );
    },
    [],
  );

  const select = useCallback((id: string | null, additive = false) => {
    if (id === null) {
      setSelectedIds(new Set());
      return;
    }
    setSelectedIds((prev) => {
      if (additive) {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }
      return new Set([id]);
    });
  }, []);

  const selectMany = useCallback((ids: string[], additive = false) => {
    setSelectedIds((prev) => {
      if (additive) {
        const next = new Set(prev);
        for (const id of ids) next.add(id);
        return next;
      }
      return new Set(ids);
    });
  }, []);

  const remove = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const set = new Set(ids);
    setNodes((current) => current.filter((n) => !set.has(n.id)));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  const duplicate = useCallback((ids: string[]): string[] => {
    if (ids.length === 0) return [];
    const newIds: string[] = [];
    setNodes((current) => {
      const map = new Map(current.map((n) => [n.id, n]));
      const dups: CanvasNode[] = [];
      for (const id of ids) {
        const src = map.get(id);
        if (!src) continue;
        const newId = generateId();
        newIds.push(newId);
        dups.push({
          ...src,
          id: newId,
          x: src.x + 30,
          y: src.y + 30,
          params: { ...src.params },
          result: null,
        });
      }
      return [...current, ...dups];
    });
    setSelectedIds(new Set(newIds));
    return newIds;
  }, []);

  const setParam = useCallback(
    (id: string, key: string, value: unknown) => {
      setNodes((current) =>
        current.map((n) =>
          n.id === id ? { ...n, params: { ...n.params, [key]: value } } : n,
        ),
      );
    },
    [],
  );

  const setParams = useCallback(
    (id: string, params: Record<string, unknown>) => {
      setNodes((current) =>
        current.map((n) => (n.id === id ? { ...n, params } : n)),
      );
    },
    [],
  );

  const setResult = useCallback((id: string, result: RunResult | null) => {
    setNodes((current) =>
      current.map((n) => (n.id === id ? { ...n, result } : n)),
    );
  }, []);

  const setPinned = useCallback(
    (id: string, pinned: Record<string, unknown> | null) => {
      setNodes((current) =>
        current.map((n) => (n.id === id ? { ...n, pinned } : n)),
      );
    },
    [],
  );

  return {
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
  };
}
