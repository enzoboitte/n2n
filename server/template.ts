// Param/string templating shared by every node that supports placeholders
// like `{a}`, `{a.0.subject}` or `{NOM_VAR}` — substituteString and
// substituteDeep walk a value (string / array / object) and replace any
// `{path}` token by looking the path up in `vars`.
//
// Also exports `indexToLetter`, `parseHumanInterval`, `stringifyValue` —
// generic helpers used in lockstep with the substitution engine.

export function indexToLetter(i: number): string {
  let n = i;
  let s = "";
  while (true) {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return s;
}

export function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export const VAR_RE = /\{([a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z0-9_$]+)*)\}/g;

export function getPath(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (Number.isFinite(idx)) { cur = cur[idx]; continue; }
      return undefined;
    }
    if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[seg];
      continue;
    }
    return undefined;
  }
  return cur;
}

export function substituteString(s: string, vars: Record<string, unknown>): string {
  return s.replace(VAR_RE, (match, expr: string) => {
    const parts = expr.split(".");
    const root = parts[0];
    if (!(root in vars)) return match;
    const value =
      parts.length === 1 ? vars[root] : getPath(vars[root], parts.slice(1));
    if (value === undefined || value === null) return match;
    return stringifyValue(value);
  });
}

export function substituteDeep(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === "string") return substituteString(value, vars);
  if (Array.isArray(value)) return value.map((v) => substituteDeep(v, vars));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteDeep(v, vars);
    }
    return out;
  }
  return value;
}

export function parseHumanInterval(s: string): number {
  const m = String(s || "").match(/^\s*(\d+)\s*(ms|s|m|h|d)?\s*$/i);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || "s").toLowerCase();
  const mult: Record<string, number> = {
    ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000,
  };
  return n * (mult[unit] ?? 1000);
}
