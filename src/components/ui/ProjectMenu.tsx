"use client";

import { useEffect, useRef, useState } from "react";
import type { ProjectMeta } from "@/lib/n2n";

type Props = {
  projects: ProjectMeta[];
  activeId: string | null;
  onSwitch: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, currentName: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onImport: () => void;
  onExport: (id: string) => void;
};

export function ProjectMenu({
  projects,
  activeId,
  onSwitch,
  onCreate,
  onRename,
  onDelete,
  onDuplicate,
  onImport,
  onExport,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onAny = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onAny);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onAny);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const active = projects.find((p) => p.id === activeId);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 max-w-[180px] items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
      >
        <span className="truncate">{active?.name ?? "—"}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 text-slate-400"
          aria-hidden
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-9 z-40 min-w-[240px] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
          <div className="max-h-64 overflow-y-auto py-1">
            {projects.length === 0 && (
              <div className="px-3 py-1.5 text-[11px] text-slate-400 italic">
                Aucun projet
              </div>
            )}
            {projects.map((p) => {
              const isActive = p.id === activeId;
              return (
                <button
                  key={p.id}
                  onClick={() => {
                    onSwitch(p.id);
                    setOpen(false);
                  }}
                  className={[
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800",
                    isActive ? "font-medium text-indigo-600 dark:text-indigo-400" : "",
                  ].join(" ")}
                >
                  <span className="w-3 shrink-0 text-center text-[10px]">
                    {isActive ? "✓" : ""}
                  </span>
                  <span className="truncate">{p.name}</span>
                </button>
              );
            })}
          </div>
          <hr className="border-slate-200 dark:border-slate-700" />
          <div className="py-1">
            <MenuItem
              onClick={() => {
                onCreate();
                setOpen(false);
              }}
            >
              + Nouveau projet
            </MenuItem>
            <MenuItem
              onClick={() => {
                onImport();
                setOpen(false);
              }}
            >
              ↑ Importer JSON…
            </MenuItem>
            {active && (
              <>
                <hr className="my-1 border-slate-200 dark:border-slate-700" />
                <MenuItem
                  onClick={() => {
                    onExport(active.id);
                    setOpen(false);
                  }}
                >
                  ↓ Exporter…
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    onDuplicate(active.id);
                    setOpen(false);
                  }}
                >
                  ⎘ Dupliquer
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    onRename(active.id, active.name);
                    setOpen(false);
                  }}
                >
                  ✎ Renommer
                </MenuItem>
                <MenuItem
                  danger
                  onClick={() => {
                    onDelete(active.id);
                    setOpen(false);
                  }}
                >
                  ✕ Supprimer
                </MenuItem>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        "block w-full px-3 py-1.5 text-left text-sm transition",
        danger
          ? "text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
          : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
