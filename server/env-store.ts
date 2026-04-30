// Persistent global env vars (used by all node templates as `{NOM}`).
// JSON dict at ~/.n2n/env.json. Mutations are pushed to clients via the
// `envChanged` SSE event from the calling code (we don't broadcast here
// to keep this file dependency-free).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ENV_PATH, N2N_DIR } from "./config.ts";

export async function loadEnv(): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(ENV_PATH, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}
  return {};
}

export async function saveEnv(env: Record<string, string>): Promise<void> {
  await mkdir(N2N_DIR, { recursive: true });
  await writeFile(ENV_PATH, JSON.stringify(env || {}, null, 2));
}
