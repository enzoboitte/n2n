"use client";

import { useEffect, useRef, useState } from "react";
import { useEnvVars } from "@/contexts/EnvContext";

type Props = {
  /** Letters available on this node, in incoming-edge order (a, b, c…). */
  availableLetters?: string[];
  /** Per-letter preview shown next to the letter (eg. socket name or value). */
  letterHints?: Record<string, string>;
  /**
   * Called with the token to insert at cursor position. The wrapper handles
   * splice-into-textarea details — this just needs to return the token.
   */
  onInsert: (token: string) => void;
  /** Visual size — `compact` matches inline canvas popups. */
  compact?: boolean;
};

/**
 * Tiny `{x}` button that opens a popover listing every variable the user
 * can drop into the current input: incoming edge letters (a, b, c…) and
 * environment variables. Clicking an entry calls `onInsert("{name}")`.
 *
 * Lives in its own component so we can drop it next to any text/number/
 * string input without re-implementing the picker each time.
 */
export function VariablePicker({
  availableLetters = [],
  letterHints,
  onInsert,
  compact = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const env = useEnvVars();
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const envEntries = Object.keys(env).sort();
  const f = filter.trim().toLowerCase();
  const matches = (s: string) => !f || s.toLowerCase().includes(f);

  const visibleLetters = availableLetters.filter((l) => matches(l) || matches(letterHints?.[l] ?? ""));
  const visibleEnv = envEntries.filter((k) => matches(k) || matches(env[k] ?? ""));

  const insert = (token: string) => {
    onInsert(token);
    // Keep open for chained insertion; user closes via Esc / outside-click.
  };

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        title="Insérer une variable"
        className={`rounded border border-slate-200 bg-white px-1.5 ${
          compact ? "py-0 text-[10px]" : "py-0.5 text-[11px]"
        } font-mono text-slate-600 hover:border-indigo-400 hover:text-indigo-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-indigo-500`}
      >
        {"{x}"}
      </button>
      {open && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          className="absolute right-0 top-full z-50 mt-1 w-64 max-h-80 overflow-auto rounded-lg border border-slate-200 bg-white p-2 shadow-lg dark:border-slate-700 dark:bg-slate-800"
        >
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filtrer…"
            className="mb-2 w-full rounded border border-slate-200 bg-white px-2 py-1 text-xs outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900"
            autoFocus
          />
          {visibleLetters.length > 0 && (
            <>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Arêtes entrantes
              </div>
              <div className="mb-2 flex flex-col gap-0.5">
                {visibleLetters.map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => insert(`{${l}}`)}
                    className="flex items-baseline justify-between gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-indigo-50 dark:hover:bg-indigo-900/30"
                  >
                    <span className="font-mono text-indigo-600 dark:text-indigo-400">{`{${l}}`}</span>
                    {letterHints?.[l] && (
                      <span className="truncate text-[10px] text-slate-500 dark:text-slate-400">
                        {letterHints[l]}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
          {visibleEnv.length > 0 && (
            <>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Variables d'environnement
              </div>
              <div className="flex flex-col gap-0.5">
                {visibleEnv.map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => insert(`{${k}}`)}
                    className="flex items-baseline justify-between gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-indigo-50 dark:hover:bg-indigo-900/30"
                  >
                    <span className="font-mono text-emerald-600 dark:text-emerald-400">{`{${k}}`}</span>
                    <span className="truncate text-[10px] text-slate-500 dark:text-slate-400">
                      {(env[k] ?? "").slice(0, 24) || "(vide)"}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
          {visibleLetters.length === 0 && visibleEnv.length === 0 && (
            <div className="px-1 py-2 text-center text-xs text-slate-400">
              Aucune variable disponible.
            </div>
          )}
          <div className="mt-2 border-t border-slate-100 pt-1.5 text-[10px] leading-tight text-slate-400 dark:border-slate-700 dark:text-slate-500">
            Aussi : <code className="font-mono">{`{a.foo}`}</code>{" "}
            <code className="font-mono">{`{a.0.bar}`}</code> pour fouiller un objet.
          </div>
        </div>
      )}
    </div>
  );
}
