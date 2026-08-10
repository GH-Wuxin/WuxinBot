# Third-Party Notices

This project includes or derives from the following third-party software.
The root `LICENSE` (MIT) covers WuxinBot's own code only; each notice below
states the license that applies to the corresponding files.

## YumuBot (yumu-bot)

- Upstream: <https://github.com/yumu-bot/yumu-bot>
- License: Apache License 2.0
- Source commit: `420ed650fa41ed8193e9fa1dc4c675cb4923a841`
- Full license text: [LICENSE.yumu-bot](LICENSE.yumu-bot)

### Upstream files used

| Upstream file | Derived file in this repository |
| --- | --- |
| `src/main/java/com/now/nowbot/model/match/MatchRating.kt` | `server/osu/matchRating.ts` |
| `src/main/java/com/now/nowbot/model/match/MatchListener.kt` | `server/osu/match.ts` |
| `src/main/java/com/now/nowbot/service/messageServiceImpl/MatchListenerService.kt` | `server/osu/match.ts` |

### Modifications

The derived files are TypeScript ports with Wuxin-side changes, including:

- `server/osu/matchRating.ts`: translated rating model, snake_case JSON
  serialization compatible with yumu-image panels `E7`/`F3`.
- `server/osu/match.ts`: translated match listener architecture, plus
  Wuxin-specific polling bounds (`POLL_INTERVAL_MS`, `TIMEOUT_MS`), group and
  user limits, group binding persistence, the rendering/sending pipeline,
  event-order serialization and cursor fixes.

Modified files carry an `SPDX-License-Identifier: Apache-2.0` header. Both the
MIT and Apache-2.0 licenses require retaining the notices above when the
software is redistributed.
