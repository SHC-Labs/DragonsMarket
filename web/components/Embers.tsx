"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { createBlaze, type BlazeInstance } from "@/lib/vendor/canvas-ui/BlazeVanilla";

const subscribe = (notify: () => void) => {
  window.addEventListener("theme-change", notify);
  return () => window.removeEventListener("theme-change", notify);
};

// "#d4a2db" -> [0.83, 0.64, 0.86], the shader's colour format.
function rgb(variable: string): [number, number, number] {
  const hex = getComputedStyle(document.documentElement).getPropertyValue(variable).trim().replace("#", "");
  const n = parseInt(hex.length === 3 ? hex.replace(/./g, c => c + c) : hex, 16);
  return Number.isNaN(n) ? [1, 0.6, 0.9] : [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Dragon's breath: sparks and smoke rising behind a section, drawn by canvas-ui's Blaze shader over the live page.
// Dark theme only; Blaze itself stops when off screen and renders a still frame under reduced motion.
export function Embers({ height = 0.75, intensity = 1, spark = "--yes", smoke = "--accent" }: { height?: number; intensity?: number; spark?: string; smoke?: string }) {
  const theme = useSyncExternalStore(subscribe, () => document.documentElement.dataset.theme || "dark", () => "light");
  const box = useRef<HTMLDivElement>(null);
  const source = useRef<HTMLCanvasElement>(null);
  const output = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (theme !== "dark" || !box.current || !source.current || !output.current) return;
    let blaze: BlazeInstance | null = null;
    try {
      blaze = createBlaze(
        { source: source.current, content: box.current, output: output.current },
        {
          height, distortion: 0, speed: 0.55, sparks: 0.55 * intensity, sparkDensity: 1.4, sparkSize: 1.25, layers: 6,
          smoke: 0.35 * intensity, glow: 0.9 * intensity, sparkColor: rgb(spark), smokeColor: rgb(smoke),
        },
        { overlayOnly: true },
      );
    } catch {
      blaze = null; // No WebGL2: the section simply has no embers.
    }
    return () => blaze?.destroy();
  }, [theme, height, intensity, spark, smoke]);

  if (theme !== "dark") return null;
  return <div ref={box} className="embers" aria-hidden="true">
    <canvas ref={source} hidden />
    <canvas ref={output} className="embers-canvas" />
  </div>;
}
