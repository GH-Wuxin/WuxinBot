# BP100 .osu corpus — [SHK]Wuxin (osu! standard)

Source export: `tmp/SHK-Wuxin-bp100-osu-2026-09-20.json`
(osu! API v2, `/users/19244792/scores/best?limit=100&mode=osu`)
Generated 2026-09-20 by the local agent.

## Layout

```
osu/<beatmap_id>.osu            100 raw .osu files, one per BP entry
manifest.json                   per file: expected md5, actual md5, source host, format flags, BP linkage
mod_difficulty_attributes.json  official ppy difficulty attributes per EXACT mod set
join_index.csv / .json          flat BP -> beatmap -> file -> official attributes table
README.md                       this file
```

## Coverage — this is the point of the package

* BP100 holds **100 unique beatmaps for 100 scores**: a strict 1:1 mapping, no map is
  shared between two BP entries. Every BP can therefore join a .osu file, not a subset.
* **100 / 100 md5 verified, 0 mismatch, 0 download failure, 0 missing files.**
* Verification is byte-exact, not similarity-based: `beatmap.checksum` from the osu! API v2
  *is* the md5 of the .osu file, so each downloaded file was hashed and compared against it.
* Verified a second time by an independent pass that re-hashed every file on disk rather than
  trusting the downloader's own bookkeeping: 100/100 OK.
* All 100 maps have status `ranked` — no graveyard / deleted / lazer-only edge cases.
* 100 files, 5.84 MB total.

## Mod sets — one per BP entry

| mods | count |
|---|---|
| HD   | 54 |
| HDHR | 43 |
| HDDT | 3  |

**All 100 entries carry HD**, so the HD AR adjustment applies to the whole corpus.

The 3 HDDT entries:

| BP | beatmap_id | official modded SR |
|---|---|---|
| BP36 | 2850905 | 7.476 |
| BP59 | 4583961 | 6.787 |
| BP90 | 4570744 | 6.856 |

## Official difficulty attributes — read carefully

`mod_difficulty_attributes.json` comes from `POST /beatmaps/{id}/attributes` with the exact
mod array of that BP score. The endpoint returns exactly these fields:

```
star_rating, max_combo, aim_difficulty, aim_difficult_slider_count,
speed_difficulty, speed_note_count, slider_factor,
aim_difficult_strain_count, speed_difficult_strain_count
```

Notes that matter for joining:

* It does **not** return `approach_rate` or `flashlight_rating`. Do not expect an AR oracle
  here; the modded AR must still come from your own runtime (or be derived from the .osu AR
  header plus the HD rule).
* `beatmap.difficulty_rating` inside the score objects is the **nomod** star rating
  (range 4.626 – 7.491 across this corpus).
* `official_star_rating` here is the **modded** star rating for that exact mod set
  (range 6.586 – 7.865). That is the number to compare against when validating the local
  ppy-derived runtime on these 100 maps — e.g. BP1 Humiliation Supreme [Extreme] +HDHR is
  nomod 6.59691 but modded 7.39855.
* These are **aggregate** attributes: no per-object strains, no strain episodes, no peak
  `currentStrain`, no performance retention. They are an independent oracle for modded SR and
  attribute-level parity only — **not** a substitute for the local ppy runtime and **not** a
  source for nine-axis demand / retention values.

## Base (nomod) AR in the .osu headers

97 maps at AR 9.x, 3 maps at AR 8.x, before the HD adjustment.

## Integrity

Per-file md5 is recorded in `manifest.json` (`expected_md5` / `actual_md5` / `verified`).
Any merge into an existing corpus can be validated file-by-file with those hashes; the 20 maps
already present locally will be byte-identical.
