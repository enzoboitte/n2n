// Replace `{name}` (and `{name.path.0.foo}`) placeholders inside strings
// with values from a merged namespace ({...env, ...letters}).
// Letters override env on conflict.

const VAR_RE = /\{([a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z0-9_$]+)*)\}/g;

function stringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function getPath(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (Number.isFinite(idx)) {
        cur = cur[idx];
        continue;
      }
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

export function substituteString(
  s: string,
  vars: Record<string, unknown>,
): string {
  return s.replace(VAR_RE, (match, expr: string) => {
    const parts = expr.split(".");
    const root = parts[0];
    if (!(root in vars)) return match;
    const value =
      parts.length === 1 ? vars[root] : getPath(vars[root], parts.slice(1));
    if (value === undefined || value === null) return match;
    return stringify(value);
  });
}

export function substituteDeep(
  value: unknown,
  vars: Record<string, unknown>,
): unknown {
  if (typeof value === "string") return substituteString(value, vars);
  if (Array.isArray(value)) {
    return value.map((v) => substituteDeep(v, vars));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteDeep(v, vars);
    }
    return out;
  }
  return value;
}
