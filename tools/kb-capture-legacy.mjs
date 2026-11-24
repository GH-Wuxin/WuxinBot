// Run on the intended baseline when a reviewed persona change updates the golden prompts.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestDataDir, assertNotProduction, cleanupTestDir } from './test-isolation.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/kb-legacy-prompts.json', import.meta.url));
const testDataDir = createTestDataDir('wuxin-kb-legacy');
try {
  assertNotProduction(testDataDir);
  const { captureDisabledPromptHashes } = await import('./fixtures/kb-prompt-cases.mjs');
  const hashes = captureDisabledPromptHashes();
  fs.writeFileSync(fixturePath, JSON.stringify(hashes, null, 2) + '\n', 'utf8');
  console.log('captured ' + Object.keys(hashes).length + ' prompt hashes -> ' + fixturePath);
} finally {
  cleanupTestDir(testDataDir);
}
