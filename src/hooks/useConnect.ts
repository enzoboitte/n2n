"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { Viewport } from "@/lib/types";

export type PendingConnect = {
  sourceId: string;
  sourceSocket: string;
  x: number;
  y: number;
};

type Options = {
  containerRef: RefObject<HTMLDivElement | null>;
  viewport: Viewport;
  onConnect: (source: string, sourceSocket: string, target: string) => void;
};

export function useConnect({ containerRef, viewport, onConnect }: Options) {
  const [pending, setPending] = useState<PendingConnect | null>(null);

  const viewportRef = useRef(viewport);
  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  const start = useCallback(
    (sourceId: string, sourceSocket: string, e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const el = containerRef.current;
      if (!el) return;

      const toWorld = (clientX: number, clientY: number) => {
        const rect = el.getBoundingClientRect();
        const vp = viewportRef.current;
        return {
          x: (clientX - rect.left - vp.x) / vp.scale,
          y: (clientY - rect.top - vp.y) / vp.scale,
        };
      };

      const initial = toWorld(e.clientX, e.clientY);
      setPending({ sourceId, sourceSocket, x: initial.x, y: initial.y });

      const handleMove = (ev: MouseEvent) => {
        const w = toWorld(ev.clientX, ev.clientY);
        setPending({ sourceId, sourceSocket, x: w.x, y: w.y });
      };

      const handleUp = (ev: MouseEvent) => {
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);

        const target = document.elementFromPoint(ev.clientX, ev.clientY);
        const nodeEl = target?.closest(
          "[data-node-id]",
        ) as HTMLElement | null;
        const targetId = nodeEl?.dataset.nodeId;

        if (targetId && targetId !== sourceId) {
          onConnect(sourceId, sourceSocket, targetId);
        }
        setPending(null);
      };

      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [containerRef, onConnect],
  );

  return { pending, start };
}
