// osu-star-api-verify.mjs — offline regression for the osu! API client's
// mod-adjusted star-rating path. Serves a local mock so the suite never
// depends on osu.ppy.sh availability or rate limits.
// Exit 0 on all pass, non-zero on any failure.

import { createTestDataDir, assertNotProduction, productionDbSnapshot, verifyProductionDbUnchanged, cleanupTestDir } from './test-isolation.mjs';
import { startOsuApiMock } from './osu-api-mock.mjs';

const testDataDir = createTestDataDir('wuxin-osustar');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);
const prodBefore = productionDbSnapshot();

const mock = await startOsuApiMock();
process.env.OSU_API_BASE_URL = mock.apiBase;
process.env.OSU_TOKEN_URL = mock.tokenUrl;
process.env.OSU_CLIENT_ID = 'fixture-client';
process.env.OSU_CLIENT_SECRET = 'fixture-secret';
console.log(`[mock] osu! API served on 127.0.0.1:${mock.port}`);

const { getBeatmapAttributes, getUser, getUserBestScores } = await import('../server/osu/api.js');

let passed = 0;
let failed = 0;
const pass = (label) => { console.log(`PASS [${label}]`); passed++; };
const fail = (label, msg) => { console.error(`FAIL [${label}]: ${msg}`); failed++; };
const assert = (cond, label, msg) => (cond ? pass(label) : fail(label, msg));

// 1. User lookup by username and id.
let user;
try {
  user = await getUser('[TST]Alpha', 'osu');
  assert(user.id === 10000001, 'user:username', `id=${user.id}`);
  const byId = await getUserByIdSafe(10000001);
  assert(byId.id === 10000001, 'user:by-id', `id=${byId.id}`);
} catch (e) {
  fail('user', e.message);
}

// 2. Best scores + mod grouping against the fixture.
if (user) {
  const scores = await getUserBestScores(user.id, 'osu', 100);
  assert(scores.length >= 7, 'scores:count', `got ${scores.length}`);

  const groups = [
    ['DT/NC', (s) => s.mods?.some((mod) => mod === 'DT' || mod === 'NC')],
    ['HR', (s) => s.mods?.includes('HR')],
    ['HD without HR/DT', (s) =>
      s.mods?.includes('HD') &&
      !s.mods.some((mod) => ['HR', 'DT', 'NC', 'HT', 'EZ', 'DA'].includes(mod))],
    ['NF/SO', (s) => s.mods?.some((mod) => mod === 'NF' || mod === 'SO')],
  ];

  for (const [label, predicate] of groups) {
    const score = scores.find(predicate);
    if (!score) {
      fail(`star:${label}`, 'no fixture BP sample');
      continue;
    }
    const base = Number(score.beatmap.difficulty_rating);
    const result = await getBeatmapAttributes(score.beatmap.id, 'osu', score.mods);
    const modded = Number(result.attributes.star_rating);
    const expectedMultiplier = label === 'DT/NC' ? 1.4 : label === 'HR' ? 1.2 : 1.0;
    const expected = Math.round(base * expectedMultiplier * 100) / 100;
    assert(
      Math.abs(modded - expected) < 0.01,
      `star:${label}`,
      `beatmap=${score.beatmap.id} mods=${score.mods.join('') || 'NM'} base=${base} modded=${modded} expected=${expected}`,
    );
  }
}

// 3. Missing resources still fail with the same error family.
try {
  await getUser('no-such-fixture-user', 'osu');
  fail('missing:user', 'expected 404 error for unknown user');
} catch {
  pass('missing:user');
}

await mock.close();
verifyProductionDbUnchanged(prodBefore);
cleanupTestDir(testDataDir);

console.log(`\nOSU-STAR-API-VERIFY: passed=${passed} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);

async function getUserByIdSafe(id) {
  const { getUserById } = await import('../server/osu/api.js');
  return getUserById(id, 'osu');
}
