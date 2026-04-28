import type { CanvasNode, Edge, ModuleManifest } from "./types";

export const NODE_DIAMETER = 96;
export const NODE_WIDTH = NODE_DIAMETER;
export const NODE_BASE_HEIGHT = NODE_DIAMETER;

// Outputs spread across a 120° arc on the right hemisphere of the circle.
const OUTPUT_ARC = (Math.PI * 2) / 3;

export function outputSocketAngle(index: number, count: number): number {
  if (count <= 1) return 0;
  return -OUTPUT_ARC / 2 + (index / (count - 1)) * OUTPUT_ARC;
}

// Position of an output socket relative to a node of given size, top-left origin.
export function outputSocketPosition(
  index: number,
  count: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const rx = width / 2;
  const ry = height / 2;
  const angle = outputSocketAngle(index, count);
  return {
    x: rx + rx * Math.cos(angle),
    y: ry + ry * Math.sin(angle),
  };
}

// Single visual input handle, on the left-mid edge of the circle.
export function inputAnchor(node: CanvasNode): { x: number; y: number } {
  return { x: node.x, y: node.y + node.height / 2 };
}

// One handle per output socket, distributed along the right semicircle.
export function outputAnchor(
  node: CanvasNode,
  manifest: ModuleManifest | undefined,
  socketName: string,
): { x: number; y: number } {
  const sockets = manifest?.outputs ?? [];
  const found = sockets.findIndex((s) => s.name === socketName);
  const index = found < 0 ? 0 : found;
  const total = sockets.length || 1;
  const pos = outputSocketPosition(index, total, node.width, node.height);
  return { x: node.x + pos.x, y: node.y + pos.y };
}

// Layered ("Sugiyama-lite") graph layout: depth = longest path from sources,
// nodes grouped by depth, then sorted within columns by barycenter of
// predecessor positions to reduce edge crossings.
export function autoLayout(
  nodes: CanvasNode[],
  edges: Edge[],
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return positions;

  const COL_GAP = 240;
  const ROW_GAP = 60;

  const incoming = new Map<string, string[]>();
  for (const n of nodes) incoming.set(n.id, []);
  for (const e of edges) {
    if (incoming.has(e.target) && incoming.has(e.source)) {
      incoming.get(e.target)!.push(e.source);
    }
  }

  const depths = new Map<string, number>();
  const visit = (id: string, on: Set<string>): number => {
    if (depths.has(id)) return depths.get(id)!;
    if (on.has(id)) return 0; // cycle: break
    on.add(id);
    const preds = incoming.get(id) ?? [];
    let d = 0;
    if (preds.length > 0) {
      d = 1 + Math.max(...preds.map((p) => visit(p, on)));
    }
    on.delete(id);
    depths.set(id, d);
    return d;
  };
  for (const n of nodes) visit(n.id, new Set());

  const maxDepth = Math.max(0, ...Array.from(depths.values()));
  const cols: string[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (const [id, d] of depths) cols[d].push(id);

  // Stable initial sort by id to keep determinism, then barycenter pass.
  for (const col of cols) col.sort();
  for (let c = 1; c < cols.length; c++) {
    const prevIdx = new Map(cols[c - 1].map((id, i) => [id, i]));
    cols[c].sort((a, b) => {
      const ba = avg(
        (incoming.get(a) ?? [])
          .map((p) => prevIdx.get(p))
          .filter((x): x is number => x !== undefined),
      );
      const bb = avg(
        (incoming.get(b) ?? [])
          .map((p) => prevIdx.get(p))
          .filter((x): x is number => x !== undefined),
      );
      return ba - bb;
    });
  }

  const heightById = new Map(nodes.map((n) => [n.id, n.height]));
  for (let c = 0; c < cols.length; c++) {
    const col = cols[c];
    const heights = col.map((id) => heightById.get(id) ?? NODE_BASE_HEIGHT);
    const total =
      heights.reduce((sum, h) => sum + h, 0) +
      Math.max(0, col.length - 1) * ROW_GAP;
    let y = -total / 2;
    for (let i = 0; i < col.length; i++) {
      positions.set(col[i], { x: c * COL_GAP, y });
      y += heights[i] + ROW_GAP;
    }
  }

  return positions;
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
