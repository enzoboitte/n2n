"use client";

import { useCallback } from "react";
import { ParamField } from "@/components/ui/ParamField";
import { NODE_BASE_HEIGHT, socketYOffset } from "@/lib/layout";
import type {
  CanvasNode as CanvasNodeData,
  ModuleManifest,
  ParamSpec,
  RunResult,
} from "@/lib/types";

const INLINE_TYPES: ParamSpec["type"][] = [
  "string",
  "select",
  "boolean",
  "env-key",
  "mcp-target",
];

type Props = {
  node: CanvasNodeData;
  module: ModuleManifest | undefined;
  selected: boolean;
  selectedIds: ReadonlySet<string>;
  scale: number;
  isSpaceDown: boolean;
  running: boolean;
  onSelect: (id: string | null, additive?: boolean) => void;
  onMove: (ids: string[], dx: number, dy: number) => void;
  onStartConnect: (id: string, sourceSocket: string, e: React.MouseEvent) => void;
  onSetParam: (id: string, key: string, value: unknown) => void;
  onRun: (id: string) => void;
  onConfigure: (id: string) => void;
  onContextMenu: (x: number, y: number, nodeId: string) => void;
};

export function CanvasNode({
  node,
  module,
  selected,
  selectedIds,
  scale,
  isSpaceDown,
  running,
  onSelect,
  onMove,
  onStartConnect,
  onSetParam,
  onRun,
  onConfigure,
  onContextMenu,
}: Props) {
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0 || isSpaceDown) return;
      e.stopPropagation();

      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      if (additive) {
        onSelect(node.id, true);
        return; // shift-click toggles selection without dragging
      }

      // Snapshot the drag set: if I'm in selection, drag the whole group;
      // otherwise replace selection with me and drag just me.
      let dragIds: string[];
      if (selected) {
        dragIds = Array.from(selectedIds);
      } else {
        onSelect(node.id, false);
        dragIds = [node.id];
      }

      let last = { x: e.clientX, y: e.clientY };
      const handleMove = (ev: MouseEvent) => {
        const dx = (ev.clientX - last.x) / scale;
        const dy = (ev.clientY - last.y) / scale;
        last = { x: ev.clientX, y: ev.clientY };
        onMove(dragIds, dx, dy);
      };
      const handleUp = () => {
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
      };
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [node.id, scale, isSpaceDown, selected, selectedIds, onSelect, onMove],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!selected) onSelect(node.id, false);
      onContextMenu(e.clientX, e.clientY, node.id);
    },
    [node.id, selected, onSelect, onContextMenu],
  );

  const outputs = module?.outputs ?? [];
  // Every node accepts incoming edges. Even modules with no declared inputs
  // receive values through `letters` and can reference them via {a}, {b}…
  // template substitution in any string param.
  const hasInput = !!module;
  const showOutputLabels = outputs.length > 1;
  const hasParams = !!module && module.params.length > 0;
  const inlineParams =
    module?.params.filter((p) => INLINE_TYPES.includes(p.type)) ?? [];
  const color = module?.color ?? "#94a3b8";
  const name = module?.name ?? `Module manquant (${node.moduleId})`;
  const result = node.result;

  return (
    <div
      data-node-id={node.id}
      onMouseDown={handleMouseDown}
      onContextMenu={handleContextMenu}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (hasParams) onConfigure(node.id);
      }}
      className={[
        "absolute flex flex-col rounded-lg border bg-white shadow-sm transition-shadow dark:bg-slate-800",
        selected
          ? "border-indigo-500 shadow-md ring-2 ring-indigo-500/20 dark:border-indigo-400"
          : "border-slate-200 hover:shadow dark:border-slate-700",
      ].join(" ")}
      style={{
        left: node.x,
        top: node.y,
        width: node.width,
        minHeight: node.height,
        cursor: isSpaceDown ? "inherit" : "move",
      }}
    >
      {hasInput && (
        <span
          data-socket-direction="input"
          title="Entrée"
          className="absolute -left-1.5 h-3 w-3 -translate-y-1/2 rounded-full border-2 border-white bg-slate-300 dark:border-slate-800 dark:bg-slate-600"
          style={{ top: `${NODE_BASE_HEIGHT / 2}px` }}
        />
      )}

      {outputs.map((s, i) => (
        <span
          key={`out-${s.name}`}
          data-socket-name={s.name}
          data-socket-direction="output"
          title={`Glisser pour relier (${s.label ?? s.name})`}
          onMouseDown={(e) => onStartConnect(node.id, s.name, e)}
          className="absolute -right-1.5 z-10 h-3 w-3 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-white bg-indigo-500 transition hover:scale-125 dark:border-slate-800"
          style={{ top: `${socketYOffset(i, outputs.length)}px` }}
        />
      ))}
      {showOutputLabels &&
        outputs.map((s, i) => (
          <span
            key={`out-label-${s.name}`}
            className="pointer-events-none absolute right-2 -translate-y-1/2 text-[10px] text-slate-500 dark:text-slate-400"
            style={{ top: `${socketYOffset(i, outputs.length)}px` }}
          >
            {s.label ?? s.name}
          </span>
        ))}

      <div className="flex items-center justify-between gap-1 border-b border-slate-100 px-3 py-2 dark:border-slate-700">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ background: color }}
          />
          <span className="truncate text-sm font-medium">{name}</span>
        </div>
        <div className="flex shrink-0 items-center">
          {hasParams && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onConfigure(node.id);
              }}
              title="Configurer"
              className="flex h-5 w-5 items-center justify-center rounded text-slate-500 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRun(node.id);
            }}
            disabled={running}
            title="Exécuter"
            className="flex h-5 w-5 items-center justify-center rounded text-slate-500 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="currentColor"
              aria-hidden
            >
              <path d="M2 1 L9 5 L2 9 Z" />
            </svg>
          </button>
        </div>
      </div>

      {selected && inlineParams.length > 0 && (
        <div
          className="flex flex-col gap-1.5 px-3 py-2"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {inlineParams.map((p) => (
            <div key={p.name} className="flex flex-col gap-0.5">
              <span className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
                {p.label ?? p.name}
              </span>
              <ParamField
                spec={p}
                value={node.params[p.name]}
                onChange={(v) => onSetParam(node.id, p.name, v)}
                compact
                allParams={node.params}
              />
            </div>
          ))}
        </div>
      )}

      <div className="flex-1 px-3 py-2 text-xs">
        <ResultView module={module} result={result} />
      </div>
    </div>
  );
}

function ResultView({
  module,
  result,
}: {
  module: ModuleManifest | undefined;
  result: RunResult | null;
}) {
  if (!result) {
    return (
      <span className="text-slate-400 dark:text-slate-500">Aucun résultat</span>
    );
  }
  if ("skipped" in result) {
    return (
      <span className="text-slate-400 italic dark:text-slate-500">
        Branche non prise
      </span>
    );
  }
  if (!result.ok) {
    return (
      <span className="text-rose-600 dark:text-rose-400">{result.error}</span>
    );
  }

  const outputs = result.outputs;
  const entries = Object.entries(outputs);
  if (entries.length === 0) {
    return <span className="text-slate-400">(vide)</span>;
  }

  // Show only the active branches (non-null) for branch-style modules
  const isBranch = (module?.outputs.length ?? 0) > 1;
  const visible = isBranch
    ? entries.filter(([, v]) => v !== null && v !== undefined)
    : entries;
  if (isBranch && visible.length === 0) {
    return (
      <span className="text-slate-400 italic dark:text-slate-500">
        Branche non prise
      </span>
    );
  }

  return (
    <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-slate-700 dark:text-slate-200">
      {visible
        .map(([k, v]) => (visible.length === 1 ? fmt(v) : `${k}: ${fmt(v)}`))
        .join("\n")}
    </pre>
  );
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
