# osu! console refresh

Frontend-only refresh, based on `884dd8c` (2026-09-07).

## Scope

- osu!-inspired dark berry palette, pink song-select accents, double-ring Wuxin mark and reduced-motion support. Shared styling lives in `src/styles/osu-console.css`.
- Overview prioritizes usage. 24-hour, 7-day and lifetime views update the same input/output/cache breakdown. Natural-day counters are explicitly separate. Exact totals and additional token details remain expandable.
- Cache hit rate uses only measured input, not older input without cache coverage. Quota windows use their returned duration and preserve unknown values; local tokens are not presented as account quota.
- Model settings retain their draft/save and login handlers, organized by account, conversation, capabilities and participation. The summary uses saved effective settings, not an unsaved draft. Advanced executable paths remain editable.
- Logs use a paginated request list and one detail panel, correlating only stable identifiers. Filters cover failures, active requests, silence, recorded token usage and completed-request duration. Missing/truncated trace usage stays unknown, not zero.
- Mobile navigation and log list/detail views are separate. Controls retain visible focus; a selected detail and the return action move keyboard focus to the corresponding region.

No server, provider transport, credentials, conversation policy or stored configuration changes are required. No new runtime dependencies are added. The overview's new quota read is a status request, not a model invocation.

Copy follow-up: remove promotional slogans, decorative English overlines, the footer signature and redundant UI descriptions across all 14 pages. Use direct functional headings, place the period selector in the usage card, and retain statistical definitions, risk warnings and operational constraints. Keep this cleanup as a separate revertible commit.

## Verification

`npm run check` includes the new `npm run console:verify` suite. It uses pure fixtures and real React server rendering without a running bot or production database. Existing server checks use their existing isolated fixtures.

Browser QA: desktop 1265×713 and mobile 390×844; period switches, model section switches, log filtering/empty results, mobile detail/back navigation, overflow checks and a shared-style smoke check on Groups. Read-only UI testing against the existing backend: no model-switch, save, pause, logout or clear-context actions.

## Rollback

Keep the refresh in a single Git commit. Use `git revert <refresh-commit>` to reverse this change without rewriting history, then `npm run build` and reload the frontend. A Vite development server reads the changed source directly. No database restore, re-login or backend restart is needed for a frontend rollback.

Do not copy or overwrite runtime data. Preserve unrelated later commits; do not use a hard reset.
