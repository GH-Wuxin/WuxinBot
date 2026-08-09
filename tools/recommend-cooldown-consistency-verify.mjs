// recommend-cooldown-consistency-verify.mjs
// Regression guard for the recommendation cooldown terminal-reply semantics.
// Fully OFFLINE: osu! API is a local mock; no LLM is called (the filter
// translator short-circuits on non-filter text, and the lead LLM is a fake).
//
// Scenarios:
//   1. requiredTool + cooldown active  -> final=true must skip the lead LLM
//      entirely and deliver the deterministic cooldown text as directContent.
//   2. ordinary tool-loop + cooldown   -> the LLM calls query_osu recommend,
//      the loop must stop after the terminal result (no second LLM turn).
//   3. requiredTool + no cooldown      -> a normal recommend still goes
//      through the lead LLM; directContent alone must NOT behave as final.
//
// Exit 0 on all pass, non-zero on any failure.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  createTestDataDir,
  assertNotProduction,
  productionDbSnapshot,
  verifyProductionDbUnchanged,
  cleanupTestDir,
} = await import(pathToFileURL(path.join(REPO, 'tools', 'test-isolation.mjs')).href);

const testDataDir = createTestDataDir('wuxin-recommend-cooldown');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);
const prodBefore = productionDbSnapshot();
console.log('[isolation] test data dir: ' + testDataDir);
console.log('[isolation] production db snapshot: ' + (prodBefore ? prodBefore.sha256.slice(0, 12) + '...' : 'N/A'));

// ── Offline osu! API mock (same fixture world as recommend-verify.mjs) ──
const MAPS = [
  [1001, 7001, 'Alpha Fixture', '6.0', { bpm: 170, ar: 9.2, version: 'Insane' }],
  [1002, 7002, 'Beta Fixture', '5.8', { bpm: 175, ar: 9.0, version: 'Hard' }],
  [1003, 7003, 'Gamma Fixture', '6.2', { bpm: 185, ar: 8.8, version: 'Insane' }],
  [1004, 7004, 'Delta Fixture', '5.9', { bpm: 180, ar: 9.5, version: 'Insane' }],
  [1005, 7005, 'Epsilon Fixture', '6.1', { bpm: 190, ar: 9.3, version: 'Insane' }],
  [1006, 7006, 'Zeta Fixture', '5.7', { bpm: 200, ar: 8.5, version: 'Hard' }],
  [1007, 7007, 'Eta Fixture', '6.3', { bpm: 165, ar: 9.7, version: 'Insane' }],
  [1008, 7008, 'Theta Fixture', '5.5', { bpm: 172, ar: 9.1, version: 'Hard' }],
  [1009, 7009, 'Iota Fixture', '5.0', { bpm: 160, ar: 8.5, version: 'DT-Fixture' }],
];

const SETS = new Map();
const BEATMAPS = new Map();
for (const [id, setId, title, stars, opts] of MAPS) {
  const setIdNum = Number(setId);
  if (!SETS.has(setIdNum)) {
    SETS.set(setIdNum, {
      id: setIdNum,
      title,
      title_unicode: title,
      artist: 'Fixture Artist',
      creator: 'Fixture Creator',
      status: 'ranked',
      covers: { cover: `https://mock.invalid/cover/${setIdNum}`, 'cover@2x': '', list: '', 'list@2x': '' },
    });
  }
  BEATMAPS.set(id, {
    id,
    beatmapset_id: setIdNum,
    mode: 'osu',
    difficulty_rating: Number(stars),
    version: opts.version,
    accuracy: 8,
    ar: opts.ar,
    bpm: opts.bpm,
    cs: 4,
    drain: 6,
    total_length: 180,
    hit_length: 180,
    max_combo: 1000,
    count_circles: 500,
    count_sliders: 100,
    count_spinners: 0,
    status: 'ranked',
    url: `https://osu.ppy.sh/beatmaps/${id}`,
  });
}

function fixtureUser(id, username, pp) {
  return {
    id,
    username,
    country_code: 'CN',
    avatar_url: 'https://mock.invalid/avatar.png',
    is_online: true,
    join_date: '2020-01-01T00:00:00Z',
    statistics: {
      level: { current: 100, progress: 0 },
      global_rank: Math.max(1, Math.round(1_000_000 - pp * 100)),
      country_rank: 1,
      pp,
      ranked_score: 1,
      total_score: 1,
      total_hits: 1,
      hit_accuracy: 98,
      play_count: 100,
      play_time: 1000,
      maximum_combo: 1000,
      replays_watched_by_others: 0,
      is_ranked: true,
      grade_counts: { ss: 0, s: 0, a: 0 },
    },
    grade_counts: { ss: 0, ssh: 0, s: 0, sh: 0, a: 0 },
    follower_count: 0,
    support_level: 0,
  };
}

const WUXIN_OSU_ID = 10000001;
const USERS = new Map([
  [WUXIN_OSU_ID, fixtureUser(WUXIN_OSU_ID, '[TST]Alpha', 8700)],
  [10000002, fixtureUser(10000002, 'BetaPlayer', 7600)],
  [37645378, fixtureUser(37645378, 'sparse-user', 1200)],
  [10000003, fixtureUser(10000003, 'playable-user', 5000)],
]);
for (let i = 1; i <= 12; i++) {
  USERS.set(90000 + i, fixtureUser(90000 + i, `similar-${String(i).padStart(2, '0')}`, 8000 + i * 10));
}

function score(id, userId, beatmapId, pp, rank = 'S', mods = []) {
  const beatmap = BEATMAPS.get(beatmapId);
  return {
    id,
    user_id: userId,
    accuracy: 98,
    max_combo: 1000,
    mods,
    pp,
    rank,
    score: 1_000_000,
    statistics: { count_50: 0, count_100: 10, count_300: 500, count_geki: 0, count_katsu: 0, count_miss: 0 },
    beatmap,
    beatmapset: SETS.get(beatmap.beatmapset_id),
    created_at: '2026-01-01T00:00:00Z',
    mode: 'osu',
  };
}

let scoreId = 1;
function best(entries) {
  return entries.map(([uid, bid, pp, rank, mods]) => score(scoreId++, uid, bid, pp, rank, mods));
}

const BEST = new Map();
BEST.set(WUXIN_OSU_ID, best([
  [WUXIN_OSU_ID, 1001, 300, 'S'], [WUXIN_OSU_ID, 1002, 280, 'S'], [WUXIN_OSU_ID, 1003, 260, 'S'],
]));
BEST.set(10000002, best([
  [10000002, 1004, 300, 'S'], [10000002, 1005, 280, 'S'], [10000002, 1006, 260, 'S'],
]));
BEST.set(37645378, []);
BEST.set(10000003, best([
  [10000003, 1001, 200, 'S'], [10000003, 1002, 190, 'S'], [10000003, 1003, 180, 'S'],
]));
for (let i = 1; i <= 12; i++) {
  const uid = 90000 + i;
  BEST.set(uid, best([
    [uid, 1001, 299 + i, 'S'], [uid, 1002, 279 + i, 'S'], [uid, 1003, 259 + i, 'S'],
    [uid, 1007, 205, 'S'], [uid, 1008, 195, 'S'], [uid, 1009, 185, 'S', ['DT']],
  ]));
}

const LEADERBOARDS = new Map();
function leaderboard(beatmapId, entries) {
  LEADERBOARDS.set(beatmapId, entries.map(([uid, pp]) => score(scoreId++, uid, beatmapId, pp, 'S', uid >= 90000 && beatmapId === 1009 ? ['DT'] : [])));
}
leaderboard(1001, [[WUXIN_OSU_ID, 300], [10000003, 200], ...Array.from({ length: 12 }, (_, i) => [90001 + i, 299 + i])]);
leaderboard(1002, [[WUXIN_OSU_ID, 280], [10000003, 190], ...Array.from({ length: 12 }, (_, i) => [90001 + i, 279 + i])]);
leaderboard(1003, [[WUXIN_OSU_ID, 260], [10000003, 180], ...Array.from({ length: 12 }, (_, i) => [90001 + i, 259 + i])]);
leaderboard(1004, [[10000002, 300], ...Array.from({ length: 12 }, (_, i) => [90001 + i, 299 + i])]);
leaderboard(1005, [[10000002, 280], ...Array.from({ length: 12 }, (_, i) => [90001 + i, 279 + i])]);
leaderboard(1006, [[10000002, 260], ...Array.from({ length: 12 }, (_, i) => [90001 + i, 259 + i])]);
leaderboard(1007, Array.from({ length: 12 }, (_, i) => [90001 + i, 205]));
leaderboard(1008, Array.from({ length: 12 }, (_, i) => [90001 + i, 195]));
leaderboard(1009, Array.from({ length: 12 }, (_, i) => [90001 + i, 185]));

let mockPort;
const mockServer = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${mockPort}`).pathname);
  const send = (body, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'POST' && pathname === '/oauth/token') {
    return send({ access_token: 'fixture-token', expires_in: 86400, token_type: 'Bearer' });
  }
  let m = /^\/api\/v2\/users\/(\d+)\/osu$/.exec(pathname);
  if (m) {
    const u = USERS.get(Number(m[1]));
    return u ? send(u) : send({ error: 'not_found' }, 404);
  }
  m = /^\/api\/v2\/users\/@(.+)\/osu$/.exec(pathname);
  if (m) {
    const u = [...USERS.values()].find((x) => x.username === decodeURIComponent(m[1]));
    return u ? send(u) : send({ error: 'not_found' }, 404);
  }
  m = /^\/api\/v2\/users\/(\d+)\/scores\/best$/.exec(pathname);
  if (m) return send(BEST.get(Number(m[1])) || []);
  m = /^\/api\/v2\/beatmaps\/(\d+)\/scores$/.exec(pathname);
  if (m) return send({ scores: LEADERBOARDS.get(Number(m[1])) || [] });
  m = /^\/api\/v2\/beatmaps\/(\d+)\/attributes$/.exec(pathname);
  if (m && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let mods = [];
      try { mods = JSON.parse(body || '{}').mods || []; } catch { /* keep [] */ }
      const beatmap = BEATMAPS.get(Number(m[1]));
      let star = beatmap ? beatmap.difficulty_rating : 5;
      if (mods.some((mod) => mod === 'DT' || mod === 'NC')) star *= 1.4;
      else if (mods.some((mod) => mod === 'HR')) star *= 1.2;
      return send({ attributes: { star_rating: Math.round(star * 100) / 100, max_combo: 1000 } });
    });
    return;
  }
  return send({ error: 'not_found' }, 404);
});
await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
mockPort = mockServer.address().port;
process.env.OSU_API_BASE_URL = `http://127.0.0.1:${mockPort}/api/v2`;
process.env.OSU_TOKEN_URL = `http://127.0.0.1:${mockPort}/oauth/token`;
console.log(`[mock] osu! API served on 127.0.0.1:${mockPort}`);

const { ensureStore, updateDb, readDb } = await import(pathToFileURL(path.join(REPO, 'server', 'store.ts')).href);
ensureStore();
updateDb((draft) => {
  draft.settings.osuClientId = 'fixture-client';
  draft.settings.osuClientSecret = 'fixture-secret';
  draft.osuBindings = draft.osuBindings || {};
  draft.osuBindings['verify-user'] = { osuUserId: WUXIN_OSU_ID, osuUsername: '[TST]Alpha' };
  draft.osuRecommendCooldowns = draft.osuRecommendCooldowns || {};
});

const { runToolLoop } = await import(pathToFileURL(path.join(REPO, 'server', 'bots', 'executor.ts')).href);

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

// ── Shared scenario fixtures ──
const PREV_REC_TEXT = [
  '[TST]Alpha 的推荐（按你的要求筛选）：',
  '1. [FLHD] Alpha Fixture [Insane] BID 7001 (https://osu.ppy.sh/beatmaps/1001)',
  '2. [HDHR] Beta Fixture [Hard] BID 7002 (https://osu.ppy.sh/beatmaps/1002)',
  '3. [HDHR] Gamma Fixture [Insane] BID 7003 (https://osu.ppy.sh/beatmaps/1003)',
].join('\n');
const CURRENT_TEXT = '给我推图，千万不要有DT、HR、FL、EZ';
const HALLUCINATED = '而且那三张本来就没带DT/HR/FL/EZ，都是NM和HD的，放心打。';
const LEAD_TEXT = '好的，推荐如下。';
const messagesWithHistory = [
  { role: 'system', content: '你是 pippi。' },
  { role: 'user', content: '[10:01] 玩家（QQ:123）：我是nomod玩家，给我推不是小众猎奇宝藏爆炸的图' },
  { role: 'assistant', content: PREV_REC_TEXT },
  { role: 'user', content: `[10:05] 玩家（QQ:123）：${CURRENT_TEXT}` },
];
const recommendArgs = JSON.stringify({ capability: 'recommend', username: '[TST]Alpha' });
const recommendToolCall = {
  id: 'call_recommend',
  type: 'function',
  function: { name: 'query_osu', arguments: recommendArgs },
};
const tools = [{
  type: 'function',
  function: { name: 'query_osu', description: 'osu queries', parameters: { type: 'object', properties: {}, required: [] } },
}];

function setCooldownActive() {
  updateDb((draft) => {
    draft.osuRecommendCooldowns[String(WUXIN_OSU_ID)] = Date.now();
  });
}
function clearCooldown() {
  updateDb((draft) => {
    delete draft.osuRecommendCooldowns[String(WUXIN_OSU_ID)];
  });
}

// ── Scenario 1: requiredTool + cooldown => terminal, no lead LLM ──
{
  const label = 'final:required-tool';
  setCooldownActive();
  let leadCalls = 0;
  const fakeChat = async () => {
    leadCalls++;
    return { text: HALLUCINATED, usage: {}, raw: { choices: [{ message: { content: HALLUCINATED, tool_calls: null } }] } };
  };
  const result = await runToolLoop(fakeChat, {
    db: readDb(),
    messages: messagesWithHistory,
    tools,
    userId: 'verify-user',
    groupId: 'test-group',
    event: { userId: 'verify-user', text: CURRENT_TEXT },
    maxIterations: 4,
    requiredTool: { toolName: 'query_osu', args: { capability: 'recommend', username: '[TST]Alpha' } },
    deliverDirectContent: true,
  });
  assert(leadCalls === 0, `${label}:lead-skipped`, `lead LLM called ${leadCalls} time(s)`);
  assert(result.text === '', `${label}:no-lead-text`, `unexpected text: ${JSON.stringify(result.text)}`);
  assert(result.directContent.includes('刚推过图'), `${label}:cooldown-fact`, result.directContent);
  assert(
    result.directContent.includes('本轮没有重新推荐') && result.directContent.includes('没有重新检查上一批'),
    `${label}:unverified-facts`,
    result.directContent,
  );
  assert(!result.directContent.includes('那三张本来就没带DT/HR/FL/EZ'), `${label}:no-hallucination`, result.directContent);
  assert(result.recommendToolCalled === true, `${label}:recommend-flag`, 'recommendToolCalled should be true');
}

// ── Scenario 2: ordinary tool-loop + cooldown => stop after terminal result ──
{
  const label = 'final:tool-loop';
  setCooldownActive();
  let llmCalls = 0;
  const fakeChat = async () => {
    llmCalls++;
    if (llmCalls === 1) {
      return {
        text: '',
        usage: {},
        raw: { choices: [{ message: { content: '', tool_calls: [recommendToolCall] } }] },
      };
    }
    return { text: HALLUCINATED, usage: {}, raw: { choices: [{ message: { content: HALLUCINATED, tool_calls: null } }] } };
  };
  const result = await runToolLoop(fakeChat, {
    db: readDb(),
    messages: messagesWithHistory,
    tools,
    userId: 'verify-user',
    groupId: 'test-group',
    event: { userId: 'verify-user', text: CURRENT_TEXT },
    maxIterations: 4,
    deliverDirectContent: false,
  });
  assert(llmCalls === 1, `${label}:no-second-turn`, `LLM called ${llmCalls} time(s)`);
  assert(result.text === '', `${label}:no-lead-text`, `unexpected text: ${JSON.stringify(result.text)}`);
  assert(result.directContent.includes('本轮没有重新推荐'), `${label}:unverified-facts`, result.directContent);
  assert(!result.directContent.includes('那三张本来就没带DT/HR/FL/EZ'), `${label}:no-hallucination`, result.directContent);
}

// ── Scenario 3: requiredTool + no cooldown => normal recommend still gets a
//    lead LLM turn; directContent alone is NOT final. ──
{
  const label = 'non-final:required-tool';
  clearCooldown();
  let leadCalls = 0;
  const fakeChat = async () => {
    leadCalls++;
    return { text: LEAD_TEXT, usage: {}, raw: { choices: [{ message: { content: LEAD_TEXT, tool_calls: null } }] } };
  };
  const result = await runToolLoop(fakeChat, {
    db: readDb(),
    messages: [
      { role: 'system', content: '你是 pippi。' },
      { role: 'user', content: '[10:05] 玩家（QQ:123）：再推荐三张' },
    ],
    tools,
    userId: 'verify-user',
    groupId: 'test-group',
    event: { userId: 'verify-user', text: '再推荐三张' },
    maxIterations: 4,
    requiredTool: { toolName: 'query_osu', args: { capability: 'recommend', username: '[TST]Alpha' } },
    deliverDirectContent: true,
  });
  assert(leadCalls === 1, `${label}:lead-called`, `lead LLM called ${leadCalls} time(s)`);
  assert(result.text === LEAD_TEXT, `${label}:lead-text`, `expected ${JSON.stringify(LEAD_TEXT)}, got ${JSON.stringify(result.text)}`);
  assert(
    result.directContent.includes('推荐') && result.directContent.includes('BID'),
    `${label}:direct-payload`,
    `directContent not the structured recommendation: ${result.directContent.slice(0, 200)}`,
  );
  assert(!result.directContent.includes('本轮没有重新推荐'), `${label}:not-cooldown`, result.directContent);
}

mockServer.close();
verifyProductionDbUnchanged(prodBefore);
cleanupTestDir(testDataDir);

console.log(`\nRECOMMEND-COOLDOWN-CONSISTENCY-VERIFY: passed=${passed} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
