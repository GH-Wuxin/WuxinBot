import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve('docs/sticker-release/scenarios.json');
const scenarios = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.ok(Array.isArray(scenarios));
assert.ok(scenarios.length >= 40, `expected at least 40 scenarios, got ${scenarios.length}`);

const requiredCategories = new Set([
  'osu_positive',
  'osu_negative',
  'ordinary_chat',
  'bot_event',
  'must_not_sticker',
]);
const ids = new Set();
for (const scenario of scenarios) {
  assert.equal(typeof scenario.id, 'string');
  assert.ok(scenario.id.trim());
  assert.equal(ids.has(scenario.id), false, `duplicate scenario id: ${scenario.id}`);
  ids.add(scenario.id);
  assert.ok(requiredCategories.has(scenario.category), `unknown category: ${scenario.category}`);
  assert.equal(typeof scenario.input, 'string');
  assert.ok(scenario.input.trim());
  assert.ok(Array.isArray(scenario.acceptableModes));
  assert.ok(scenario.acceptableModes.every((mode) => ['none', 'text_image', 'image_only'].includes(mode)));
  assert.equal(typeof scenario.mustRemainText, 'boolean');
  if (scenario.mustRemainText) assert.ok(scenario.acceptableModes.includes('none'));
}
for (const category of requiredCategories) {
  assert.ok(scenarios.some((scenario) => scenario.category === category), `missing category: ${category}`);
}

console.log(JSON.stringify({
  ok: true,
  count: scenarios.length,
  categories: Object.fromEntries([...requiredCategories].map((category) => [
    category,
    scenarios.filter((scenario) => scenario.category === category).length,
  ])),
}, null, 2));
