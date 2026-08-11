# Console V2 Design Language

## Product direction

Console V2 combines approximately 70% osu!web information structure and density with 30% osu!lazer interaction language. It should feel familiar to the osu! community without copying osu! branding or presenting WuxinBot as an official osu! product.

The console is dark, compact and fast. Pink is an interaction accent, not a page background.

## Color tokens

| Token | Value | Use |
|---|---|---|
| `--v2-bg` | `#17141f` | application background |
| `--v2-sidebar` | `#1d1927` | navigation shell |
| `--v2-surface-1` | `#221e2c` | primary page surface |
| `--v2-surface-2` | `#2a2535` | cards and rows |
| `--v2-surface-3` | `#332d40` | controls and elevated content |
| `--v2-surface-hover` | `#3b3449` | hover feedback |
| `--v2-surface-selected` | `#463247` | selected row or segment |
| `--v2-border` | `#40384d` | normal border |
| `--v2-border-strong` | `#5a4e69` | focus and strong separation |
| `--v2-text` | `#f4f0f7` | primary text |
| `--v2-text-soft` | `#c8bfce` | secondary text |
| `--v2-text-muted` | `#918699` | metadata |
| `--v2-accent` | `#f0649a` | primary action and selection |
| `--v2-accent-hover` | `#ff79ad` | accent hover |
| `--v2-accent-soft` | `rgba(240, 100, 154, .14)` | selected background |
| `--v2-success` | `#74d99f` | healthy / online |
| `--v2-warning` | `#f2c96d` | degraded / caution |
| `--v2-danger` | `#ff7182` | destructive / failed |
| `--v2-info` | `#78b8ff` | neutral operational information |

Color must never be the only carrier of state. Labels, icons or status text accompany semantic colors.

## Surface hierarchy

1. `bg`: the application canvas.
2. `surface-1`: large page regions and sidebar-adjacent content.
3. `surface-2`: cards, list rows and grouped controls.
4. `surface-3`: inputs, selected subregions and elevated controls.
5. `surface-hover` / `surface-selected`: transient interaction states.

Not every region is a card. Lists should primarily use row separation and surface changes; cards are reserved for independent metrics or cohesive control groups.

## Typography

- Font stack: `Segoe UI`, `Microsoft YaHei`, system sans-serif.
- Page title: 24–28 px, 700.
- Section title: 15–18 px, 700.
- Body: 14 px, 400–500.
- Metadata: 12–13 px.
- Numeric metrics use `font-variant-numeric: tabular-nums`.
- Uppercase navigation labels use modest tracking and must not dominate Chinese labels.

## Spacing and density

The base grid is 4 px. Preferred values are 4, 8, 12, 16, 20, 24 and 32 px.

- Compact row height: 44–56 px.
- Standard control height: 36–40 px.
- Dense control height: 30–34 px.
- Page gaps: 16–20 px.
- Card padding: 14–18 px.
- Avoid decorative whitespace larger than 32 px inside working areas.

## Radius, borders and shadows

- Small control radius: 6 px.
- Standard surface radius: 10 px.
- Elevated surface radius: 14 px maximum.
- Pills use `999px` only when their shape communicates tag/status semantics.
- Normal borders are 1 px and low contrast.
- Focus borders use accent plus a visible focus ring.
- Shadows are reserved for dialogs, drawers and floating layers. Normal cards rely on surface contrast.

## Motion

- Fast feedback: 120–140 ms.
- Surface and selection transitions: 160–180 ms.
- Use opacity, color and small transforms only.
- Avoid long spring animations and decorative continuous motion.
- Respect `prefers-reduced-motion: reduce`.

## Controls

### Buttons

- Primary: pink fill, one clear primary action per local region.
- Secondary: surface fill and border.
- Ghost: low-priority navigation or disclosure.
- Danger: red border/fill and destructive wording.
- Disabled: reduced contrast with no hover response.
- Icon-only buttons require an accessible label and tooltip/title.

### Danger hierarchy

| Level | Examples | Treatment |
|---|---|---|
| Caution | pause, disable injection, stop recalculation | warning or secondary button; clear reversible language |
| Destructive | clear context, clear profile, remove binding/policy | danger button plus confirmation |
| Critical | delete group, restore backup, clear all contexts | danger button plus explicit impact summary in modal |

Normal save actions must never share the same visual weight as deletion or data clearing.

### Inputs

- Inputs use `surface-3`, visible border and accent focus ring.
- Labels remain visible; placeholders do not replace labels.
- Error text appears adjacent to the field or operation.
- Password values remain masked and preserve the existing keep-secret behavior.
- Selects use a consistent custom shell while retaining the native accessible control.
- Number inputs use compact decrement/value/suffix/increment controls; sliders pair a visible value with the range.

### Setting groups

- Desktop settings use compact rows: title and secondary explanation on the left, control on the right.
- Below 640 px a setting row stacks copy and control without changing field order.
- Related rows live inside a `SettingGroup`; groups are structural surfaces rather than independent oversized cards.
- Normal, warning and danger actions keep distinct semantic treatments.

### Switches

- A switch represents an immediate boolean state.
- Save buttons are used for multi-field drafts.
- Pending switches disable repeated interaction and show progress where needed.

### Pills and status

- Pills identify modes, roles, sources and compact metadata.
- `StatusDot` is paired with readable status text.
- Success, warning, danger and neutral variants use consistent tokens.
- Avoid using pills as generic decoration.

## Navigation

- Sidebar sections: Overview, Runtime, Context, System.
- Current page uses accent edge/fill and high-contrast text.
- Section labels are visually subordinate to page links.
- Connection/runtime status stays in the sidebar footer.
- Above 900 px the approved grouped sidebar remains unchanged.
- At 900 px and below it becomes a compact top bar plus off-canvas drawer. The drawer supports Escape, backdrop/close controls, `aria-expanded`, `aria-controls` and automatic close after navigation.
- The complete site map never occupies the narrow viewport's first screen or causes horizontal page overflow.

## Lists, cards and detail panels

### List rows

- Prefer avatar/identifier, primary label, one metadata line, compact pills and a disclosure indicator.
- Hover changes surface; selection adds an accent marker.
- Row-level destructive actions belong in the detail panel, not beside the primary selection target.

### Cards

- Metric cards show one metric and one supporting label/status.
- Operational cards group related controls, not arbitrary content.
- Avoid wrapping every paragraph or row in a rounded card.

### Detail panels

- Desktop uses list + detail split layout.
- Heavy editor workspaces (Members, Memory, Relationships and Permissions) stack below 1240 px, before their minimum columns can create document overflow.
- Narrow layouts stack detail after the list or use a full-width drawer.
- Selection, loading, empty and error states must be explicit.
- Large relationship, permission and log collections keep their own bounded scrolling region; they must not turn the whole document into an unbounded record dump.

## Responsive behavior

- 1440p: full grouped sidebar and two-column working layouts.
- 1200px-class desktop: full navigation remains usable; heavy editor workspaces stack before their minimum widths overflow.
- 1080p: metric grids reduce columns; list/detail widths remain practical.
- At 900 px and below: navigation becomes a top bar plus drawer, list/detail stacks and action groups wrap.
- Below approximately 640 px: metrics become one column where needed, settings controls stack, dialogs fit the viewport and primary actions remain reachable.
- No page-level horizontal scrolling is allowed for normal content.

## Forbidden directions

- AI purple-gradient SaaS styling.
- Excessive glassmorphism or translucent blur layers.
- Huge decorative whitespace.
- Excessive large-radius cards.
- Full-page pink surfaces.
- Anime wallpaper or character art as a working background.
- Copying the osu! logo, official wordmarks or branded assets.
- Language or visuals that imply WuxinBot is an official osu! product.
- Fabricated telemetry, placeholder percentages or invented success rates.
