import {
  GENERATOR_VERSION,
  SCHEMA_VERSION,
  TRACE_VERSION,
  type ReplayAssertionId,
  type ReplayScenario,
  type RuntimeInvariantId,
} from './types.js';
import { INVARIANT_REGISTRY } from './oracles.js';

const INVARIANT_IDS = new Set<RuntimeInvariantId>([
  'RT_FINAL_NO_LLM', 'RT_FINAL_NO_TOOL', 'RT_FINAL_NO_EFFECT',
  'RT_DIRECT_EMIT_ONCE', 'RT_DIRECT_LEAD_LIMIT', 'RT_REQUIRED_ONCE',
  'RT_BOUNDED_LOOP', 'RR_MONOTONIC_LOOP', 'HARNESS_ISOLATED', 'TRACE_DETERMINISTIC',
  'RT_FINAL_PAYLOAD_VALID', 'RT_FINAL_IMAGES_PRESERVED', 'RT_EXPOSED_SCHEMA_ONLY',
  'RT_TOOL_COUNT_EXACT', 'RT_BATCH_FAILURE_MEMORY', 'RT_EFFECT_IDEMPOTENCY',
  'RT_TOOL_THROW_RECOVERY', 'RT_TARGET_LOCK', 'RT_ABORT_NO_LATE_EFFECT',
  'RT_MALFORMED_RESULT', 'LLM_REASONING_EXHAUSTION', 'LLM_ATTEMPT_METADATA',
  'RR_REQUIRED_ROLE', 'RR_TOOL_SELECTION_SIGNAL', 'SEM_FACT_PRECEDENCE',
]);
const ASSERTION_IDS = new Set<ReplayAssertionId>([
  'ASSERT_TERMINAL_KIND', 'ASSERT_LLM_CALL_COUNT', 'ASSERT_TOOL_CALL_COUNT',
  'ASSERT_TOOL_CALLS_MADE', 'ASSERT_ITERATIONS_AT_MOST', 'ASSERT_DIRECT_CONTENT',
  'ASSERT_TEXT', 'ASSERT_RECOMMEND_TOOL_CALLED', 'ASSERT_SETTLEMENT_ATTEMPTS',
  'ASSERT_ACCEPTED_SETTLEMENTS', 'ASSERT_CONTROL_KIND',
  'ASSERT_RUNTIME_SETTLED_AFTER_CONTROL', 'ASSERT_SCRIPT_CONSUMPTION',
  'ASSERT_SIDECAR_FACTS',
]);

export class ReplayScenarioError extends Error {
  constructor(source: string, path: string, message: string) {
    super(`${source}:${path}: ${message}`);
    this.name = 'ReplayScenarioError';
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fail(source: string, path: string, message: string): never {
  throw new ReplayScenarioError(source, path, message);
}

function objectAt(value: unknown, source: string, path: string): Record<string, any> {
  if (!isRecord(value)) fail(source, path, 'expected object');
  return value;
}

function arrayAt(value: unknown, source: string, path: string): unknown[] {
  if (!Array.isArray(value)) fail(source, path, 'expected array');
  return value;
}

function stringAt(value: unknown, source: string, path: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    fail(source, path, allowEmpty ? 'expected string' : 'expected non-empty string');
  }
  return value;
}

function optionalFiniteNumber(value: unknown, source: string, path: string): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
    fail(source, path, 'expected finite number');
  }
}

function validateSettlement(value: unknown, source: string, path: string): void {
  if (value === undefined) return;
  const settlement = objectAt(value, source, path);
  if (!Number.isInteger(settlement.atTick) || settlement.atTick < 0) {
    fail(source, `${path}.atTick`, 'expected non-negative integer logical tick');
  }
  if (settlement.duplicateAtTicks !== undefined) {
    arrayAt(settlement.duplicateAtTicks, source, `${path}.duplicateAtTicks`).forEach((tick, index) => {
      if (!Number.isInteger(tick) || Number(tick) < 0) {
        fail(source, `${path}.duplicateAtTicks[${index}]`, 'expected non-negative integer logical tick');
      }
    });
  }
}

function validateOracleList(value: unknown, source: string, path: string, level: 'enforced' | 'candidate'): void {
  arrayAt(value, source, path).forEach((entry, index) => {
    const oracle = objectAt(entry, source, `${path}[${index}]`);
    if (oracle.kind !== 'invariant' && oracle.kind !== 'assertion') {
      fail(source, `${path}[${index}].kind`, 'expected invariant or assertion');
    }
    const id = stringAt(oracle.id, source, `${path}[${index}].id`);
    if (oracle.kind === 'invariant' && !INVARIANT_IDS.has(id as RuntimeInvariantId)) {
      fail(source, `${path}[${index}].id`, `unknown invariant ${id}`);
    }
    if (oracle.kind === 'invariant' && INVARIANT_REGISTRY[id as RuntimeInvariantId].level !== level) {
      fail(source, `${path}[${index}].id`, `${id} belongs in expected.${INVARIANT_REGISTRY[id as RuntimeInvariantId].level}`);
    }
    if (oracle.kind === 'assertion' && !ASSERTION_IDS.has(id as ReplayAssertionId)) {
      fail(source, `${path}[${index}].id`, `unknown assertion ${id}`);
    }
    if (oracle.note !== undefined) stringAt(oracle.note, source, `${path}[${index}].note`, true);
  });
}

function validateLlmSteps(value: unknown, source: string): void {
  arrayAt(value, source, '$.llmSteps').forEach((entry, index) => {
    const path = `$.llmSteps[${index}]`;
    const step = objectAt(entry, source, path);
    if (step.outcome !== 'return' && step.outcome !== 'throw') {
      fail(source, `${path}.outcome`, 'expected return or throw');
    }
    validateSettlement(step.settlement, source, `${path}.settlement`);
    if (step.expect !== undefined) {
      const expect = objectAt(step.expect, source, `${path}.expect`);
      if (expect.exposedTools !== undefined) {
        arrayAt(expect.exposedTools, source, `${path}.expect.exposedTools`)
          .forEach((name, i) => stringAt(name, source, `${path}.expect.exposedTools[${i}]`));
      }
      if (expect.messageRoles !== undefined) {
        arrayAt(expect.messageRoles, source, `${path}.expect.messageRoles`)
          .forEach((role, i) => stringAt(role, source, `${path}.expect.messageRoles[${i}]`));
      }
      if (expect.labelIncludes !== undefined) {
        stringAt(expect.labelIncludes, source, `${path}.expect.labelIncludes`, true);
      }
    }
    if (step.outcome === 'throw') {
      const error = objectAt(step.error, source, `${path}.error`);
      stringAt(error.message, source, `${path}.error.message`, true);
      return;
    }
    if (step.text !== undefined) stringAt(step.text, source, `${path}.text`, true);
    if (step.toolCalls !== undefined) {
      arrayAt(step.toolCalls, source, `${path}.toolCalls`).forEach((call, callIndex) => {
        const tool = objectAt(call, source, `${path}.toolCalls[${callIndex}]`);
        stringAt(tool.name, source, `${path}.toolCalls[${callIndex}].name`);
        if (tool.rawArguments !== undefined && tool.args !== undefined) {
          fail(source, `${path}.toolCalls[${callIndex}]`, 'use args or rawArguments, not both');
        }
        if (tool.rawArguments !== undefined) {
          stringAt(tool.rawArguments, source, `${path}.toolCalls[${callIndex}].rawArguments`, true);
        }
        if (tool.args !== undefined) objectAt(tool.args, source, `${path}.toolCalls[${callIndex}].args`);
      });
    }
  });
}

function validateToolSteps(value: unknown, source: string): void {
  arrayAt(value, source, '$.toolSteps').forEach((entry, index) => {
    const path = `$.toolSteps[${index}]`;
    const step = objectAt(entry, source, path);
    if (step.outcome !== 'return' && step.outcome !== 'throw') {
      fail(source, `${path}.outcome`, 'expected return or throw');
    }
    validateSettlement(step.settlement, source, `${path}.settlement`);
    if (step.expect !== undefined) {
      const expect = objectAt(step.expect, source, `${path}.expect`);
      if (expect.name !== undefined) stringAt(expect.name, source, `${path}.expect.name`);
      if (expect.args !== undefined && expect.argsSubset !== undefined) {
        fail(source, `${path}.expect`, 'use args or argsSubset, not both');
      }
      if (expect.args !== undefined) objectAt(expect.args, source, `${path}.expect.args`);
      if (expect.argsSubset !== undefined) objectAt(expect.argsSubset, source, `${path}.expect.argsSubset`);
    }
    if (step.outcome === 'throw') {
      const error = objectAt(step.error, source, `${path}.error`);
      stringAt(error.message, source, `${path}.error.message`, true);
      return;
    }
    const result = objectAt(step.result, source, `${path}.result`);
    if (typeof result.ok !== 'boolean') fail(source, `${path}.result.ok`, 'expected boolean');
    stringAt(result.content, source, `${path}.result.content`, true);
    if (result.final !== undefined && typeof result.final !== 'boolean') {
      fail(source, `${path}.result.final`, 'expected boolean');
    }
    if (result.directContent !== undefined) {
      stringAt(result.directContent, source, `${path}.result.directContent`, true);
    }
    if (result.images !== undefined) {
      arrayAt(result.images, source, `${path}.result.images`)
        .forEach((image, i) => stringAt(image, source, `${path}.result.images[${i}]`, true));
    }
    if (step.effects !== undefined) {
      arrayAt(step.effects, source, `${path}.effects`).forEach((entry, effectIndex) => {
        const effect = objectAt(entry, source, `${path}.effects[${effectIndex}]`);
        stringAt(effect.kind, source, `${path}.effects[${effectIndex}].kind`);
        if (effect.class !== undefined && effect.class !== 'business' && effect.class !== 'housekeeping') {
          fail(source, `${path}.effects[${effectIndex}].class`, 'expected business or housekeeping');
        }
      });
    }
  });
}

export function parseReplayScenario(value: unknown, source = '<scenario>'): ReplayScenario {
  const root = objectAt(value, source, '$');
  if (root.schemaVersion !== SCHEMA_VERSION) {
    fail(source, '$.schemaVersion', `expected ${SCHEMA_VERSION}`);
  }
  if (root.traceVersion !== TRACE_VERSION) {
    fail(source, '$.traceVersion', `expected ${TRACE_VERSION}`);
  }
  if (root.generatorVersion !== GENERATOR_VERSION) {
    fail(source, '$.generatorVersion', `expected ${GENERATOR_VERSION}`);
  }
  const scenarioId = stringAt(root.id, source, '$.id');
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(scenarioId)) {
    fail(source, '$.id', 'expected stable ID matching ^[A-Z][A-Z0-9_]{2,63}$');
  }
  if (!Number.isSafeInteger(root.seed)) fail(source, '$.seed', 'expected safe integer');

  const state = objectAt(root.initialState, source, '$.initialState');
  for (const sidecarOnly of ['actor', 'target', 'facts', 'constraints', 'symbolicClaims']) {
    if (Object.prototype.hasOwnProperty.call(state, sidecarOnly)) {
      fail(source, `$.initialState.${sidecarOnly}`, 'semantic oracle data belongs in oracleSidecar only');
    }
  }
  const allowedStateKeys = new Set([
    'context', 'db', 'messages', 'toolSchemas', 'maxIterations', 'temperature',
    'maxTokens', 'model', 'label', 'deliverDirectContent', 'requiredTool',
  ]);
  for (const key of Object.keys(state)) {
    if (!allowedStateKeys.has(key)) fail(source, `$.initialState.${key}`, 'unknown initialState field');
  }
  const context = objectAt(state.context, source, '$.initialState.context');
  stringAt(context.userId, source, '$.initialState.context.userId');
  if (context.groupId !== undefined) stringAt(context.groupId, source, '$.initialState.context.groupId', true);
  if (context.selfQq !== undefined) stringAt(context.selfQq, source, '$.initialState.context.selfQq', true);
  if (state.db !== undefined) objectAt(state.db, source, '$.initialState.db');

  arrayAt(state.messages, source, '$.initialState.messages').forEach((entry, index) => {
    const message = objectAt(entry, source, `$.initialState.messages[${index}]`);
    stringAt(message.role, source, `$.initialState.messages[${index}].role`);
    if (message.content !== null) {
      stringAt(message.content, source, `$.initialState.messages[${index}].content`, true);
    }
  });
  arrayAt(state.toolSchemas, source, '$.initialState.toolSchemas').forEach((entry, index) => {
    const schema = objectAt(entry, source, `$.initialState.toolSchemas[${index}]`);
    stringAt(schema.name, source, `$.initialState.toolSchemas[${index}].name`);
  });
  if (state.requiredTool !== undefined) {
    const required = objectAt(state.requiredTool, source, '$.initialState.requiredTool');
    stringAt(required.toolName, source, '$.initialState.requiredTool.toolName');
    objectAt(required.args, source, '$.initialState.requiredTool.args');
  }
  if (state.maxIterations !== undefined && (!Number.isInteger(state.maxIterations) || state.maxIterations < 0)) {
    fail(source, '$.initialState.maxIterations', 'expected non-negative integer');
  }
  optionalFiniteNumber(state.temperature, source, '$.initialState.temperature');
  optionalFiniteNumber(state.maxTokens, source, '$.initialState.maxTokens');
  if (state.deliverDirectContent !== undefined && typeof state.deliverDirectContent !== 'boolean') {
    fail(source, '$.initialState.deliverDirectContent', 'expected boolean');
  }

  validateLlmSteps(root.llmSteps, source);
  validateToolSteps(root.toolSteps, source);

  if (root.faultProfile !== undefined) {
    const profile = objectAt(root.faultProfile, source, '$.faultProfile');
    stringAt(profile.id, source, '$.faultProfile.id');
    arrayAt(profile.tags, source, '$.faultProfile.tags')
      .forEach((tag, index) => stringAt(tag, source, `$.faultProfile.tags[${index}]`));
    if (profile.symbolicControl !== undefined) {
      const control = objectAt(profile.symbolicControl, source, '$.faultProfile.symbolicControl');
      if (control.kind !== 'abort' && control.kind !== 'timeout') {
        fail(source, '$.faultProfile.symbolicControl.kind', 'expected abort or timeout');
      }
      if (!Number.isInteger(control.atTick) || control.atTick < 0) {
        fail(source, '$.faultProfile.symbolicControl.atTick', 'expected non-negative integer logical tick');
      }
    }
  }

  if (root.oracleSidecar !== undefined) {
    const sidecar = objectAt(root.oracleSidecar, source, '$.oracleSidecar');
    if (sidecar.actor !== undefined) {
      const actor = objectAt(sidecar.actor, source, '$.oracleSidecar.actor');
      stringAt(actor.userId, source, '$.oracleSidecar.actor.userId');
      if (actor.groupId !== undefined) stringAt(actor.groupId, source, '$.oracleSidecar.actor.groupId', true);
    }
    if (sidecar.target !== undefined) {
      const target = objectAt(sidecar.target, source, '$.oracleSidecar.target');
      stringAt(target.toolName, source, '$.oracleSidecar.target.toolName');
      if (target.callIndex !== undefined && (!Number.isInteger(target.callIndex) || target.callIndex < 0)) {
        fail(source, '$.oracleSidecar.target.callIndex', 'expected non-negative integer');
      }
    }
    if (sidecar.facts !== undefined) {
      arrayAt(sidecar.facts, source, '$.oracleSidecar.facts').forEach((entry, index) => {
        const fact = objectAt(entry, source, `$.oracleSidecar.facts[${index}]`);
        stringAt(fact.path, source, `$.oracleSidecar.facts[${index}].path`);
        if (!Object.prototype.hasOwnProperty.call(fact, 'equals')) {
          fail(source, `$.oracleSidecar.facts[${index}].equals`, 'required');
        }
      });
    }
    if (sidecar.constraints !== undefined) {
      arrayAt(sidecar.constraints, source, '$.oracleSidecar.constraints').forEach((entry, index) => {
        const constraint = objectAt(entry, source, `$.oracleSidecar.constraints[${index}]`);
        stringAt(constraint.path, source, `$.oracleSidecar.constraints[${index}].path`);
        if (constraint.callIndex !== undefined && (!Number.isInteger(constraint.callIndex) || constraint.callIndex < 0)) {
          fail(source, `$.oracleSidecar.constraints[${index}].callIndex`, 'expected non-negative integer');
        }
        if (!Object.prototype.hasOwnProperty.call(constraint, 'equals')) {
          fail(source, `$.oracleSidecar.constraints[${index}].equals`, 'required');
        }
      });
    }
    if (sidecar.symbolicClaims !== undefined) {
      arrayAt(sidecar.symbolicClaims, source, '$.oracleSidecar.symbolicClaims').forEach((entry, index) => {
        const claim = objectAt(entry, source, `$.oracleSidecar.symbolicClaims[${index}]`);
        stringAt(claim.id, source, `$.oracleSidecar.symbolicClaims[${index}].id`);
        stringAt(claim.path, source, `$.oracleSidecar.symbolicClaims[${index}].path`);
        if (!['equals', 'contains', 'not_contains'].includes(claim.operator)) {
          fail(source, `$.oracleSidecar.symbolicClaims[${index}].operator`, 'unknown operator');
        }
        if (!Object.prototype.hasOwnProperty.call(claim, 'value')) {
          fail(source, `$.oracleSidecar.symbolicClaims[${index}].value`, 'required');
        }
      });
    }
  }

  const expected = objectAt(root.expected, source, '$.expected');
  validateOracleList(expected.enforced, source, '$.expected.enforced', 'enforced');
  if (expected.candidate !== undefined) {
    validateOracleList(expected.candidate, source, '$.expected.candidate', 'candidate');
  }
  if (root.minimalReproduction !== undefined) {
    stringAt(root.minimalReproduction, source, '$.minimalReproduction');
  }

  return root as ReplayScenario;
}

export function parseReplayScenarioJson(text: string, source = '<scenario>'): ReplayScenario {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error: any) {
    throw new ReplayScenarioError(source, '$', `invalid JSON: ${String(error?.message || error)}`);
  }
  return parseReplayScenario(value, source);
}
