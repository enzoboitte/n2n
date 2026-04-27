"use client";


import { useEffect, useState } from "react";

export function useKeyPress(targetCode: string): boolean {
  const [pressed, setPressed] = useState(false);

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
      if (e.code !== targetCode) return;
      if (isTextField(document.activeElement)) return;
      setPressed(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== targetCode) return;
      setPressed(false);
    };
    const blur = () => setPressed(false);

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [targetCode]);

  return pressed;
}
