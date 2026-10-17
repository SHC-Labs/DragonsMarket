"use client";
import { useSyncExternalStore } from "react";
import { Moon, Sun } from "@/components/icons";
const subscribe = (notify: () => void) => {
  window.addEventListener("theme-change", notify);
  return () => window.removeEventListener("theme-change", notify);
};
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, () => document.documentElement.dataset.theme || "dark", () => "dark");
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("council-theme", next); } catch {}
    window.dispatchEvent(new Event("theme-change"));
  };
  return <button type="button" className="theme-toggle" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} onClick={toggle}>{theme === "dark" ? <Sun size={20} variant="TwoTone" /> : <Moon size={20} variant="TwoTone" />}</button>;
}
