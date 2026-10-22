"use client";
import Image from "next/image";
import type { PointerEvent } from "react";
const DESCRIPTIONS = ["Yellow robot with green helmet accents, protective goggles and a respirator", "Dark armored robot with red eyes against a burning city", "Blue robot with glowing green eyes and luminous tendrils", "Weathered metal robot with red vented eyes against an orange skyline"];
// Pointer tilt with a glare that follows the cursor across the artwork.
function tilt(event: PointerEvent<HTMLElement>) {
  if (event.pointerType === "touch") return;
  event.currentTarget.dataset.tilting = "true";
  const bounds = event.currentTarget.getBoundingClientRect();
  const x = (event.clientX - bounds.left) / bounds.width - .5;
  const y = (event.clientY - bounds.top) / bounds.height - .5;
  event.currentTarget.style.setProperty("--tilt-x", `${-y * 22}deg`);
  event.currentTarget.style.setProperty("--tilt-y", `${x * 22}deg`);
  event.currentTarget.style.setProperty("--glare-x", `${(x + .5) * 100}%`);
  event.currentTarget.style.setProperty("--glare-y", `${(y + .5) * 100}%`);
}
function reset(event: PointerEvent<HTMLElement>) {
  delete event.currentTarget.dataset.tilting;
  event.currentTarget.style.setProperty("--tilt-x", "0deg");
  event.currentTarget.style.setProperty("--tilt-y", "0deg");
}
export function CollectionGallery() {
  return <section className="collection-gallery" aria-label="NFT collection">
    <div className="collection-gallery-heading"><h2>The Dragons</h2><p>Four Dragons from the larger collection.</p></div>
    <div className="collection-art-row">{DESCRIPTIONS.map((description,i)=><figure key={description} className="collection-tilt-card enter" style={{ "--i": i } as React.CSSProperties} onPointerMove={tilt} onPointerLeave={reset} onPointerCancel={reset}>
      <div className="collection-tilt-image"><Image src={`/collection/council-${String(i+1).padStart(2,"0")}.jpg`} alt={description} width={1600} height={1600} unoptimized /><span className="collection-glare" aria-hidden="true" /></div>
    </figure>)}</div>
  </section>;
}
