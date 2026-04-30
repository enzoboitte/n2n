// File CRUD primitives sandboxed under ~/.n2n/data/. Same path-resolution
// rules as `resolveSqliteSandboxPath`: relative paths root under DATA_DIR,
// absolute paths must stay inside $HOME, `~/foo` expands. Refuses to step
// out of $HOME so a workflow can't, e.g., overwrite /etc.
//
// Public surface mirrors the moduleIds the graph runtime dispatches to:
//   file-read    → runFileRead
//   file-write   → runFileWrite
//   file-delete  → runFileDelete
//   file-list    → runFileList
//   file-mkdir   → runFileMkdir
//
// Each returns a normalised `RunResult`.

import {
  mkdir, readFile, writeFile, readdir, rm, stat, access, appendFile,
} from "node:fs/promises";
import { join, resolve, dirname, relative, sep } from "node:path";
import { homedir } from "node:os";
import { DATA_DIR } from "./config.ts";
import type { RunResult } from "./graph-types.ts";

/**
 * Resolve any user-supplied path under the n2n data sandbox.
 *
 *   ""                  → DATA_DIR (the sandbox root)
 *   "foo.txt"           → ~/.n2n/data/foo.txt
 *   "subdir/file.bin"   → ~/.n2n/data/subdir/file.bin
 *   "~/notes/x.md"      → ~/notes/x.md (must stay under $HOME)
 *   "/abs/under/home"   → only if under $HOME
 *
 * Throws otherwise.
 */
export function resolveDataSandboxPath(input: string): string {
  const cleaned = String(input || "").trim();
  let target: string;
  if (!cleaned) {
    target = DATA_DIR;
  } else if (cleaned.startsWith("~/")) {
    target = join(homedir(), cleaned.slice(2));
  } else if (cleaned.startsWith("/")) {
    target = resolve(cleaned);
  } else {
    target = join(DATA_DIR, cleaned);
  }
  const resolved = resolve(target);
  const homeReal = resolve(homedir());
  if (resolved !== homeReal && !resolved.startsWith(homeReal + sep)) {
    throw new Error(`Chemin refusé (hors de $HOME) : ${input}`);
  }
  return resolved;
}

async function statSafe(p: string): Promise<{ kind: "file" | "dir" | null; size: number; mtime: number }> {
  try {
    const s = await stat(p);
    return {
      kind: s.isDirectory() ? "dir" : s.isFile() ? "file" : null,
      size: Number(s.size || 0),
      mtime: Number(s.mtimeMs || 0),
    };
  } catch {
    return { kind: null, size: 0, mtime: 0 };
  }
}

export async function runFileRead(
  substituted: Record<string, unknown>,
): Promise<RunResult> {
  let path: string;
  try { path = resolveDataSandboxPath(String(substituted.path ?? "")); }
  catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  const encoding = String(substituted.encoding || "utf8");
  try {
    if (encoding === "base64") {
      const buf = await readFile(path);
      return {
        ok: true,
        outputs: { content: buf.toString("base64"), exists: true, path, size: buf.length },
      };
    }
    const content = await readFile(path, "utf8");
    return {
      ok: true,
      outputs: { content, exists: true, path, size: Buffer.byteLength(content, "utf8") },
    };
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      return { ok: true, outputs: { content: null, exists: false, path, size: 0 } };
    }
    return { ok: false, error: `file-read: ${e?.message || e}` };
  }
}

export async function runFileWrite(
  substituted: Record<string, unknown>,
  inputs: Record<string, unknown>,
): Promise<RunResult> {
  let path: string;
  try { path = resolveDataSandboxPath(String(substituted.path ?? "")); }
  catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  // Content can come from the param (after substitution) OR from the input
  // socket — input wins so chained pipelines (regex → file-write) work.
  let raw: unknown = inputs.content;
  if (raw === null || raw === undefined) raw = substituted.content;
  let body: string | Buffer;
  const encoding = String(substituted.encoding || "utf8");
  if (encoding === "base64" && typeof raw === "string") {
    body = Buffer.from(raw, "base64");
  } else if (typeof raw === "string") {
    body = raw;
  } else if (raw === null || raw === undefined) {
    body = "";
  } else {
    body = JSON.stringify(raw);
  }
  const mode = String(substituted.mode || "overwrite");
  const createDirs = substituted.create_dirs !== false;
  try {
    if (createDirs) await mkdir(dirname(path), { recursive: true });
    if (mode === "append") {
      await appendFile(path, body);
    } else if (mode === "create-only") {
      // Refuse if file exists.
      try { await access(path); return { ok: false, error: `file-write: existe déjà → ${path}` }; }
      catch { /* not present, proceed */ }
      await writeFile(path, body);
    } else {
      await writeFile(path, body);
    }
    const bytes = typeof body === "string" ? Buffer.byteLength(body, "utf8") : body.length;
    return { ok: true, outputs: { path, bytes } };
  } catch (e: any) {
    return { ok: false, error: `file-write: ${e?.message || e}` };
  }
}

export async function runFileDelete(
  substituted: Record<string, unknown>,
): Promise<RunResult> {
  let path: string;
  try { path = resolveDataSandboxPath(String(substituted.path ?? "")); }
  catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  // Refuse to delete the sandbox root itself or $HOME.
  const homeReal = resolve(homedir());
  const dataReal = resolve(DATA_DIR);
  if (path === homeReal || path === dataReal) {
    return { ok: false, error: `file-delete: refus de supprimer ${path}` };
  }
  const recursive = !!substituted.recursive;
  try {
    await rm(path, { recursive, force: true });
    return { ok: true, outputs: { path, removed: true } };
  } catch (e: any) {
    return { ok: false, error: `file-delete: ${e?.message || e}` };
  }
}

export async function runFileList(
  substituted: Record<string, unknown>,
): Promise<RunResult> {
  let root: string;
  try { root = resolveDataSandboxPath(String(substituted.path ?? "")); }
  catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  const recursive = !!substituted.recursive;
  const includeStat = substituted.include_stat !== false;
  const out: Array<{ path: string; abs: string; kind: "file" | "dir"; size?: number; mtime?: number }> = [];
  const walk = async (cur: string): Promise<void> => {
    let entries;
    try { entries = await readdir(cur, { withFileTypes: true }); }
    catch (e: any) { throw new Error(`file-list: ${e?.message || e}`); }
    for (const e of entries) {
      const abs = join(cur, e.name);
      const rel = relative(root, abs);
      const kind: "file" | "dir" = e.isDirectory() ? "dir" : "file";
      let size: number | undefined;
      let mtime: number | undefined;
      if (includeStat) {
        const st = await statSafe(abs);
        size = st.size;
        mtime = st.mtime;
      }
      out.push({ path: rel || e.name, abs, kind, size, mtime });
      if (recursive && kind === "dir") await walk(abs);
    }
  };
  try {
    const st = await statSafe(root);
    if (st.kind === null) {
      return { ok: false, error: `file-list: chemin introuvable → ${root}` };
    }
    if (st.kind === "file") {
      // List a single file as a one-element array for symmetry.
      return {
        ok: true,
        outputs: {
          files: [{
            path: relative(dirname(root), root) || root,
            abs: root,
            kind: "file" as const,
            size: st.size,
            mtime: st.mtime,
          }],
          path: root,
        },
      };
    }
    await walk(root);
    return { ok: true, outputs: { files: out, path: root } };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export async function runFileMkdir(
  substituted: Record<string, unknown>,
): Promise<RunResult> {
  let path: string;
  try { path = resolveDataSandboxPath(String(substituted.path ?? "")); }
  catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  const recursive = substituted.recursive !== false;
  try {
    await mkdir(path, { recursive });
    return { ok: true, outputs: { path, created: true } };
  } catch (e: any) {
    return { ok: false, error: `file-mkdir: ${e?.message || e}` };
  }
}
