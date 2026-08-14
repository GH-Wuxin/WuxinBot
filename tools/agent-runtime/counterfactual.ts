import { createHash } from 'node:crypto';
import { classifyReplayResult, type CampaignFinding } from './campaign.js';
import { parseReplayScenario } from './scenario.js';
import { normalizedJson } from './trace.js';
import {
  GENERATOR_VERSION,
  SCHEMA_VERSION,
  TRACE_VERSION,
  type OracleSpec,
  type ReplayLlmStep,
  type ReplayOracleSidecar,
  type ReplayRunResult,
  type ReplayScenario,
  type ReplayToolStep,
} from './types.js';
/** Fixture variant labels (fast/thinking) — distinct from router levels. */
type ReasoningMode = 'fast' | 'thinking';

export const COUNTERFACTUAL_SCHEMA_VERSION = 1 as const;

export interface CounterfactualVariantSpec {
  mode: ReasoningMode;
  llmSteps: ReplayLlmStep[];
  toolSteps: ReplayToolStep[];
  expected: {
    enforced: OracleSpec[];
    candidate?: OracleSpec[];
  };
}

export interface CounterfactualFixture {
  counterfactualSchemaVersion: typeof COUNTERFACTUAL_SCHEMA_VERSION;
  scenarioSchemaVersion: typeof SCHEMA_VERSION;
  traceSchemaVersion: typeof TRACE_VERSION;
  generatorVersion: typeof GENERATOR_VERSION;
  id: string;
  seed: number;
  base: {
    initialState: ReplayScenario['initialState'];
    oracleSidecar?: ReplayOracleSidecar;
  };
  variants: {
    fast: CounterfactualVariantSpec;
    thinking: CounterfactualVariantSpec;
  };
}

export interface CounterfactualVariantSummary {
  mode: ReasoningMode;
  toolSequence: string[];
  toolCallCount: number;
  target: string | null;
  targets: string[];
  terminalState: {
    kind: 'result' | 'error';
    text?: string;
    directContent?: string;
    errorName?: string;
  };
  reasoningDecisions: Array<{
    callRole: string;
    level: string;
    source: string;
    reasonCode: string;
  }>;
  simulatedTokens: {
    prompt: number;
    completion: number;
    total: number;
    reasoning: number;
  };
  simulatedLatencyMs: number;
  invariants: Array<{ id: string; level: string; passed: boolean; detail: string }>;
}

export interface CounterfactualComparison {
  counterfactualSchemaVersion: number;
  fixtureId: string;
  seed: number;
  runtime: 'real_runToolLoop';
  offline: true;
  productionThinkingEnabled: false;
  disclaimer: string;
  variants: {
    fast: CounterfactualVariantSummary;
    thinking: CounterfactualVariantSummary;
  };
  differences: {
    toolSequenceChanged: boolean;
    toolCallCountDelta: number;
    targetChanged: boolean;
    terminalChanged: boolean;
    reasoningChanged: boolean;
    simulatedTokenDelta: number;
    simulatedLatencyDeltaMs: number;
    invariantDifferences: Array<{
      id: string;
      fast?: { level: string; passed: boolean; detail: string };
      thinking?: { level: string; passed: boolean; detail: string };
    }>;
  };
  findings: Array<{ variant: ReasoningMode; finding: CampaignFinding }>;
  fingerprint: string;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertFixtureShape(value: unknown, source: string): asserts value is CounterfactualFixture {
  if (!isRecord(value)) throw new Error(`${source}: expected object`);
  if (value.counterfactualSchemaVersion !== COUNTERFACTUAL_SCHEMA_VERSION) {
    throw new Error(`${source}: counterfactualSchemaVersion must be ${COUNTERFACTUAL_SCHEMA_VERSION}`);
  }
  if (value.scenarioSchemaVersion !== SCHEMA_VERSION || value.traceSchemaVersion !== TRACE_VERSION ||
      value.generatorVersion !== GENERATOR_VERSION) {
    throw new Error(`${source}: incompatible Replay schema/trace/generator version`);
  }
  if (typeof value.id !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(value.id)) {
    throw new Error(`${source}: invalid stable fixture id`);
  }
  if (!Number.isSafeInteger(value.seed)) throw new Error(`${source}: seed must be a safe integer`);
  if (!isRecord(value.base) || !isRecord(value.base.initialState)) throw new Error(`${source}: base.initialState required`);
  if (!isRecord(value.variants) || !isRecord(value.variants.fast) || !isRecord(value.variants.thinking)) {
    throw new Error(`${source}: fast and thinking variants required`);
  }
  if (value.variants.fast.mode !== 'fast' || value.variants.thinking.mode !== 'thinking') {
    throw new Error(`${source}: variant modes must match their keys`);
  }
}

function variantScenario(
  fixture: CounterfactualFixture,
  key: 'fast' | 'thinking',
  source: string,
): ReplayScenario {
  const variant = fixture.variants[key];
  return parseReplayScenario({
    schemaVersion: fixture.scenarioSchemaVersion,
    traceVersion: fixture.traceSchemaVersion,
    generatorVersion: fixture.generatorVersion,
    id: `${fixture.id}_${key.toUpperCase()}`,
    seed: fixture.seed,
    initialState: fixture.base.initialState,
    llmSteps: variant.llmSteps,
    toolSteps: variant.toolSteps,
    ...(fixture.base.oracleSidecar ? { oracleSidecar: fixture.base.oracleSidecar } : {}),
    expected: variant.expected,
    minimalReproduction: 'tools/fixtures/agent-runtime/counterfactual/fast-thinking.json',
  }, `${source}#${key}`);
}

export function parseCounterfactualFixture(value: unknown, source = '<counterfactual>'): CounterfactualFixture {
  assertFixtureShape(value, source);
  const fixture = value as CounterfactualFixture;
  variantScenario(fixture, 'fast', source);
  variantScenario(fixture, 'thinking', source);
  return fixture;
}

function targetFromEvent(event: any): string {
  const target = event?.data?.args?.target;
  return target === undefined || target === null ? '' : String(target);
}

function summarize(
  variant: CounterfactualVariantSpec,
  result: ReplayRunResult,
): CounterfactualVariantSummary {
  const toolEvents = result.trace.events.filter((event) => event.type === 'tool_call');
  const reasoningEvents = result.trace.events.filter((event) => event.type === 'reasoning');
  const targets = [...new Set(toolEvents.map(targetFromEvent).filter(Boolean))];
  const usage = result.trace.terminal.kind === 'result'
    ? result.trace.terminal.result.usage as any
    : {};
  const terminalState = result.trace.terminal.kind === 'result'
    ? {
        kind: 'result' as const,
        text: result.trace.terminal.result.text,
        directContent: result.trace.terminal.result.directContent,
      }
    : {
        kind: 'error' as const,
        errorName: result.trace.terminal.error.name,
      };
  return {
    mode: variant.mode,
    toolSequence: toolEvents.map((event) => String((event.data as any).name || '')),
    toolCallCount: toolEvents.length,
    target: targets.length === 1 ? targets[0] : null,
    targets,
    terminalState,
    reasoningDecisions: reasoningEvents.map((event) => ({
      callRole: String((event.data as any).callRole || ''),
      level: String((event.data as any).decision?.level || ''),
      source: String((event.data as any).decision?.source || ''),
      reasonCode: String((event.data as any).decision?.reasonCode || ''),
    })),
    simulatedTokens: {
      prompt: Number(usage?.prompt_tokens || 0),
      completion: Number(usage?.completion_tokens || 0),
      total: Number(usage?.total_tokens || 0),
      reasoning: variant.llmSteps.reduce((sum, step) =>
        sum + (step.outcome === 'return' ? Number(step.meta?.reasoningTokens || 0) : 0), 0),
    },
    simulatedLatencyMs: variant.llmSteps.reduce((sum, step) =>
      sum + (step.outcome === 'return' ? Number(step.meta?.latencyMs || 0) : 0), 0),
    invariants: result.oracles
      .filter((oracle) => oracle.kind === 'invariant')
      .map((oracle) => ({
        id: String(oracle.id),
        level: oracle.level,
        passed: oracle.passed,
        detail: oracle.detail,
      })),
  };
}

export function compareInvariantOutcomes(
  fast: CounterfactualVariantSummary,
  thinking: CounterfactualVariantSummary,
): CounterfactualComparison['differences']['invariantDifferences'] {
  const fastMap = new Map(fast.invariants.map((entry) => [entry.id, entry]));
  const thinkingMap = new Map(thinking.invariants.map((entry) => [entry.id, entry]));
  const ids = [...new Set([...fastMap.keys(), ...thinkingMap.keys()])].sort();
  return ids.flatMap((id) => {
    const left = fastMap.get(id);
    const right = thinkingMap.get(id);
    // A different detail string (for example, observed count 1 vs 2) is
    // already represented by dedicated metrics; only contract outcomes
    // belong in invariantDifferences.
    if (left?.level === right?.level && left?.passed === right?.passed) return [];
    return [{ id, ...(left ? { fast: left } : {}), ...(right ? { thinking: right } : {}) }];
  });
}

async function replayVariantTwice(
  fixture: CounterfactualFixture,
  key: 'fast' | 'thinking',
  source: string,
): Promise<ReplayRunResult> {
  const { replayScenario } = await import('./runner.js');
  const scenario = variantScenario(fixture, key, source);
  const mode = fixture.variants[key].mode;
  const first = await replayScenario(scenario, { scriptedReasoningMode: mode });
  const second = await replayScenario(scenario, { scriptedReasoningMode: mode });
  if (normalizedJson(first.trace) !== normalizedJson(second.trace)) {
    throw new Error(`${source}#${key}: nondeterministic counterfactual trace`);
  }
  return first;
}

export async function runCounterfactualFixture(
  fixture: CounterfactualFixture,
  source = '<counterfactual>',
): Promise<CounterfactualComparison> {
  const parsed = parseCounterfactualFixture(fixture, source);
  const [fastRun, thinkingRun] = await Promise.all([
    replayVariantTwice(parsed, 'fast', source),
    replayVariantTwice(parsed, 'thinking', source),
  ]);
  const fast = summarize(parsed.variants.fast, fastRun);
  const thinking = summarize(parsed.variants.thinking, thinkingRun);
  const findings = ([
    ['fast', classifyReplayResult(fastRun)],
    ['thinking', classifyReplayResult(thinkingRun)],
  ] as const).flatMap(([variant, finding]) => finding ? [{ variant, finding }] : []);
  const body = {
    counterfactualSchemaVersion: parsed.counterfactualSchemaVersion,
    fixtureId: parsed.id,
    seed: parsed.seed,
    runtime: 'real_runToolLoop' as const,
    offline: true as const,
    productionThinkingEnabled: false as const,
    disclaimer: 'Scripted counterfactual validates runtime control-flow differences only; it does not predict real model answer quality.',
    variants: { fast, thinking },
    differences: {
      toolSequenceChanged: normalizedJson(fast.toolSequence) !== normalizedJson(thinking.toolSequence),
      toolCallCountDelta: thinking.toolCallCount - fast.toolCallCount,
      targetChanged: normalizedJson(fast.targets) !== normalizedJson(thinking.targets),
      terminalChanged: normalizedJson(fast.terminalState) !== normalizedJson(thinking.terminalState),
      reasoningChanged: normalizedJson(fast.reasoningDecisions) !== normalizedJson(thinking.reasoningDecisions),
      simulatedTokenDelta: thinking.simulatedTokens.total - fast.simulatedTokens.total,
      simulatedLatencyDeltaMs: thinking.simulatedLatencyMs - fast.simulatedLatencyMs,
      invariantDifferences: compareInvariantOutcomes(fast, thinking),
    },
    findings,
  };
  return {
    ...body,
    fingerprint: createHash('sha256').update(normalizedJson(body)).digest('hex'),
  };
}
