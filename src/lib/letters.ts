import type { Edge } from "./types";

// Excel-style: 0=a, 25=z, 26=aa, 27=ab, …
export function indexToLetter(i: number): string {
  let n = i;
  let s = "";
  while (true) {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return s;
}

// Map every edge id to its letter (a, b, c, …) computed per target node,
// in edge-creation order (= order in the edges array).
export function lettersByEdge(edges: Edge[]): Map<string, string> {
  const out = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const e of edges) {
    const i = counts.get(e.target) ?? 0;
    out.set(e.id, indexToLetter(i));
    counts.set(e.target, i + 1);
  }
  return out;
}
