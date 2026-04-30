// In-memory async barrier registry. Used by the `barrier` module to
// accumulate values across multiple trigger fires that share a
// correlation key. When the count reaches `expected`, the next call
// emits the full list on the `complete` socket; before that, it emits
// `null` for `complete` and a non-null `partial` snapshot.
//
// Each per-key state has a TTL: the last activity refreshes it; if
// nothing arrives within the TTL, the entry is purged. This prevents
// half-finished groups from leaking forever.
//
// `pendingCids` lets a downstream node (e.g. a custom responder) know
// every HTTP connection currently waiting for this group to complete,
// so the user can broadcast a final response to all of them.

import type { RunResult, RunCtx } from "./graph-types.ts";

type BarrierState = {
  values: unknown[];
  pendingCids: string[];
  expected: number;
  timer: ReturnType<typeof setTimeout>;
  lastActivity: number;
};

const barriers = new Map<string, BarrierState>();

function refreshTimer(key: string, state: BarrierState, ttlMs: number): void {
  if (state.timer) clearTimeout(state.timer);
  state.lastActivity = Date.now();
  state.timer = setTimeout(() => {
    if (barriers.get(key) === state) barriers.delete(key);
  }, ttlMs);
}

export function runBarrier(
  inputs: Record<string, unknown>,
  letters: Record<string, unknown>,
  substituted: Record<string, unknown>,
  ctx: RunCtx,
): RunResult {
  const key = String(substituted.key ?? "default").trim() || "default";
  const expectedRaw = parseInt(String(substituted.expected ?? "10"), 10);
  const expected = Number.isFinite(expectedRaw) && expectedRaw > 0 ? expectedRaw : 10;
  const ttlMs = (() => {
    const n = parseInt(String(substituted.ttl_ms ?? "60000"), 10);
    return Number.isFinite(n) && n > 0 ? n : 60_000;
  })();

  const value = inputs.value !== undefined && inputs.value !== null
    ? inputs.value
    : (letters.a ?? null);

  let state = barriers.get(key);
  if (!state) {
    state = {
      values: [],
      pendingCids: [],
      expected,
      timer: setTimeout(() => undefined, 0),
      lastActivity: Date.now(),
    };
    barriers.set(key, state);
  }
  // Allow `expected` to grow with the latest run if user changed it; never
  // shrink below current count (would lose values).
  state.expected = Math.max(state.expected, expected);
  state.values.push(value);
  if (ctx.triggerConnectionId && !state.pendingCids.includes(ctx.triggerConnectionId)) {
    state.pendingCids.push(ctx.triggerConnectionId);
  }
  refreshTimer(key, state, ttlMs);

  const count = state.values.length;
  if (count >= state.expected) {
    const complete = [...state.values];
    const pendingCids = [...state.pendingCids];
    clearTimeout(state.timer);
    barriers.delete(key);
    return {
      ok: true,
      outputs: {
        complete,
        progress: count,
        partial: complete,
        pendingCids,
      },
    };
  }
  return {
    ok: true,
    outputs: {
      complete: null,
      progress: count,
      partial: [...state.values],
      pendingCids: [...state.pendingCids],
    },
  };
}

/** Diagnostics — list active barriers (no values, just shapes). */
export function listBarriers(): Array<{ key: string; count: number; expected: number; lastActivity: number }> {
  return [...barriers.entries()].map(([key, s]) => ({
    key,
    count: s.values.length,
    expected: s.expected,
    lastActivity: s.lastActivity,
  }));
}

export function clearAllBarriers(): void {
  for (const s of barriers.values()) clearTimeout(s.timer);
  barriers.clear();
}
