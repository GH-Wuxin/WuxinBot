import fs from 'node:fs/promises';
import path from 'node:path';

import { installReplayIsolation } from './agent-runtime/isolation.js';
import {
  parseCounterfactualFixture,
  runCounterfactualFixture,
} from './agent-runtime/counterfactual.js';
import { normalizedJson } from './agent-runtime/trace.js';

const DEFAULT_FIXTURE = path.resolve(
  'tools',
  'fixtures',
  'agent-runtime',
  'counterfactual',
  'fast-thinking.json',
);

async function main(): Promise<void> {
  const input = path.resolve(process.argv[2] || DEFAULT_FIXTURE);
  const fixture = parseCounterfactualFixture(
    JSON.parse(await fs.readFile(input, 'utf8')),
    input,
  );
  const isolation = await installReplayIsolation();
  try {
    const comparison = await runCounterfactualFixture(fixture, input);
    if (comparison.findings.length > 0) {
      throw new Error(`counterfactual candidate/enforced finding: ${normalizedJson(comparison.findings)}`);
    }
    if (!await isolation.assertProductionDbUnchanged()) {
      throw new Error('production DB hash changed during offline counterfactual replay');
    }
    console.log(JSON.stringify(comparison, null, 2));
  } finally {
    await isolation.restore();
  }
}

main().catch((error) => {
  console.error(`AGENT COUNTERFACTUAL ERROR: ${String(error?.message || error)}`);
  process.exitCode = 1;
});
