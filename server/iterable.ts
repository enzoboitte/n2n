/**
 * Normalize any value into a list of items so `for-each` works on more than
 * just arrays. Strategy by `iter`:
 *
 *   - "auto"     → array as-is, dict → entries, string → lines, number → range,
 *                  other → [value]
 *   - "list"     → array as-is, anything else → [value] (force "list of one")
 *   - "entries"  → dict / array of [k,v] pairs / array → [{key,value}, …]
 *   - "keys"     → dict → keys; array → indices
 *   - "values"   → dict → values; array → as-is
 *   - "lines"    → string → split(/\r?\n/); array → as-is
 *   - "chars"    → string → chars; array → as-is
 *   - "range"    → number → 0..n-1; string-number → same; array → indices
 *
 * `null` / `undefined` → [].
 */
export function normalizeIterable(value: unknown, iter: string): unknown[] {
  if (value === null || value === undefined) return [];
  if (iter === "list") {
    return Array.isArray(value) ? value : [value];
  }
  if (Array.isArray(value)) {
    if (iter === "keys") return value.map((_, i) => i);
    if (iter === "entries") return value.map((v, i) => ({ key: i, value: v }));
    return value;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const m = iter === "auto" ? "entries" : iter;
    if (m === "keys") return Object.keys(obj);
    if (m === "values") return Object.values(obj);
    return Object.entries(obj).map(([key, val]) => ({ key, value: val }));
  }
  if (typeof value === "string") {
    const m = iter === "auto" ? "lines" : iter;
    if (m === "chars") return Array.from(value);
    if (m === "range") {
      const n = Number(value);
      if (Number.isFinite(n)) {
        const c = Math.max(0, Math.floor(n));
        return Array.from({ length: c }, (_, i) => i);
      }
      return [];
    }
    return value.split(/\r?\n/);
  }
  if (typeof value === "number") {
    const m = iter === "auto" ? "range" : iter;
    if (m === "range") {
      const c = Math.max(0, Math.floor(value));
      return Array.from({ length: c }, (_, i) => i);
    }
    return [value];
  }
  return [value];
}
