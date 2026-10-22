"use client";
import { useEffect, useSyncExternalStore } from "react";
import palette from "@/design/palette.json";
import { Moon, Sun } from "@/components/icons";
const subscribe = (notify: () => void) => {
  window.addEventListener("theme-change", notify);
  return () => window.removeEventListener("theme-change", notify);
};
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, () => document.documentElement.dataset.theme || "dark", () => "dark");
  useEffect(() => {
    // One palette on every page; only the theme changes the browser chrome colour.
    document.documentElement.dataset.palette = "venue";
    const colors = palette.themes;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) meta.content = theme === "light" ? colors.light.bg : colors.dark.bg;
  }, [theme]);
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("council-theme", next); } catch {}
    window.dispatchEvent(new Event("theme-change"));
  };
  return <button type="button" className="theme-toggle" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} onClick={toggle}>{theme === "dark" ? <Sun size={20} variant="TwoTone" /> : <Moon size={20} variant="TwoTone" />}</button>;
}
