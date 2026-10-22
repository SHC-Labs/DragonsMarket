"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { createClouds, type CloudsInstance } from "@/lib/vendor/canvas-ui/CloudsVanilla";

const subscribe = (notify: () => void) => {
  window.addEventListener("theme-change", notify);
  return () => window.removeEventListener("theme-change", notify);
};

// Volumetric smoke drawn by canvas-ui's Clouds shader over the live page. It drifts on its own and parts around the
// cursor (the wind follows pointer moves anywhere in the window), while the layer itself never takes a click.
// The shader stops off screen and draws a single frame under reduced motion.
export function Smoke({ opacity = 0.42 }: { opacity?: number }) {
  const theme = useSyncExternalStore(subscribe, () => document.documentElement.dataset.theme || "dark", () => "dark");
  const box = useRef<HTMLDivElement>(null);
  const source = useRef<HTMLCanvasElement>(null);
  const output = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!box.current || !source.current || !output.current) return;
    let smoke: CloudsInstance | null = null;
    try {
      smoke = createClouds(
        { source: source.current, content: box.current, output: output.current },
        {
          scale: 1.15, speed: 0.45, cover: 0.08, density: 2.2, shading: 0.45, opacity, shadow: 0,
          wind: 0.9, windRadius: 320, quality: 0.75,
          color: theme === "dark" ? [0.78, 0.71, 0.86] : [0.42, 0.36, 0.48],
        },
        { overlayOnly: true, pointerTarget: window },
      );
    } catch {
      smoke = null; // No WebGL2: no smoke.
    }
    return () => smoke?.destroy();
  }, [theme, opacity]);

  return <div ref={box} className="smoke" aria-hidden="true">
    <canvas ref={source} hidden />
    <canvas ref={output} className="smoke-canvas" />
  </div>;
}
