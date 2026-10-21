"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ComponentProps } from "react";

// ClickPowerUp interaction adapted for our links and native radio labels.
// Reference: https://www.evilbuttons.com/docs/click-power-up
export function usePowerUp() {
  const [powered, setPowered] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  function powerUp() {
    clearTimeout(timer.current);
    setPowered(true);
    timer.current = setTimeout(() => setPowered(false), 500);
  }
  return { "data-powered": powered || undefined, onClick: powerUp };
}

export function PowerUpLink({ className = "", onClick, ...props }: ComponentProps<typeof Link>) {
  const effect = usePowerUp();
  return <Link {...props} {...effect} className={`power-up-control ${className}`} onClick={event => {
    onClick?.(event);
    if (!event.defaultPrevented) effect.onClick();
  }} />;
}

export function PowerUpVisual() {
  return <span className="power-up-visual" aria-hidden="true">
    <span className="power-up-panel" />
    <span className="power-up-flash" />
    { ["tl", "tr", "bl", "br"].map(corner => <span key={corner} className={`power-up-corner power-up-${corner}`} />) }
  </span>;
}
