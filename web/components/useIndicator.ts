"use client";

import { useLayoutEffect, type RefObject } from "react";

const ACTIVE = '[aria-pressed="true"], [aria-current="page"], [aria-selected="true"]';

// Positions a container's sliding indicator under its active child by setting --seg-x and --seg-w.
// The indicator only appears once measured (data-ready), so the first paint never shows it in the wrong place.
export function useIndicator(ref: RefObject<HTMLElement | null>, key: unknown) {
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const place = () => {
      const active = box.querySelector<HTMLElement>(ACTIVE);
      if (!active || !active.offsetWidth) {
        box.removeAttribute("data-ready");
        return;
      }
      box.style.setProperty("--seg-x", `${active.offsetLeft}px`);
      box.style.setProperty("--seg-w", `${active.offsetWidth}px`);
      box.setAttribute("data-ready", "");
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(box);
    document.fonts?.ready.then(place).catch(() => {});
    return () => observer.disconnect();
  }, [ref, key]);
}
