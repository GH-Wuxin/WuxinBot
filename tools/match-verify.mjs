// match-verify.mjs
// Regression guard for the !ml migration: osu matches API access, MatchRating
// port structure, and the command layer. Uses DATA_DIR isolation (real API).

import fs from 'node:fs';
import path from 'node:path';
import { createTestDataDir, assertNotProduction, productionDbSnapshot, verifyProductionDbUnchanged, cleanupTestDir } from './test-isolation.mjs';

const testDataDir = createTestDataDir('wuxin-match');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);
const prodBefore = productionDbSnapshot();

const { ensureStore, updateDb, readDb } = await import('../server/store.ts');
ensureStore();
const prod = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'Wuxin', 'db.json'), 'utf8'));
updateDb((d) => {
  d.settings = JSON.parse(JSON.stringify(prod.settings || {}));
});

const { getMatch, getMatchAfter } = await import('../server/osu/api.ts');
const { buildMatchRating } = await import('../server/osu/matchRating.ts');
const { matchManager } = await import('../server/osu/match.ts');

let passed = 0;
let failed = 0;
const pass = (label) => { console.log(`PASS [${label}]`); passed++; };
const fail = (label, msg) => { console.error(`FAIL [${label}]: ${msg}`); failed++; };
const assert = (cond, label, msg) => (cond ? pass(label) : fail(label, msg));

// 1. Real matches API + incremental after query.
let matchId = 0;
try {
  const match = await getMatch(121622776);
  matchId = match.match.id;
  assert(match.match.id > 0, 'api:getMatch', 'empty id');
  assert(Array.isArray(match.events), 'api:events', 'events not array');
  const after = await getMatchAfter(matchId, match.latest_event_id);
  assert(after.latest_event_id >= match.latest_event_id, 'api:after', `after.latest=${after.latest_event_id} base=${match.latest_event_id}`);
} catch (e) {
  fail('api', e.message);
}

// 2. MatchRating port: structural assertions on real data (even a tiny match).
if (matchId > 0) {
  try {
    const match = await getMatch(matchId);
    const { json, rounds } = buildMatchRating(match);
    assert(typeof json.round_count === 'number', 'rating:round_count', typeof json.round_count);
    assert(typeof json.score_count === 'number', 'rating:score_count', typeof json.score_count);
    assert(typeof json.player_count === 'number', 'rating:player_count', typeof json.player_count);
    assert(typeof json.is_team_vs === 'boolean', 'rating:is_team_vs', typeof json.is_team_vs);
    assert(typeof json.average_star === 'number', 'rating:average_star', typeof json.average_star);
    assert(Array.isArray(json.player_data_list), 'rating:player_data_list', 'not array');
    for (const p of json.player_data_list) {
      assert(p.player && typeof p.player.username === 'string', 'rating:pd.player', JSON.stringify(p).slice(0, 80));
      assert(p.player_class === null || typeof p.player_class?.english === 'string', 'rating:pd.class', JSON.stringify(p.player_class));
      break;
    }
    assert(Array.isArray(rounds), 'rating:rounds', 'rounds not array');
    assert(typeof json.match?.is_match_end === 'boolean', 'rating:match.is_match_end', typeof json.match?.is_match_end);
  } catch (e) {
    fail('rating', e.message);
  }
}

// 3. Command layer (isolated db, real API).
const db = readDb();
const baseEvent = { groupId: 'test-group', userId: 'u1' };

let r = await matchManager.handleCommand(db, baseEvent, '!ml 99999999999', false);
assert(/找不到比赛/.test(r.text || ''), 'cmd:not-found', r.text);

r = await matchManager.handleCommand(db, baseEvent, '!ml list', false);
assert(/没有观战/.test(r.text || ''), 'cmd:list-empty', r.text);

r = await matchManager.handleCommand(db, baseEvent, '!ml end', false);
assert(/没有观战/.test(r.text || ''), 'cmd:end-empty', r.text);

// A real match ID must register successfully (isolated db only). The fixture
// match is live data and eventually ends, so the assertion follows the API
// state: a live match starts watching, an ended match is reported honestly.
if (matchId > 0) {
  const liveMatch = await getMatch(matchId);
  const ended = liveMatch.match?.is_match_end === true ||
    buildMatchRating(liveMatch).json.match?.is_match_end === true;
  r = await matchManager.handleCommand(db, baseEvent, `!ml ${matchId}`, false);
  assert(
    ended ? /已经结束|已结束/.test(r.text || '') : /开始观战/.test(r.text || ''),
    'cmd:live-start',
    r.text
  );
}

verifyProductionDbUnchanged(prodBefore);
cleanupTestDir(testDataDir);
console.log(`\nMATCH-VERIFY: passed=${passed} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
