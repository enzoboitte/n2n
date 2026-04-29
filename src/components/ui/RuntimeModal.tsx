"use client";

import { useEffect, useState } from "react";
import { getApi, type RuntimeStatus } from "@/lib/n2n";

type Props = {
  onClose: () => void;
};

export function RuntimeModal({ onClose }: Props) {
  const [runtimes, setRuntimes] = useState<RuntimeStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const api = getApi();
    if (!api) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const list = await api.runtimesList();
        if (!cancelled) setRuntimes(list);
      } catch (err) {
        if (!cancelled) setError(String((err as Error).message ?? err));
      }
    };
    void refresh();
    const off = api.onRuntimesChanged(() => void refresh());
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const install = async (id: string) => {
    const api = getApi();
    if (!api) return;
    try {
      await api.runtimesInstall(id);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-4 dark:border-slate-700">
          <div className="flex flex-col leading-tight">
            <span className="text-base font-semibold">Environnements</span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Détecte Node.js, Python et autres runtimes nécessaires aux
              modules et aux serveurs MCP.
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

        <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto px-5 py-4">
          {error && (
            <p className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
              {error}
            </p>
          )}

          {!runtimes && !error && (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Détection en cours…
            </p>
          )}

          {runtimes?.map((rt) => (
            <RuntimeCard key={rt.id} rt={rt} onInstall={() => install(rt.id)} />
          ))}

          <p className="mt-2 rounded-md border border-dashed border-slate-300 p-3 text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-400">
            D&apos;autres environnements (Deno, Bun, Ruby, Go…) pourront être
            ajoutés ici. Les binaires sont téléchargés dans{" "}
            <code className="rounded bg-slate-100 px-1 font-mono text-[10px] dark:bg-slate-800">
              ~/.n2n/runtimes
            </code>{" "}
            et n&apos;impactent pas le système.
          </p>
        </div>
      </div>
    </div>
  );
}

function RuntimeCard({
  rt,
  onInstall,
}: {
  rt: RuntimeStatus;
  onInstall: () => void;
}) {
  const status = rt.installing
    ? "installing"
    : rt.installed
      ? "ok"
      : rt.error
        ? "error"
        : "missing";

  const dotClass =
    status === "ok"
      ? "bg-emerald-500"
      : status === "installing"
        ? "bg-amber-500 animate-pulse"
        : status === "error"
          ? "bg-rose-500"
          : "bg-slate-400";

  const buttonLabel = rt.installing
    ? "Installation…"
    : rt.installed
      ? "Réinstaller"
      : "Installer";

  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-700 dark:bg-slate-800/50">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
            <span className="text-sm font-semibold">{rt.label}</span>
            {rt.installed && (
              <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                installé
              </span>
            )}
            {!rt.installed && !rt.installing && (
              <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-700 dark:bg-slate-700 dark:text-slate-300">
                manquant
              </span>
            )}
          </div>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {rt.description}
          </span>
        </div>
        <button
          onClick={onInstall}
          disabled={rt.installing || !rt.installable}
          title={
            !rt.installable
              ? "Plateforme non supportée pour l'installation auto"
              : undefined
          }
          className="shrink-0 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {buttonLabel}
        </button>
      </div>

      <div className="mt-3 flex flex-col gap-1">
        {rt.details.map((d) => (
          <div
            key={d.name}
            className="flex items-center justify-between gap-2 text-[11px]"
          >
            <code className="font-mono text-slate-700 dark:text-slate-300">
              {d.name}
            </code>
            {d.path ? (
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-mono text-slate-500 dark:text-slate-400">
                  {d.path}
                </span>
                {d.version && (
                  <span className="shrink-0 rounded bg-slate-200 px-1.5 py-0.5 font-mono text-[10px] text-slate-700 dark:bg-slate-700 dark:text-slate-300">
                    {d.version}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-slate-400">introuvable</span>
            )}
          </div>
        ))}
      </div>

      {rt.error && (
        <p className="mt-2 break-words rounded bg-rose-50 px-2 py-1 text-[11px] text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
          {rt.error}
        </p>
      )}

      {rt.log && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
            Journal d&apos;installation
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded bg-slate-900 px-2 py-1.5 font-mono text-[10px] leading-snug text-slate-200">
            {rt.log}
          </pre>
        </details>
      )}
    </div>
  );
}
