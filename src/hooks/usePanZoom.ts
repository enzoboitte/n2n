"use client";


import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_SCALE,
  MIN_SCALE,
  ZOOM_BUTTON_STEP,
  ZOOM_SPEED,
} from "@/lib/constants";
import type { Viewport } from "@/lib/types";

type UsePanZoomReturn = {
  viewport: Viewport;
  isPanning: boolean;
  isSpaceDown: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onMouseDown: (e: React.MouseEvent) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
};

const INITIAL: Viewport = { x: 0, y: 0, scale: 1 };

export function usePanZoom(initial: Viewport = INITIAL): UsePanZoomReturn {
  const [viewport, setViewport] = useState<Viewport>(initial);
  const [isPanning, setIsPanning] = useState(false);
  const [isSpaceDown, setIsSpaceDown] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const spaceDownRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);

  // Track Space key (skip when typing in an input)
  useEffect(() => {
    const isTextField = (el: Element | null) => {
      if (!el) return false;
      const tag = el.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (el as HTMLElement).isContentEditable
      );
    };

    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      if (isTextField(document.activeElement)) return;
      e.preventDefault();
      spaceDownRef.current = true;
      setIsSpaceDown(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      spaceDownRef.current = false;
      setIsSpaceDown(false);
    };
    const blur = () => {
      spaceDownRef.current = false;
      setIsSpaceDown(false);
    };

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // Wheel: Ctrl/Cmd + wheel to zoom around the cursor, otherwise pan
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      if (e.ctrlKey || e.metaKey) {
        setViewport((vp) => zoomAt(vp, cx, cy, -e.deltaY * ZOOM_SPEED));
      } else {
        setViewport((vp) => ({
          ...vp,
          x: vp.x - e.deltaX,
          y: vp.y - e.deltaY,
        }));
      }
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Begin a pan on middle-click, or on left-click while Space is held
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const isPanTrigger =
      e.button === 1 || (e.button === 0 && spaceDownRef.current);
    if (!isPanTrigger) return;
    e.preventDefault();
    setIsPanning(true);
    lastPointRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  // Track the global mouse while panning
  useEffect(() => {
    if (!isPanning) return;

    const onMove = (e: MouseEvent) => {
      const last = lastPointRef.current;
      if (!last) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      lastPointRef.current = { x: e.clientX, y: e.clientY };
      setViewport((vp) => ({ ...vp, x: vp.x + dx, y: vp.y + dy }));
    };
    const onUp = () => {
      setIsPanning(false);
      lastPointRef.current = null;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isPanning]);

  const zoomFromCenter = useCallback((delta: number) => {
    setViewport((vp) => {
      const el = containerRef.current;
      if (!el) return vp;
      const rect = el.getBoundingClientRect();
      return zoomAt(vp, rect.width / 2, rect.height / 2, delta);
    });
  }, []);

  const zoomIn = useCallback(
    () => zoomFromCenter(ZOOM_BUTTON_STEP),
    [zoomFromCenter],
  );
  const zoomOut = useCallback(
    () => zoomFromCenter(-ZOOM_BUTTON_STEP),
    [zoomFromCenter],
  );
  const reset = useCallback(() => setViewport(INITIAL), []);

  return {
    viewport,
    isPanning,
    isSpaceDown,
    containerRef,
    onMouseDown,
    zoomIn,
    zoomOut,
    reset,
  };
}

function zoomAt(vp: Viewport, cx: number, cy: number, delta: number): Viewport {
  const factor = Math.exp(delta);
  const newScale = clamp(vp.scale * factor, MIN_SCALE, MAX_SCALE);
  const ratio = newScale / vp.scale;
  return {
    x: cx - (cx - vp.x) * ratio,
    y: cy - (cy - vp.y) * ratio,
    scale: newScale,
  };
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}
