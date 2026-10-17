"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

// Ease desktop wheel input without replacing the document's native scroll container.
export function SmoothScroll() {
  const pathname = usePathname();
  useEffect(() => {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const finePointer = matchMedia("(pointer: fine)");
    let frame = 0;
    let target = window.scrollY;
    let previous = 0;
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      target = window.scrollY;
    };
    const maxScroll = () => Math.max(0, document.documentElement.scrollHeight - innerHeight);
    const animate = (time: number) => {
      const elapsed = Math.min(time - previous, 50);
      previous = time;
      target = Math.max(0, Math.min(target, maxScroll()));
      const next = window.scrollY + (target - window.scrollY) * (1 - Math.exp(-elapsed / 85));
      window.scrollTo({ top: Math.abs(target - next) < 2 ? target : next, behavior: "instant" });
      if (Math.abs(target - window.scrollY) > 0.5) frame = requestAnimationFrame(animate);
      else frame = 0;
    };
    const wheel = (event: WheelEvent) => {
      if (reduced.matches || !finePointer.matches || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || !event.cancelable || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      // Let controls, dialogs, and nested scroll areas keep their own wheel behavior.
      const path = event.composedPath();
      for (const node of path) {
        if (!(node instanceof HTMLElement) || node === document.body || node === document.documentElement) continue;
        if (node.matches("input, textarea, select, [role=dialog], [data-native-scroll]")) return;
        const css = getComputedStyle(node);
        if (/(auto|scroll)/.test(css.overflowY) && node.scrollHeight > node.clientHeight) return;
      }
      if (getComputedStyle(document.body).overflowY === "hidden" || getComputedStyle(document.documentElement).overflowY === "hidden") return;
      const delta = event.deltaY * (event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? innerHeight : 1);
      if (!delta) return;
      event.preventDefault();
      if (!frame) target = window.scrollY;
      // Reverse immediately when the wheel changes direction.
      if ((target - window.scrollY) * delta < 0) target = window.scrollY;
      target = Math.max(0, Math.min(target + delta, maxScroll()));
      if (!frame) {
        previous = performance.now();
        frame = requestAnimationFrame(animate);
      }
    };
    window.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("pointerdown", stop, { passive: true });
    window.addEventListener("keydown", stop);
    window.addEventListener("touchstart", stop, { passive: true });
    reduced.addEventListener("change", stop);
    return () => {
      stop();
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("pointerdown", stop);
      window.removeEventListener("keydown", stop);
      window.removeEventListener("touchstart", stop);
      reduced.removeEventListener("change", stop);
    };
  }, [pathname]);
  return null;
}
