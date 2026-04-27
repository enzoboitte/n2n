"use client";

import { useMemo } from "react";
import type { PendingConnect } from "@/hooks/useConnect";
import { inputAnchor, outputAnchor } from "@/lib/layout";
import { lettersByEdge } from "@/lib/letters";
import type {
  CanvasNode,
  Edge,
  ModuleManifest,
  Viewport,
} from "@/lib/types";

type Point = { x: number; y: number };

type Props = {
  nodes: CanvasNode[];
  edges: Edge[];
  pending: PendingConnect | null;
  viewport: Viewport;
  modulesById: Map<string, ModuleManifest>;
  onRemoveEdge: (id: string) => void;
};

function bezier(s: Point, t: Point) {
  const dx = Math.max(40, Math.abs(t.x - s.x) * 0.5);
  return `M${s.x},${s.y} C${s.x + dx},${s.y} ${t.x - dx},${t.y} ${t.x},${t.y}`;
}

export function CanvasEdges({
  nodes,
  edges,
  pending,
  viewport,
  modulesById,
  onRemoveEdge,
}: Props) {
  const nodeById = useMemo(() => {
    const m = new Map<string, CanvasNode>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  const edgeLetters = useMemo(() => lettersByEdge(edges), [edges]);

  const toScreen = (wx: number, wy: number): Point => ({
    x: wx * viewport.scale + viewport.x,
    y: wy * viewport.scale + viewport.y,
  });

  const sourcePoint = (node: CanvasNode, socket: string): Point => {
    const manifest = modulesById.get(node.moduleId);
    const a = outputAnchor(node, manifest, socket);
    return toScreen(a.x, a.y);
  };
  const targetPoint = (node: CanvasNode): Point => {
    const a = inputAnchor(node);
    return toScreen(a.x, a.y);
  };

  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      aria-hidden
    >
      <defs>
        <marker
          id="edge-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8" />
        </marker>
      </defs>

      {edges.map((edge) => {
        const src = nodeById.get(edge.source);
        const tgt = nodeById.get(edge.target);
        if (!src || !tgt) return null;
        const s = sourcePoint(src, edge.sourceSocket);
        const t = targetPoint(tgt);
        const d = bezier(s, t);
        const mx = (s.x + t.x) / 2;
        const my = (s.y + t.y) / 2;
        // letter chip near target side (75% along the chord)
        const lx = s.x + (t.x - s.x) * 0.75;
        const ly = s.y + (t.y - s.y) * 0.75;
        const letter = edgeLetters.get(edge.id) ?? "";
        return (
          <g key={edge.id}>
            <path
              d={d}
              stroke="#94a3b8"
              strokeWidth={2}
              fill="none"
              markerEnd="url(#edge-arrow)"
            />
            {letter && (
              <g
                transform={`translate(${lx} ${ly})`}
                className="text-slate-700 dark:text-slate-200"
                aria-hidden
              >
                <circle
                  r="9"
                  fill="white"
                  stroke="#94a3b8"
                  strokeWidth="1.25"
                  className="dark:fill-slate-800"
                />
                <text
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize="10"
                  fontWeight="600"
                  fill="currentColor"
                >
                  {letter}
                </text>
              </g>
            )}
            <g
              transform={`translate(${mx} ${my})`}
              className="cursor-pointer text-slate-400 opacity-0 transition-opacity hover:text-rose-500 hover:opacity-100"
              style={{ pointerEvents: "auto" }}
              onClick={(e) => {
                e.stopPropagation();
                onRemoveEdge(edge.id);
              }}
            >
              <circle r="9" fill="white" stroke="currentColor" strokeWidth="1" />
              <path
                d="M-3,-3 L3,3 M-3,3 L3,-3"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                fill="none"
              />
            </g>
          </g>
        );
      })}

      {pending &&
        (() => {
          const src = nodeById.get(pending.sourceId);
          if (!src) return null;
          const s = sourcePoint(src, pending.sourceSocket);
          const t = toScreen(pending.x, pending.y);
          return (
            <path
              d={bezier(s, t)}
              stroke="#6366f1"
              strokeWidth={2}
              strokeDasharray="5 4"
              fill="none"
            />
          );
        })()}
    </svg>
  );
}
