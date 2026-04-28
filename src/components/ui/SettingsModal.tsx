"use client";

import { useEffect, useState } from "react";
import { getApiBase, pingServer, setApiBase, type ServerInfo } from "@/lib/n2n";

type Props = {
  /** When true, the modal cannot be dismissed (first-run / unreachable server). */
  required?: boolean;
  onClose: () => void;
};

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; info: ServerInfo }
  | { kind: "error"; message: string };

export function SettingsModal({ required = false, onClose }: Props) {
  const [url, setUrl] = useState(() => getApiBase());
  const [state, setState] = useState<TestState>({ kind: "idle" });

  // Auto-test the URL once the user pauses typing.
  useEffect(() => {
    if (!url.trim()) { setState({ kind: "idle" }); return; }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setState({ kind: "testing" });
      try {
        const info = await pingServer(url, ctrl.signal);
        setState({ kind: "ok", info });
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setState({ kind: "error", message: (e as Error).message });
      }
    }, 350);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [url]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !required) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, required]);

  const apply = () => {
    setApiBase(url);
    onClose();
    // Force a soft refresh so hooks re-fetch projects/modules from the new server.
    if (typeof window !== "undefined") window.location.reload();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm"
      onClick={() => { if (!required) onClose(); }}
    >
      <div
        className="flex w-full max-w-md flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-700">
          <div className="flex items-center gap-3">
            <span className="h-3 w-3 rounded-full bg-indigo-500" />
            <div className="flex flex-col leading-tight">
              <span className="text-base font-semibold">Connexion serveur n2n</span>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {required
                  ? "Première configuration — entre l'URL du serveur n2n auquel cette interface doit se connecter."
                  : "Modifie l'URL du serveur backend (HTTP + SSE)."}
              </span>
            </div>
          </div>
          {!required && (
            <button
              onClick={onClose}
              title="Fermer"
              className="flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              ×
            </button>
          )}
        </header>

        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300">
              URL du serveur
            </label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://localhost:9999"
              autoFocus
              className="rounded border border-slate-200 bg-white px-2 py-1.5 font-mono text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900"
            />
            <span className="text-[10px] text-slate-400 dark:text-slate-500">
              Ex. <code>http://192.168.1.42:9999</code>, <code>https://n2n.exemple.com</code>. Sans slash final.
            </span>
          </div>

          <StatusLine state={state} />

          <details className="text-xs text-slate-500 dark:text-slate-400">
            <summary className="cursor-pointer select-none">Aide</summary>
            <ul className="mt-2 list-disc space-y-1 pl-4">
              <li>Le serveur doit écouter sur <code>0.0.0.0</code> (par défaut depuis cette version) sinon il n'est pas joignable depuis cette page.</li>
              <li>Si l'UI est servie en HTTPS, le serveur doit l'être aussi (sinon le navigateur bloque le mixed content).</li>
              <li>Le CORS doit autoriser l'origine de cette page : variable <code>N2N_CORS_ORIGIN</code> côté serveur (par défaut <code>*</code>).</li>
            </ul>
          </details>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3 dark:border-slate-700 dark:bg-slate-800/40">
          {!required && (
            <button
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              Annuler
            </button>
          )}
          <button
            onClick={apply}
            disabled={state.kind !== "ok"}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-300 dark:disabled:bg-slate-700"
          >
            Connecter
          </button>
        </footer>
      </div>
    </div>
  );
}

function StatusLine({ state }: { state: TestState }) {
  if (state.kind === "idle") {
    return <span className="text-xs text-slate-400 dark:text-slate-500">Saisis une URL pour tester la connexion…</span>;
  }
  if (state.kind === "testing") {
    return <span className="text-xs text-slate-500 dark:text-slate-400">Test en cours…</span>;
  }
  if (state.kind === "ok") {
    const { info } = state;
    return (
      <div className="flex flex-col gap-0.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
        <span className="font-semibold">✓ Connecté à {info.name} v{info.version}</span>
        <span className="text-[10px] opacity-80">
          bind {info.host}:{info.apiPort}{info.webhookPort !== info.apiPort && ` · webhooks :${info.webhookPort}`}
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
      <span className="font-semibold">✗ Impossible de joindre le serveur</span>
      <span className="break-words text-[10px] opacity-80">{state.message}</span>
    </div>
  );
}
