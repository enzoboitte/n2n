"use client";

import { useCallback } from "react";
import { ParamField } from "@/components/ui/ParamField";
import { outputSocketPosition } from "@/lib/layout";
import { paramVisible } from "@/lib/params";
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
  "project-id",
  "letter",
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
  /** Letters (a, b, c…) currently bound to incoming edges of this node. */
  availableLetters: string[];
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
  availableLetters,
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
  const hasParams = !!module && module.params.length > 0;
  const inlineParams =
    module?.params.filter(
      (p) => INLINE_TYPES.includes(p.type) && paramVisible(p.showIf, node.params),
    ) ?? [];
  const color = module?.color ?? "#94a3b8";
  const name = module?.name ?? `Module manquant (${node.moduleId})`;
  const result = node.result;

  const resultStatus = resultStatusOf(result);

  return (
    <div
      data-node-id={node.id}
      onMouseDown={handleMouseDown}
      onContextMenu={handleContextMenu}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (hasParams) onConfigure(node.id);
      }}
      className="group/node absolute"
      style={{
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
        cursor: isSpaceDown ? "inherit" : "move",
      }}
    >
      <div
        className={[
          "relative flex h-full w-full flex-col items-center justify-center overflow-hidden rounded-full border-[3px] bg-white text-center shadow-sm transition-shadow dark:bg-slate-800",
          selected
            ? "shadow-md ring-2 ring-indigo-500/30 dark:ring-indigo-400/30"
            : "hover:shadow",
        ].join(" ")}
        style={{
          borderColor: selected ? "#6366f1" : color,
          boxShadow: selected ? undefined : `0 0 0 1px ${color}26`,
        }}
        title={module?.description ?? name}
      >
        <span
          className="absolute top-2 h-1.5 w-1.5 rounded-full"
          style={{ background: color }}
        />

        <span className="line-clamp-2 px-2.5 text-[10px] font-medium leading-tight text-slate-800 dark:text-slate-100">
          {name}
        </span>

        {resultStatus && (
          <span
            className={[
              "absolute bottom-2 h-2 w-2 rounded-full",
              resultStatus === "ok"
                ? "bg-emerald-500"
                : resultStatus === "error"
                  ? "bg-rose-500"
                  : "bg-slate-300 dark:bg-slate-600",
            ].join(" ")}
            title={
              resultStatus === "ok"
                ? "Exécution réussie"
                : resultStatus === "error"
                  ? "Erreur"
                  : "Branche non prise"
            }
          />
        )}

      </div>

      {/* Hover action chip: configure + run. Floats just above the disc so it
          stays out of the way of the selected-state panel below. */}
      <div
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 -translate-x-1/2 opacity-0 transition-opacity group-hover/node:opacity-100"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-slate-200 bg-white/95 px-1 py-0.5 shadow-sm backdrop-blur dark:border-slate-700 dark:bg-slate-900/95">
          {hasParams && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onConfigure(node.id);
              }}
              title="Configurer (double-clic)"
              className="flex h-5 w-5 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700"
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
            className="flex h-5 w-5 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-700"
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

      {/* Input socket — sits on the left edge of the circle */}
      {hasInput && (
        <span
          data-socket-direction="input"
          title="Entrée"
          className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-slate-300 dark:border-slate-800 dark:bg-slate-600"
          style={{ left: 0, top: node.height / 2 }}
        />
      )}

      {/* Output sockets — distributed across right semicircle, with hover labels. */}
      {outputs.map((s, i) => {
        const pos = outputSocketPosition(
          i,
          outputs.length,
          node.width,
          node.height,
        );
        const labelOnLeft = pos.x < node.width / 2;
        return (
          <div
            key={`out-${s.name}`}
            className="group/output absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: pos.x, top: pos.y }}
          >
            <span
              data-socket-name={s.name}
              data-socket-direction="output"
              onMouseDown={(e) => onStartConnect(node.id, s.name, e)}
              title={`Glisser pour relier (${s.label ?? s.name})`}
              className="block h-3 w-3 cursor-crosshair rounded-full border-2 border-white bg-indigo-500 transition hover:scale-125 dark:border-slate-800"
            />
            {outputs.length > 1 && (
              <span
                className={[
                  "pointer-events-none absolute top-1/2 -translate-y-1/2 whitespace-nowrap rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-700 opacity-0 shadow-sm transition-opacity group-hover/output:opacity-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200",
                  labelOnLeft ? "right-4" : "left-4",
                ].join(" ")}
              >
                {s.label ?? s.name}
              </span>
            )}
          </div>
        );
      })}

      {/* Inline params + result preview, anchored under the disc and only
          shown when the node is selected. Keeps the circle uncluttered. */}
      {selected && (inlineParams.length > 0 || result) && (
        <div
          className="absolute left-1/2 top-full z-10 mt-2 w-56 -translate-x-1/2 rounded-lg border border-slate-200 bg-white p-2 shadow-md dark:border-slate-700 dark:bg-slate-800"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {inlineParams.length > 0 && (
            <div className="flex flex-col gap-1.5">
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
                    availableLetters={availableLetters}
                  />
                </div>
              ))}
            </div>
          )}
          {result && (
            <div
              className={[
                "text-xs",
                inlineParams.length > 0
                  ? "mt-2 border-t border-slate-100 pt-2 dark:border-slate-700"
                  : "",
              ].join(" ")}
            >
              <ResultView module={module} result={result} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function resultStatusOf(
  result: RunResult | null,
): "ok" | "error" | "skipped" | null {
  if (!result) return null;
  if ("skipped" in result) return "skipped";
  return result.ok ? "ok" : "error";
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
