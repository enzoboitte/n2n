// External runtimes manager — Node.js, Python and the optional npm
// driver packages (mysql2, oracledb, mongodb, …). Ships:
//
//   - Path-resolving helpers (`getExtendedPath`, `findInPath`) that scan
//     well-known user dirs (NVM, Volta, Bun, pyenv, Homebrew…) so MCP
//     spawns and python module spawns find their tools even when
//     n2n-server runs from an Electron-launched parent with a minimal
//     inherited PATH.
//   - Detection (`detectNode`, `detectPython`, `detectNpmPkg`, `listRuntimes`).
//   - One-click install of the bundled Node and Python (tarball download +
//     `tar -xzf` extraction under ~/.n2n/runtimes/).
//   - npm driver install via `npm install <pkg>` against ~/.n2n/npm/.
//
// `startRuntimeInstall` ends with an optional callback (see
// `setPostInstallHook`) so the MCP state module can request a restart of
// running servers after Node/Python finishes — without creating a circular
// import.

import { spawn } from "bun";
import { mkdir, readFile, writeFile, readdir, rm, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import {
  N2N_NODE_DIR, N2N_NPM_DIR, N2N_PY_DIR, NODE_VERSION, PY_RELEASE, PY_VERSION,
  RUNTIMES_DIR,
} from "./config.ts";
import { exists } from "./fs-helpers.ts";
import { broadcast } from "./sse.ts";

// String so we can mix the bundled Node/Python runtimes with optional npm
// driver packages (mysql2, oracledb, …) under one runtime list.
export type RuntimeId = string;

export type RuntimeArch = "x64" | "arm64";
export type RuntimePlatform = "linux" | "darwin";

export function detectRuntimePlatform(): { platform: RuntimePlatform; arch: RuntimeArch } | null {
  const p = process.platform;
  const a = process.arch;
  if (p !== "linux" && p !== "darwin") return null;
  if (a !== "x64" && a !== "arm64") return null;
  return { platform: p as RuntimePlatform, arch: a as RuntimeArch };
}

let cachedExtPath: string | null = null;

async function listIfExists(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
  } catch { return []; }
}

async function buildExtendedPath(): Promise<string> {
  const home = homedir();
  const parts: string[] = [];

  // Our managed installs first
  parts.push(join(N2N_NODE_DIR, "bin"));
  parts.push(join(N2N_PY_DIR, "bin"));

  // Common user-local install paths
  parts.push(join(home, ".local", "bin"));
  parts.push(join(home, ".bun", "bin"));
  parts.push(join(home, ".cargo", "bin"));
  parts.push(join(home, ".volta", "bin"));
  parts.push(join(home, ".npm-global", "bin"));

  // NVM: ~/.nvm/versions/node/<version>/bin (latest first)
  const nvmDirs = (await listIfExists(join(home, ".nvm", "versions", "node")))
    .sort()
    .reverse()
    .map((d) => join(d, "bin"));
  parts.push(...nvmDirs);

  // pyenv shims
  const pyenvShims = join(home, ".pyenv", "shims");
  if (await exists(pyenvShims)) parts.push(pyenvShims);

  // System paths (Homebrew + standard)
  parts.push("/opt/homebrew/bin", "/opt/homebrew/sbin");
  parts.push("/home/linuxbrew/.linuxbrew/bin", "/home/linuxbrew/.linuxbrew/sbin");
  parts.push("/usr/local/bin", "/usr/local/sbin");
  parts.push("/usr/bin", "/usr/sbin", "/bin", "/sbin");

  // Existing PATH (last so we don't override our managed installs)
  if (process.env.PATH) parts.push(process.env.PATH);

  // De-duplicate while preserving order
  const seen = new Set<string>();
  const out: string[] = [];
  for (const segment of parts) {
    for (const p of segment.split(":")) {
      if (p && !seen.has(p)) { seen.add(p); out.push(p); }
    }
  }
  return out.join(":");
}

export async function getExtendedPath(): Promise<string> {
  if (!cachedExtPath) cachedExtPath = await buildExtendedPath();
  return cachedExtPath;
}

export function invalidateExtendedPath(): void {
  cachedExtPath = null;
}

export async function findInPath(cmd: string, path: string): Promise<string | null> {
  if (cmd.includes("/")) {
    return (await exists(cmd)) ? cmd : null;
  }
  for (const dir of path.split(":")) {
    if (!dir) continue;
    const full = join(dir, cmd);
    if (await exists(full)) return full;
  }
  return null;
}

async function getCmdVersion(cmd: string, args: string[] = ["--version"]): Promise<string | null> {
  try {
    const path = await getExtendedPath();
    const resolved = await findInPath(cmd, path);
    if (!resolved) return null;
    const proc = spawn({
      cmd: [resolved, ...args],
      env: { ...process.env, PATH: path } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, , code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) return null;
    return out.trim() || null;
  } catch { return null; }
}

export type RuntimeStatus = {
  id: RuntimeId;
  label: string;
  description: string;
  installed: boolean;
  installable: boolean;
  installing: boolean;
  error: string | null;
  log: string;
  details: { name: string; path: string | null; version: string | null }[];
};

export type InstallState = {
  installing: boolean;
  error: string | null;
  log: string;
};

const installStates = new Map<RuntimeId, InstallState>();

export function getInstallState(id: RuntimeId): InstallState {
  if (!installStates.has(id)) {
    installStates.set(id, { installing: false, error: null, log: "" });
  }
  return installStates.get(id)!;
}

export function appendInstallLog(id: RuntimeId, line: string): void {
  const s = getInstallState(id);
  const ts = new Date().toISOString().slice(11, 19);
  s.log += `[${ts}] ${line}\n`;
  // Cap the log so it doesn't grow forever
  if (s.log.length > 16000) s.log = s.log.slice(-12000);
  broadcast("runtimesChanged");
}

async function detectNode(): Promise<RuntimeStatus["details"]> {
  const path = await getExtendedPath();
  const out: RuntimeStatus["details"] = [];
  for (const cmd of ["node", "npx"]) {
    const resolved = await findInPath(cmd, path);
    const version = resolved ? await getCmdVersion(cmd) : null;
    out.push({ name: cmd, path: resolved, version });
  }
  return out;
}

async function detectPython(): Promise<RuntimeStatus["details"]> {
  const path = await getExtendedPath();
  const out: RuntimeStatus["details"] = [];
  for (const cmd of ["python3", "uv", "uvx"]) {
    const resolved = await findInPath(cmd, path);
    const version = resolved ? await getCmdVersion(cmd) : null;
    out.push({ name: cmd, path: resolved, version });
  }
  return out;
}

/**
 * Optional npm packages used dynamically by sql-query. Surfaced in the
 * Environnements panel so the user can install them without SSH.
 */
export const KNOWN_NPM_PKGS: Array<{
  id: string;
  pkg: string;
  label: string;
  description: string;
}> = [
  { id: "npm-mysql2", pkg: "mysql2", label: "MySQL / MariaDB",
    description: "Driver Node pour MySQL et MariaDB (sql-query mysql/mariadb)." },
  { id: "npm-mssql", pkg: "mssql", label: "Microsoft SQL Server",
    description: "Driver MSSQL (sql-query mssql)." },
  { id: "npm-oracledb", pkg: "oracledb", label: "Oracle DB",
    description: "Driver Oracle Thin mode 6.0+ (sql-query oracle). Pas besoin d'Instant Client." },
  { id: "npm-mongodb", pkg: "mongodb", label: "MongoDB",
    description: "Driver Mongo (sql-query mongodb : find / insert / update / aggregate…)." },
  { id: "npm-redis", pkg: "redis", label: "Redis",
    description: "Client Redis (sql-query redis : commandes brutes JSON)." },
  { id: "npm-duckdb", pkg: "@duckdb/node-api", label: "DuckDB",
    description: "Base analytique in-process (sql-query duckdb)." },
  { id: "npm-ajv", pkg: "ajv", label: "ajv (JSON Schema)",
    description: "Validateur JSON Schema (utilisé par le module validate)." },
];

async function detectNpmPkg(pkg: string): Promise<RuntimeStatus["details"]> {
  // pkg can be "@scope/name" — split on / to walk into the right dir.
  const parts = pkg.split("/").filter(Boolean);
  const dir = join(N2N_NPM_DIR, "node_modules", ...parts);
  const pkgJson = join(dir, "package.json");
  try {
    const meta = JSON.parse(await readFile(pkgJson, "utf8"));
    return [{ name: pkg, path: dir, version: typeof meta.version === "string" ? meta.version : null }];
  } catch {
    return [{ name: pkg, path: null, version: null }];
  }
}

export async function listRuntimes(): Promise<RuntimeStatus[]> {
  const out: RuntimeStatus[] = [];
  const platform = detectRuntimePlatform();

  for (const id of ["node", "python"] as RuntimeId[]) {
    const state = getInstallState(id);
    const details = id === "node" ? await detectNode() : await detectPython();
    const installed = id === "node"
      ? details.every((d) => d.path)
      : details[0]?.path != null;
    out.push({
      id,
      label: id === "node" ? "Node.js" : "Python",
      description: id === "node"
        ? "Required for npx-based MCP servers (filesystem, github, slack, …)."
        : "Required for python3 modules and uvx-based MCP servers (git, time, sqlite, …).",
      installed,
      installable: !!platform,
      installing: state.installing,
      error: state.error,
      log: state.log,
      details,
    });
  }

  // npm driver packages — appended after the bundled runtimes so the UI
  // groups them naturally below Node + Python.
  for (const meta of KNOWN_NPM_PKGS) {
    const state = getInstallState(meta.id);
    const details = await detectNpmPkg(meta.pkg);
    out.push({
      id: meta.id,
      label: meta.label,
      description: meta.description,
      installed: !!details[0]?.path,
      installable: true,
      installing: state.installing,
      error: state.error,
      log: state.log,
      details,
    });
  }

  return out;
}

// ---- install: download a tarball, extract via system tar ----

async function downloadFile(id: RuntimeId, url: string, target: string): Promise<void> {
  appendInstallLog(id, `Téléchargement de ${url}`);
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} sur ${url}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, buf);
  appendInstallLog(id, `Téléchargé ${(buf.length / 1024 / 1024).toFixed(1)} Mo dans ${target}`);
}

async function extractTarGz(id: RuntimeId, archive: string, dest: string, stripComponents = 1): Promise<void> {
  appendInstallLog(id, `Extraction dans ${dest}`);
  await mkdir(dest, { recursive: true });
  const proc = spawn({
    cmd: ["tar", "-xzf", archive, "-C", dest, `--strip-components=${stripComponents}`],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, errOut, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`tar a échoué (code ${code}): ${errOut.trim()}`);
}

async function installNode(): Promise<void> {
  const id: RuntimeId = "node";
  const plat = detectRuntimePlatform();
  if (!plat) throw new Error(`Plateforme non supportée: ${process.platform}/${process.arch}`);

  const arch = plat.arch === "arm64" ? "arm64" : "x64";
  const suffix = plat.platform === "darwin" ? `darwin-${arch}` : `linux-${arch}`;
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${suffix}.tar.gz`;
  const tmp = join(RUNTIMES_DIR, `node-${NODE_VERSION}.tar.gz`);

  await mkdir(RUNTIMES_DIR, { recursive: true });
  await downloadFile(id, url, tmp);
  await rm(N2N_NODE_DIR, { recursive: true, force: true });
  await extractTarGz(id, tmp, N2N_NODE_DIR, 1);
  try { await unlink(tmp); } catch {}

  invalidateExtendedPath();
  appendInstallLog(id, `Node.js v${NODE_VERSION} installé dans ${N2N_NODE_DIR}`);
}

async function installPython(): Promise<void> {
  const id: RuntimeId = "python";
  const plat = detectRuntimePlatform();
  if (!plat) throw new Error(`Plateforme non supportée: ${process.platform}/${process.arch}`);

  // python-build-standalone naming: cpython-<py>+<release>-<triplet>-install_only.tar.gz
  let triplet: string;
  if (plat.platform === "linux") {
    triplet = plat.arch === "arm64"
      ? "aarch64-unknown-linux-gnu"
      : "x86_64-unknown-linux-gnu";
  } else {
    triplet = plat.arch === "arm64"
      ? "aarch64-apple-darwin"
      : "x86_64-apple-darwin";
  }
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${PY_RELEASE}/cpython-${PY_VERSION}+${PY_RELEASE}-${triplet}-install_only.tar.gz`;
  const tmp = join(RUNTIMES_DIR, `python-${PY_VERSION}.tar.gz`);

  await mkdir(RUNTIMES_DIR, { recursive: true });
  await downloadFile(id, url, tmp);
  await rm(N2N_PY_DIR, { recursive: true, force: true });
  // The archive contains a top-level "python/" folder; strip it so bin/ ends
  // up directly under N2N_PY_DIR.
  await extractTarGz(id, tmp, N2N_PY_DIR, 1);
  try { await unlink(tmp); } catch {}

  invalidateExtendedPath();
  appendInstallLog(id, `Python ${PY_VERSION} installé dans ${N2N_PY_DIR}`);
}

async function installNpmPkg(id: string): Promise<void> {
  const meta = KNOWN_NPM_PKGS.find((p) => p.id === id);
  if (!meta) throw new Error(`Package npm inconnu: ${id}`);
  const path = await getExtendedPath();
  const npm = await findInPath("npm", path);
  if (!npm) {
    throw new Error("npm introuvable. Installe d'abord Node.js dans cet onglet.");
  }
  await mkdir(N2N_NPM_DIR, { recursive: true });
  // Bootstrap a tiny package.json so npm doesn't moan about the absent project.
  const pj = join(N2N_NPM_DIR, "package.json");
  if (!(await exists(pj))) {
    await writeFile(pj, JSON.stringify(
      { name: "n2n-runtime-deps", version: "1.0.0", private: true },
      null,
      2,
    ));
  }
  appendInstallLog(id, `$ npm install ${meta.pkg}`);
  const proc = spawn({
    cmd: [npm, "install", meta.pkg, "--no-audit", "--no-fund", "--loglevel=warn"],
    cwd: N2N_NPM_DIR,
    env: { ...process.env, PATH: path } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const drain = async (s: ReadableStream<Uint8Array>) => {
    const reader = s.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.trim()) appendInstallLog(id, text.replace(/\n$/, ""));
      }
    } catch {}
  };
  void drain(proc.stdout);
  void drain(proc.stderr);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`npm install ${meta.pkg} a échoué (code ${code}). Vois le log ci-dessus.`);
  }
  appendInstallLog(id, `Installation OK : ${join(N2N_NPM_DIR, "node_modules", meta.pkg)}`);
}

// Optional callback registered by the MCP module: after a *core* runtime
// install finishes, kick MCP servers so any of them stuck on "spawn npx
// not found" finally start. We use a setter to avoid importing mcp.ts here
// (which would create a cycle).
let postCoreInstallHook: (() => void) | null = null;
export function setPostInstallHook(hook: () => void): void {
  postCoreInstallHook = hook;
}

export async function startRuntimeInstall(id: RuntimeId): Promise<void> {
  const state = getInstallState(id);
  if (state.installing) return;
  state.installing = true;
  state.error = null;
  state.log = "";
  broadcast("runtimesChanged");

  const isNpm = id.startsWith("npm-");
  try {
    appendInstallLog(id, `Installation de ${id} démarrée`);
    if (isNpm) await installNpmPkg(id);
    else if (id === "node") await installNode();
    else if (id === "python") await installPython();
    else throw new Error(`Runtime inconnu: ${id}`);
    appendInstallLog(id, `Installation terminée`);
  } catch (e: any) {
    state.error = e?.message || String(e);
    appendInstallLog(id, `Erreur: ${state.error}`);
  } finally {
    state.installing = false;
    invalidateExtendedPath();
    broadcast("runtimesChanged");
    // Restart MCP servers when a *core* runtime install succeeded — npm
    // packages are loaded lazily by sql-query, no MCP restart needed.
    if (!state.error && !isNpm && postCoreInstallHook) {
      try { postCoreInstallHook(); } catch {}
    }
  }
}
