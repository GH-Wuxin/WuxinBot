#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installReplayIsolation } from './agent-runtime/isolation.js';
import { parseReplayScenarioJson } from './agent-runtime/scenario.js';
import { formatReplayTrace, normalizedJson, sanitizeTraceString } from './agent-runtime/trace.js';
import type { ReplayRunResult, ReplayScenario } from './agent-runtime/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCENARIO = path.join(HERE, 'fixtures', 'agent-runtime', 'scenario.min.json');

function usage(): string {
  return [
    'Usage: npm run agent:replay -- [scenario.json] [--json]',
    `Default: ${path.relative(process.cwd(), DEFAULT_SCENARIO)}`,
  ].join('\n');
}

function safeCliError(error: any): { name: string; message: string; code?: string } {
  const scrub = (value: unknown) => sanitizeTraceString(String(value || ''))
    .replace(/\bBearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(/\b((?:api[_-]?key|token|secret|password)\s*[:=]\s*)\S+/gi, '$1<redacted>')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 2_000);
  return {
    name: scrub(error?.name || 'Error') || 'Error',
    message: scrub(error?.message || error) || 'unknown replay error',
    ...(error?.code ? { code: scrub(error.code) } : {}),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    return;
  }
  const jsonOutput = args.includes('--json');
  const fileArg = args.find((arg) => !arg.startsWith('-'));
  const scenarioPath = path.resolve(fileArg || DEFAULT_SCENARIO);
  const isolation = await installReplayIsolation();
  let scenario!: ReplayScenario;
  let result!: ReplayRunResult;
  let productionDbUnchanged = false;
  try {
    scenario = parseReplayScenarioJson(await fs.readFile(scenarioPath, 'utf8'), scenarioPath);
    const { replayScenario } = await import('./agent-runtime/runner.js');
    result = await replayScenario(scenario);
    productionDbUnchanged = await isolation.assertProductionDbUnchanged();
  } finally {
    // Restore and re-check before printing PASS/JSON. A DB guard failure is an
    // infrastructure error (exit 2), never a late failure after success text.
    await isolation.restore();
  }

  if (jsonOutput) {
    console.log(normalizedJson({ result, isolation: { productionDbUnchanged } }));
  } else {
    console.log(`AGENT REPLAY ${result.passed ? 'PASS' : 'FAIL'}: ${scenario.id}`);
    console.log(`Versions: schema=${scenario.schemaVersion} trace=${scenario.traceVersion} generator=${scenario.generatorVersion}`);
    console.log(`Seed provenance: ${scenario.seed} (replay does not use randomness)`);
    console.log(`Isolation: productionDbUnchanged=${productionDbUnchanged}`);
    console.log('\nTrace:\n' + formatReplayTrace(result.trace));
    console.log('\nOracles:');
    for (const oracle of result.oracles) {
      const mark = oracle.passed ? 'PASS' : (oracle.level === 'candidate' ? 'DIAG' : 'FAIL');
      console.log(`  ${mark} [${oracle.level}] ${oracle.id}: ${oracle.detail}`);
    }
    if (!result.passed) {
      const reproduction = scenario.minimalReproduction || path.relative(process.cwd(), scenarioPath);
      console.log(`\nMinimal reproduction: ${reproduction}`);
      console.log(`Command: npm run agent:replay -- ${JSON.stringify(reproduction)}`);
    }
  }
  process.exitCode = result.passed ? 0 : 1;
}

main().catch((error) => {
  const safe = safeCliError(error);
  if (process.argv.includes('--json')) console.error(normalizedJson({ error: safe }));
  else console.error(`AGENT REPLAY ERROR [${safe.name}${safe.code ? `/${safe.code}` : ''}]: ${safe.message}`);
  process.exitCode = 2;
});
