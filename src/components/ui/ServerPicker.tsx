"use client";

import { useEffect, useMemo, useState } from "react";
import {
  getActiveProfileId,
  listServerProfiles,
  pingServer,
  removeServerProfile,
  setActiveProfile,
  upsertServerProfile,
  type ServerInfo,
  type ServerProfile,
} from "@/lib/n2n";

type Props = {
  /** Called once a profile is saved AND set as active. The caller decides
   * whether to navigate, reload the SPA, close a modal, etc. */
  onConnected: (profile: ServerProfile) => void;
  /** Optional "back" affordance shown when the picker is opened from inside a
   * working session (e.g. the gear button while already connected). */
  onClose?: () => void;
  /** Title bar headline. Tunable so the same picker reads naturally either as
   * a first-run landing page or as a "switch server" panel. */
  title?: string;
  subtitle?: string;
};

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; info: ServerInfo }
  | { kind: "error"; message: string };

type Draft = {
  id?: string;
  label: string;
  url: string;
  token: string;
};

function emptyDraft(): Draft {
  return { label: "", url: "", token: "" };
}

function draftFromProfile(p: ServerProfile): Draft {
  return { id: p.id, label: p.label, url: p.url, token: p.token ?? "" };
}

export function ServerPicker({
  onConnected,
  onClose,
  title = "Serveurs n2n",
  subtitle = "Choisis sur quel backend brancher cette interface.",
}: Props) {
  const [profiles, setProfiles] = useState<ServerProfile[]>(() =>
    listServerProfiles(),
  );
  const [activeId, setActiveId] = useState<string | null>(() =>
    getActiveProfileId(),
  );
  const [draft, setDraft] = useState<Draft | null>(() =>
    listServerProfiles().length === 0 ? emptyDraft() : null,
  );
  const [state, setState] = useState<TestState>({ kind: "idle" });

  const refresh = () => {
    setProfiles(listServerProfiles());
    setActiveId(getActiveProfileId());
  };

  useEffect(() => {
    if (!draft || !draft.url.trim()) {
      setState({ kind: "idle" });
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setState({ kind: "testing" });
      try {
        const info = await pingServer(draft.url, {
          token: draft.token,
          signal: ctrl.signal,
        });
        setState({ kind: "ok", info });
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setState({ kind: "error", message: (e as Error).message });
      }
    }, 350);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [draft]);

  const saveDraftAndConnect = () => {
    if (!draft) return;
    const profile = upsertServerProfile({
      id: draft.id,
      label: draft.label,
      url: draft.url,
      token: draft.token || undefined,
    });
    setActiveProfile(profile.id);
    onConnected(profile);
  };

  const connectExisting = (p: ServerProfile) => {
    setActiveProfile(p.id);
    onConnected(p);
  };

  const removeExisting = (id: string) => {
    if (!confirm("Supprimer cette connexion ?")) return;
    removeServerProfile(id);
    refresh();
    if (listServerProfiles().length === 0) setDraft(emptyDraft());
  };

  const editExisting = (p: ServerProfile) => setDraft(draftFromProfile(p));

  const showList = !draft;

  return (
    <div className="flex w-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-700">
        <div className="flex items-center gap-3">
          <span className="h-3 w-3 rounded-full bg-indigo-500" />
          <div className="flex flex-col leading-tight">
            <span className="text-base font-semibold">{title}</span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {subtitle}
            </span>
          </div>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            title="Retour"
            className="flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            ×
          </button>
        )}
      </header>

      <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto px-5 py-4">
        {showList && (
          <ProfileList
            profiles={profiles}
            activeId={activeId}
            onConnect={connectExisting}
            onEdit={editExisting}
            onRemove={removeExisting}
            onAdd={() => setDraft(emptyDraft())}
          />
        )}

        {draft && (
          <DraftForm
            draft={draft}
            setDraft={setDraft}
            state={state}
            isNew={!draft.id}
          />
        )}
      </div>

      {draft && (
        <footer className="flex items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3 dark:border-slate-700 dark:bg-slate-800/40">
          <button
            onClick={() => {
              if (profiles.length === 0 && onClose) onClose();
              else setDraft(null);
            }}
            className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            {profiles.length === 0 ? "Annuler" : "Retour à la liste"}
          </button>
          <button
            onClick={saveDraftAndConnect}
            disabled={state.kind !== "ok"}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-300 dark:disabled:bg-slate-700"
          >
            {draft.id ? "Enregistrer & se connecter" : "Ajouter & se connecter"}
          </button>
        </footer>
      )}
    </div>
  );
}

function ProfileList({
  profiles,
  activeId,
  onConnect,
  onEdit,
  onRemove,
  onAdd,
}: {
  profiles: ServerProfile[];
  activeId: string | null;
  onConnect: (p: ServerProfile) => void;
  onEdit: (p: ServerProfile) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}) {
  if (profiles.length === 0) {
    return (
      <p className="rounded border border-dashed border-slate-300 p-3 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
        Aucun serveur enregistré. Clique « Ajouter » pour t'y connecter.
      </p>
    );
  }
  return (
    <>
      <ul className="flex flex-col gap-2">
        {profiles.map((p) => (
          <ProfileCard
            key={p.id}
            profile={p}
            isActive={activeId === p.id || (!activeId && profiles[0]?.id === p.id)}
            onConnect={() => onConnect(p)}
            onEdit={() => onEdit(p)}
            onRemove={() => onRemove(p.id)}
          />
        ))}
      </ul>
      <button
        onClick={onAdd}
        className="self-start rounded-md border border-dashed border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:border-indigo-400 hover:text-indigo-500 dark:border-slate-700 dark:text-slate-300"
      >
        + Ajouter un serveur
      </button>
    </>
  );
}

function ProfileCard({
  profile,
  isActive,
  onConnect,
  onEdit,
  onRemove,
}: {
  profile: ServerProfile;
  isActive: boolean;
  onConnect: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [probe, setProbe] = useState<TestState>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    setProbe({ kind: "testing" });
    pingServer(profile.url, { token: profile.token, signal: ctrl.signal })
      .then((info) => {
        if (!cancelled) setProbe({ kind: "ok", info });
      })
      .catch((e) => {
        if (cancelled || (e as Error).name === "AbortError") return;
        setProbe({ kind: "error", message: (e as Error).message });
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [profile.url, profile.token]);

  const dot = useMemo(() => {
    if (probe.kind === "ok") return "bg-emerald-500";
    if (probe.kind === "error") return "bg-rose-500";
    return "bg-slate-400";
  }, [probe]);

  return (
    <li
      className={[
        "flex flex-col gap-1.5 rounded-md border px-3 py-2",
        isActive
          ? "border-indigo-400 bg-indigo-50/40 dark:border-indigo-500 dark:bg-indigo-950/20"
          : "border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/50",
      ].join(" ")}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-sm font-medium">{profile.label}</span>
            <span className="truncate font-mono text-[11px] text-slate-500 dark:text-slate-400">
              {profile.url}
              {profile.token ? " · token" : ""}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!isActive && (
            <button
              onClick={onConnect}
              className="rounded bg-indigo-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-indigo-500"
            >
              Connecter
            </button>
          )}
          {isActive && (
            <button
              onClick={onConnect}
              className="rounded bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-500"
            >
              Reprendre
            </button>
          )}
          <button
            onClick={onEdit}
            className="rounded px-2 py-0.5 text-[11px] text-slate-500 hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-slate-700"
          >
            Modifier
          </button>
          <button
            onClick={onRemove}
            className="rounded px-2 py-0.5 text-[11px] text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40"
          >
            Suppr.
          </button>
        </div>
      </div>
      {probe.kind === "ok" && (
        <span className="text-[10px] text-slate-500 dark:text-slate-400">
          {probe.info.name} v{probe.info.version}
          {probe.info.authRequired ? " · auth requis" : ""}
        </span>
      )}
      {probe.kind === "error" && (
        <span className="break-words text-[10px] text-rose-600 dark:text-rose-400">
          {probe.message}
        </span>
      )}
    </li>
  );
}

function DraftForm({
  draft,
  setDraft,
  state,
  isNew,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  state: TestState;
  isNew: boolean;
}) {
  const authRequired = state.kind === "ok" && state.info.authRequired;

  return (
    <div className="flex flex-col gap-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {isNew ? "Nouveau serveur" : "Modifier le serveur"}
      </div>

      <Field label="Nom (libellé)">
        <input
          type="text"
          value={draft.label}
          placeholder="Local · VPS Hetzner · Prod"
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900"
        />
      </Field>

      <Field label="URL">
        <input
          type="url"
          value={draft.url}
          placeholder="http://localhost:9999"
          autoFocus={isNew}
          onChange={(e) => setDraft({ ...draft, url: e.target.value })}
          className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 font-mono text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900"
        />
        <span className="text-[10px] text-slate-400 dark:text-slate-500">
          Ex. <code>http://192.168.1.42:9999</code>, <code>https://n2n.exemple.com</code>. Sans slash final.
        </span>
      </Field>

      <Field
        label={
          authRequired
            ? "Token (requis par ce serveur)"
            : "Token (optionnel)"
        }
      >
        <input
          type="password"
          value={draft.token}
          placeholder="laisser vide si le serveur n'exige pas d'authentification"
          onChange={(e) => setDraft({ ...draft, token: e.target.value })}
          className={[
            "w-full rounded-md border bg-white px-2 py-1.5 font-mono text-sm outline-none focus:border-indigo-500 dark:bg-slate-900",
            authRequired && !draft.token.trim()
              ? "border-amber-400"
              : "border-slate-200 dark:border-slate-700",
          ].join(" ")}
        />
        <span className="text-[10px] text-slate-400 dark:text-slate-500">
          Le serveur vérifie <code>Authorization: Bearer &lt;token&gt;</code>. Active-le côté serveur via la variable d'env <code>N2N_API_TOKEN</code>.
        </span>
      </Field>

      <StatusLine state={state} />

      <details className="text-xs text-slate-500 dark:text-slate-400">
        <summary className="cursor-pointer select-none">
          Déployer en sécurité sur un serveur public
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          <li>
            Génère un token long et aléatoire :{" "}
            <code>openssl rand -hex 32</code>.
          </li>
          <li>
            Lance le serveur avec{" "}
            <code>N2N_API_TOKEN=&lt;token&gt; ./n2n-server</code>. Toute requête
            <code> /api/*</code> sans <code>Authorization: Bearer</code> sera
            refusée (401).
          </li>
          <li>
            Mets <code>n2n</code> derrière un reverse proxy HTTPS
            (Caddy/Traefik/Nginx). Restreins <code>N2N_CORS_ORIGIN</code> à
            l'origine de ton UI.
          </li>
          <li>
            Pour les webhooks publics, ajoute un <code>Secret</code> sur chaque
            node webhook : il accepte alors{" "}
            <code>?key=…</code>, <code>X-Webhook-Secret</code> ou{" "}
            <code>Authorization: Bearer</code>.
          </li>
        </ul>
      </details>
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

function StatusLine({ state }: { state: TestState }) {
  if (state.kind === "idle") {
    return (
      <span className="text-xs text-slate-400 dark:text-slate-500">
        Saisis une URL pour tester la connexion…
      </span>
    );
  }
  if (state.kind === "testing") {
    return (
      <span className="text-xs text-slate-500 dark:text-slate-400">
        Test en cours…
      </span>
    );
  }
  if (state.kind === "ok") {
    const { info } = state;
    return (
      <div className="flex flex-col gap-0.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
        <span className="font-semibold">
          ✓ Connecté à {info.name} v{info.version}
          {info.authRequired ? " · auth requis" : ""}
        </span>
        <span className="text-[10px] opacity-80">
          bind {info.host}:{info.apiPort}
          {info.webhookPort !== info.apiPort && ` · webhooks :${info.webhookPort}`}
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
