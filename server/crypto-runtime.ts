// Runtime dispatch for the no-code primitive modules: hash, random,
// encode, validate. Kept in their own file so graph-runtime stays
// readable; each `runX` returns a RunResult that the dispatch wires
// directly into the node's `result.outputs`.

import { createHash, createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { RunResult } from "./graph-types.ts";
import { loadOptionalPkg } from "./sql-runtime.ts";

// ---- hash ----

const HASH_ALGORITHMS = new Set([
  "md5", "sha1", "sha256", "sha512", "hmac-sha256", "hmac-sha512",
]);

function toBuffer(data: unknown): Buffer {
  if (data === null || data === undefined) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === "string") return Buffer.from(data, "utf8");
  return Buffer.from(JSON.stringify(data), "utf8");
}

export function runHash(
  inputs: Record<string, unknown>,
  substituted: Record<string, unknown>,
): RunResult {
  const algo = String(substituted.algorithm || "sha256").toLowerCase();
  if (!HASH_ALGORITHMS.has(algo)) {
    return { ok: false, error: `hash: algorithme inconnu "${algo}"` };
  }
  const data = toBuffer(inputs.data ?? substituted.data ?? "");
  let digest: Buffer;
  if (algo.startsWith("hmac-")) {
    const inner = algo.slice(5); // "sha256" / "sha512"
    const secret = String(substituted.secret || "");
    if (!secret) return { ok: false, error: `hash: HMAC requiert un secret` };
    digest = createHmac(inner, secret).update(data).digest();
  } else {
    digest = createHash(algo).update(data).digest();
  }
  return {
    ok: true,
    outputs: { hex: digest.toString("hex"), base64: digest.toString("base64") },
  };
}

// ---- random ----

function parseChoices(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return arr.map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
    } catch { /* fall through to line split */ }
  }
  return trimmed.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

export function runRandom(
  substituted: Record<string, unknown>,
): RunResult {
  const mode = String(substituted.mode || "uuid");
  switch (mode) {
    case "uuid":
      return { ok: true, outputs: { value: randomUUID() } };
    case "int": {
      const min = Math.floor(Number(substituted.min ?? 0));
      const max = Math.floor(Number(substituted.max ?? 100));
      if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
        return { ok: false, error: "random int: min/max invalides" };
      }
      // randomInt is [min, max) so add 1 to make max inclusive.
      return { ok: true, outputs: { value: randomInt(min, max + 1) } };
    }
    case "float": {
      const min = Number(substituted.min ?? 0);
      const max = Number(substituted.max ?? 1);
      if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
        return { ok: false, error: "random float: min/max invalides" };
      }
      // Crypto-grade float in [min, max) using 6 random bytes for ~48 bits
      // of precision — plenty for typical no-code use without pulling in
      // a full crypto-random-float library.
      const buf = randomBytes(6);
      const u = (buf.readUIntBE(0, 6)) / 0x1000000000000;
      return { ok: true, outputs: { value: min + (max - min) * u } };
    }
    case "string": {
      const len = Math.max(1, Math.min(256, parseInt(String(substituted.length ?? 16), 10) || 16));
      const bytes = Math.ceil(len / 2);
      const hex = randomBytes(bytes).toString("hex").slice(0, len);
      return { ok: true, outputs: { value: hex } };
    }
    case "choice": {
      const choices = parseChoices(String(substituted.choices ?? ""));
      if (choices.length === 0) {
        return { ok: false, error: "random choice: liste vide" };
      }
      const idx = randomInt(0, choices.length);
      return { ok: true, outputs: { value: choices[idx] } };
    }
    default:
      return { ok: false, error: `random: mode inconnu "${mode}"` };
  }
}

// ---- encode ----

export function runEncode(
  inputs: Record<string, unknown>,
  substituted: Record<string, unknown>,
): RunResult {
  const format = String(substituted.format || "base64");
  const direction = String(substituted.direction || "encode");
  const raw = inputs.data ?? substituted.data ?? "";
  const dataStr = typeof raw === "string" ? raw : JSON.stringify(raw);

  try {
    if (direction === "encode") {
      let value: string;
      switch (format) {
        case "base64":
          value = Buffer.from(dataStr, "utf8").toString("base64"); break;
        case "base64url":
          value = Buffer.from(dataStr, "utf8").toString("base64url"); break;
        case "hex":
          value = Buffer.from(dataStr, "utf8").toString("hex"); break;
        case "url":
          value = encodeURIComponent(dataStr); break;
        default:
          return { ok: false, error: `encode: format inconnu "${format}"` };
      }
      return { ok: true, outputs: { value } };
    }
    if (direction === "decode") {
      let value: string;
      switch (format) {
        case "base64":
          value = Buffer.from(dataStr, "base64").toString("utf8"); break;
        case "base64url":
          value = Buffer.from(dataStr, "base64url").toString("utf8"); break;
        case "hex":
          value = Buffer.from(dataStr, "hex").toString("utf8"); break;
        case "url":
          value = decodeURIComponent(dataStr); break;
        default:
          return { ok: false, error: `encode: format inconnu "${format}"` };
      }
      return { ok: true, outputs: { value } };
    }
    return { ok: false, error: `encode: direction inconnue "${direction}"` };
  } catch (e: any) {
    return { ok: false, error: `encode: ${e?.message || e}` };
  }
}

// ---- validate ----

let ajvInstance: any = null;
async function getAjv(): Promise<any> {
  if (ajvInstance) return ajvInstance;
  // loadOptionalPkg returns `null` on failure (it doesn't throw), so we
  // fall through manually. Try the modern 2020 entrypoint first, then
  // the default ajv export — covers ajv 6/7/8 and ajv 2020.
  const mod: any =
    (await loadOptionalPkg("ajv/dist/2020.js")) ??
    (await loadOptionalPkg("ajv/dist/2020")) ??
    (await loadOptionalPkg("ajv"));
  if (!mod) {
    throw new Error(
      "ajv non installé. Ouvre Environnements > installe « ajv (JSON Schema) ».",
    );
  }
  // ESM/CJS interop. Dynamic import of a CJS module yields
  // `{ default: TheCtor }`; ESM yields the namespace.
  const AjvCtor =
    typeof mod === "function"
      ? mod
      : (mod.default ?? mod.Ajv2020 ?? mod.Ajv ?? mod);
  if (typeof AjvCtor !== "function") {
    throw new Error(
      "ajv : impossible de trouver le constructeur (versions 6/8/2020 supportées).",
    );
  }
  ajvInstance = new AjvCtor({ allErrors: true, strict: false });
  return ajvInstance;
}

export async function runValidate(
  inputs: Record<string, unknown>,
  substituted: Record<string, unknown>,
): Promise<RunResult> {
  const data = inputs.data ?? null;
  const rawSchema = substituted.schema;
  let schema: unknown;
  if (typeof rawSchema === "string") {
    try { schema = JSON.parse(rawSchema); }
    catch (e: any) {
      return { ok: false, error: `validate: schema JSON invalide (${e?.message || e})` };
    }
  } else if (rawSchema && typeof rawSchema === "object") {
    schema = rawSchema;
  } else {
    return { ok: false, error: "validate: schema requis" };
  }

  let ajv: any;
  try { ajv = await getAjv(); }
  catch (e: any) { return { ok: false, error: e?.message || String(e) }; }

  let validateFn: any;
  try { validateFn = ajv.compile(schema as any); }
  catch (e: any) {
    return { ok: false, error: `validate: schema invalide (${e?.message || e})` };
  }
  const ok = validateFn(data);
  const errors = (validateFn.errors as any[] | null) ?? [];
  return {
    ok: true,
    outputs: {
      valid: ok ? data : null,
      invalid: ok ? null : data,
      errors: errors.map((e) => ({
        path: e.instancePath || "/",
        message: e.message,
        keyword: e.keyword,
        params: e.params,
      })),
    },
  };
}
