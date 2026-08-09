import { createHash } from 'node:crypto';
import fc, { type Arbitrary, type Command } from 'fast-check';
import { parseReplayScenario } from './scenario.js';
import {
  GENERATOR_VERSION,
  SCHEMA_VERSION,
  TRACE_VERSION,
  type JsonValue,
  type OracleSpec,
  type ReplayLlmStep,
  type ReplayScenario,
  type ReplaySettlementPlan,
  type ReplayToolSchema,
  type ReplayToolStep,
} from './types.js';

export const C2_ARTIFACT_SCENARIO = 'tools/fixtures/agent-runtime/c2/scenario.min.json';

export type C2Behavior = 'normal' | 'final_batch' | 'retry_destructive' | 'bounded_failures';
export type C2Settlement = 'immediate' | 'late' | 'duplicate' | 'reordered';
export type C2Control = 'none' | 'abort' | 'timeout';

interface C2Model {
  behavior?: C2Behavior;
  settlement?: C2Settlement;
  control?: Exclude<C2Control, 'none'>;
}

interface C2Builder extends C2Model {
  semanticSteps: string[];
}

class BehaviorCommand implements Command<C2Model, C2Builder> {
  constructor(readonly value: C2Behavior) {}
  check(model: Readonly<C2Model>): boolean { return model.behavior === undefined; }
  run(model: C2Model, builder: C2Builder): void {
    model.behavior = this.value;
    builder.behavior = this.value;
    builder.semanticSteps.push(`behavior:${this.value}`);
  }
  toString(): string { return `Behavior(${this.value})`; }
}

class SettlementCommand implements Command<C2Model, C2Builder> {
  constructor(readonly value: C2Settlement) {}
  check(model: Readonly<C2Model>): boolean { return model.settlement === undefined; }
  run(model: C2Model, builder: C2Builder): void {
    model.settlement = this.value;
    builder.settlement = this.value;
    builder.semanticSteps.push(`settlement:${this.value}`);
  }
  toString(): string { return `Settlement(${this.value})`; }
}

class ControlCommand implements Command<C2Model, C2Builder> {
  constructor(readonly value: Exclude<C2Control, 'none'>) {}
  check(model: Readonly<C2Model>): boolean { return model.control === undefined; }
  run(model: C2Model, builder: C2Builder): void {
    model.control = this.value;
    builder.control = this.value;
    builder.semanticSteps.push(`control:${this.value}`);
  }
  toString(): string { return `Control(${this.value})`; }
}

function commandArbitrary(): Arbitrary<Command<C2Model, C2Builder>> {
  return fc.oneof(
    { weight: 4, arbitrary: fc.constantFrom<C2Behavior>(
      'normal', 'final_batch', 'retry_destructive', 'bounded_failures',
    ).map((value) => new BehaviorCommand(value)) },
    { weight: 4, arbitrary: fc.constantFrom<C2Settlement>(
      'immediate', 'late', 'duplicate', 'reordered',
    ).map((value) => new SettlementCommand(value)) },
    { weight: 2, arbitrary: fc.constantFrom<Exclude<C2Control, 'none'>>(
      'abort', 'timeout',
    ).map((value) => new ControlCommand(value)) },
  );
}

export function c2CommandsArbitrary(
  maxCommands = 3,
): Arbitrary<Iterable<Command<C2Model, C2Builder>>> {
  return fc.commands<C2Model, C2Builder>([commandArbitrary()], {
    maxCommands,
    size: 'small',
    disableReplayLog: false,
  });
}

function settlementPlan(kind: C2Settlement, callIndex: number): ReplaySettlementPlan | undefined {
  const base = 4 + callIndex * 4;
  switch (kind) {
    case 'immediate': return undefined;
    case 'late': return { atTick: base };
    case 'duplicate': return { atTick: base, duplicateAtTicks: [base + 1] };
    // The duplicate-labelled resolver wins first. Native Promise settlement
    // still accepts only one value; this is a deterministic ordering probe.
    case 'reordered': return { atTick: base + 2, duplicateAtTicks: [base] };
  }
}

function toolCall(id: string, name: string, args: Record<string, JsonValue>) {
  return { id, name, args };
}

function toolStep(args: {
  name: string;
  target: string;
  ordinal: number;
  settlement: C2Settlement;
  ok?: boolean;
  final?: boolean;
  effectKey?: string;
}): ReplayToolStep {
  return {
    outcome: 'return',
    expect: { name: args.name, args: { target: args.target } },
    ...(settlementPlan(args.settlement, args.ordinal) ? {
      settlement: settlementPlan(args.settlement, args.ordinal),
    } : {}),
    ...(args.effectKey ? {
      effects: [{
        kind: 'destructive_write',
        class: 'business',
        data: { idempotencyKey: args.effectKey, target: args.target },
      }],
    } : {}),
    result: {
      ok: args.ok !== false,
      content: args.ok === false ? 'deterministic failure after boundary work' : `result for ${args.target}`,
      ...(args.ok === false ? { error: 'fixture_failure' } : {}),
      ...(args.final ? { final: true, directContent: `terminal payload for ${args.target}` } : {}),
    },
  };
}

function buildRuntimeScript(behavior: C2Behavior, settlement: C2Settlement): {
  llmSteps: ReplayLlmStep[];
  toolSteps: ReplayToolStep[];
  toolSchemas: ReplayToolSchema[];
  expectedLlmConsumed: number;
  expectedToolConsumed: number;
  expectedToolTotal: number;
  expectedSettlementAttempts: number;
  expectedAcceptedSettlements: number;
  hasFinal: boolean;
  maxIterations: number;
  firstTool: { name: string; args: Record<string, JsonValue> };
} {
  const attemptsPerTool = settlement === 'immediate' ? 0 :
    (settlement === 'late' ? 1 : 2);
  if (behavior === 'final_batch') {
    const first = toolCall('final_call', 'destructive_final', { target: 'locked-player' });
    const skipped = toolCall('skipped_call', 'must_not_execute', { target: 'forbidden-player' });
    return {
      llmSteps: [{ outcome: 'return', text: '', toolCalls: [first, skipped] }],
      toolSteps: [
        toolStep({ name: first.name, target: 'locked-player', ordinal: 0, settlement, final: true, effectKey: 'final-once' }),
        toolStep({ name: skipped.name, target: 'forbidden-player', ordinal: 1, settlement, effectKey: 'must-not-run' }),
      ],
      toolSchemas: [{ name: first.name }, { name: skipped.name }],
      expectedLlmConsumed: 1,
      expectedToolConsumed: 1,
      expectedToolTotal: 2,
      expectedSettlementAttempts: attemptsPerTool,
      expectedAcceptedSettlements: settlement === 'immediate' ? 0 : 1,
      hasFinal: true,
      maxIterations: 3,
      firstTool: { name: first.name, args: first.args },
    };
  }

  if (behavior === 'retry_destructive') {
    const repeated = toolCall('retry_call_1', 'destructive_retry', { target: 'locked-player' });
    const repeatedAgain = toolCall('retry_call_2', 'destructive_retry', { target: 'locked-player' });
    return {
      llmSteps: [
        { outcome: 'return', text: '', toolCalls: [repeated] },
        { outcome: 'return', text: '', toolCalls: [repeatedAgain] },
        { outcome: 'return', text: 'retry path complete' },
      ],
      toolSteps: [
        toolStep({ name: repeated.name, target: 'locked-player', ordinal: 0, settlement, ok: false, effectKey: 'destructive-operation' }),
        toolStep({ name: repeatedAgain.name, target: 'locked-player', ordinal: 1, settlement, effectKey: 'destructive-operation' }),
      ],
      toolSchemas: [{ name: repeated.name }],
      expectedLlmConsumed: 3,
      expectedToolConsumed: 2,
      expectedToolTotal: 2,
      expectedSettlementAttempts: attemptsPerTool * 2,
      expectedAcceptedSettlements: settlement === 'immediate' ? 0 : 2,
      hasFinal: false,
      maxIterations: 3,
      firstTool: { name: repeated.name, args: repeated.args },
    };
  }

  if (behavior === 'bounded_failures') {
    const first = toolCall('bounded_call_1', 'bounded_failure_1', { target: 'locked-player' });
    const second = toolCall('bounded_call_2', 'bounded_failure_2', { target: 'locked-player-2' });
    return {
      llmSteps: [
        { outcome: 'return', text: '', toolCalls: [first] },
        { outcome: 'return', text: '', toolCalls: [second] },
        { outcome: 'return', text: 'bounded synthesis', expect: { exposedTools: [] } },
      ],
      toolSteps: [
        toolStep({ name: first.name, target: 'locked-player', ordinal: 0, settlement, ok: false }),
        toolStep({ name: second.name, target: 'locked-player-2', ordinal: 1, settlement, ok: false }),
      ],
      toolSchemas: [{ name: first.name }, { name: second.name }],
      expectedLlmConsumed: 3,
      expectedToolConsumed: 2,
      expectedToolTotal: 2,
      expectedSettlementAttempts: attemptsPerTool * 2,
      expectedAcceptedSettlements: settlement === 'immediate' ? 0 : 2,
      hasFinal: false,
      maxIterations: 2,
      firstTool: { name: first.name, args: first.args },
    };
  }

  const normal = toolCall('normal_call', 'normal_tool', { target: 'locked-player' });
  return {
    llmSteps: [
      { outcome: 'return', text: '', toolCalls: [normal] },
      { outcome: 'return', text: 'normal complete' },
    ],
    toolSteps: [toolStep({
      name: normal.name,
      target: 'locked-player',
      ordinal: 0,
      settlement,
      effectKey: 'normal-once',
    })],
    toolSchemas: [{ name: normal.name }],
    expectedLlmConsumed: 2,
    expectedToolConsumed: 1,
    expectedToolTotal: 1,
    expectedSettlementAttempts: attemptsPerTool,
    expectedAcceptedSettlements: settlement === 'immediate' ? 0 : 1,
    hasFinal: false,
    maxIterations: 3,
    firstTool: { name: normal.name, args: normal.args },
  };
}

function scenarioId(parts: unknown): string {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16).toUpperCase();
  return `C2_${digest}`;
}

export interface GeneratedC2Scenario {
  scenario: ReplayScenario;
  semanticSteps: string[];
  profile: { behavior: C2Behavior; settlement: C2Settlement; control: C2Control };
}

export function buildC2Scenario(
  commands: Iterable<Command<C2Model, C2Builder>>,
  seed: number,
): GeneratedC2Scenario {
  const model: C2Model = {};
  const builder: C2Builder = { semanticSteps: [] };
  fc.modelRun(() => ({ model, real: builder }), Array.from(commands));

  const behavior = builder.behavior || 'normal';
  let settlement = builder.settlement || 'immediate';
  const control: C2Control = builder.control || 'none';
  // A control race needs a pending injected Promise. This normalization only
  // chooses a dependency delay; it does not model an Agent transition.
  if (control !== 'none' && settlement === 'immediate') settlement = 'late';
  const script = buildRuntimeScript(behavior, settlement);
  const controlAccepted = control !== 'none';

  const enforced: OracleSpec[] = [
    { kind: 'invariant', id: 'RT_BOUNDED_LOOP' },
    { kind: 'invariant', id: 'RR_MONOTONIC_LOOP' },
    { kind: 'invariant', id: 'HARNESS_ISOLATED' },
    { kind: 'invariant', id: 'TRACE_DETERMINISTIC' },
    { kind: 'assertion', id: 'ASSERT_TERMINAL_KIND', value: controlAccepted ? 'error' : 'result' },
    { kind: 'assertion', id: 'ASSERT_SETTLEMENT_ATTEMPTS', value: script.expectedSettlementAttempts },
    { kind: 'assertion', id: 'ASSERT_ACCEPTED_SETTLEMENTS', value: script.expectedAcceptedSettlements },
    {
      kind: 'assertion',
      id: 'ASSERT_SCRIPT_CONSUMPTION',
      value: {
        llmConsumed: script.expectedLlmConsumed,
        llmTotal: script.llmSteps.length,
        toolConsumed: script.expectedToolConsumed,
        toolTotal: script.expectedToolTotal,
      },
    },
  ];
  if (!controlAccepted) enforced.push({ kind: 'invariant', id: 'RT_TOOL_COUNT_EXACT' });
  if (script.hasFinal) {
    enforced.push(
      { kind: 'invariant', id: 'RT_FINAL_NO_LLM' },
      { kind: 'invariant', id: 'RT_FINAL_NO_TOOL' },
      { kind: 'invariant', id: 'RT_FINAL_NO_EFFECT' },
    );
  }
  if (controlAccepted) {
    enforced.push(
      { kind: 'assertion', id: 'ASSERT_CONTROL_KIND', value: control },
      { kind: 'assertion', id: 'ASSERT_RUNTIME_SETTLED_AFTER_CONTROL', value: true },
    );
  }

  const candidate: OracleSpec[] = [{ kind: 'invariant', id: 'RT_EFFECT_IDEMPOTENCY' }];
  if (controlAccepted) candidate.push({ kind: 'invariant', id: 'RT_ABORT_NO_LATE_EFFECT' });

  const profile = { behavior, settlement, control };
  const semanticSteps = [...builder.semanticSteps, `effective:${behavior}+${settlement}+${control}`];
  const actor = { userId: 'c2-actor', groupId: 'c2-group' };
  const scenario: ReplayScenario = {
    schemaVersion: SCHEMA_VERSION,
    traceVersion: TRACE_VERSION,
    generatorVersion: GENERATOR_VERSION,
    id: scenarioId({ semanticSteps, profile }),
    seed,
    initialState: {
      context: actor,
      db: { settings: {} },
      messages: [{ role: 'user', content: 'C2 offline compound-fault replay' }],
      toolSchemas: script.toolSchemas,
      maxIterations: script.maxIterations,
      label: 'Agent Replay C2.1',
    },
    llmSteps: script.llmSteps.map((step) => step.outcome === 'return'
      ? {
          ...step,
          expect: {
            ...(step.expect || {}),
            exposedTools: step.expect?.exposedTools || script.toolSchemas.map((tool) => tool.name),
          },
        }
      : step),
    toolSteps: script.toolSteps,
    faultProfile: {
      id: `${behavior}+${settlement}+${control}`,
      tags: [behavior, settlement, control].filter((tag) => tag !== 'none'),
      ...(controlAccepted ? { symbolicControl: { kind: control, atTick: 1 } } : {}),
    },
    oracleSidecar: {
      actor,
      target: {
        callIndex: 0,
        toolName: script.firstTool.name,
        args: script.firstTool.args,
      },
    },
    expected: { enforced, candidate },
    minimalReproduction: C2_ARTIFACT_SCENARIO,
  };

  return {
    scenario: parseReplayScenario(scenario, '<C2 generated scenario>'),
    semanticSteps,
    profile,
  };
}

export function buildC2ProfileScenario(
  profile: { behavior: C2Behavior; settlement: C2Settlement; control: C2Control },
  seed = 20_260_811,
): GeneratedC2Scenario {
  const commands: Array<Command<C2Model, C2Builder>> = [
    new BehaviorCommand(profile.behavior),
    new SettlementCommand(profile.settlement),
  ];
  if (profile.control !== 'none') commands.push(new ControlCommand(profile.control));
  return buildC2Scenario(commands, seed);
}
