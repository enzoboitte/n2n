"use client";

import { useCallback, useState } from "react";
import type { Edge } from "@/lib/types";

function generateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

export function useEdges() {
  const [edges, setEdges] = useState<Edge[]>([]);

  const add = useCallback(
    (source: string, sourceSocket: string, target: string) => {
      if (source === target) return;
      setEdges((current) => {
        const exists = current.some(
          (e) =>
            e.source === source &&
            e.sourceSocket === sourceSocket &&
            e.target === target,
        );
        if (exists) return current;
        return [
          ...current,
          { id: generateId(), source, sourceSocket, target },
        ];
      });
    },
    [],
  );

  const remove = useCallback((id: string) => {
    setEdges((current) => current.filter((e) => e.id !== id));
  }, []);

  const removeForNode = useCallback((nodeId: string) => {
    setEdges((current) =>
      current.filter((e) => e.source !== nodeId && e.target !== nodeId),
    );
  }, []);

  const setAllEdges = useCallback((next: Edge[]) => {
    setEdges(next);
  }, []);

  const removeForNodes = useCallback((nodeIds: string[]) => {
    if (nodeIds.length === 0) return;
    const set = new Set(nodeIds);
    setEdges((current) =>
      current.filter((e) => !set.has(e.source) && !set.has(e.target)),
    );
  }, []);

  return { edges, add, remove, removeForNode, removeForNodes, setAllEdges };
}
