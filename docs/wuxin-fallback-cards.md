# Wuxin external-query fallback cards

When a bridged query fails, returns no reply, or has no available endpoint, Wuxin renders its own card. Successful replies still come from the requested bot. The fallback never calls a second external bot.

The cards reuse the `/w info` and `/w compare` HTML document, fonts and headless browser. They use a 1280 × 720 dark layout with a circular avatar and cyan accents. Their identity is `WUXIN_QUERY_CARD_V2`; they are query cards, not Skill Profiler results.

Score cards use the selected beatmapset's official full-size background (falling back to the API cover URL); BP lists share the first selected score's artwork across their pages. Profile, PP+ and error cards use the player's profile cover when available. Directional dark overlays preserve readability while keeping the artwork visible. Avatar and background downloads run in parallel through the existing validated image cache, with two- and six-second display budgets. Missing artwork leaves the dark layout usable and never blocks the score result.

Supported replacement data:

- Recent plays and recent passes, including `#N`. Passing scores are selected before applying the ordinal. LazyBot `/rp` retains its passed-score meaning. The latest 100 recent records bound pass lookup; the card labels that limit.
- BP ranks and ranges within 1–100. Lists use eight rows per page, including all 100 records when requested.
- A specific beatmap score with the original BID and Mods filter.
- Public osu!standard player statistics.
- PP+ results from an existing cache or a completed job. This path never starts a new calculation. Cached results show their source and write time.

Unknown fields display `—`; real zero values remain zero. Missing modded stars never fall back to no-mod stars, and custom Mod settings are not replaced by default settings. Player and beatmap mismatches stop delivery. Missing scores, unsupported operations and explicitly requested non-standard modes produce a Wuxin error card. If the local renderer itself fails, the final response explicitly says so in text. No FC/SS estimates or missing skill dimensions are invented.

PNG files live in `DATA_DIR/wuxin-query-cards`, with a 256-file / 128 MiB / seven-day retention limit. The existing bounded avatar cache and serial browser renderer are shared with skill cards. Tests use isolated data directories and mocked transports; no real QQ messages are sent.

Verification (Node 22 with tsx):

```text
node --import tsx tools/wuxin-fallback-verify.mjs
node --import tsx tools/wuxin-fallback-bg-verify.mjs
node --import tsx tools/wuxin-fallback-routing-verify.mjs
node --import tsx tools/score-command-verify.mjs
node --import tsx tools/evidence-requirement-verify.mjs
```

Set `WUXIN_PRODUCTION_DATA_DIR` to the real production directory before running tests. `wuxin-fallback-verify --render` writes fixture previews to `FALLBACK_PREVIEW_DIR`. `FALLBACK_VERIFY_ROOT` lets the routing verifier import a separately installed backend while retaining isolated fixtures. The evidence verifier must also be given an isolated `DATA_DIR`.

For a background preview, set `FALLBACK_BG_FILE` to a downloaded official beatmap JPEG, set `FALLBACK_PREVIEW_DIR`, and run `wuxin-fallback-bg-verify.mjs --render`. Only the artwork is real; the score/player statistics in these previews are labelled test data.
