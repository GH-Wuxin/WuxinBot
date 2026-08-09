# `toolCallsMade` contract audit

Date: 2026-08-09

## Decision

`RT_TOOL_COUNT_EXACT` is a **known production accounting violation** in the ordinary planner path. It is not an invalid invariant and not a harness observability mismatch.

No production fix is included in this audit. The invariant remains candidate/diagnostic rather than becoming a smoke-blocking enforced invariant.

The confirmed field contract, for a `runToolLoop` invocation that returns a `ToolLoopResult`, is:

> `toolCallsMade` is the number of calls dispatched to `executeToolCallFn` that settled with a `ToolResult`, independent of whether the returned content was safe enough to expose to the LLM.

This is executor-boundary accounting. It does not claim that every call reached an external API or committed a business side effect. If the executor throws, `runToolLoop` currently throws and no `ToolLoopResult.toolCallsMade` value exists to audit.

## Sole reproduction entry

The only reproduction entry for the violation remains:

```text
tools/fixtures/agent-runtime/c1/scenario.min.json
```

It produces one real injected executor invocation, one settled `ToolResult`, one scripted business effect, and `toolConsumed=1/1`, but the terminal result reports `toolCallsMade=0`.

The two additional JSON files are counterfactual controls, not alternate reproduction entries.

## Definition and write-path evidence

The field is declared as a required numeric member of `ToolLoopResult` in `server/bots/executor.ts:2062-2066` and initialized to zero at `server/bots/executor.ts:2113-2116`.

There are three production write patterns:

1. **Required tool:** `toolCallsMade=1` is assigned at `server/bots/executor.ts:2145-2149`, before the executor call at `server/bots/executor.ts:2159-2161`. Every returning required-tool path therefore reports one, including an unsafe result that is replaced by the safety-filter placeholder.
2. **Ordinary final result:** after the executor returns at `server/bots/executor.ts:2426-2429`, a terminal `ToolResult` increments at `server/bots/executor.ts:2444-2452` before returning.
3. **Ordinary non-final result:** after the same executor return, content is checked at `server/bots/executor.ts:2460-2468`. The unsafe branch appends a placeholder and `continue`s. The normal increment at `server/bots/executor.ts:2513-2519` is therefore skipped only by this branch.

The mismatch is branch placement after a completed executor call. It is not caused by an absent executor call.

## Consumer audit

All repository consumers were enumerated with `rg`.

### Production consumers

- The mutable count is passed into `ReasoningInput` at `server/bots/executor.ts:2349-2359` and `server/bots/executor.ts:2565-2575`.
- `resolveReasoningMode` interprets `toolCallsMade > 0 && iterations > 1` as `tool_multi_step` at `server/bot/reasoningRouter.ts:131-150`.
- The current router is Shadow-only, so this changes telemetry/decision records but does not yet select the production model.
- `server/bot.ts` consumes `text`, `usage`, `images`, `directContent`, and `recommendToolCalled`, but does not consume the returned `toolCallsMade`. There is no current QQ delivery or DB accounting dependency on this result field.

### Contract tests and diagnostics

- `tools/repeated-history-verify.mjs:259` explicitly explains its assertion as: `tool must have executed before the crash` and requires `toolCallsMade===1`.
- The required-tool tests at `tools/repeated-history-verify.mjs:71`, `:125`, and `:161` consistently require one executed call to report one.
- Agent Replay copies the returned number at `tools/agent-runtime/runner.ts:84` without deriving it from the trace.
- `RT_TOOL_COUNT_EXACT` independently counts executor-boundary `tool_call` events at `tools/agent-runtime/oracles.ts:195-200`.

There are no other production readers or writers.

## Harness observability audit

The injected adapter records `tool_call` at the entry of the function supplied as `executeToolCallFn` (`tools/agent-runtime/adapters.ts:169-183`). It then consumes exactly one scripted step, records its business effect and settled result, and returns that `ToolResult` to the real `runToolLoop` (`tools/agent-runtime/adapters.ts:204-234`).

The source trace therefore observes the same dependency boundary that production invokes. It does not infer execution from an LLM `tool_calls` declaration. This excludes a harness observability mismatch for this invariant.

## Counterfactual fixtures

### Safe-result control

`counterfactual-safe-result.json` is derived from `scenario.min.json`. It keeps the same planner calls, tool name, arguments, `ok=true`, and business effect. Only the returned content changes from injection-shaped text to `generated safe result 1`.

Result:

```text
executor calls = 1
settled ToolResult = 1
business effects = 1
toolCallsMade = 1
RT_TOOL_COUNT_EXACT = PASS
```

It also changes the second Shadow reasoning reason from `tool_selection` to `tool_multi_step`, proving that the missed accounting is consumed inside production control telemetry.

### Required-tool unsafe control

`counterfactual-required-unsafe.json` returns the exact same unsafe content as the source, but through `requiredTool`.

Result:

```text
executor calls = 1
settled ToolResult = 1
business effects = 1
toolCallsMade = 1
RT_TOOL_COUNT_EXACT = PASS
```

This disproves the alternative contract “only safe/accepted tool results count”: safety acceptance is identical, while accounting differs only by runtime branch.

Both controls replay twice to byte-identical normalized traces and leave the production DB unchanged.

## Classification reasoning

### Not an invalid invariant

The field name, required-tool behavior, terminal-result behavior, explicit regression assertion, and `tool_multi_step` consumer all describe completed executor calls rather than LLM-visible safe results. No code or documentation defines `toolCallsMade` as “accepted results”. The required-tool unsafe counterfactual directly contradicts that interpretation.

### Not a harness mismatch

The harness observes invocation at the injected production executor seam, and the call returns normally. Script consumption, `tool_result`, and the business-effect event independently agree that one call occurred.

### Production accounting bug

Only ordinary non-final unsafe content passes through a `continue` located before `toolCallsMade++`. Changing only result safety flips the reported count from zero to one without changing the number of executor invocations. The violation is therefore production branch-local accounting.

## Operational severity

The current user-facing impact is low:

- `server/bot.ts` discards the returned count;
- no DB usage or billing counter reads it;
- the only production behavior difference is Shadow Reasoning telemetry/decision classification.

The semantic contract violation is nevertheless real and deterministic. It should remain a known diagnostic until a separately authorized production fix decides where executor-boundary accounting must occur and updates this characterization fixture deliberately.
