// recommend-verify.mjs
// Regression guard for the beatmap recommendation engine (MVP collaborative
// filtering). Uses a DATA_DIR-isolated db (real osu! API calls, real binding
// settings copied from production) and asserts:
//   - mid/high players get 1..count candidates within star limits
//   - candidates never overlap the player's own top100
//   - sparse players get a definitive result (success or honest failure)
//   - cooldown + 7-day anti-repeat persistence work
//   - executeInternalBotCommand('recommend') returns readable text + images
// Exit 0 on all pass, non-zero on any failure.

import fs from 'node:fs';
import path from 'node:path';
import { createTestDataDir, assertNotProduction, productionDbSnapshot, verifyProductionDbUnchanged, cleanupTestDir } from './test-isolation.mjs';

const testDataDir = createTestDataDir('wuxin-recommend');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);
const prodBefore = productionDbSnapshot();
console.log('[isolation] production db snapshot: ' + (prodBefore ? prodBefore.sha256.slice(0, 12) + '...' : 'N/A'));

const { ensureStore, updateDb } = await import('../server/store.ts');
ensureStore();

// Copy osu client credentials from production so real API calls work.
const prodDbPath = path.join(process.env.APPDATA, 'Wuxin', 'db.json');
if (fs.existsSync(prodDbPath)) {
  const prod = JSON.parse(fs.readFileSync(prodDbPath, 'utf8'));
  updateDb((draft) => {
    draft.settings = {
      ...(draft.settings || {}),
      osuClientId: prod.settings?.osuClientId || '',
      osuClientSecret: prod.settings?.osuClientSecret || '',
    };
  });
}

const {
  recommendForPlayer,
  checkRecommendCooldown,
  loadRecommendHistory,
  markRecommendation,
  formatRecommendLine,
} = await import('../server/osu/recommender.ts');
const { getUserBestScores } = await import('../server/osu/api.ts');
const { executeInternalBotCommand } = await import('../server/bots/executor.ts');
const { readDb } = await import('../server/store.ts');

let passed = 0;
let failed = 0;

function pass(label) {
  console.log(`PASS [${label}]`);
  passed++;
}

function fail(label, msg) {
  console.error(`FAIL [${label}]: ${msg}`);
  failed++;
}

function assert(cond, label, msg) {
  if (cond) pass(label);
  else fail(label, msg);
}

const db = readDb();

// ── 1. Engine: mid/high players ──
for (const [name, osuId] of [['[SHK]Wuxin', 19244792], ['tan-X', 24657559]]) {
  const label = `engine:${name}`;
  try {
    const res = await recommendForPlayer({ kind: 'id', value: osuId }, db, {
      count: 3,
      excludeBeatmapsetIds: new Set(),
      bypassCache: true,
    });
    assert(res.ok, label, `expected ok, got ${JSON.stringify(res).slice(0, 200)}`);
    if (!res.ok) continue;
    assert(res.candidates.length >= 1 && res.candidates.length <= 3, `${label}:count`, `got ${res.candidates.length}`);

    const ownTop = await getUserBestScores(osuId, 'osu', 100);
    const ownIds = new Set(ownTop.map((s) => s.beatmap?.id).filter(Boolean));
    const ownSetIds = new Set(ownTop.map((s) => s.beatmapset?.id || s.beatmap?.beatmapset_id).filter(Boolean));
    const overlap = res.candidates.filter((c) => ownIds.has(c.beatmapId) || ownSetIds.has(c.beatmapsetId));
    assert(overlap.length === 0, `${label}:no-top100-overlap`, `overlap: ${JSON.stringify(overlap.map((c) => c.title))}`);

    const topStars = ownTop.slice(0, 30).map((s) => s.beatmap?.difficulty_rating || 0).filter((v) => v > 0);
    const upper = Math.max(...topStars) * 1.3 + 0.01;
    const tooHard = res.candidates.filter((c) => c.stars > 0 && c.stars > upper);
    assert(tooHard.length === 0, `${label}:star-cap`, `above ${upper.toFixed(2)}*: ${JSON.stringify(tooHard.map((c) => c.title))}`);

    for (const c of res.candidates) {
      const line = formatRecommendLine(c, 0);
      assert(/https:\/\/osu\.ppy\.sh\/beatmaps\/\d+/.test(line), `${label}:link`, line);
    }
  } catch (e) {
    fail(label, e.message);
  }
}

// ── 2. Engine: sparse player gets a definitive result ──
{
  const label = 'engine:sparse';
  const res = await recommendForPlayer({ kind: 'id', value: 37645378 }, db, {
    count: 3,
    excludeBeatmapsetIds: new Set(),
    bypassCache: true,
  });
  assert(res.ok || (typeof res.reason === 'string' && res.reason.length > 0), label, `expected candidates or honest failure, got ${JSON.stringify(res).slice(0, 200)}`);
}

// ── 3. Cooldown + anti-repeat persistence ──
{
  const label = 'cooldown';
  const osuId = 24657559; // tan-X (do not touch production binding)
  const before = checkRecommendCooldown(db, osuId);
  assert(before === 0, `${label}:fresh`, `expected 0, got ${before}`);

  markRecommendation(osuId, [
    { beatmapId: 99991, beatmapsetId: 88881, title: 't', artist: 'a', creator: 'c', version: 'v', coverUrl: '', mapUrl: '', stars: 5, bpm: 180, totalLength: 120, mods: [], pp: 100, similarCount: 1 },
  ]);
  const afterDb = readDb();
  const cooldown = checkRecommendCooldown(afterDb, osuId);
  assert(cooldown > 0, `${label}:set`, `expected > 0, got ${cooldown}`);
  const history = loadRecommendHistory(afterDb, osuId);
  assert(history.has(88881), `${label}:history`, `88881 missing from ${JSON.stringify([...history])}`);
}

// ── 4. Internal bot command returns readable output ──
{
  const label = 'internal-command';
  try {
    const result = await executeInternalBotCommand('yumu', 'recommend', '[SHK]Wuxin', { db, userId: 'verify-user', groupId: 'test-group' });
    const text = typeof result === 'string' ? result : result.content;
    const images = typeof result === 'string' ? [] : (result.images || []);
    assert(String(text).includes('谱面推荐'), `${label}:content`, text.slice(0, 200));
    assert(Array.isArray(images) && images.length <= 3, `${label}:images`, `images=${JSON.stringify(images).slice(0, 120)}`);
  } catch (e) {
    fail(label, e.message);
  }
}

verifyProductionDbUnchanged(prodBefore);
cleanupTestDir(testDataDir);

console.log(`\nRECOMMEND-VERIFY: passed=${passed} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
