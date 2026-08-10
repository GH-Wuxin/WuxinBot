# Console V2 Inventory

> Status: Phase 2.5 visual polish plus osu! and Integrations migration. This document is the parity checklist for the Console V2 migration. A checked migration item means the old behavior remains reachable and has been verified against the same backend API.

## Source baseline

| Area | Current source | Baseline |
|---|---|---:|
| App shell and remaining legacy pages | `src/App.jsx` | 1,439 lines after current migrations |
| Styles | `src/styles.css` + `src/styles/*` | Legacy styles retained; V2 tokens/globals/components layered separately |
| osu! console | `src/pages/Osu/index.jsx` | V2 page; legacy component removed |
| UI primitives | `src/components/ui/index.jsx` | V2.1 formal primitives |
| Inline JSX styles | `src/App.jsx` | Remain only in pages not yet migrated |

The frontend has no router. `App` owns the active tab and the shared `/api/state` snapshot. V2 must not add a second owner for that snapshot.

## Page map and migration status

| Existing page / area | V2 destination | Current functions | Phase status |
|---|---|---|---|
| 总览 | Overview / Dashboard | health, usage, OneBot status, model quick switch | **Visual Spike migrated** |
| 群聊 | Runtime / Groups | group configuration, profiles, bot toggles, destructive maintenance | **Visual Spike migrated** |
| 决策沙盒 | Runtime / Agent | sandbox input and optional LLM execution | Legacy content relocated; not visually migrated |
| osu! | Runtime / osu! | bindings, quick routing, bot status, player drawer | **Migrated** |
| 成员 | Context / Members | member policy CRUD and filtering | Not migrated |
| 人设 | Context / Persona | bot names and personality prompt | Not migrated |
| 记忆 | Context / Memory | memory settings, editing, recalculation and deletion | Not migrated |
| 关系 | Context / Relationships | relationship candidates, generation, editing and deletion | Not migrated |
| 画像日志 | Context / Profile logs | filtered profile pipeline logs | Not migrated |
| 模型 | System / Models | provider/model/search settings and search test | Not migrated |
| QQ 连接 | System / Integrations | OneBot settings, autodetect and connect | **Migrated and expanded with real service status** |
| 权限 | System / Permissions | roles and command permissions | Not migrated |
| 日志 | System / Logs | messages, decisions, commands, diagnostics, context clear | Not migrated |
| 备份 / 全局画像重算 | System / Maintenance | backup CRUD/restore and recalculation control | Legacy content relocated; not visually migrated |

## Page contracts

### Dashboard

| Contract | Details |
|---|---|
| Existing functions | Overall health; QQ/OneBot status; LLM latency and recent failures; enabled groups; message/token/reply totals; experience count; 24-hour/7-day token chart; mention-only toggle; manual refresh; model quick switch. |
| API | Shared `GET /api/state`; page-owned `GET /api/health`; `POST /api/settings`. |
| Polling | `/api/state` is owned by `App` at 10 s. `/api/health` is owned by mounted Dashboard at 5 s. |
| Destructive actions | None. Runtime pause remains a global shell action. |
| Loading | App boot state for `/api/state`; health card loading state for `/api/health`. |
| Error | App boot/re-auth error; non-blocking Dashboard health error with retry. |
| Empty | Usage chart empty state when no usage buckets exist. |
| Dependencies | `db.groups`, `db.messages`, `db.stateStats`, `db.usage`, `db.usageStats`, `db.experience`, `db.settings`, `oneBot`. |

Parity checklist:

- [x] Health and OneBot status use real API values.
- [x] Existing usage totals and period switch remain available.
- [x] Model quick switch still writes the same settings endpoint.
- [x] Mention-only mode and manual refresh remain available.
- [x] Sandbox, backup and recalculation are no longer embedded in Dashboard.
- [x] No reasoning distribution, tool success rate or tool timeline is fabricated.

### Groups

| Contract | Details |
|---|---|
| Existing functions | Add/edit group; enable/disable; mode, hourly limit and cooldown; derived group name; search/sort; member/memory/activity signals; group profile automatic update settings; profile injection toggle, generation, manual edit and clear; external bot toggles; per-group context clear; group deletion. |
| API | Shared `GET /api/state`; `POST /api/settings`; `POST /api/groups`; `DELETE /api/groups/:groupId`; `POST /api/clear-context/:groupId`; `POST /api/group-bot-config`; `POST /api/group-profiles/:groupId/update`; `PATCH /api/group-profiles/:groupId`; `DELETE /api/group-profiles/:groupId`. |
| Polling | No page-owned timer. Groups consumes the App-owned `/api/state` snapshot. |
| Destructive actions | Clear group context; delete group and related data; clear group profile. All require an explicit confirmation dialog. |
| Loading | App boot state plus per-operation pending state. |
| Error | Page-level operation error with retry-through-action; optimistic bot toggles roll back on failure. |
| Empty | No configured groups; no search results; no generated group profile. |
| Dependencies | `db.groups`, `db.settings`, `db.messages`, `db.users`, `db.memories`, `db.groupProfiles`, `db.groupBotConfig`, `db.groupExperience`, `db.experience`. |

Parity checklist:

- [x] Add and edit preserve all group fields.
- [x] Search, recent/enabled/name sorting and derived names remain available.
- [x] Enable/disable, clear context and delete group remain available.
- [x] Group profile auto-update and threshold remain editable.
- [x] Profile injection, LLM update, manual edit and clear remain available.
- [x] Yumu, Kanon, Hydrant and LazyBot toggles remain available.
- [x] Existing activity, configured-member, memory and experience signals remain visible.
- [x] Destructive operations have danger-specific confirmation hierarchy.

### osu!

| Contract | Details |
|---|---|
| Existing functions | Player search; binding add/remove; global and group quick routing; per-group external Bot toggles; external Bot status; command statistics and recent records; player profile/BP/recent/PP+/type/badges/analysis drawer. |
| API | `GET /api/osu/status`; `GET/POST /api/group-bot-config`; `POST /api/osu/bindings`; `POST /api/osu/quick`; `GET /api/osu/search`; `GET/POST /api/osu/player/:id/*`. |
| Polling | Mounted page owns a 10 s status/config timer. The player drawer owns one 5 s timer only while the analysis tab reports `running`. |
| Destructive actions | Remove binding uses the V2 confirmation dialog. |
| Loading/error/empty | Page status error, operation error, empty bindings/groups/logs, per-tab loading and errors, and analysis running/error/done states are explicit. |

Parity checklist:

- [x] All legacy endpoints and player drawer tabs remain reachable.
- [x] Binding removal keeps confirmation semantics.
- [x] External Bot and quick-router state comes from existing runtime APIs.
- [x] Player analysis keeps its conditional 5 s polling and does not create a second timer.
- [x] No telemetry or player data is fabricated.

### Integrations

| Contract | Details |
|---|---|
| Existing functions | OneBot HTTP/WS/token/identity settings; autodetect; save and connect; transport/API/session/heartbeat/error evidence. |
| Added presentation | OneBot as a core dependency; Yumu/Kanon/Hydrant/LazyBot as optional services; yumu-image renderer as an optional renderer. |
| API | Shared `GET /api/state`; `GET /api/osu/status`; `GET /api/onebot/autodetect`; `POST /api/settings`; `POST /api/onebot/connect`. |
| Polling | App owns `/api/state`; mounted Integrations owns one 10 s `/api/osu/status` timer. It is mutually exclusive with the mounted osu! page. |
| Draft safety | Settings resync only while the form is clean. App polling cannot replace a dirty draft. |
| Status evidence | OneBot state uses the shared snapshot; external Bot availability uses backend TCP probes; renderer uses `listeningPort` and authenticated-client presence from `RenderServer`. |

Parity checklist:

- [x] All legacy OneBot fields, autodetect and save/connect remain available.
- [x] Secret keep-value semantics remain unchanged.
- [x] Core and optional services are visually distinct.
- [x] `Available`, `Unavailable` and `Degraded` are derived only from runtime evidence.
- [x] Dirty drafts survive the 10-second shared-state polling cycle.

### Legacy pages retained after Phase 2.5

| Page | API endpoints | Destructive / important actions | Async state |
|---|---|---|---|
| Agent / Sandbox | `POST /api/sandbox` | Optional real LLM call controlled by existing checkbox | request loading/error/result |
| Persona | `POST /api/settings` | overwrite prompt and bot names | local draft/save toast |
| Models | `POST /api/settings`, `POST /api/search/test-local` | replace provider/model/search configuration | test loading/result |
| Members | `POST /api/users`, `DELETE /api/users/:groupId/:userId` | remove policy | local filters/form |
| Memory | `POST /api/settings`, `POST/DELETE /api/memories/:userId`, `POST /api/memories/:userId/recalculate` | delete memory; recalculate against stored data | dirty draft, recalculation state |
| Profile logs | `GET /api/profile-logs` | none | fetch on filter changes |
| Relationships | `GET /api/relationship-profiles`, `POST /update`, `PATCH/DELETE /:groupId/:userA/:userB` | delete profile; regenerate | fetch on data stamp; per-item pending |
| Permissions | `POST /api/settings` | remove role and remap commands | dirty draft |
| Logs | `GET /api/diagnostics`, `POST /api/clear-context` | clear all contexts/logs | local filtering |
| Maintenance | `GET/POST/DELETE /api/backups*`, `GET /api/recalc-status`, `POST /api/recalc`, `POST /api/recalc/stop` | restore/delete backup; start/stop recalculation | backup operation state; recalc polling |

## Polling ownership

One data source has one timer owner. Consumers receive shared state or mount the sole owner only on the page that needs it.

| Data source | Endpoint | Interval | Unique owner | Consumers |
|---|---|---:|---|---|
| Console state | `GET /api/state` | 10 s | `App` | shell, Dashboard, Groups and all legacy pages |
| Health | `GET /api/health` | 5 s | mounted Dashboard | Dashboard health/status cards |
| Recalculation progress | `GET /api/recalc-status` | 1.5 s | mounted Maintenance panel | Maintenance only |
| osu! status and bot config | `GET /api/osu/status`, `GET /api/group-bot-config` | 10 s | mounted `OsuPage` or `IntegrationsPage`; never both because pages unmount on navigation | osu! or Integrations page |
| Player analysis | `GET /api/osu/player/:id/analyze` | 5 s while running | mounted player drawer analysis tab | player drawer only |

Rules:

1. A V2 child must consume the App state snapshot instead of polling `/api/state`.
2. A page-owned timer is created only while that page is mounted and must be cleared on unmount.
3. Moving a component must move its ownership; the old owner must be removed before the new owner is mounted.
4. No timer may be started from both a page and its child card.

## Removed legacy code

- `src/components/osu.jsx` was removed after `App` moved to `src/pages/Osu/index.jsx`; repository search has no remaining import or `<Osu>` call site.
- The legacy `Connect` function was removed after `App` moved to `src/pages/Integrations/index.jsx`; repository search has no remaining definition or call site.
- `src/components/ui.jsx` was removed during the Visual Spike after confirming it had zero imports. Formal primitives live in `src/components/ui/index.jsx`.

No other legacy page implementation was removed in Phase 2.5.

## Global migration gate

- [x] All old operations remain reachable.
- [x] No backend Agent runtime semantics changed.
- [x] No new API or fabricated telemetry was introduced.
- [x] Polling ownership matches the table above.
- [x] New V2 code does not add broad inline-style debt.
- [x] Loading, error and empty states exist for migrated pages.
- [x] Destructive actions use an explicit danger hierarchy.
- [x] Typecheck, build, check and relevant frontend verifiers pass.
- [x] 1440p, 1080p and narrow-window layouts are visually reviewed.

## Visual Spike verification

- `npm run check`: passed (`typecheck`, production build, sanity and security).
- Production build: 1,761 modules transformed; final CSS 30.90 kB and JavaScript 320.68 kB before gzip.
- Browser review: Dashboard and Groups at 2560×1440, 1920×1080, 760×900 and 500×900. No document-level horizontal overflow was observed. At 500 px, the grouped navigation intentionally owns its horizontal scrolling.
- Dashboard: `/api/health` now accepts the endpoint's successful payload even though health data does not use the standard `{ ok: true }` envelope; health, usage and runtime cards rendered from the live local API.
- Groups: selection, create mode, 10-second polling during an unsaved edit, and all three confirmation dialogs were exercised. The draft remained unchanged across the shared-state poll. Confirmation dialogs were cancelled; no destructive action was executed.
- Groups create mode no longer evaluates confirmation copy against a null selected group.
- Hidden V2 switch inputs now override the legacy global `input { width: 100% }` rule, preventing document-level overflow.
- `npm run verify-all`: 65/67 passed. The two failures were `agent-runtime-c2-verify.mjs` and `agent-runtime-verify.mjs`; both observed the production DB changing while the live bot was running. No frontend verifier failed, and this spike did not modify those runtime verifiers.

## Phase 2.5 verification

- HMR root ownership moved to `src/main.jsx`; the browser console remained free of duplicate-root warnings after live updates.
- Navigation uses the approved desktop sidebar above 900 px and an accessible top bar plus off-canvas drawer at 900 px and below. Escape, backdrop, close button and page navigation all close the drawer.
- Group avatar audit found no avatar URL in the current `db.groups`, OneBot `get_group_info` response or existing helper chain. `GroupAvatar` therefore reserves a stable frame and implements future real URL support with neutral group-icon and initial fallback, without inventing a CDN contract.
- osu! and Integrations use the formal V2 form and service patterns. No page-level overflow was found at 2560×1440, 1920×1080, 760×900 or 500×900.
- Integrations dirty HTTP endpoint draft remained unchanged across an 11-second shared-state polling window.
