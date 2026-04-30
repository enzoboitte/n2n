// Project persistence: each project is a single JSON file in
// ~/.n2n/projects/<id>.json. Plus the active-project pointer
// (state.json) and the run history (history.jsonl, append-only).
//
// The CRUD here is filesystem-only. Trigger sync, autosave from the
// renderer, and SSE broadcasts live elsewhere.

import { mkdir, readFile, writeFile, readdir, rm, appendFile, unlink } from "node:fs/promises";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import {
  HISTORY_MAX_LINES, HISTORY_PATH, N2N_DIR, PROJECTS_DIR, STATE_PATH,
} from "./config.ts";

function projectFile(id: string): string {
  if (!/^[a-z0-9._-]+$/i.test(id)) throw new Error(`ID projet invalide: ${id}`);
  return join(PROJECTS_DIR, `${id}.json`);
}

export async function listProjects(): Promise<any[]> {
  await mkdir(PROJECTS_DIR, { recursive: true });
  const files = await readdir(PROJECTS_DIR);
  const out: any[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const p = JSON.parse(await readFile(join(PROJECTS_DIR, f), "utf8"));
      if (p && p.id) out.push({
        id: p.id, name: p.name || "(sans nom)",
        createdAt: p.createdAt || 0, updatedAt: p.updatedAt || 0,
      });
    } catch {}
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function loadProject(id: string): Promise<any> {
  return JSON.parse(await readFile(projectFile(id), "utf8"));
}

export async function saveProjectFile(project: any): Promise<{ id: string }> {
  if (!project || !project.id) throw new Error("Projet sans id");
  await mkdir(PROJECTS_DIR, { recursive: true });
  await writeFile(projectFile(project.id), JSON.stringify(project, null, 2));
  return { id: project.id };
}

export async function createProject(name?: string): Promise<any> {
  const id = randomUUID();
  const now = Date.now();
  const project = { id, name: name || "Untitled", createdAt: now, updatedAt: now, nodes: [], edges: [] };
  await saveProjectFile(project);
  return project;
}

export async function deleteProject(id: string): Promise<void> {
  await rm(projectFile(id), { force: true });
}

export async function renameProject(id: string, name: string): Promise<{ id: string; name: string }> {
  const p = await loadProject(id);
  p.name = String(name || "Untitled");
  p.updatedAt = Date.now();
  await saveProjectFile(p);
  return { id, name: p.name };
}

export async function duplicateProject(id: string): Promise<any> {
  const src = await loadProject(id);
  const newId = randomUUID();
  const now = Date.now();
  const dup = { ...src, id: newId, name: `${src.name} (copie)`, createdAt: now, updatedAt: now };
  await saveProjectFile(dup);
  return dup;
}

export async function loadState(): Promise<any> {
  try { return JSON.parse(await readFile(STATE_PATH, "utf8")) || {}; } catch { return {}; }
}

export async function saveState(state: any): Promise<void> {
  await mkdir(N2N_DIR, { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state || {}, null, 2));
}

export async function getActiveProjectId(): Promise<string | null> {
  return (await loadState()).activeProjectId || null;
}

export async function setActiveProjectId(id: string): Promise<void> {
  const s = await loadState();
  s.activeProjectId = id;
  await saveState(s);
}

export async function importProjectFromBuffer(
  filename: string,
  raw: string,
): Promise<{ canceled: false; project: any } | { canceled: false; error: string }> {
  let parsed: any;
  try { parsed = JSON.parse(raw); }
  catch (err: any) { return { canceled: false, error: `JSON invalide: ${err.message}` }; }
  const id = randomUUID();
  const now = Date.now();
  const project = {
    id,
    name: typeof parsed.name === "string" && parsed.name.trim()
      ? parsed.name + " (importé)"
      : basename(filename || "imported", ".json") + " (importé)",
    createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : now,
    updatedAt: now,
    nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
    edges: Array.isArray(parsed.edges) ? parsed.edges : [],
  };
  await saveProjectFile(project);
  return { canceled: false, project };
}

// ---------- history (append-only JSONL of node runs) ----------

export async function appendHistory(entry: any): Promise<void> {
  await mkdir(N2N_DIR, { recursive: true });
  await appendFile(HISTORY_PATH, JSON.stringify(entry) + "\n");
  if (Math.random() < 0.01) await trimHistory();
}

export async function trimHistory(): Promise<void> {
  try {
    const content = await readFile(HISTORY_PATH, "utf8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length > HISTORY_MAX_LINES) {
      await writeFile(HISTORY_PATH, lines.slice(-HISTORY_MAX_LINES).join("\n") + "\n");
    }
  } catch {}
}

export async function readHistory(limit = 200): Promise<any[]> {
  try {
    const content = await readFile(HISTORY_PATH, "utf8");
    const lines = content.split("\n").filter(Boolean);
    return lines.slice(-Math.max(1, limit)).reverse()
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

export async function clearHistory(): Promise<void> {
  try { await unlink(HISTORY_PATH); } catch {}
}
