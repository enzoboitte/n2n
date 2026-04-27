"use client";

import { useEffect, useState } from "react";
import { getApi, type McpServerState } from "@/lib/n2n";
import { useMcpServers } from "@/hooks/useMcpServers";

type Props = {
  onClose: () => void;
};

type Preset = {
  id: string;
  name: string;
  description: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  notes?: string;
};

const PRESETS: Preset[] = [
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Lire / écrire dans un dossier local",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    env: {},
    notes: "Remplace /tmp par le chemin absolu du dossier autorisé.",
  },
  {
    id: "github",
    name: "GitHub",
    description: "Issues, PRs, branches, fichiers",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" },
    notes:
      "Génère un token sur github.com/settings/tokens (permissions : repo).",
  },
  {
    id: "brave-search",
    name: "Brave Search",
    description: "Recherche web via Brave",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    env: { BRAVE_API_KEY: "" },
    notes: "Récupère une clé sur brave.com/search/api.",
  },
  {
    id: "fetch",
    name: "Fetch (HTTP)",
    description: "Requêtes HTTP arbitraires",
    command: "uvx",
    args: ["mcp-server-fetch"],
    env: {},
    notes: "Nécessite uv (curl -LsSf https://astral.sh/uv/install.sh | sh).",
  },
  {
    id: "memory",
    name: "Memory (knowledge graph)",
    description: "Mémoire persistante en knowledge graph",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    env: {},
  },
  {
    id: "custom",
    name: "Personnalisé…",
    description: "Commande arbitraire",
    command: "",
    args: [],
    env: {},
  },
];

type Editor = {
  name: string;
  command: string;
  argsText: string; // newline-separated for the form
  env: Record<string, string>;
  notes?: string;
};

function emptyEditor(): Editor {
  return { name: "", command: "", argsText: "", env: {} };
}

function fromServer(s: McpServerState): Editor {
  return {
    name: s.name,
    command: s.command,
    argsText: s.args.join("\n"),
    env: { ...s.env },
  };
}

function fromPreset(p: Preset): Editor {
  return {
    name: p.id === "custom" ? "" : p.id,
    command: p.command,
    argsText: p.args.join("\n"),
    env: { ...p.env },
    notes: p.notes,
  };
}

export function McpModal({ onClose }: Props) {
  const { servers, refresh } = useMcpServers();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [editingExisting, setEditingExisting] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (editor) {
          setEditor(null);
          setEditingExisting(null);
          setSaveError(null);
        } else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor, onClose]);

  const startEdit = (s: McpServerState) => {
    setEditor(fromServer(s));
    setEditingExisting(s.name);
    setSaveError(null);
  };

  const startCreate = (preset?: Preset) => {
    setEditor(preset ? fromPreset(preset) : emptyEditor());
    setEditingExisting(null);
    setSaveError(null);
  };

  const save = async () => {
    if (!editor) return;
    const api = getApi();
    if (!api) return;
    if (!editor.name.trim() || !/^[a-z0-9_-]+$/i.test(editor.name)) {
      setSaveError("Nom invalide (a-z, 0-9, _, -)");
      return;
    }
    if (!editor.command.trim()) {
      setSaveError("La commande est requise");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const args = editor.argsText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      // If renaming, delete old first
      if (editingExisting && editingExisting !== editor.name) {
        await api.mcpDelete(editingExisting);
      }
      await api.mcpSave(editor.name, {
        command: editor.command,
        args,
        env: editor.env,
      });
      setEditor(null);
      setEditingExisting(null);
      await refresh();
    } catch (err) {
      setSaveError(String((err as Error).message ?? err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (name: string) => {
    if (!confirm(`Supprimer le serveur MCP "${name}" ?`)) return;
    const api = getApi();
    if (!api) return;
    await api.mcpDelete(name);
    await refresh();
  };

  const restart = async (name: string) => {
    const api = getApi();
    if (!api) return;
    await api.mcpRestart(name);
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
            <span className="text-base font-semibold">Serveurs MCP</span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Branche n'importe quel service compatible Model Context Protocol
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
          {!editor && (
            <>
              {servers.length === 0 ? (
                <p className="rounded border border-dashed border-slate-300 p-3 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                  Aucun serveur enregistré. Choisis un preset ci-dessous pour
                  démarrer en 30 secondes.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {servers.map((s) => (
                    <li
                      key={s.name}
                      className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/50"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full ${
                              s.connected
                                ? "bg-emerald-500"
                                : s.error
                                  ? "bg-rose-500"
                                  : "bg-slate-400"
                            }`}
                            title={
                              s.connected
                                ? "Connecté"
                                : s.error || "Non connecté"
                            }
                          />
                          <span className="truncate font-mono text-sm font-medium">
                            {s.name}
                          </span>
                          <span className="text-[11px] text-slate-500 dark:text-slate-400">
                            {s.tools.length} outil{s.tools.length > 1 ? "s" : ""}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => restart(s.name)}
                            className="rounded px-2 py-0.5 text-[11px] text-slate-500 hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-slate-700"
                          >
                            Relancer
                          </button>
                          <button
                            onClick={() => startEdit(s)}
                            className="rounded px-2 py-0.5 text-[11px] text-slate-500 hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-slate-700"
                          >
                            Modifier
                          </button>
                          <button
                            onClick={() => remove(s.name)}
                            className="rounded px-2 py-0.5 text-[11px] text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                          >
                            Supprimer
                          </button>
                        </div>
                      </div>
                      {s.error && (
                        <p className="mt-1 break-words text-[11px] text-rose-600 dark:text-rose-400">
                          {s.error}
                        </p>
                      )}
                      {s.connected && s.tools.length > 0 && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-[11px] text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
                            Voir les outils
                          </summary>
                          <ul className="mt-1 flex flex-wrap gap-1">
                            {s.tools.map((t) => (
                              <li
                                key={t.name}
                                title={t.description}
                                className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-700 dark:bg-slate-900 dark:text-slate-300"
                              >
                                {t.name}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-2">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Ajouter un serveur
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {PRESETS.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => startCreate(p)}
                      className="flex flex-col items-start gap-0.5 rounded-md border border-slate-200 bg-white px-3 py-2 text-left transition hover:border-indigo-400 hover:bg-indigo-50/40 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-indigo-500 dark:hover:bg-indigo-950/20"
                    >
                      <span className="text-sm font-medium">{p.name}</span>
                      <span className="text-[11px] text-slate-500 dark:text-slate-400">
                        {p.description}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {editor && (
            <EditorForm
              editor={editor}
              setEditor={setEditor}
              isNew={!editingExisting}
              error={saveError}
            />
          )}
        </div>

        {editor && (
          <footer className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3 dark:border-slate-700 dark:bg-slate-800/40">
            <button
              onClick={() => {
                setEditor(null);
                setEditingExisting(null);
                setSaveError(null);
              }}
              className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              Annuler
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
            >
              {saving ? "Démarrage…" : "Enregistrer & lancer"}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

function EditorForm({
  editor,
  setEditor,
  isNew,
  error,
}: {
  editor: Editor;
  setEditor: (e: Editor) => void;
  isNew: boolean;
  error: string | null;
}) {
  const updateEnv = (next: Record<string, string>) =>
    setEditor({ ...editor, env: next });
  const entries = Object.entries(editor.env);

  return (
    <div className="flex flex-col gap-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {isNew ? "Nouveau serveur" : "Modifier le serveur"}
      </div>

      {editor.notes && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          ℹ️ {editor.notes}
        </p>
      )}

      <Field label="Nom (identifiant unique)">
        <input
          type="text"
          value={editor.name}
          placeholder="github"
          onChange={(e) => setEditor({ ...editor, name: e.target.value })}
          className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 font-mono text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900"
        />
      </Field>
      <Field label="Commande">
        <input
          type="text"
          value={editor.command}
          placeholder="npx"
          onChange={(e) => setEditor({ ...editor, command: e.target.value })}
          className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 font-mono text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900"
        />
      </Field>
      <Field label="Arguments (un par ligne)">
        <textarea
          value={editor.argsText}
          onChange={(e) => setEditor({ ...editor, argsText: e.target.value })}
          rows={4}
          className="w-full resize-y rounded-md border border-slate-200 bg-white px-2 py-1.5 font-mono text-xs outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900"
        />
      </Field>
      <Field label="Variables d'environnement du serveur">
        <div className="flex flex-col gap-1.5">
          {entries.length === 0 && (
            <span className="text-[11px] text-slate-400">Aucune.</span>
          )}
          {entries.map(([k, v], i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                type="text"
                value={k}
                placeholder="NOM"
                onChange={(e) => {
                  const next: Record<string, string> = {};
                  entries.forEach(([ek, ev], ei) => {
                    if (ei === i) next[e.target.value] = ev;
                    else next[ek] = ev;
                  });
                  updateEnv(next);
                }}
                className="w-1/3 rounded border border-slate-200 bg-white px-2 py-1 font-mono text-xs outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900"
              />
              <input
                type="text"
                value={v}
                placeholder="valeur"
                onChange={(e) => {
                  const next: Record<string, string> = { ...editor.env };
                  next[k] = e.target.value;
                  updateEnv(next);
                }}
                className="flex-1 rounded border border-slate-200 bg-white px-2 py-1 text-xs outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900"
              />
              <button
                onClick={() => {
                  const next: Record<string, string> = { ...editor.env };
                  delete next[k];
                  updateEnv(next);
                }}
                title="Retirer"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-950/40"
              >
                ×
              </button>
            </div>
          ))}
          <button
            onClick={() => updateEnv({ ...editor.env, "": "" })}
            className="self-start rounded border border-dashed border-slate-300 px-2 py-1 text-xs text-slate-500 hover:border-indigo-400 hover:text-indigo-500 dark:border-slate-700 dark:text-slate-400"
          >
            + Ajouter
          </button>
        </div>
      </Field>

      {error && (
        <p className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] font-medium text-slate-600 dark:text-slate-300">
        {label}
      </label>
      {children}
    </div>
  );
}
