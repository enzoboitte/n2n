"use client";

import { useEffect, useState } from "react";

type Props = {
  initial: Record<string, string>;
  onSave: (env: Record<string, string>) => void;
  onClose: () => void;
};

type Row = { key: string; value: string };

function fromObject(obj: Record<string, string>): Row[] {
  return Object.entries(obj).map(([key, value]) => ({
    key,
    value: String(value ?? ""),
  }));
}

function toObject(rows: Row[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (r.key) out[r.key] = r.value;
  }
  return out;
}

export function EnvModal({ initial, onSave, onClose }: Props) {
  const [rows, setRows] = useState<Row[]>(() => fromObject(initial));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const updateKey = (i: number, key: string) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, key } : r)));
  const updateValue = (i: number, value: string) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, value } : r)));
  const remove = (i: number) =>
    setRows((rs) => rs.filter((_, idx) => idx !== i));
  const add = () => setRows((rs) => [...rs, { key: "", value: "" }]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-4 dark:border-slate-700">
          <div className="flex flex-col leading-tight">
            <span className="text-base font-semibold">
              Variables d&apos;environnement
            </span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Référencables dans tous les paramètres via{" "}
              <code className="rounded bg-slate-100 px-1 font-mono text-[10px] dark:bg-slate-800">
                {"{NOM_VAR}"}
              </code>
            </span>
          </div>
          <button
            onClick={onClose}
            title="Fermer"
            className="flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            ×
          </button>
        </header>

        <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto px-5 py-4">
          {rows.length === 0 && (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Aucune variable. Ajoutez-en pour les réutiliser dans vos modules.
            </p>
          )}
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="text"
                value={row.key}
                placeholder="NOM"
                onChange={(e) => updateKey(i, e.target.value)}
                className="w-1/3 rounded border border-slate-200 bg-white px-2 py-1.5 font-mono text-xs outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900"
              />
              <input
                type="text"
                value={row.value}
                placeholder="valeur"
                onChange={(e) => updateValue(i, e.target.value)}
                className="flex-1 rounded border border-slate-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900"
              />
              <button
                onClick={() => remove(i)}
                title="Retirer"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-950/40"
              >
                ×
              </button>
            </div>
          ))}
          <button
            onClick={add}
            className="self-start rounded border border-dashed border-slate-300 px-2 py-1 text-xs text-slate-500 hover:border-indigo-400 hover:text-indigo-500 dark:border-slate-700 dark:text-slate-400"
          >
            + Ajouter
          </button>
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
              onSave(toObject(rows));
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
