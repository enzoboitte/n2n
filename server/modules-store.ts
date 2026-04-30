// User module CRUD: list, create, delete, plus per-file ops (list/read/
// write/delete) all sandboxed under ~/.n2n/modules/<id>/. Also the module
// watcher that broadcasts `modulesChanged` whenever the dir changes on
// disk (handy when the user edits a module via their own editor).

import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { watch as fsWatch, type FSWatcher } from "node:fs";
import { join, resolve, dirname, sep } from "node:path";
import { MODULES_DIR } from "./config.ts";
import { exists, ensureModulesDir } from "./fs-helpers.ts";
import { broadcast } from "./sse.ts";

export async function listModules(): Promise<any[]> {
  await ensureModulesDir();
  const out: any[] = [];
  for (const entry of await readdir(MODULES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      out.push(JSON.parse(await readFile(join(MODULES_DIR, entry.name, "manifest.json"), "utf8")));
    } catch (err: any) {
      console.warn(`[n2n] skip ${entry.name}: ${err.message}`);
    }
  }
  return out;
}

export function moduleFilePath(id: string, file: string): string {
  if (!/^[a-z0-9._-]+$/i.test(id)) throw new Error(`Module id invalide: ${id}`);
  const dir = join(MODULES_DIR, id);
  const target = resolve(dir, file || "");
  const dirReal = resolve(dir);
  if (target !== dirReal && !target.startsWith(dirReal + sep)) {
    throw new Error("Chemin hors du module");
  }
  return target;
}

export async function createModule(args: { id: string; manifest?: any; code?: string }): Promise<{ id: string }> {
  const { id, manifest, code } = args;
  if (!/^[a-z0-9._-]+$/i.test(id)) throw new Error("ID invalide (a-z, 0-9, ., _, -)");
  const dir = join(MODULES_DIR, id);
  if (await exists(dir)) throw new Error(`Module ${id} existe déjà`);
  await mkdir(dir, { recursive: true });
  const finalManifest = {
    id,
    name: manifest?.name || id,
    description: manifest?.description || "",
    version: manifest?.version || "0.1.0",
    color: manifest?.color || "#64748b",
    entry: "module.py",
    inputs: manifest?.inputs || [],
    outputs: manifest?.outputs || [{ name: "value", label: "Valeur", type: "any" }],
    params: manifest?.params || [],
    ...(manifest?.configurable ? { configurable: true } : {}),
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(finalManifest, null, 2));
  await writeFile(join(dir, "module.py"), code || defaultModuleCode(id));
  return { id };
}

export function defaultModuleCode(id: string): string {
  return `"""Module ${id} — squelette généré."""

import json
import sys
import traceback


def run(inputs: dict, params: dict, letters: dict, env: dict) -> dict:
    # TODO: implémenter
    return {"value": (letters or {}).get("a")}


if __name__ == "__main__":
    payload = json.loads(sys.stdin.read() or "{}")
    try:
        result = run(
            payload.get("inputs") or {},
            payload.get("params") or {},
            payload.get("letters") or {},
            payload.get("env") or {},
        )
        sys.stdout.write(json.dumps(result, default=str))
    except Exception:
        sys.stderr.write(traceback.format_exc())
        sys.exit(1)
`;
}

export async function deleteModule(id: string): Promise<void> {
  const dir = moduleFilePath(id, "");
  await rm(dir, { recursive: true, force: true });
}

export async function listModuleFiles(id: string): Promise<{ path: string; kind: "file" | "dir" }[]> {
  const dir = moduleFilePath(id, "");
  if (!(await exists(dir))) throw new Error(`Module ${id} introuvable`);
  const out: { path: string; kind: "file" | "dir" }[] = [];
  const walk = async (cur: string, rel: string) => {
    for (const e of await readdir(cur, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push({ path: r, kind: "dir" });
        await walk(join(cur, e.name), r);
      } else {
        out.push({ path: r, kind: "file" });
      }
    }
  };
  await walk(dir, "");
  return out;
}

export async function readModuleFile(id: string, file: string): Promise<string> {
  return readFile(moduleFilePath(id, file), "utf8");
}

export async function writeModuleFile(id: string, file: string, content: string): Promise<void> {
  const p = moduleFilePath(id, file);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content ?? "");
}

export async function deleteModuleFile(id: string, file: string): Promise<void> {
  await rm(moduleFilePath(id, file), { recursive: true, force: true });
}

// ---- module watcher ----

let moduleWatcher: FSWatcher | null = null;

/**
 * Watch ~/.n2n/modules for changes. On any change, debounced 200 ms,
 * invalidate the manifest cache (callback) and broadcast `modulesChanged`
 * so renderers refetch the module list.
 */
export function attachModuleWatcher(invalidateManifestCache: () => void): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    moduleWatcher = fsWatch(MODULES_DIR, { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        invalidateManifestCache();
        broadcast("modulesChanged");
      }, 200);
    });
  } catch (err: any) {
    console.warn(`[n2n] module watcher disabled: ${err.message}`);
  }
}

export function detachModuleWatcher(): void {
  if (moduleWatcher) {
    try { moduleWatcher.close(); } catch {}
    moduleWatcher = null;
  }
}
