import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fc, { type Command } from 'fast-check';
import { classifyReplayResult, CampaignViolation, type CampaignFinding } from './campaign.js';
import { C2_ARTIFACT_SCENARIO, buildC2Scenario, c2CommandsArbitrary } from './c2-generator.js';
import { installReplayIsolation } from './isolation.js';
import { parseReplayScenarioJson } from './scenario.js';
import { normalizedJson } from './trace.js';
import type { ReplayRunResult, ReplayScenario } from './types.js';

export const C2_DEFAULT_SEED = 20_260_811;
export const C2_DEFAULT_RUNS = 1_000;
export const C2_HARD_LIMIT_MS = 60_000;
const VALIDATED_NON_GATING_CANDIDATES = new Set(['RT_ABORT_NO_LATE_EFFECT']);

type GeneratedCommand = Command<any, any>;

export interface C2CampaignConfig {
  seed?: number;
  numRuns?: number;
  maxCommands?: number;
  artifactDir?: string;
  hardLimitMs?: number;
  path?: string;
  /** Validated candidates remain evaluated and counted, but do not gate this campaign. */
  nonGatingCandidateIds?: readonly string[];
}

export interface C2CampaignResult {
  status: 'passed' | 'violation' | 'infrastructure_error';
  seed: number;
  requestedRuns: number;
  completedRuns: number;
  numShrinks: number;
  counterexamplePath: string | null;
  generatorReplayPath?: string;
  finding?: CampaignFinding;
  scenarioPath?: string;
  evidencePath?: string;
  tracePath?: string;
  fingerprint?: string;
  faultProfileCounts: Record<string, number>;
  nonGatingCandidateCounts: Record<string, number>;
  productionDbUnchanged: boolean;
}

function sortedCounts(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, content, 'utf8');
  await fs.rename(temporary, file);
}

async function fileFingerprint(file: string): Promise<string> {
  try {
    const bytes = await fs.readFile(file);
    return `present:${createHash('sha256').update(bytes).digest('hex')}`;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function replayTwice(
  scenario: ReplayScenario,
  replayScenario: (scenario: ReplayScenario) => Promise<ReplayRunResult>,
): Promise<ReplayRunResult> {
  const first = await replayScenario(scenario);
  const second = await replayScenario(scenario);
  if (normalizedJson(first.trace) !== normalizedJson(second.trace)) {
    throw new Error(`TRACE_DETERMINISTIC: byte mismatch for ${scenario.id}`);
  }
  return first;
}

async function persistFinding(args: {
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
  ignoredCandidateIds?: ReadonlySet<string>;
}): Promise<{ scenarioPath: string; evidencePath: string; tracePath: string; fingerprint: string }> {
  const scenarioPath = path.join(args.artifactDir, 'scenario.min.json');
  const evidencePath = path.join(args.artifactDir, 'evidence.json');
  const tracePath = path.join(args.artifactDir, 'trace.json');
  const relativeScenarioPath = path.relative(process.cwd(), scenarioPath).replace(/\\/g, '/');
  const relativeTracePath = path.relative(process.cwd(), tracePath).replace(/\\/g, '/');
  const scenarioToSave: ReplayScenario = {
    ...args.scenario,
    minimalReproduction: relativeScenarioPath,
  };
  await atomicWrite(scenarioPath, JSON.stringify(scenarioToSave, null, 2) + '\n');

  // The disk scenario is the long-term replay source. seed/path remain
  // generator-version-scoped auxiliary provenance only.
  const saved = parseReplayScenarioJson(await fs.readFile(scenarioPath, 'utf8'), scenarioPath);
  const replay = await replayTwice(saved, args.replayScenario);
  const replayFinding = classifyReplayResult(replay, { ignoredCandidateIds: args.ignoredCandidateIds });
  if (!replayFinding || replayFinding.kind !== args.finding.kind || replayFinding.oracleId !== args.finding.oracleId) {
    throw new Error('shrunk C2 scenario did not reproduce the same finding from disk');
  }
  const traceJson = normalizedJson(replay.trace) + '\n';
  const fingerprint = createHash('sha256')
    .update(normalizedJson({ scenario: saved, trace: replay.trace, finding: replayFinding }))
    .digest('hex');
  await atomicWrite(tracePath, traceJson);
  const evidence = {
    evidenceVersion: 2,
    scenarioSchemaVersion: saved.schemaVersion,
    traceSchemaVersion: saved.traceVersion,
    generatorVersion: saved.generatorVersion,
    scenarioPath: relativeScenarioPath,
    tracePath: relativeTracePath,
    seed: args.seed,
    counterexamplePath: args.counterexamplePath,
    // fc.commands reports the shrink suffix in counterexamplePath, but the
    // stable generator re-entry point is the original case index. Re-entering
    // this path deterministically shrinks to the same scenario again.
    generatorReplayPath: args.counterexamplePath.split(':')[0],
    requestedRuns: args.requestedRuns,
    completedRunsBeforeFailure: args.completedRuns,
    numShrinks: args.numShrinks,
    semanticSteps: args.semanticSteps,
    finding: replayFinding,
    deterministicReplay: true,
    fingerprint,
    consumption: replay.consumption,
    oracles: replay.oracles,
  };
  await atomicWrite(evidencePath, normalizedJson(evidence) + '\n');
  return { scenarioPath, evidencePath, tracePath, fingerprint };
}

export async function runC2Campaign(config: C2CampaignConfig = {}): Promise<C2CampaignResult> {
  const seed = config.seed ?? C2_DEFAULT_SEED;
  const requestedRuns = config.numRuns ?? C2_DEFAULT_RUNS;
  const maxCommands = config.maxCommands ?? 3;
  const hardLimitMs = config.hardLimitMs ?? C2_HARD_LIMIT_MS;
  const artifactDir = path.resolve(config.artifactDir || path.dirname(path.resolve(C2_ARTIFACT_SCENARIO)));
  const nonGatingCandidateIds = new Set(config.nonGatingCandidateIds || []);
  for (const id of nonGatingCandidateIds) {
    if (!VALIDATED_NON_GATING_CANDIDATES.has(id)) {
      throw new Error(`candidate is not registered as validated/non-gating: ${id}`);
    }
  }
  const faultProfileCounts = new Map<string, number>();
  const nonGatingCandidateCounts = new Map<string, number>();
  const oldAppData = process.env.APPDATA;
  const realProductionDb = path.join(
    oldAppData || path.join(process.env.USERPROFILE || 'C:', 'AppData', 'Roaming'),
    'Wuxin',
    'db.json',
  );
  const realProductionBaseline = await fileFingerprint(realProductionDb);
  const productionGuard = async (): Promise<boolean> =>
    await isolation.assertProductionDbUnchanged() &&
    await fileFingerprint(realProductionDb) === realProductionBaseline;
  const campaignAppData = await fs.mkdtemp(path.join(os.tmpdir(), 'wuxin-agent-c2-appdata-'));
  process.env.APPDATA = campaignAppData;
  const isolation = await installReplayIsolation();
  let productionDbUnchanged = false;
  try {
    const { replayScenario } = await import('./runner.js');
    const property = fc.asyncProperty(c2CommandsArbitrary(maxCommands), async (commands) => {
      const generated = buildC2Scenario(commands as Iterable<GeneratedCommand>, seed);
      const profileId = generated.scenario.faultProfile?.id || 'none';
      faultProfileCounts.set(profileId, (faultProfileCounts.get(profileId) || 0) + 1);
      let replay: ReplayRunResult;
      try {
        replay = await replayTwice(generated.scenario, replayScenario);
      } catch (error: any) {
        throw new CampaignViolation({
          kind: 'harness_bug',
          detail: String(error?.message || error),
          provisionalClassification: 'needs_manual_review',
        }, generated.scenario.id);
      }
      for (const oracle of replay.oracles) {
        const id = String(oracle.id);
        if (oracle.level === 'candidate' && !oracle.passed && nonGatingCandidateIds.has(id)) {
          nonGatingCandidateCounts.set(id, (nonGatingCandidateCounts.get(id) || 0) + 1);
        }
      }
      const finding = classifyReplayResult(replay, { ignoredCandidateIds: nonGatingCandidateIds });
      if (finding) throw new CampaignViolation(finding, generated.scenario.id);
    });

    const details = await fc.check(property, {
      seed,
      numRuns: requestedRuns,
      interruptAfterTimeLimit: hardLimitMs,
      markInterruptAsFailure: true,
      timeout: 2_000,
      maxSkipsPerRun: 100,
      ...(config.path ? { path: config.path } : {}),
    });

    if (!details.failed && !details.interrupted) {
      productionDbUnchanged = await productionGuard();
      return {
        status: 'passed', seed, requestedRuns, completedRuns: details.numRuns,
        numShrinks: details.numShrinks, counterexamplePath: null,
        faultProfileCounts: sortedCounts(faultProfileCounts),
        nonGatingCandidateCounts: sortedCounts(nonGatingCandidateCounts),
        productionDbUnchanged,
      };
    }
    if (!details.counterexample || !details.counterexamplePath) {
      productionDbUnchanged = await productionGuard();
      return {
        status: 'infrastructure_error', seed, requestedRuns, completedRuns: details.numRuns,
        numShrinks: details.numShrinks, counterexamplePath: null,
        finding: {
          kind: 'harness_bug',
          detail: details.interrupted ? `campaign exceeded ${hardLimitMs}ms` : 'campaign failed without counterexample',
          provisionalClassification: 'needs_manual_review',
        },
        faultProfileCounts: sortedCounts(faultProfileCounts),
        nonGatingCandidateCounts: sortedCounts(nonGatingCandidateCounts),
        productionDbUnchanged,
      };
    }

    const minimizedCommands = details.counterexample[0] as Iterable<GeneratedCommand>;
    const minimized = buildC2Scenario(minimizedCommands, seed);
    const replay = await replayTwice(minimized.scenario, replayScenario);
    const finding = classifyReplayResult(replay, { ignoredCandidateIds: nonGatingCandidateIds }) || {
      kind: 'harness_bug' as const,
      detail: String((details.errorInstance as any)?.message || details.errorInstance || 'shrunk failure lost its oracle finding'),
      provisionalClassification: 'needs_manual_review' as const,
    };
    const files = await persistFinding({
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
      ignoredCandidateIds: nonGatingCandidateIds,
    });
    productionDbUnchanged = await productionGuard();
    return {
      status: 'violation', seed, requestedRuns, completedRuns: details.numRuns,
      numShrinks: details.numShrinks, counterexamplePath: details.counterexamplePath,
      generatorReplayPath: details.counterexamplePath.split(':')[0],
      finding, ...files,
      faultProfileCounts: sortedCounts(faultProfileCounts),
      nonGatingCandidateCounts: sortedCounts(nonGatingCandidateCounts),
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
