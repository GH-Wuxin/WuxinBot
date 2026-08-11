# Console V2 Inventory

> Status: final migration implementation. This file records the frontend routes, real data contracts, polling ownership and retained behavior. Rendered QA remains the acceptance source of truth.

## Source layout

| Area | Source | Responsibility |
|---|---|---|
| App orchestration | `src/App.jsx` | Active page, sole shared `/api/state` owner, global save/toast flow |
| Navigation and shell | `src/components/layout/AppShell.jsx` | Desktop sidebar, narrow top bar/drawer, page header and global runtime actions |
| Shared primitives | `src/components/ui/index.jsx` | Buttons, fields, settings, states, dialogs, list rows and avatars |
| Design tokens | `src/styles/tokens.css` | Color, radius and motion tokens |
| Global rules | `src/styles/globals.css` | Root/body, boot, toast, focus and reduced-motion behavior |
| Component/page styles | `src/styles/components.css` | V2 shell, primitives and route layouts |
| Pages | `src/pages/*/index.jsx` | One standalone component per Console route |

The Console intentionally has no URL router. `App` owns the active page and conditionally mounts exactly one route component.

## Route inventory

| Navigation | Component | Core behavior | State/API ownership | Status |
|---|---|---|---|---|
| 总览 | `DashboardPage` | Runtime health, usage, participation mode and model shortcut | Shared state plus page-owned `/api/health` | V2 |
| 群聊 | `GroupsPage` | Group config, profiles, external Bot routing, experience and destructive group operations | Shared state; no page timer | V2 |
| Agent | `AgentPage` | Deterministic decision sandbox with optional real LLM generation | `POST /api/sandbox` on demand | V2 |
| osu! | `OsuPage` | Bindings, quick routing, external services and player drawer | Page-owned osu! status; conditional analysis timer | V2 |
| 成员 | `MembersPage` | Member policy CRUD, command access and per-member prompt fields | Shared state plus on-demand mutations | V2 |
| 人设 | `PersonaPage` | Bot names and default persona prompt | Dirty local draft; `POST /api/settings` | V2 |
| 记忆 | `MemoryPage` | Generation settings, directory, manual editing, recalculation and deletion | Dirty settings/profile drafts plus on-demand APIs | V2 |
| 关系 | `RelationshipsPage` | Candidates, generation, filtering, expand/edit and delete | On-mount relationship fetch plus on-demand APIs | V2 |
| 画像日志 | `ProfileLogsPage` | Filtered profile-pipeline events and expanded evidence | Fetch on filter change | V2 |
| 模型 | `ModelsPage` | Provider/model, generation, vision, search and participation settings | Dirty local draft plus on-demand search test | V2 |
| 集成 | `IntegrationsPage` | OneBot configuration and actual optional-service status | Dirty local draft plus page-owned osu! status | V2 |
| 权限 | `PermissionsPage` | Roles and per-command minimum permissions | Dirty local draft; `POST /api/settings` | V2 |
| 日志 | `LogsPage` | Messages, decisions, commands, diagnostics export and context clear | Shared state plus on-demand diagnostics | V2 |
| 维护 | `MaintenancePage` | Recalculation, backups, restore and delete | Page-owned recalc status plus backup APIs | V2 |

## Functional parity by route

### Dashboard

- Uses real `/api/state` and `/api/health` values; no Agent telemetry is inferred.
- Keeps 24-hour/7-day usage periods, manual refresh, mention-only mode and model shortcuts.
- Loading, stale-health error and empty usage states are explicit.

### Groups

- Preserves add/edit, enable state, reply mode, hourly limit and cooldown.
- Preserves search/sort, derived names, activity signals, group profile controls and group experience.
- Preserves Yumu, Kanon, Hydrant and LazyBot per-group switches.
- Clear context, clear profile and delete group retain explicit confirmation semantics.
- Group drafts are local and are not replaced by shared-state polling.
- No reliable group avatar URL exists in the current data chain. `GroupAvatar` reserves a stable frame and uses neutral group icon plus initial fallback; it does not guess a Tencent CDN URL.

### Agent

- Preserves group/user selection, temporary policy/mode overrides and context toggles.
- Real LLM generation remains opt-in; the default sandbox request does not call the model.
- Results expose only the real `/api/sandbox` decision, context, prompt and usage payload.
- A manually entered nickname survives shared-state polling.

### osu!

- Preserves binding add/remove, global and group quick routing, external Bot switches and runtime statistics.
- Player drawer keeps overview, BP, recent, PP+, type, badges and analysis tabs.
- Binding removal remains confirmed; loading/error/empty states exist per page and drawer tab.
- All player/service values come from existing backend responses.

### Members, Persona and Models

- Members preserves policy CRUD, attention level, admin-command flag, role, note and prompt fields.
- Persona preserves bot-name and prompt editing.
- Models preserves provider defaults, secret keep-value behavior, generation/vision/search settings and local search test.
- Persona and Models now guard dirty drafts so the App-owned 10-second poll cannot overwrite unsaved work.

### Memory and Relationships

- Memory preserves settings, search, directory selection, metadata, manual editing, recalculation and deletion.
- Relationship profiles preserve candidates, manual pair generation, group/search filters, expand/edit, enable/update and delete.
- Dirty Memory settings/profile values survive polling.
- Large relationship collections render in a bounded internal list instead of creating an unbounded document.

### Profile Logs, Permissions and Logs

- Profile Logs preserves user/event/run filters and expandable real metadata.
- Permissions preserves role CRUD and all command-to-role mappings; dirty data survives polling.
- Logs preserves search, three data families, diagnostics export and confirmed context clearing.
- Large command/log collections use bounded internal scrolling at practical widths.

### Integrations and Maintenance

- Integrations preserves OneBot HTTP/WS/token/identity fields, autodetect, save and connect.
- OneBot is presented as core; external Bots and renderer are optional. Available/degraded/unavailable states use only current API evidence.
- Maintenance preserves recalc start/stop, backup create/restore/delete and existing confirmation behavior.

## Polling ownership

Each source has one mounted owner. Page-owned effects clean up on unmount.

| Source | Interval | Owner |
|---|---:|---|
| `GET /api/state` | 10 s | `App` only |
| `GET /api/health` | 5 s | Mounted Dashboard through `usePollingResource` |
| `GET /api/osu/status` and group Bot config | 10 s | Mounted osu! page |
| `GET /api/osu/status` | 10 s | Mounted Integrations page; mutually exclusive with osu! because routes unmount |
| `GET /api/osu/player/:id/analyze` | 5 s | Open player drawer only while analysis is running |
| `GET /api/recalc-status` | 1.5 s | Mounted Maintenance panel |

There is no second `/api/state` timer in a child page.

## Draft ownership

| Page | Protection |
|---|---|
| Groups | Selected form stays local until save or explicit group selection |
| Agent | Manual nickname has a dirty guard |
| Persona | Dirty guard |
| Memory | Separate settings/profile dirty guards |
| Models | Dirty guard |
| Integrations | Dirty guard |
| Permissions | Dirty guard |

The guards were exercised across an actual 10-second App polling window without saving.

## Shared V2 patterns

- `SectionHeader` for route and panel hierarchy.
- `SettingGroup` / `SettingRow` for compact game-settings layouts.
- `Button` variants for primary, secondary, ghost, warning and destructive semantics.
- `LoadingState`, `EmptyState` and `ErrorState` for consistent async states.
- `ConfirmDialog` for destructive operations.
- `ListRow`, `Pill`, `StatusBadge` and bounded lists for dense data presentation.
- Desktop sidebar above 900px; compact top bar and off-canvas drawer at 900px and below.
- Heavy editor workspaces stack below 1240px before their minimum columns can overflow.

## Legacy cleanup

- `src/App.jsx` now contains only app-level orchestration and route mounting.
- All inline legacy route implementations were removed from `App.jsx` after their standalone V2 replacements were wired.
- `src/styles.css`, the complete white V1 stylesheet, was removed after repository search confirmed that only boot/toast/reset behavior remained live. Those rules now live in `src/styles/globals.css` using V2 tokens.
- The remaining `.legacy-page` selector was removed.
- Earlier dead `src/components/ui.jsx`, `src/components/osu.jsx` and legacy `Connect` implementations remain removed with no call sites.

## Current data limitations surfaced honestly

- Group avatar URLs are unavailable in the current state/API chain, so the Console shows an intentional fallback.
- Optional service status is limited to the probes and fields the backend exposes.
- Relationship/profile endpoints can be slow with large local datasets; the UI shows loading and keeps the final list bounded.
- The Console does not invent queue depth, tool success, reasoning distribution or other unavailable Agent telemetry.
