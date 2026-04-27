"use client";


import { GRID_SIZE } from "@/lib/constants";
import type { Viewport } from "@/lib/types";

type Props = { viewport: Viewport };

export function CanvasGrid({ viewport }: Props) {
  const size = GRID_SIZE * viewport.scale;
  const offsetX = ((viewport.x % size) + size) % size;
  const offsetY = ((viewport.y % size) + size) % size;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{
        backgroundImage:
          "radial-gradient(circle, var(--grid-dot) 1px, transparent 1px)",
        backgroundSize: `${size}px ${size}px`,
        backgroundPosition: `${offsetX}px ${offsetY}px`,
      }}
    />
  );
}
