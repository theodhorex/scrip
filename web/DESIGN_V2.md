# Design v2: dioramas (shared brief for every landing worker)

## Why v2
jitsuinfi.vercel.app feels premium because EACH chapter has one big physical diorama (a press with a lever, a seal desk, a vault) and the interaction happens ON that object: you pull the lever, the seal stamps, the paper drops into the vault. Our v1 had flat boxes plus a form beside them. v2 makes the object the interface.
We borrow principles only (object-as-interface, story captions, real data, tactile detail, generous layout). We do NOT copy their town, Japanese motifs or light-paper palette.

## Look
- Dark blueprint stays (tokens in `src/app/globals.css`: `--bp-canvas`, `--bp-surface`, `--bp-line*`, `--bp-pass`, `--bp-reject`, `--bp-ink`, `--bp-muted`).
- Scenes are ISOMETRIC objects lit from the top-left, drawn with the shared primitives in `src/components/landing/iso/Iso.tsx` (`IsoBox`, `IsoCylinder`, `IsoGround`, `IsoLine`, `IsoShadow`, `isoProject`, `tone`). DO NOT edit `Iso.tsx`; if you need another primitive, define it inside your own scene file.
- Object palette (use these CSS-value constants; mix via `tone()` for shading):
  steel `#8fa3c4`, vault blue `#1f4fd8`, deep navy `#0c1527`, paper `#e8eef7`, brass `#c9a24a` (use sparingly, only for dials and plaques), pass `var(--bp-pass)`, reject `var(--bp-reject)`.
- Tactile detail is the point: ground plate with grid, contact shadows (`IsoShadow`), screws/rivets (tiny circles), engraved plaques with monospace labels, indicator lamps that glow, chamfered edges (a second slightly smaller box on top), cables (`IsoLine`). A scene with fewer than ~12 distinct parts looks empty.
- Colour meaning is fixed: teal = passed/allowed, coral = rejected/leaked. Nothing else is red or teal.
- Type: serif (Fraunces) for chapter titles, Geist for text, Geist Mono for real data, labels, rejection codes.

## Layout per chapter (desktop 1120px container)
Two columns like jitsuinfi: LEFT = chapter label (`02 / The race`), big serif title (2-3 short lines), one short paragraph (max 55 words), one small "try it" hint. RIGHT = the diorama, big (at least 560px wide, viewBox about 720x480). Data/readout panel sits BELOW the diorama, not beside it. At 360-768px the columns stack (title, diorama, panel). Keep text lines under 62ch.

## Interaction rules
- The control is part of the scene: a lever to pull, a dial to turn, a switch to flip, a button on the object. Native inputs (select, range) may exist ONLY as visually hidden / secondary accessible equivalents; the primary control is the object (use `role="button"` / `role="slider"` with keyboard support, visible focus ring).
- Every state change animates the object (lamp turns on, arm moves, packet travels). Motion = CSS transforms/opacity or SVG `transform` only; stop loops when off-screen (see `useAnimationActive.ts`) and respect `prefers-reduced-motion` via `useReducedMotion.ts` (final state static + a "play" button).
- Result text goes in an `aria-live="polite"` region under the diorama with the REAL code (e.g. `OVER_BUDGET`).
- Every number shown comes from the pure modules (`rules.ts`, `guardian.ts`, `landing-data.ts`, `proof-data.ts`), never hard-coded.

## Quality bar (check before you report)
1. Looks like an object, not a diagram: shading on three faces, shadow, at least 12 parts, a lit lamp or glow somewhere.
2. The control acts on the object and the result is readable at a glance (no reading needed to understand pass vs reject).
3. 360px: no horizontal scroll, diorama scales (use `viewBox` + `width:100%`), text >= 13px.
4. `bunx tsc --noEmit`, `bun run lint`, `node --test tests/*.test.mjs src/lib/*.test.mjs` all green (66 tests today; do not delete tests).
5. Do not run `next build/dev/start`; a dev server is already running on :3000 (hot reload). The PM will look at it in the browser.
