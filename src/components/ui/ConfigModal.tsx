"use client";

import { useEffect, useState } from "react";
import type { ModuleManifest } from "@/lib/types";
import { paramVisible } from "@/lib/params";
import { ParamField } from "./ParamField";

type Props = {
  module: ModuleManifest;
  initialParams: Record<string, unknown>;
  /** Letters bound to incoming edges of the configured node, in order. */
  availableLetters?: string[];
  onSave: (params: Record<string, unknown>) => void;
  onClose: () => void;
};

export function ConfigModal({
  module,
  initialParams,
  availableLetters,
  onSave,
  onClose,
}: Props) {
  const [draft, setDraft] = useState(initialParams);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const update = (key: string, value: unknown) =>
    setDraft((d) => ({ ...d, [key]: value }));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header
          className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-700"
          style={{
            background: `linear-gradient(90deg, ${module.color ?? "#6366f1"}11, transparent)`,
          }}
        >
          <div className="flex items-center gap-3">
            <span
              className="h-3 w-3 rounded-full"
              style={{ background: module.color ?? "#94a3b8" }}
            />
            <div className="flex flex-col leading-tight">
              <span className="text-base font-semibold">{module.name}</span>
              {module.description && (
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {module.description}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            title="Fermer"
            className="flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            ×
          </button>
        </header>

        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto px-5 py-4">
          {module.params.length === 0 && (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Aucun paramètre à configurer.
            </p>
          )}
          {module.params.map((p) => {
            if (!paramVisible(p.showIf, draft)) return null;
            return (
              <div key={p.name} className="flex flex-col gap-1.5">
                <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300">
                  {p.label ?? p.name}
                </label>
                <ParamField
                  spec={p}
                  value={draft[p.name]}
                  onChange={(v) => update(p.name, v)}
                  allParams={draft}
                  availableLetters={availableLetters}
                />
              </div>
            );
          })}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3 dark:border-slate-700 dark:bg-slate-800/40">
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            Annuler
          </button>
          <button
            onClick={() => {
              onSave(draft);
              onClose();
            }}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Enregistrer
          </button>
        </footer>
      </div>
    </div>
  );
}
