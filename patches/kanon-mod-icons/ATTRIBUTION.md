# Asset sources and modifications

The white Daycore, Difficulty Adjust and Classic symbols are by **ppy / osu!
contributors**, from the official
[osu-resources Mod icons](https://github.com/ppy/osu-resources/tree/master/osu.Game.Resources/Textures/Icons/Mods):
`mod-daycore.png`, `mod-difficulty-adjust.png`, and `mod-classic.png`.

The symbols were retrieved on 2026-10-20. The original PNG bytes are embedded
in the SVG masters. Their supplied licence is **Creative Commons
Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)**; a copy is included
in [osu-resources-LICENCE.md](osu-resources-LICENCE.md).
The repository's MIT licence does not replace the upstream assets' licence.

Adaptation: crop transparent bounds, scale proportionally, add a small display
shadow and place the symbol in a KanonBot-style badge. These assets are not an
official osu! release.

Existing KanonBot `work/mods` and `work/mods_v2` images were used as references
for geometry, palette, borders, shadow and curved background texture.
Letter outlines use Torus SemiBold from the deployed `work/fonts` resource
folder. No font file is distributed here and no new font licence is asserted.
The Unknown badge uses a grey background and question mark, reserving space
for the renderer's dynamic acronym.
