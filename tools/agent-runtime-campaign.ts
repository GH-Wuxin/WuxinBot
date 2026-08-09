#!/usr/bin/env node
import path from 'node:path';
import {
  C1_DEFAULT_RUNS,
  C1_DEFAULT_SEED,
  C1_HARD_LIMIT_MS,
  runC1Campaign,
  type C1CampaignConfig,
} from './agent-runtime/campaign.js';
import { normalizedJson, sanitizeTraceString } from './agent-runtime/trace.js';

function usage(): string {
  return [
    'Usage: npm run agent:campaign:c1 -- [options]',
    '',
    `  --seed <integer>         fast-check seed (default ${C1_DEFAULT_SEED})`,
    `  --runs <positive>        requested cases (default ${C1_DEFAULT_RUNS})`,
    '  --max-commands <positive> maximum semantic commands per case (default 5)',
    `  --hard-limit-ms <positive> campaign hard limit (default ${C1_HARD_LIMIT_MS})`,
    '  --artifact-dir <path>    directory for scenario.min.json and evidence.json',
    '  --safe-only              exclude the known unsafe-result candidate fault',
    '  --json                   emit a normalized JSON result',
    '  --help                   show this help',
    '',
    'Exit codes: 0=pass, 1=invariant finding, 2=harness/infrastructure error.',
  ].join('\n');
}

function positiveInteger(flag: string, value: string | undefined): number {
  if (value === undefined) throw new Error(`${flag} requires a value`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function integer(flag: string, value: string | undefined): number {
  if (value === undefined) throw new Error(`${flag} requires a value`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} must be an integer`);
  return parsed;
}

function parseArgs(args: string[]): { config: C1CampaignConfig; json: boolean; help: boolean } {
  const config: C1CampaignConfig = {};
  let json = false;
  let help = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    switch (flag) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--json':
        json = true;
        break;
      case '--safe-only':
        config.includeUnsafe = false;
        break;
      case '--seed':
        config.seed = integer(flag, args[++index]);
        break;
      case '--runs':
        config.numRuns = positiveInteger(flag, args[++index]);
        break;
      case '--max-commands':
        config.maxCommands = positiveInteger(flag, args[++index]);
        break;
      case '--hard-limit-ms':
        config.hardLimitMs = positiveInteger(flag, args[++index]);
        break;
      case '--artifact-dir': {
        const value = args[++index];
        if (!value) throw new Error(`${flag} requires a value`);
        config.artifactDir = path.resolve(value);
        break;
      }
      default:
        throw new Error(`unknown option: ${flag}`);
    }
  }
  return { config, json, help };
}

function safeError(error: any): { name: string; message: string; code?: string } {
  const clean = (value: unknown) => sanitizeTraceString(String(value || ''))
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 2_000);
  return {
    name: clean(error?.name || 'Error') || 'Error',
    message: clean(error?.message || error) || 'unknown campaign error',
    ...(error?.code ? { code: clean(error.code) } : {}),
  };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(usage());
    return;
  }
  const result = await runC1Campaign(parsed.config);
  if (parsed.json) {
    console.log(normalizedJson(result));
  } else {
    console.log(`AGENT C1 CAMPAIGN ${result.status.toUpperCase()}`);
    console.log(`seed=${result.seed} requested=${result.requestedRuns} completed=${result.completedRuns} shrinks=${result.numShrinks}`);
    console.log(`productionDbUnchanged=${result.productionDbUnchanged}`);
    if (result.finding) {
      console.log(`finding=${result.finding.kind}/${result.finding.oracleId || 'none'}`);
      console.log(`classification=${result.finding.provisionalClassification}`);
      console.log(`detail=${result.finding.detail}`);
    }
    if (result.scenarioPath) {
      const relative = path.relative(process.cwd(), result.scenarioPath) || result.scenarioPath;
      console.log(`scenario=${relative}`);
      console.log(`replay=npm run agent:replay -- ${JSON.stringify(relative)}`);
    }
    if (result.evidencePath) console.log(`evidence=${path.relative(process.cwd(), result.evidencePath) || result.evidencePath}`);
  }
  process.exitCode = result.status === 'passed' ? 0 : (result.status === 'violation' ? 1 : 2);
}

main().catch((error) => {
  const safe = safeError(error);
  if (process.argv.includes('--json')) console.error(normalizedJson({ error: safe }));
  else console.error(`AGENT C1 CAMPAIGN ERROR [${safe.name}${safe.code ? `/${safe.code}` : ''}]: ${safe.message}`);
  process.exitCode = 2;
});
