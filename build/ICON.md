# WuxinBot desktop icon

The master artwork is `build/icon-source.png`. It follows the circular pink / white-rim design of the [official osu!lazer logo](https://github.com/ppy/osu/blob/master/assets/lazer.png), with WuxinBot's existing `w!` lettering.

Generated using the built-in imagegen tool on 2026-10-22. The transparent master is kept in this repository so builds do not depend on the generation tool or a user profile directory.

Run `node tools/build-desktop-icons.mjs` to export the matching build/public PNG and multi-resolution Windows ICO resources. `npm run build` runs this automatically. The ICO contains 16, 20, 24, 32, 40, 48, 64, 96, 128 and 256 pixel entries. Windows executable / installer assets and the web favicon use this same source.

## Generation prompt

```text
Use case: text-localization / logo-brand.
Input image 1 is the official osu!lazer logo and is the visual reference/edit target.
Create the WuxinBot desktop application icon by closely preserving this reference, changing only the central wordmark from "osu!" to exactly "w!" (a lowercase w followed by an exclamation mark).
Preserve the circular silhouette, thick clean white outer rim, vivid pink-to-rose vertical gradient, subtle overlapping outlined triangles inside the pink disc, gentle inner-edge shading, and very soft shadow outside the rim.
The new "w!" must use the same friendly, very round white lettering with rounded terminals and the same restrained soft letter shadow. Upright, not italic. Center it optically inside the disc. Let the lowercase w and exclamation mark together occupy about 58 percent of the disc width, with generous space around the letters and a clear separate round exclamation dot.
Keep the reference composition and finish: a flat front-facing circular logo, not a perspective object, not a 3D badge. No new ornaments, no neon, no dark square tile, no extra text. Smooth crisp app-icon edges. Square high resolution canvas, approximately 90 percent occupied by the circle. Truly transparent background outside the circular logo and its soft shadow; no white or checkerboard background.
```
