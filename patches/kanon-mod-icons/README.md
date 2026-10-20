# Kanon lazer Mod icons

Resource overlay for the deployed KanonBot score-card renderer:

- DC (Daycore), DA (Difficulty Adjust), CL (Classic): main badges at 257×77,
  square icons at 60×60 and 118×118.
- `mods/Unknown.png`: a 257×77 grey badge with a question mark. The existing
  renderer places an unknown Mod's acronym on its right. This replaces the
  old 1×1 bright green fallback.

`work/` contains the ten deployment PNGs. `svg/` contains their editable SVG
masters, including embedded official symbols and outlined text. Sizes, colours,
symbol bounds and text placement are recorded in `design-spec.json`.
The palette adapts the existing HT, RX/AP and V2 assets; it is not an official
osu! colour assignment.

## Install

Back up the target files, then merge the contents of `work/` into the Kanon
installation's `work/` directory, retaining the directory structure:

```text
work/mods/{DC,DA,CL,Unknown}.png
work/mods_v2/1x/{DC,DA,CL}.png
work/mods_v2/2x/{DC,DA,CL}.png
```

Copy `ATTRIBUTION.md` and `osu-resources-LICENCE.md` alongside the resource
overlay. If a deployment keeps a separate source resource directory, apply the
same overlay there so a later reinstall retains the icons.

This overlay needs no Kanon executable changes. The deployed renderer
invalidates its local image cache using file size and modification time;
new cards pick up the changed files. Previously sent cards stay unchanged.

The main score-card path was verified through the deployed assembly and
original template, including mixed old/new badges, parameter labels and
unknown two/three-character acronyms. A real HD+DA score on beatmap 3648544
also rendered successfully. The two square sizes were checked for dimensions,
alpha, appearance and file loading; full list/dev-card rendering was not tested.
Other missing Mod icons and those paths' existing skip-on-missing behaviour
are outside this overlay.

See [ATTRIBUTION.md](ATTRIBUTION.md) for asset provenance and licensing.
