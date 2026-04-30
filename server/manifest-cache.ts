// Cached `Map<id, manifest>` of every user module. The graph runtime hits
// this on each node execution to look up a module's input/output schema —
// caching avoids re-reading every JSON manifest from disk per call.
// Invalidated by the module watcher whenever ~/.n2n/modules changes.

import { listModules } from "./modules-store.ts";

let manifestCache: Map<string, any> | null = null;

export async function getManifests(): Promise<Map<string, any>> {
  if (manifestCache) return manifestCache;
  const list = await listModules();
  manifestCache = new Map(list.map((m) => [m.id, m]));
  return manifestCache;
}

export function invalidateManifestCache(): void {
  manifestCache = null;
}
