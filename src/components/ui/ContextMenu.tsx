"use client";

import { useEffect } from "react";

export type MenuItem =
  | { divider: true }
  | {
      label: string;
      onClick: () => void;
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
    };

type Props = {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
};

export function ContextMenu({ x, y, items, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onAnyClick = () => onClose();
    window.addEventListener("keydown", onKey);
    // skip the click that opened the menu
    const t = window.setTimeout(
      () => window.addEventListener("mousedown", onAnyClick),
      0,
    );
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onAnyClick);
      window.clearTimeout(t);
    };
  }, [onClose]);

  return (
    <div
      style={{ left: x, top: y }}
      className="fixed z-50 min-w-[180px] rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-xl dark:border-slate-700 dark:bg-slate-900"
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        "divider" in item ? (
          <hr
            key={i}
            className="my-1 border-slate-200 dark:border-slate-700"
          />
        ) : (
          <button
            key={i}
            disabled={item.disabled}
            onClick={(e) => {
              e.stopPropagation();
              item.onClick();
              onClose();
            }}
            className={[
              "flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left disabled:opacity-40 disabled:hover:bg-transparent",
              item.danger
                ? "text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
                : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800",
            ].join(" ")}
          >
            <span>{item.label}</span>
            {item.shortcut && (
              <span className="font-mono text-xs text-slate-400 dark:text-slate-500">
                {item.shortcut}
              </span>
            )}
          </button>
        ),
      )}
    </div>
  );
}
