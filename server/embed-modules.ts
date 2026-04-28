// Bun macro: walks assets/modules/ at build time and returns every module's
// files as an in-memory dict. Imported from server/index.ts with
// `with { type: "macro" }`, so the result is inlined into the compiled
// binary as a literal — the produced n2n-server has no external asset
// dependency. In dev mode (bun --watch), Bun also evaluates the macro at
// startup, reading from the live filesystem, so module edits show up after
// a watcher reload without any extra build step.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type EmbeddedModuleFiles = Record<string, string>;
export type EmbeddedModules = Record<string, EmbeddedModuleFiles>;

export function loadEmbeddedModules(): EmbeddedModules {
  const root = join(import.meta.dir, "..", "assets", "modules");
  const out: EmbeddedModules = {};
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return {};
  }
  for (const id of names) {
    const dir = join(root, id);
    let st;
    try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const files: EmbeddedModuleFiles = {};
    const walk = (cur: string, rel: string) => {
      for (const entry of readdirSync(cur)) {
        const fp = join(cur, entry);
        const r = rel ? `${rel}/${entry}` : entry;
        const fst = statSync(fp);
        if (fst.isDirectory()) walk(fp, r);
        else files[r] = readFileSync(fp, "utf8");
      }
    };
    walk(dir, "");
    out[id] = files;
  }
  return out;
}
