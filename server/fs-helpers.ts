// Filesystem helpers shared across the server: existence check, recursive
// dir copy, manifest reads/writes for module sync. None of these talk to
// the runtime — they are pure utilities operating on paths.

import { mkdir, readFile, writeFile, readdir, rm, copyFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { BUNDLED_MODULES_DIR, DEPRECATED_MODULES, MODULES_DIR } from "./config.ts";
import { EMBEDDED_MODULES } from "./embedded.ts";

export async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

export async function copyDir(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const sp = join(src, entry.name);
    const dp = join(dst, entry.name);
    if (entry.isDirectory()) await copyDir(sp, dp);
    else await copyFile(sp, dp);
  }
}

export async function readManifest(dir: string): Promise<any | null> {
  try { return JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")); }
  catch { return null; }
}

export async function syncModule(srcDir: string, dstDir: string): Promise<void> {
  if (!(await exists(dstDir))) { await copyDir(srcDir, dstDir); return; }
  const src = await readManifest(srcDir);
  const dst = await readManifest(dstDir);
  const same = src && dst && src.version && src.version === dst.version;
  if (same) return;
  await rm(dstDir, { recursive: true, force: true });
  await copyDir(srcDir, dstDir);
}

export async function syncEmbeddedModule(
  id: string,
  files: Record<string, string>,
): Promise<void> {
  const manifestRaw = files["manifest.json"];
  if (!manifestRaw) return;
  let manifest: any;
  try { manifest = JSON.parse(manifestRaw); }
  catch { return; }
  const dstDir = join(MODULES_DIR, id);
  if (await exists(dstDir)) {
    const existing = await readManifest(dstDir);
    if (existing?.version && manifest?.version && existing.version === manifest.version) return;
    await rm(dstDir, { recursive: true, force: true });
  }
  await mkdir(dstDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dstDir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

export async function ensureModulesDir(): Promise<void> {
  await mkdir(MODULES_DIR, { recursive: true });
  for (const id of DEPRECATED_MODULES) {
    const dir = join(MODULES_DIR, id);
    if (await exists(dir)) {
      await rm(dir, { recursive: true, force: true });
      console.log(`[n2n] removed deprecated module: ${id}`);
    }
  }
  // Prefer the on-disk bundle when running from source — keeps `bun --watch`
  // hot-reloads honest. The compiled binary has no assets/ folder, so it
  // falls back to the EMBEDDED_MODULES literal inlined at build time.
  if (await exists(BUNDLED_MODULES_DIR)) {
    for (const entry of await readdir(BUNDLED_MODULES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      await syncModule(join(BUNDLED_MODULES_DIR, entry.name), join(MODULES_DIR, entry.name));
    }
    return;
  }
  for (const [id, files] of Object.entries(EMBEDDED_MODULES)) {
    await syncEmbeddedModule(id, files);
  }
}
