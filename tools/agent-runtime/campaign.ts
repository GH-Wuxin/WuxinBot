import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fc, { type Command } from 'fast-check';
import { C1_ARTIFACT_SCENARIO, buildC1Scenario, c1CommandsArbitrary } from './generator.js';
import { installReplayIsolation } from './isolation.js';
import { parseReplayScenarioJson } from './scenario.js';
import { normalizedJson } from './trace.js';
import type { OracleResult, ReplayRunResult, ReplayScenario } from './types.js';

export const C1_DEFAULT_SEED = 20_260_809;
export const C1_DEFAULT_RUNS = 1_000;
export const C1_HARD_LIMIT_MS = 60_000;

type GeneratedCommand = Command<any, any>;

export type FindingKind = 'enforced_violation' | 'candidate_violation' | 'harness_bug';

export interface CampaignFinding {
  kind: FindingKind;
  oracleId?: string;
  detail: string;
  provisionalClassification: 'provisional_real_production_candidate' | 'needs_manual_review';
}

export interface C1CampaignConfig {
  seed?: number;
  numRuns?: number;
  maxCommands?: number;
  artifactDir?: string;
  includeUnsafe?: boolean;
  hardLimitMs?: number;
}

export interface C1CampaignResult {
  status: 'passed' | 'violation' | 'infrastructure_error';
  seed: number;
  requestedRuns: number;
  completedRuns: number;
  numShrinks: number;
  counterexamplePath: string | null;
  finding?: CampaignFinding;
  scenarioPath?: string;
  evidencePath?: string;
  productionDbUnchanged: boolean;
}

export class CampaignViolation extends Error {
  constructor(
    readonly finding: CampaignFinding,
    readonly scenarioId: string,
  ) {
    super(`${finding.kind}${finding.oracleId ? `/${finding.oracleId}` : ''}: ${finding.detail}`);
    this.name = 'CampaignViolation';
  }
}

function firstFailed(oracles: OracleResult[], level: 'enforced' | 'candidate'): OracleResult | undefined {
  return oracles.find((oracle) => oracle.level === level && !oracle.passed);
}

export function classifyReplayResult(result: ReplayRunResult): CampaignFinding | null {
  const enforced = firstFailed(result.oracles, 'enforced');
  if (enforced) {
    return {
      kind: 'enforced_violation',
      oracleId: String(enforced.id),
      detail: enforced.detail,
      provisionalClassification: 'needs_manual_review',
    };
  }
  const candidate = firstFailed(result.oracles, 'candidate');
  if (!candidate) return null;
  return {
    kind: 'candidate_violation',
    oracleId: String(candidate.id),
    detail: candidate.detail,
    provisionalClassification: 'needs_manual_review',
  };
}

function artifactPaths(artifactDir: string): { scenarioPath: string; evidencePath: string } {
  return {
    scenarioPath: path.join(artifactDir, 'scenario.min.json'),
    evidencePath: path.join(artifactDir, 'evidence.json'),
  };
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, content, 'utf8');
  await fs.rename(temporary, file);
}

async function replayDeterministically(
  scenario: ReplayScenario,
  replayScenario: (scenario: ReplayScenario) => Promise<ReplayRunResult>,
): Promise<{ first: ReplayRunResult; second: ReplayRunResult }> {
  const first = await replayScenario(scenario);
  const second = await replayScenario(scenario);
  if (normalizedJson(first.trace) !== normalizedJson(second.trace)) {
    throw new Error(`TRACE_DETERMINISTIC: byte mismatch for ${scenario.id}`);
  }
  return { first, second };
}

async function persistCounterexample(args: {
  scenario: ReplayScenario;
  semanticSteps: string[];
  finding: CampaignFinding;
  artifactDir: string;
  seed: number;
  requestedRuns: number;
  completedRuns: number;
  numShrinks: number;
  counterexamplePath: string;
  replayScenario: (scenario: ReplayScenario) => Promise<ReplayRunResult>;
}): Promise<{ scenarioPath: string; evidencePath: string }> {
  const files = artifactPaths(args.artifactDir);
  await atomicWrite(files.scenarioPath, JSON.stringify(args.scenario, null, 2) + '\n');

  // scenario.min.json is the long-term truth. Read and parse it from disk,
  // then prove that two independent executions still reproduce the finding.
  const saved = parseReplayScenarioJson(await fs.readFile(files.scenarioPath, 'utf8'), files.scenarioPath);
  const replay = await replayDeterministically(saved, args.replayScenario);
  const replayFinding = classifyReplayResult(replay.first);
  if (!replayFinding || replayFinding.kind !== args.finding.kind || replayFinding.oracleId !== args.finding.oracleId) {
    throw new Error('shrunk scenario did not reproduce the same finding after persistence');
  }

  const evidence = {
    evidenceVersion: 1,
    scenarioSchemaVersion: saved.schemaVersion,
    traceSchemaVersion: saved.traceVersion,
    generatorVersion: saved.generatorVersion,
    scenarioPath: C1_ARTIFACT_SCENARIO,
    seed: args.seed,
    counterexamplePath: args.counterexamplePath,
    requestedRuns: args.requestedRuns,
    completedRunsBeforeFailure: args.completedRuns,
    numShrinks: args.numShrinks,
    semanticSteps: args.semanticSteps,
    finding: replayFinding,
    deterministicReplay: true,
    consumption: replay.first.consumption,
    oracles: replay.first.oracles,
    trace: replay.first.trace,
  };
  await atomicWrite(files.evidencePath, normalizedJson(evidence) + '\n');
  return files;
}

export async function runC1Campaign(config: C1CampaignConfig = {}): Promise<C1CampaignResult> {
  const seed = config.seed ?? C1_DEFAULT_SEED;
  const requestedRuns = config.numRuns ?? C1_DEFAULT_RUNS;
  const maxCommands = config.maxCommands ?? 5;
  const hardLimitMs = config.hardLimitMs ?? C1_HARD_LIMIT_MS;
  const artifactDir = path.resolve(config.artifactDir || path.dirname(path.resolve(C1_ARTIFACT_SCENARIO)));
  const oldAppData = process.env.APPDATA;
  const campaignAppData = await fs.mkdtemp(path.join(os.tmpdir(), 'wuxin-agent-c1-appdata-'));
  process.env.APPDATA = campaignAppData;
  const isolation = await installReplayIsolation();
  let productionDbUnchanged = false;
  try {
    const { replayScenario } = await import('./runner.js');
    const commandArbitrary = c1CommandsArbitrary(maxCommands, { includeUnsafe: config.includeUnsafe !== false });
    const property = fc.asyncProperty(commandArbitrary, async (commands) => {
      const generated = buildC1Scenario(commands as Iterable<GeneratedCommand>, seed);
      let replay: { first: ReplayRunResult; second: ReplayRunResult };
      try {
        replay = await replayDeterministically(generated.scenario, replayScenario);
      } catch (error: any) {
        throw new CampaignViolation({
          kind: 'harness_bug',
          detail: String(error?.message || error),
          provisionalClassification: 'needs_manual_review',
        }, generated.scenario.id);
      }
      const finding = classifyReplayResult(replay.first);
      if (finding) throw new CampaignViolation(finding, generated.scenario.id);
    });

    const details = await fc.check(property, {
      seed,
      numRuns: requestedRuns,
      interruptAfterTimeLimit: hardLimitMs,
      markInterruptAsFailure: true,
      timeout: 2_000,
      maxSkipsPerRun: 100,
    });

    if (!details.failed && !details.interrupted) {
      productionDbUnchanged = await isolation.assertProductionDbUnchanged();
      return {
        status: 'passed',
        seed,
        requestedRuns,
        completedRuns: details.numRuns,
        numShrinks: details.numShrinks,
        counterexamplePath: null,
        productionDbUnchanged,
      };
    }
    if (!details.counterexample || !details.counterexamplePath) {
      productionDbUnchanged = await isolation.assertProductionDbUnchanged();
      return {
        status: 'infrastructure_error',
        seed,
        requestedRuns,
        completedRuns: details.numRuns,
        numShrinks: details.numShrinks,
        counterexamplePath: null,
        finding: {
          kind: 'harness_bug',
          detail: details.interrupted ? `campaign exceeded ${hardLimitMs}ms` : 'campaign failed without a counterexample',
          provisionalClassification: 'needs_manual_review',
        },
        productionDbUnchanged,
      };
    }

    const minimizedCommands = details.counterexample[0] as Iterable<GeneratedCommand>;
    const minimized = buildC1Scenario(minimizedCommands, seed);
    const replay = await replayDeterministically(minimized.scenario, replayScenario);
    const finding = classifyReplayResult(replay.first) || {
      kind: 'harness_bug' as const,
      detail: String((details.errorInstance as any)?.message || details.errorInstance || 'shrunk failure lost its oracle finding'),
      provisionalClassification: 'needs_manual_review' as const,
    };
    const files = await persistCounterexample({
      scenario: minimized.scenario,
      semanticSteps: minimized.semanticSteps,
      finding,
      artifactDir,
      seed,
      requestedRuns,
      completedRuns: details.numRuns,
      numShrinks: details.numShrinks,
      counterexamplePath: details.counterexamplePath,
      replayScenario,
    });
    productionDbUnchanged = await isolation.assertProductionDbUnchanged();
    return {
      status: 'violation',
      seed,
      requestedRuns,
      completedRuns: details.numRuns,
      numShrinks: details.numShrinks,
      counterexamplePath: details.counterexamplePath,
      finding,
      scenarioPath: files.scenarioPath,
      evidencePath: files.evidencePath,
      productionDbUnchanged,
    };
  } finally {
    try {
      await isolation.restore();
    } finally {
      if (oldAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = oldAppData;
      await fs.rm(campaignAppData, { recursive: true, force: true });
    }
  }
}
