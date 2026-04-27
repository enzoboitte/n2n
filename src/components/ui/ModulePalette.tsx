"use client";

import { useMemo, useState } from "react";
import type { ModuleManifest } from "@/lib/types";

type Props = {
  modules: ModuleManifest[];
  loading: boolean;
  error: string | null;
  onAdd: (module: ModuleManifest) => void;
  onOpenFolder: () => void;
  onOpenEnv: () => void;
  onOpenMcp: () => void;
};

export function ModulePalette({
  modules,
  loading,
  error,
  onAdd,
  onOpenFolder,
  onOpenEnv,
  onOpenMcp,
}: Props) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return modules;
    return modules.filter((m) => {
      const haystack = [m.id, m.name, m.description ?? ""]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [modules, query]);

  return (
    <aside className="absolute top-3 bottom-3 left-3 z-20 flex w-56 flex-col gap-2 overflow-hidden rounded-lg border border-slate-200 bg-white/95 p-2 shadow-lg backdrop-blur dark:border-slate-700 dark:bg-slate-900/95">
      <div className="flex shrink-0 items-center justify-between px-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Modules
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={onOpenMcp}
            title="Serveurs MCP"
            className="rounded px-1 py-0.5 text-[11px] text-slate-500 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            MCP
          </button>
          <button
            onClick={onOpenEnv}
            title="Variables d'environnement"
            className="rounded px-1 py-0.5 font-mono text-[11px] text-slate-500 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {"{ENV}"}
          </button>
          <button
            onClick={onOpenFolder}
            title="Ouvrir ~/.n2n/modules"
            className="rounded px-1 py-0.5 text-[11px] text-slate-500 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            ~/.n2n
          </button>
        </div>
      </div>

      <div className="relative shrink-0">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Rechercher…"
          className="w-full rounded-md border border-slate-200 bg-white py-1.5 pr-7 pl-7 text-xs outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 dark:border-slate-700 dark:bg-slate-950"
        />
        <svg
          className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-slate-400 dark:text-slate-500"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            title="Effacer"
            className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {loading && (
        <div className="shrink-0 px-2 py-1 text-xs text-slate-500 dark:text-slate-400">
          Chargement…
        </div>
      )}

      {error && (
        <div className="shrink-0 rounded bg-rose-50 px-2 py-1.5 text-[11px] text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </div>
      )}

      {!loading && !error && modules.length === 0 && (
        <div className="shrink-0 px-2 py-1 text-xs text-slate-500 dark:text-slate-400">
          Aucun module trouvé.
        </div>
      )}

      <ul className="-mx-1 flex flex-1 flex-col gap-0.5 overflow-y-auto px-1">
        {filtered.map((m) => (
          <li key={m.id}>
            <button
              onClick={() => onAdd(m)}
              className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <span
                className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: m.color ?? "#94a3b8" }}
              />
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="truncate font-medium">{m.name}</span>
                {m.description && (
                  <span className="line-clamp-2 text-[11px] text-slate-500 dark:text-slate-400">
                    {m.description}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
        {!loading && !error && filtered.length === 0 && modules.length > 0 && (
          <li className="px-2 py-3 text-center text-[11px] text-slate-400 dark:text-slate-500">
            Aucun module ne correspond à « {query} »
          </li>
        )}
      </ul>
    </aside>
  );
}
