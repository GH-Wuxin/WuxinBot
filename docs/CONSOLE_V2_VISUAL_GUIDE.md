# Console V2 Visual Guide

This is the concise implementation guide for the Console that exists today. The rendered product and the CSS tokens remain the source of truth.

## Principles

- Use osu!web-like information hierarchy and density with restrained osu!lazer-like interaction feedback.
- Keep the application dark, compact and practical. Pink marks selection and primary action; it is not a decorative page fill.
- Prefer deterministic, real runtime values. Missing data gets an unavailable/empty state, never invented telemetry.
- Avoid generic SaaS spacing, nested card stacks and large decorative empty areas.

## Page hierarchy

1. Shell page title and global runtime actions.
2. Route `SectionHeader` with a concise eyebrow, title, explanation and local action.
3. Cohesive panels or `SettingGroup` sections.
4. Dense rows, lists and controls.

The content area is centered and capped on wide screens. Independent sections use a 14–18px working rhythm; metadata stays visually subordinate.

## Surfaces and typography

- Canvas: `--v2-bg`; navigation: `--v2-sidebar`.
- Primary panels: `--v2-surface-1`; rows/groups: `--v2-surface-2`; controls: `--v2-surface-3`.
- Normal borders use `--v2-border`; selected/focused content uses the accent or strong border.
- Page titles are 24–28px. Section titles are 15–18px. Body text is 14px; metadata is 10–12px.
- Numeric values use tabular figures. Long IDs/names truncate or wrap within their own container and never widen the document.

## Controls and action hierarchy

- Primary: one clear local commit action.
- Secondary/ghost: navigation, refresh and disclosure.
- Warning: reversible interruption such as pause or stop.
- Danger: deletion, restore or clearing; pair with explicit impact copy and confirmation.
- Labels remain visible. Selects retain native semantics. Number controls and sliders always expose their current value.
- Dirty multi-field forms keep local state across the shared 10-second poll until save or explicit navigation.

## Lists and states

- Dense list rows carry identity, one metadata line, compact pills and local disclosure/actions.
- Very large collections use bounded internal scrolling. Loading, empty and error content uses the shared state family.
- Optional integrations distinguish configured, available, degraded and unavailable only when the backend provides evidence.
- Group avatars reserve a stable frame. Current data uses the neutral group icon/initial fallback because no reliable real avatar URL is exposed.

## Responsive behavior

- Wide desktop: grouped sidebar and multi-column workspaces.
- Below 1240px: heavy editor workspaces stack before minimum widths can overflow.
- At 900px and below: compact top bar plus off-canvas navigation drawer; route content uses the full width.
- Below 640px: settings rows and action groups stack, metrics reduce to one column where necessary, and dialogs stay inside the viewport.
- Document-level horizontal scrolling is a defect. Long data lists may scroll inside their designated region.

## Accessibility and motion

- All interactive elements use semantic buttons, inputs or labels.
- Icon-only actions require accessible labels and titles.
- Focus-visible rings use the accent token; status meaning includes text or icons, not color alone.
- Escape closes the navigation drawer and confirmation dialogs.
- Motion stays under 180ms for normal feedback and respects `prefers-reduced-motion`.

## Avoid

- White V1 panels, generic admin templates, glassmorphism and decorative gradients.
- Huge single-number cards or deep card-within-card nesting.
- Every action/status using pink.
- Unbounded record dumps and rigid minimum widths that create empty or overflow regions.
- Fake charts, guessed avatar/CDN URLs or unavailable runtime metrics.
