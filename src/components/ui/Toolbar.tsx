"use client";


import type { ReactNode } from "react";

type Props = {
  zoomPercent: number;
  chatOpen: boolean;
  onToggleChat: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  onAutoLayout: () => void;
  onOpenSettings: () => void;
  projectSlot?: ReactNode;
};

export function Toolbar({
  zoomPercent,
  chatOpen,
  onToggleChat,
  onZoomIn,
  onZoomOut,
  onReset,
  onAutoLayout,
  onOpenSettings,
  projectSlot,
}: Props) {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center gap-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-900 text-[11px] font-bold text-white dark:bg-white dark:text-slate-900">
          n2n
        </div>
        {projectSlot}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={onAutoLayout}
          title="Réorganiser le graphe"
          className="flex h-7 items-center gap-1.5 rounded-md border border-slate-200 px-2.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
          Layout
        </button>
        <button
          onClick={onToggleChat}
          title={chatOpen ? "Fermer l'IA" : "Ouvrir l'IA"}
          className={[
            "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition",
            chatOpen
              ? "bg-indigo-600 text-white hover:bg-indigo-500"
              : "border border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800",
          ].join(" ")}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          IA
        </button>
        <div className="flex items-center gap-1 rounded-md border border-slate-200 px-1 py-0.5 dark:border-slate-800">
        <ToolButton onClick={onZoomOut} title="Zoom arrière">
          <Icon path="M5 12h14" />
        </ToolButton>
        <button
          onClick={onReset}
          title="Réinitialiser la vue"
          className="min-w-[3.5rem] rounded px-2 py-1 text-xs tabular-nums text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          {zoomPercent}%
        </button>
        <ToolButton onClick={onZoomIn} title="Zoom avant">
          <Icon path="M12 5v14M5 12h14" />
        </ToolButton>
        </div>
        <button
          onClick={onOpenSettings}
          title="Paramètres de connexion serveur"
          className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 text-slate-600 transition hover:bg-slate-100 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.36.13.69.34.97.62a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </header>
  );
}

function ToolButton({
  children,
  onClick,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex h-7 w-7 items-center justify-center rounded text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
    >
      {children}
    </button>
  );
}

function Icon({ path }: { path: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={path} />
    </svg>
  );
}
