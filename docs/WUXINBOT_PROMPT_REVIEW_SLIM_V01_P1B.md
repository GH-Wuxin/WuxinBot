# WUXINBOT_PROMPT_REVIEW_SLIM_V01_P1B

Status: **P1B COMPLETE — conditional tool-guidance injection**

Repository: `G:\QQ-AI-ChatBot`
Predecessor: `WUXINBOT_PROMPT_REVIEW_SLIM_V01_P1A`

Artifacts:

- `tmp/prompt_review_slim_v01_p1b/baseline_injection_matrix.json`
- `tmp/prompt_review_slim_v01_p1b/policy_scope_map.json`
- `tmp/prompt_review_slim_v01_p1b/capability_scope_matrix.json`
- `tmp/prompt_review_slim_v01_p1b/before_after_budget.json`
- `tmp/prompt_review_slim_v01_p1b/verification_summary.json`
- `tmp/prompt_review_slim_v01_p1b/p1a_guidance_baseline.txt` (P1A full guidance capture)
- `tmp/prompt_review_slim_v01_p1b/tool_schema_baseline.json` (P1A tool schema capture)
- verify tool: `tools/prompt-review-slim-p1b-verify.mjs`

---

## A. Objective and allowed scope

Make the already-single-sourced P1A tool guidance injected only when the current
LLM call needs it, scoped to **deterministic exposed capabilities**. No
architecture refactor; no tool schema, exposed tool set, planner loop, routing,
permission, KB, persona, rewrite or reviewer changes; no provider/model changes.

Architecture reality that bounds the work:

- The exposed tool set is `query_osu` (all callable capabilities in one unified
  schema) plus `get_player_skill`. There is no per-call narrower schema and no
  intent-specific tool list.
- The only deterministic runtime state that narrows a capability is
  `requiredTool` (`query_osu` with `args.capability`), which the deterministic
  router emits for `bp`, `bp_type`, `recent`, `recommend`, `info`.
- Everything else (`useTools` with no required tool) genuinely exposes the
  whole callable catalog, so P1B keeps full guidance. The no-tools path already
  injects nothing and stays unchanged.

Because an additional safe reduction was implemented, the
`P1B_NO_ADDITIONAL_SAFE_REDUCTION` outcome does not apply.

## B. Implementation

Changed:

1. `server/bots/toolGuidance.ts`
   - Added `ToolGuidanceExposure` / `buildToolGuidance(exposure?)`.
   - Added `ToolPolicy` scoping: `GLOBAL_WHEN_ANY_TOOL_EXPOSED` vs
     `CAPABILITY_SCOPED` with `requiredCapabilities`.
   - `buildToolGuidanceFromMetadata(meta, exposure?, policies?)` remains pure
     and deterministic; optional `policies` only exists for synthetic drift
     tests (production uses the canonical `POLICIES` default).
   - Contract:
     - no exposure -> full canonical guidance;
     - `exposedCapabilities: []` -> empty string;
     - any unknown capability id -> fail closed to full guidance;
     - valid subset -> capability list narrowed to that subset, recent
       bot/selector line only for `recent`, global policies always kept,
       capability-scoped policies kept only when their required capability is
       selected.

2. `server/bot.ts`
   - Injection stays a single point at the start of the `useTools` block.
   - After `requiredTool` is resolved, it computes `requiredCapability` only
     for `requiredTool.toolName === 'query_osu'` and a truthy
     `requiredTool.args.capability`.
   - Required-tool path: `buildToolGuidance({ exposedCapabilities: [requiredCapability] })`.
   - All other tool calls: `buildToolGuidance()` (full).
   - Empty guidance is skipped by `if (toolGuidance)`; no-tools path is
     untouched and still injects nothing.

3. New verifier `tools/prompt-review-slim-p1b-verify.mjs` — 345 checks,
   0 failures. It writes all five required JSON artifacts on every run.

Not changed by P1B: tool schema, exposed tool names, `query_osu` enum,
`get_player_skill`, planner caps/loop, deterministic router, `validateOperation`
permission gate, KB, persona, rewrite, reviewer, provider/model.

## C. Injection matrix

`baseline_injection_matrix.json` records every path. Summary:

| Runtime path | P1A chars | P1B chars | Delta per LLM call | Runtime reachable |
|---|---:|---:|---:|:--:|
| no tools | 0 | 0 | 0 | yes |
| tools, no deterministic required tool | 1,098 | 1,098 | 0 | yes |
| required `bp` | 1,098 | 486 | **-612** | yes |
| required `bp_type` | 1,098 | 582 | **-516** | yes |
| required `recent` | 1,098 | 702 | **-396** | yes |
| required `recommend` | 1,098 | 634 | **-464** | yes |
| required `info` | 1,098 | 488 | **-610** | yes |
| required `profile` / `ppplus` / `skill` / `beatmap_lookup` / `pp_calc` / `leaderboard` | 1,098 | 491 / 490 / 489 / 498 / 573 / 495 | -607 / -608 / -609 / -600 / -525 / -603 | builder-only, not claimed as current runtime saving |

`capability_scope_matrix.json` contains the exact per-capability guidance size,
line count, listed capability set, scoped policy ids, global policy ids, and
recent-selector-line presence for all 11 callable capabilities. Every subset is
strictly smaller than full, lists exactly its own capability, keeps all six
global policies, and includes only its own capability-scoped policies.

`policy_scope_map.json` maps:

- 6 global policies -> always present when any capability is exposed.
- 4 capability-scoped policies -> present only for their required capability:
  `bp_type`, `recommend`, `pp_calc`, `recent`.

## D. Prompt budget

Baseline for P1B is P1A behavior: full generated guidance (1,098 chars) is
appended to `messages[0]` whenever tools are enabled; 0 chars when tools are
disabled. P1B changes only the deterministic required-tool path.

Measured guidance-string sizes (`capability_scope_matrix.json`):

| Exposure | Chars |
|---|---:|
| full (P1A baseline) | 1,098 |
| empty | 0 |
| bp | 486 |
| bp_type | 582 |
| recent | 702 |
| recommend | 634 |
| pp_calc | 573 |
| info | 488 |
| profile | 491 |
| ppplus | 490 |
| skill | 489 |
| beatmap_lookup | 498 |
| leaderboard | 495 |

Claimed P1B saving (runtime-reachable deterministic routes only): 396–612 chars
per LLM request on those turns, i.e. 36–56% of the 1,098-char guidance string.

Multi-iteration math — `before_after_budget.json` states it explicitly:

- Logical unique guidance per turn is the string length above.
- The string is appended once to `messages[0]`; `runToolLoop` reuses the same
  `messages` array for up to 4 iterations, so every LLM request in that turn
  carries the same string. Request-visible guidance chars =
  `logical unique chars × number of LLM requests in the turn`.
- Example `bp` turn with 3 LLM requests: P1A = 3 × 1,098 = 3,294;
  P1B = 3 × 486 = 1,458; request-visible delta = 1,836.
- The no-tools path is 0 before and after and is **not** counted as P1B saving.
- Tool schema and all other prompt components are byte-identical on the same
  runtime path, so only the guidance string differs.

No chars were converted to provider tokens.

## E. Equivalence and boundary checks

P1B verifier + full regression suite confirm:

- Full guidance is byte-identical to the captured P1A baseline (1,098 chars).
- Empty exposure returns `''`; unknown capability ids fail closed to full.
- Tool schema JSON is byte-identical to the captured baseline; exposed tool
  names remain exactly `query_osu,get_player_skill`; `query_osu` capability
  enum equals `callableCapabilities()`; `query_osu` description remains
  single-sourced from `AGENT_CAPABILITY_META`.
- Planner loop unchanged: `maxIterations: 4`; `AGENT_MAX_TOOL_CALLS_PER_RESPONSE`
  stays 4 and `AGENT_MAX_TOOL_CALLS_PER_TURN` stays 8.
- Tool exposure still gated by enabled bots; no-tool osu intent still fails
  explicitly; `validateOperation` still runs before the deterministic tool.
- `buildPrompt` still contains no tool guidance; the only production injection
  point is the P1B block in `bot.ts`, which has zero handwritten guidance text.
- Synthetic-only drift tests prove: capability additions, bot-name additions,
  recent-selector additions, and injected capability-scoped policies change
  generated guidance without mutating production metadata.
- Phase0 verifier, P1A verifier, KB, osu fixture, quick router and vision
  suites all pass (see Section F), covering persona/KB/routing/rewrite-adjacent
  surfaces indirectly and directly where those suites assert them.

## F. Validation

All suites passed on branch `refactor/prompt-review-slim-v01`
(created from `4bbcc6ba4c18b01ec11a4145289e955a56511221` on
`fix/onebot-connection-lifecycle`, where the uncommitted Prompt/Review work
originated):

- `npm run typecheck` — PASS
- Phase0 verifier — 45 PASS
- P1A verifier — 63 PASS
- P1B verifier — 345 PASS (new, also writes the five P1B artifacts)
- `tools/kb-verify.mjs` — 56 PASS
- `tools/osu-fixture-verify.mjs` — all analyzer fixture tests PASS
- `tools/quick-router-verify.mjs` — 121 PASS
- `tools/vision-verify.mjs` — all vision tests PASS
- `git diff --check` — PASS

## G. Risks and residuals

`PROMPT_REVIEW_P1B_PASS_WITH_RISKS` is recorded for one architectural residual,
not for an implementation defect:

1. **Required-tool guidance is scoped while the full schema stays callable.**
   The deterministic `requiredTool` is executed before the first LLM call, but
   the model still sees the full `query_osu` enum and may legitimately call
   another capability in a later loop iteration. That later call runs with the
   subset guidance, so the other capability's scoped policy text is absent for
   that turn. P1A carried the full policy set on such turns.
   - Bounding factors: the deterministic router is high-precision for its five
     routes; capability descriptions remain in the full tool schema; the six
     global policies (no fabrication, no numbers without tool, identity
     binding, attribution, osu!std-only, no markup) remain present in every
     subset; and the turn budget is unchanged.
   - Future safe mitigation (not done in P1B because it would touch the planner
     loop): re-scope guidance per LLM request after each tool-call selection,
     or append a small "other capabilities retain their schema rules" safety
     line on required-tool turns. Both were left out deliberately.

2. **Runtime reachable scoping is only five capabilities** (`bp`, `bp_type`,
   `recent`, `recommend`, `info`). The other six subset sizes are proven by the
   builder and recorded as future deterministic-router headroom, but no saving
   is claimed for them today.

3. **Guidance is injected once per turn, not once per loop iteration.** This is
   the intended cost model and is why request-visible and logical-unique char
   math are reported separately.

No schema, exposed-tool-set, planner, routing, permission, KB, persona,
rewrite, reviewer, provider or model changes were made in P1B.

## H. Cost and files touched by P1B

- `server/bot.ts` — replaced the P1A unconditional injection with the
  required-tool-aware conditional injection at the same single point.
- `server/bots/toolGuidance.ts` — added exposure/policy scoping and the
  fail-closed unknown-id contract; full output unchanged.
- `tools/prompt-review-slim-p1b-verify.mjs` — new verifier.
- `tmp/prompt_review_slim_v01_p1b/*` and this document — new artifacts.
- No LLM calls, no log rescan, no full-repo audit, no subagents.

## I. Final verdict

**`PROMPT_REVIEW_P1B_PASS_WITH_RISKS`**

**`PROMPT_SLIM_SHORTLINE_COMPLETE = YES`**

Rationale: the shortline objective is complete — tool guidance is single-sourced
(P1A) and now conditional on the only deterministic capability narrowing the
architecture offers (P1B). The remaining risk is documented in Section G and is
an accepted consequence of keeping the planner loop and tool schema untouched.
