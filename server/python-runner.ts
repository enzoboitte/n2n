// Spawn a user module's Python entry point and round-trip JSON through
// stdin/stdout. The contract for module.py is defined by the bundled
// modules: read one line of JSON `{inputs, params, letters, env}` from
// stdin, write the result dict to stdout. Errors → stderr + non-zero exit.
//
// Uses the runtime path-finder so a Python install in NVM/pyenv/Homebrew
// is picked up even when the parent inherited a minimal PATH.

import { spawn } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MODULES_DIR, PYTHON } from "./config.ts";
import { findInPath, getExtendedPath } from "./runtimes.ts";

export function runPythonModule(args: {
  id: string;
  inputs?: any;
  params?: any;
  letters?: any;
  env?: any;
}): Promise<{ ok: boolean; outputs?: any; error?: string }> {
  return new Promise(async (resolve) => {
    const dir = join(MODULES_DIR, args.id);
    let manifest: any;
    try {
      manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
    } catch (err: any) {
      return resolve({ ok: false, error: `manifest: ${err.message}` });
    }
    const entry = join(dir, manifest.entry || "module.py");
    const path = await getExtendedPath();
    const resolvedPython = (await findInPath(PYTHON, path)) || PYTHON;
    let child;
    try {
      child = spawn({
        cmd: [resolvedPython, entry],
        cwd: dir,
        env: { ...process.env, PATH: path } as Record<string, string>,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err: any) {
      return resolve({
        ok: false,
        error: `spawn ${PYTHON}: ${err?.message || err}. Installe Python via l'onglet « Environnements ».`,
      });
    }

    child.stdin.write(JSON.stringify({
      inputs: args.inputs || {},
      params: args.params || {},
      letters: args.letters || {},
      env: args.env || {},
    }));
    child.stdin.end();

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) {
      return resolve({ ok: false, error: stderr.trim() || `exit ${exitCode}` });
    }
    try {
      const outputs = stdout.trim() ? JSON.parse(stdout) : {};
      resolve({ ok: true, outputs });
    } catch (err: any) {
      resolve({ ok: false, error: `JSON output invalide: ${err.message}\n${stdout}` });
    }
  });
}
