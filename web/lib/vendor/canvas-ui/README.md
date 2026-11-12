# canvas-ui (vendored)

`BlazeVanilla.ts`, `canvas-viewport.ts` and `html-in-canvas.ts` are copied from
[DavidHDev/canvas-ui](https://github.com/DavidHDev/canvas-ui) (`src/lib/Blaze`, `src/lib`), under the
MIT + Commons Clause licence in `LICENSE.md`: free to use as part of this product; the components
themselves may not be sold or redistributed on their own.

Local change: `createBlaze` takes `{ overlayOnly }`, used by `components/Embers.tsx` to draw the
ember and smoke layer over the page without the experimental html-in-canvas capture.
