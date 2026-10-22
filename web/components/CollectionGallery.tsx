"use client";
import Image from "next/image";
import { useState, type PointerEvent } from "react";
import { Pause, Play } from "./icons";
const DRAGONS = [
  [991, "Blue dragon robot with glowing green eyes and luminous tendrils in an overgrown city"],
  [992, "Red armored dragon robot with glowing amber eyes in a scorched red wasteland"],
  [993, "Yellow hazard-suit dragon robot with goggles and a respirator in a toxic wasteland"],
  [994, "Cyan wireframe dragon holding a sword on a neon grid"],
  [995, "White, blue and gold mech dragon standing on the Moon with Earth behind"],
  [996, "Rusted metal dragon robot with red slatted eyes and gears against an orange skyline"],
  [997, "White and gold dragon robot with glowing blue eyes and a chest core against a blue sky"],
  [998, "Purple dragon robot with green mesh goggles and a drill arm in a toxic swamp"],
  [999, "Black dragon with violet star eyes crackling with purple lightning"],
  [1000, "Dark gray dragon robot with red eyes and a minigun in front of a burning city"],
] as const;
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
// A slow endless reel that stops under the pointer, so a card can be tilted in place.
// The second copy only makes the loop seamless, so it is hidden from assistive tech.
export function CollectionGallery() {
  const [paused, setPaused] = useState(false);
  const row = (copy: boolean) => <ul className="collection-art-row" aria-hidden={copy || undefined} inert={copy || undefined}>
    {DRAGONS.map(([id, description], i) => <li key={id} className="collection-tilt-card enter" style={{ "--i": i } as React.CSSProperties} onPointerMove={tilt} onPointerLeave={reset} onPointerCancel={reset}>
      <div className="collection-tilt-image"><Image src={`/collection/dragon-${id}.jpg`} alt={copy ? "" : description} width={960} height={960} unoptimized /><span className="collection-glare" aria-hidden="true" /></div>
    </li>)}
  </ul>;
  return <section className="collection-gallery" aria-label="NFT collection" data-paused={paused || undefined} style={{ "--collection-items": DRAGONS.length } as React.CSSProperties}>
    <div className="collection-gallery-heading">
      <h2>The Dragons</h2>
      <p>Ten Dragons from the larger collection.</p>
      <button type="button" className="tape-toggle collection-toggle" aria-label={paused ? "Play the Dragon carousel" : "Pause the Dragon carousel"} onClick={() => setPaused(p => !p)}>{paused ? <Play size={14} /> : <Pause size={14} />}</button>
    </div>
    <div className="collection-carousel">{row(false)}{row(true)}</div>
  </section>;
}
