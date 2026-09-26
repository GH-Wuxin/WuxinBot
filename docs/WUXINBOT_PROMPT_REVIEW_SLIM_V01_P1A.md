# WUXINBOT_PROMPT_REVIEW_SLIM_V01_P1A

Status: **P1A COMPLETE — tool guidance is single-source generated**

Repository: `G:\QQ-AI-ChatBot`
Predecessor: `WUXINBOT_PROMPT_REVIEW_SLIM_V01_PHASE0`

Artifacts:

- `tmp/prompt_review_slim_v01_p1a/source_mapping.json`
- `tmp/prompt_review_slim_v01_p1a/removed_shadow_copies.json`
- `tmp/prompt_review_slim_v01_p1a/before_after_budget.json`
- `tmp/prompt_review_slim_v01_p1a/verification_summary.json`
- `tmp/prompt_review_slim_v01_p1a/old_tool_note.txt` / `.json` (pre-P1A extracted evidence)
- verify tool: `tools/prompt-review-slim-p1a-verify.mjs`

---

## 1. Canonical source hierarchy

- **Capability facts** -> `server/bots/capabilityCatalog.ts` (via `AGENT_CAPABILITY_META`).
- **Tool schema** -> `buildBotToolSchemas` -> `buildQueryOsuDescriptionFromMeta` (refactored to accept metadata for drift tests; production output unchanged).
- **Bot names** -> `server/bots/registry.ts DEFAULT_BOTS`.
- **Recent selector ids** -> `capabilityCatalog.ts RECENT_BOT_SELECTOR_IDS`.
- **Command facts** -> existing `CommandDescriptor` (`server/bot/commands/*.meta.ts`); P1A does not inject command facts into tool guidance.
- **Non-derivable policy** -> one compact block in `server/bots/toolGuidance.ts HANDWRITTEN_POLICY`.

## 2. Implementation

New: `server/bots/toolGuidance.ts`

- `buildToolGuidance()` — production entry, deterministic, no DB/network/LLM.
- `buildToolGuidanceFromMetadata()` — pure injected-metadata variant used by drift tests.
- Output structure:
  - generated availability line;
  - generated capability names only (no full descriptions dumped; details stay in tool schema);
  - generated bot-name + recent-selector line;
  - compact handwritten policy (10 rules).

Changed:

- `server/bot.ts` — the 1,400-char handwritten literal was replaced with
  `messages[0].content += '\n\n' + buildToolGuidance();` at the same injection point.
- `server/bots/agentCapabilities.ts` — extracted `buildQueryOsuDescriptionFromMeta`; production output is byte-equivalent (1,259 chars).

Not changed: tool schema, injection timing, routing, permissions, KB, persona, rewrite, reviewer.

## 3. Shadow copies removed

See `removed_shadow_copies.json`.

- capability availability sentence: removed from handwritten note, now generated.
- bot names and selector facts: removed from handwritten note, now generated from `DEFAULT_BOTS` / `RECENT_BOT_SELECTOR_IDS`.
- full 1,400-char literal: removed from `bot.ts`.

Still handwritten by design: behavioral policy that metadata does not and should not encode (no fabrication, failure honesty, attribution, BID delivery, bp_type/recommend/pp_calc/recent route rules, osu!std-only, no markup).

## 4. Drift proof

P1A verifier mutates synthetic metadata only:

- adding a test-only capability changes generated guidance;
- adding a test-only bot name changes generated guidance;
- adding a test-only recent selector changes generated guidance;
- mutating a capability description changes `buildQueryOsuDescriptionFromMeta`.

No production metadata is modified by the verifier.

## 5. Prompt budget

| Item | Chars |
|---|---:|
| old handwritten tool note | 1,400 |
| new generated guidance | 1,098 |
| delta | **-302** |
| tool schema | 3,295 (unchanged) |

Path deltas (same Phase0 fixtures):

| Path | Delta |
|---|---:|
| normal chat (no tools) | 0 |
| osu no-tool question | 0 |
| natural-language tool trigger | -302 system guidance |
| KB hit tool path | -302 system guidance |
| serious / owner / profile-heavy (no tools) | 0 |
| analyze reviewer | 0 |

No chars were converted to exact provider tokens.

## 6. Validation

All suites passed; see `verification_summary.json`:

- `npm run typecheck` — PASS
- Phase0 verifier — 45 PASS
- P1A verifier — 63 PASS
- `tools/kb-verify.mjs` — 56 PASS
- `tools/osu-fixture-verify.mjs` — all analyzer fixture tests PASS
- `tools/quick-router-verify.mjs` — 121 PASS
- `tools/vision-verify.mjs` — all vision tests PASS
- `git diff --check` — PASS

## 7. Verdict

**`PROMPT_REVIEW_P1A_PASS`**

**`READY_FOR_P1B_CONDITIONAL_INJECTION = YES`**

P1B may now make the generated guidance conditional on tool exposure / request type without first untangling another handwritten copy.
