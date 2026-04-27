import type { Viewport } from "@/lib/types";

type Props = {
  viewport: Viewport;
  nodeCount: number;
  edgeCount: number;
};

export function StatusBar({ viewport, nodeCount, edgeCount }: Props) {
  return (
    <footer className="flex h-7 shrink-0 items-center justify-between border-t border-slate-200 bg-white px-4 text-[11px] text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
      <div className="flex gap-4 tabular-nums">
        <span>x: {Math.round(viewport.x)}</span>
        <span>y: {Math.round(viewport.y)}</span>
        <span>
          {nodeCount} nœud{nodeCount > 1 ? "s" : ""}
        </span>
        <span>
          {edgeCount} liaison{edgeCount > 1 ? "s" : ""}
        </span>
      </div>
      <div className="hidden gap-3 md:flex">
        <Hint label="Glisser ●" value="relier" />
        <Hint label="▶" value="exécuter" />
        <Hint label="Suppr" value="supprimer" />
        <Hint label="Espace + glisser" value="déplacer" />
      </div>
    </footer>
  );
}

function Hint({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <kbd className="rounded border border-slate-200 bg-slate-50 px-1 font-mono text-[10px] dark:border-slate-700 dark:bg-slate-800">
        {label}
      </kbd>{" "}
      {value}
    </span>
  );
}
