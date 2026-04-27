"use client";

import { useState, type RefObject } from "react";
import type { PendingConnect } from "@/hooks/useConnect";
import type {
  CanvasNode as CanvasNodeData,
  Edge,
  ModuleManifest,
  Viewport,
} from "@/lib/types";
import { CanvasEdges } from "./CanvasEdges";
import { CanvasGrid } from "./CanvasGrid";
import { CanvasNode } from "./CanvasNode";
import { EmptyState } from "./EmptyState";

type Props = {
  viewport: Viewport;
  isPanning: boolean;
  isSpaceDown: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  onPanMouseDown: (e: React.MouseEvent) => void;
  nodes: CanvasNodeData[];
  edges: Edge[];
  pending: PendingConnect | null;
  selectedIds: ReadonlySet<string>;
  modulesById: Map<string, ModuleManifest>;
  runningIds: ReadonlySet<string>;
  onSelect: (id: string | null, additive?: boolean) => void;
  onSelectMany: (ids: string[], additive?: boolean) => void;
  onMove: (ids: string[], dx: number, dy: number) => void;
  onStartConnect: (id: string, sourceSocket: string, e: React.MouseEvent) => void;
  onRemoveEdge: (id: string) => void;
  onSetParam: (id: string, key: string, value: unknown) => void;
  onRun: (id: string) => void;
  onConfigure: (id: string) => void;
  onNodeContextMenu: (x: number, y: number, nodeId: string) => void;
  onCanvasContextMenu: (x: number, y: number) => void;
};

type RubberBand = {
  start: { x: number; y: number };
  end: { x: number; y: number };
};

export function Canvas({
  viewport,
  isPanning,
  isSpaceDown,
  containerRef,
  onPanMouseDown,
  nodes,
  edges,
  pending,
  selectedIds,
  modulesById,
  runningIds,
  onSelect,
  onSelectMany,
  onMove,
  onStartConnect,
  onRemoveEdge,
  onSetParam,
  onRun,
  onConfigure,
  onNodeContextMenu,
  onCanvasContextMenu,
}: Props) {
  const [rubber, setRubber] = useState<RubberBand | null>(null);
  const cursor = isPanning ? "grabbing" : isSpaceDown ? "grab" : "default";

  const handleMouseDown = (e: React.MouseEvent) => {
    const isPanTrigger =
      e.button === 1 || (e.button === 0 && isSpaceDown);
    if (isPanTrigger) {
      onPanMouseDown(e);
      return;
    }
    if (e.button !== 0) return;

    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const start = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    let end = start;
    let moved = false;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;

    const handleMove = (ev: MouseEvent) => {
      end = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
      if (
        !moved &&
        (Math.abs(end.x - start.x) > 3 || Math.abs(end.y - start.y) > 3)
      ) {
        moved = true;
      }
      if (moved) setRubber({ start, end });
    };

    const handleUp = () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      setRubber(null);

      if (!moved) {
        if (!additive) onSelect(null);
        return;
      }

      const x1 =
        (Math.min(start.x, end.x) - viewport.x) / viewport.scale;
      const y1 =
        (Math.min(start.y, end.y) - viewport.y) / viewport.scale;
      const x2 =
        (Math.max(start.x, end.x) - viewport.x) / viewport.scale;
      const y2 =
        (Math.max(start.y, end.y) - viewport.y) / viewport.scale;

      const inside: string[] = [];
      for (const n of nodes) {
        if (n.x < x2 && n.x + n.width > x1 && n.y < y2 && n.y + n.height > y1) {
          inside.push(n.id);
        }
      }
      onSelectMany(inside, additive);
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    onCanvasContextMenu(e.clientX, e.clientY);
  };

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onContextMenu={handleContextMenu}
      className="relative flex-1 overflow-hidden bg-slate-50 select-none dark:bg-slate-900"
      style={{ cursor }}
    >
      <CanvasGrid viewport={viewport} />
      <div
        className="absolute top-0 left-0 origin-top-left will-change-transform"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
        }}
      >
        {nodes.map((node) => (
          <CanvasNode
            key={node.id}
            node={node}
            module={modulesById.get(node.moduleId)}
            selected={selectedIds.has(node.id)}
            selectedIds={selectedIds}
            scale={viewport.scale}
            isSpaceDown={isSpaceDown}
            running={runningIds.has(node.id)}
            onSelect={onSelect}
            onMove={onMove}
            onStartConnect={onStartConnect}
            onSetParam={onSetParam}
            onRun={onRun}
            onConfigure={onConfigure}
            onContextMenu={onNodeContextMenu}
          />
        ))}
      </div>
      <CanvasEdges
        nodes={nodes}
        edges={edges}
        pending={pending}
        viewport={viewport}
        modulesById={modulesById}
        onRemoveEdge={onRemoveEdge}
      />
      {rubber && (
        <div
          className="pointer-events-none absolute border border-indigo-400 bg-indigo-400/10"
          style={{
            left: Math.min(rubber.start.x, rubber.end.x),
            top: Math.min(rubber.start.y, rubber.end.y),
            width: Math.abs(rubber.end.x - rubber.start.x),
            height: Math.abs(rubber.end.y - rubber.start.y),
          }}
        />
      )}
      {nodes.length === 0 && <EmptyState />}
    </div>
  );
}
