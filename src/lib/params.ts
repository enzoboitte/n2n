import type { ParamShowIf } from "./types";

/**
 * Whether a param's `showIf` clause matches the current draft. Used by both
 * the full ConfigModal and the inline param popup under the canvas node so
 * conditional fields hide consistently in either UI.
 */
export function paramVisible(
  showIf: ParamShowIf | undefined,
  draft: Record<string, unknown>,
): boolean {
  if (!showIf) return true;
  for (const [key, expected] of Object.entries(showIf)) {
    const actual = String(draft[key] ?? "");
    const ok = Array.isArray(expected)
      ? expected.some((e) => String(e) === actual)
      : String(expected) === actual;
    if (!ok) return false;
  }
  return true;
}
