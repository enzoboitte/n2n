// Date arithmetic for the `date-math` module. Pure runtime — no deps.
//
// Modes:
//   now        — emit current time (ignores input)
//   parse      — parse the input (ISO string, epoch ms, Date) and emit
//   add        — input + amount × unit
//   subtract   — input - amount × unit
//   format     — format the input with the `format` token
//   diff       — emit (input - other) in ms

import type { RunResult } from "./graph-types.ts";

const UNIT_TO_MS: Record<string, number> = {
  ms: 1,
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 7 * 86_400_000,
};

function coerceDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value;
  if (typeof value === "number") {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string") {
    // Bare integer string → treat as epoch ms
    if (/^\d+$/.test(value.trim())) {
      const d = new Date(parseInt(value, 10));
      return isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function applyOffset(date: Date, amount: number, unit: string, sign: 1 | -1): Date {
  const factor = UNIT_TO_MS[unit];
  if (factor !== undefined) {
    return new Date(date.getTime() + sign * amount * factor);
  }
  // months / years use Date setters so leap years and varying month
  // lengths are handled correctly.
  const out = new Date(date.getTime());
  if (unit === "months") out.setMonth(out.getMonth() + sign * amount);
  else if (unit === "years") out.setFullYear(out.getFullYear() + sign * amount);
  return out;
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, "0");
}

function formatDate(d: Date, fmt: string, useUtc: boolean): string {
  const year = useUtc ? d.getUTCFullYear() : d.getFullYear();
  const month = (useUtc ? d.getUTCMonth() : d.getMonth()) + 1;
  const day = useUtc ? d.getUTCDate() : d.getDate();
  const hour = useUtc ? d.getUTCHours() : d.getHours();
  const min = useUtc ? d.getUTCMinutes() : d.getMinutes();
  const sec = useUtc ? d.getUTCSeconds() : d.getSeconds();
  const ms = useUtc ? d.getUTCMilliseconds() : d.getMilliseconds();
  // Replace longest tokens first so YYYY isn't shadowed by YY.
  return fmt
    .replace(/YYYY/g, String(year))
    .replace(/YY/g, pad(year % 100, 2))
    .replace(/MM/g, pad(month, 2))
    .replace(/DD/g, pad(day, 2))
    .replace(/HH/g, pad(hour, 2))
    .replace(/mm/g, pad(min, 2))
    .replace(/SSS/g, pad(ms, 3))
    .replace(/ss/g, pad(sec, 2));
}

function partsOf(d: Date, useUtc: boolean): Record<string, unknown> {
  const start = useUtc
    ? Date.UTC(d.getUTCFullYear(), 0, 1)
    : new Date(d.getFullYear(), 0, 1).getTime();
  const doy = Math.floor((d.getTime() - start) / 86_400_000) + 1;
  return {
    y: useUtc ? d.getUTCFullYear() : d.getFullYear(),
    m: (useUtc ? d.getUTCMonth() : d.getMonth()) + 1,
    d: useUtc ? d.getUTCDate() : d.getDate(),
    h: useUtc ? d.getUTCHours() : d.getHours(),
    mi: useUtc ? d.getUTCMinutes() : d.getMinutes(),
    s: useUtc ? d.getUTCSeconds() : d.getSeconds(),
    ms: useUtc ? d.getUTCMilliseconds() : d.getMilliseconds(),
    dow: useUtc ? d.getUTCDay() : d.getDay(),
    doy,
  };
}

export function runDateMath(
  inputs: Record<string, unknown>,
  substituted: Record<string, unknown>,
): RunResult {
  const mode = String(substituted.mode || "now");
  const useUtc = String(substituted.tz || "local") === "utc";
  const fmt = String(substituted.format || "YYYY-MM-DD HH:mm:ss");

  // Base date resolution:
  //   - explicit input (string / number / Date)         → use it
  //   - else `parse` mode requires input                 → error
  //   - else default to "now" (so add/subtract/format with no wired
  //     input still does something sensible)
  let base: Date;
  const parsed = coerceDate(inputs.date ?? null);
  if (parsed) {
    base = parsed;
  } else if (mode === "parse") {
    return { ok: false, error: "date-math parse: date d'entrée invalide ou manquante" };
  } else {
    base = new Date();
  }

  let target = base;
  let diffMs: number | null = null;

  if (mode === "add" || mode === "subtract") {
    const amount = Number(substituted.amount ?? 0) || 0;
    const unit = String(substituted.unit || "days");
    target = applyOffset(base, amount, unit, mode === "add" ? 1 : -1);
  } else if (mode === "diff") {
    const other = coerceDate(substituted.other ?? null);
    if (!other) {
      return { ok: false, error: "date-math diff: paramètre `other` requis (ISO ou epoch ms)" };
    }
    diffMs = base.getTime() - other.getTime();
    target = base;
  }

  return {
    ok: true,
    outputs: {
      iso: target.toISOString(),
      epoch_ms: target.getTime(),
      formatted: formatDate(target, fmt, useUtc),
      parts: partsOf(target, useUtc),
      diff_ms: diffMs,
    },
  };
}
