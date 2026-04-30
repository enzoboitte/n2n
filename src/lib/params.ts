import type { ParamShowIf, ParamShowIfNumeric } from "./types";

/**
 * Whether a param's `showIf` clause matches the current draft. Used by both
 * the full ConfigModal and the inline param popup under the canvas node so
 * conditional fields hide consistently in either UI.
 *
 * Supported clause shapes:
 *   - `string`   → exact string equality
 *   - `string[]` → any-of equality
 *   - `{ gte, lte, gt, lt, eq, ne }` → numeric comparison (the draft
 *     value is parsed as float; non-numeric values fail the check)
 */
export function paramVisible(
  showIf: ParamShowIf | undefined,
  draft: Record<string, unknown>,
): boolean {
  if (!showIf) return true;
  for (const [key, expected] of Object.entries(showIf)) {
    const raw = draft[key];
    if (Array.isArray(expected)) {
      const actual = String(raw ?? "");
      if (!expected.some((e) => String(e) === actual)) return false;
    } else if (typeof expected === "string") {
      if (String(raw ?? "") !== expected) return false;
    } else if (expected && typeof expected === "object") {
      if (!matchesNumeric(raw, expected)) return false;
    }
  }
  return true;
}

function matchesNumeric(raw: unknown, spec: ParamShowIfNumeric): boolean {
  const n = parseFloat(String(raw ?? ""));
  if (!Number.isFinite(n)) return false;
  if (spec.gt !== undefined && !(n > spec.gt)) return false;
  if (spec.gte !== undefined && !(n >= spec.gte)) return false;
  if (spec.lt !== undefined && !(n < spec.lt)) return false;
  if (spec.lte !== undefined && !(n <= spec.lte)) return false;
  if (spec.eq !== undefined && !(n === spec.eq)) return false;
  if (spec.ne !== undefined && !(n !== spec.ne)) return false;
  return true;
}
