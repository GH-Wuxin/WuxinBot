#!/usr/bin/env node
import path from 'node:path';
import {
  C2_DEFAULT_RUNS,
  C2_DEFAULT_SEED,
  C2_HARD_LIMIT_MS,
  runC2Campaign,
  type C2CampaignConfig,
} from './agent-runtime/c2-campaign.js';
import { normalizedJson, sanitizeTraceString } from './agent-runtime/trace.js';

function positive(flag: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`);
  return parsed;
}

function integer(flag: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} requires an integer`);
  return parsed;
}

function parseArgs(args: string[]): { config: C2CampaignConfig; json: boolean } {
  const config: C2CampaignConfig = {};
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    switch (flag) {
      case '--json': json = true; break;
      case '--acknowledge-validated-abort-candidate':
        config.nonGatingCandidateIds = ['RT_ABORT_NO_LATE_EFFECT'];
        break;
      case '--seed': config.seed = integer(flag, args[++index]); break;
      case '--runs': config.numRuns = positive(flag, args[++index]); break;
      case '--max-commands': config.maxCommands = positive(flag, args[++index]); break;
      case '--hard-limit-ms': config.hardLimitMs = positive(flag, args[++index]); break;
      case '--path': {
        const value = args[++index];
        if (!value) throw new Error(`${flag} requires a fast-check path`);
        config.path = value;
        break;
      }
      case '--artifact-dir': {
        const value = args[++index];
        if (!value) throw new Error(`${flag} requires a path`);
        config.artifactDir = path.resolve(value);
        break;
      }
      default: throw new Error(`unknown option: ${flag}`);
    }
  }
  return { config, json };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const result = await runC2Campaign(parsed.config);
  if (parsed.json) console.log(normalizedJson(result));
  else {
    console.log(`AGENT C2.1 CAMPAIGN ${result.status.toUpperCase()}`);
    console.log(`seed=${result.seed} requested=${result.requestedRuns} completed=${result.completedRuns} shrinks=${result.numShrinks}`);
    console.log(`productionDbUnchanged=${result.productionDbUnchanged}`);
    console.log(`faultProfiles=${JSON.stringify(result.faultProfileCounts)}`);
    console.log(`nonGatingCandidates=${JSON.stringify(result.nonGatingCandidateCounts)}`);
    if (result.finding) console.log(`finding=${result.finding.kind}/${result.finding.oracleId || 'none'} ${result.finding.detail}`);
    if (result.generatorReplayPath) console.log(`generatorReplayPath=${result.generatorReplayPath}`);
    if (result.scenarioPath) console.log(`scenario=${path.relative(process.cwd(), result.scenarioPath)}`);
    if (result.tracePath) console.log(`trace=${path.relative(process.cwd(), result.tracePath)}`);
    if (result.fingerprint) console.log(`fingerprint=${result.fingerprint}`);
  }
  process.exitCode = result.status === 'passed' ? 0 : (result.status === 'violation' ? 1 : 2);
}

main().catch((error: any) => {
  const clean = sanitizeTraceString(String(error?.message || error)).slice(0, 2_000);
  console.error(`AGENT C2.1 CAMPAIGN ERROR: ${clean}`);
  process.exitCode = 2;
});

export const C2_CAMPAIGN_DEFAULTS = { C2_DEFAULT_SEED, C2_DEFAULT_RUNS, C2_HARD_LIMIT_MS };
