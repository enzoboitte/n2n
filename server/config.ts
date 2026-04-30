// Paths and environment configuration. All filesystem locations the n2n
// server reads from / writes to are centralised here so a single import
// gives any module the information it needs about where data lives.

import { join } from "node:path";
import { homedir } from "node:os";

export const N2N_DIR = join(homedir(), ".n2n");
export const MODULES_DIR = join(N2N_DIR, "modules");
export const ENV_PATH = join(N2N_DIR, "env.json");
export const PROJECTS_DIR = join(N2N_DIR, "projects");
export const STATE_PATH = join(N2N_DIR, "state.json");
export const HISTORY_PATH = join(N2N_DIR, "history.jsonl");
export const HISTORY_MAX_LINES = 5000;
export const MCP_SERVERS_PATH = join(N2N_DIR, "mcp-servers.json");
export const RUNTIMES_DIR = join(N2N_DIR, "runtimes");
export const DATA_DIR = join(N2N_DIR, "data");
export const BUNDLED_MODULES_DIR = join(import.meta.dir, "..", "assets", "modules");

// Where we install npm driver packages (mysql2, oracledb, mongodb, …)
// invoked dynamically by sql-query. Kept separate from the user's global
// node_modules so n2n can manage it via the Environnements panel.
export const N2N_NPM_DIR = join(N2N_DIR, "npm");

// Self-managed runtime install dirs (Node, Python).
export const N2N_NODE_DIR = join(RUNTIMES_DIR, "node");
export const N2N_PY_DIR = join(RUNTIMES_DIR, "python");

export const PYTHON = process.env.N2N_PYTHON || "python3";
export const LLAMA_URL = process.env.N2N_LLAMA_URL || "http://localhost:8080/v1/chat/completions";
export const HOST = process.env.N2N_HOST || "0.0.0.0";
export const API_PORT = parseInt(process.env.N2N_PORT || "9999", 10);

// If set, webhooks listen on this dedicated port; otherwise webhooks share API_PORT.
const WEBHOOK_PORT_RAW = process.env.N2N_WEBHOOK_PORT;
export const WEBHOOK_PORT = WEBHOOK_PORT_RAW ? parseInt(WEBHOOK_PORT_RAW, 10) : null;
export const ALLOWED_ORIGIN = process.env.N2N_CORS_ORIGIN || "*";

// Optional bearer token. When set, every /api/* call must present
// `Authorization: Bearer <token>` (or `?token=` for SSE/EventSource which
// can't set headers). Webhooks ignore this — they have their own per-route
// secret. /api/health and /api/info always stay reachable so onboarding
// clients can probe the server before authenticating.
export const API_TOKEN = (process.env.N2N_API_TOKEN || "").trim();

// Bundled-then-removed module ids — clean these up at startup so an old
// install upgrading to a newer n2n doesn't surface stale modules.
export const DEPRECATED_MODULES = [
  "bool-source", "bool-and", "bool-or", "bool-not", "bool-xor",
  "branch", "branch-length", "branch-contains", "branch-equals", "code",
];

// Versions for the self-managed runtime installer.
export const NODE_VERSION = "20.18.1";
export const PY_VERSION = "3.13.1";
export const PY_RELEASE = "20250115";
