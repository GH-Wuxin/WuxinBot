import assert from 'node:assert/strict';
import http from 'node:http';
import { createTestDataDir, assertNotProduction } from './test-isolation.mjs';

assertNotProduction(createTestDataDir('wuxin-player-update'));
Object.assign(process.env, {
  NODE_ENV: 'test', OSU_CLIENT_ID: 'fixture', OSU_CLIENT_SECRET: 'fixture',
  OSU_API_MIN_INTERVAL_MS: '0', PPLUS_POLL_INTERVAL_MS: '5',
});
let version = 1;
let failSkill = false;
let failPPlus = false;
const counts = new Map();
const holds = new Map();
const axes = ['aim_control', 'jump_aim', 'spatial_precision', 'flow_aim', 'raw_speed', 'finger_control', 'stamina', 'endurance', 'reading'];
const count = key => counts.get(key) || 0;
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;
    const currentVersion = version;
    counts.set(req.url, count(req.url) + 1);
    res.setHeader('Content-Type', 'application/json');
    const send = data => {
      const hold = holds.get(req.url);
      if (hold) { holds.delete(req.url); hold(() => res.end(JSON.stringify(data))); }
      else res.end(JSON.stringify(data));
    };
    if (route === '/oauth/token') return send({ access_token: 'fixture', expires_in: 7200 });
    if (route === '/auth/token') return send({ code: 200, data: 'fixture' });
    if (route === '/player/jobs') {
      const id = Number(url.searchParams.get('id'));
      return send({ code: 200, data: failPPlus
        ? { id, status: 'failed', errorCode: 'CALCULATION_FAILED' }
        : { id, status: 'completed', result: { performances: { pp: currentVersion * 1000, ppJumpAim: 900, ppFlowAim: 800, ppSpeed: 700, ppStamina: 600, ppPrecision: 500, ppAcc: 400 } } } });
    }
    if (route === '/api/state') return send({ algorithm_id: 'UPDATE_FIXTURE', map_demand_version: '1' });
    const user = /^\/api\/v2\/users\/(\d+)\/osu$/.exec(route);
    if (user || route.startsWith('/api/v2/users/@')) {
      const id = user ? Number(user[1]) : 1;
      return send({ id, username: 'Fixture Player', statistics: { pp: currentVersion * 2000 } });
    }
    if (/^\/api\/v2\/users\/\d+\/scores\/best$/.test(route)) {
      return send([1, 2, 3].map(index => ({
        id: currentVersion * 100 + index, mods: [], accuracy: .99, max_combo: 100,
        pp: 400, passed: true, rank: 'S', statistics: { count_300: 100 },
        beatmap: { id: currentVersion * 100 + index, max_combo: 100 },
      })));
    }
    if (route === '/api/analyze') {
      if (failSkill) { res.statusCode = 503; return send({ error: 'FIXTURE_ANALYSIS_FAILURE' }); }
      return send({ status: 'OK', schema_version: 'map_demand_bid_analysis_v0.1.0',
        beatmap: { beatmap_id: JSON.parse(raw).beatmap_id },
        axes: Object.fromEntries(axes.map(axis => [axis, { stars: 4 }])),
        identity: { algorithm_id: 'UPDATE_FIXTURE', map_demand_version: '1' } });
    }
    res.statusCode = 404;
    send({});
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
Object.assign(process.env, { OSU_API_BASE_URL: base + '/api/v2', OSU_TOKEN_URL: base + '/oauth/token', SKILL_PROFILER_URL: base });
const holdNext = url => {
  let release;
  const reached = new Promise(resolve => holds.set(url, finish => { release = finish; resolve(); }));
  return { reached, release: () => release() };
};
const realNow = Date.now;
try {
  const { updateDb, readDb } = await import('../server/store.ts');
  updateDb(db => {
    Object.assign(db.settings, { pplusBaseUrl: base, pplusClientId: 1, pplusClientSecret: 'fixture', ownerQq: '9999', globalPaused: false });
    db.osuBindings = { '2222': { osuUserId: 1, osuUsername: 'Fixture Player' } };
    db.groups = [{ groupId: '3333', name: 'Fixture', enabled: true, mode: 'osu', cooldownSec: 0, maxPerHour: 100 }];
  });
  const { buildPlayerSkillProfilePayload, preparePlayerSkillProfile, buildPreparedPlayerSkillProfile, refreshPlayerSkillProfile } = await import('../server/bots/playerSkillProfile.ts');
  const { getPlayerBars, refreshPlayerPPlus } = await import('../server/osu/pplus.ts');
  const { getUserBestScores } = await import('../server/osu/api.ts');
  const { processIncoming } = await import('../server/bot.ts');
  const { parseOwnerCommandText, OWNER_COMMANDS } = await import('../server/bot/commands/owner.meta.ts');
  assert.equal(parseOwnerCommandText('/w update').id, 'osuUpdate');
  assert.equal(OWNER_COMMANDS.find(item => item.id === 'osuUpdate').permission, 'all');

  const first = await buildPlayerSkillProfilePayload(1);
  assert.equal(first.rows[0].beatmapId, 101);
  assert.equal(first.ppPlus.ppTotal, 1000);
  await buildPlayerSkillProfilePayload(2);
  const unrelatedRequests = count('/api/v2/users/2/scores/best?mode=osu&limit=50');

  version = 2;
  const updates = await Promise.all(Array.from({ length: 5 }, () => refreshPlayerSkillProfile(1)));
  assert.ok(updates.every(row => row.skill.updated && row.ppPlus.updated));
  assert.equal(count('/player/jobs?id=1&refresh=true'), 1, 'concurrent updates share one forced PP+ job');
  assert.equal(count('/api/v2/users/1/scores/best?mode=osu&limit=50'), 2, 'BP cache is bypassed exactly once');
  const updated = await buildPlayerSkillProfilePayload(1);
  assert.equal(updated.player.pp, 4000, 'six-hour user cache is bypassed');
  assert.equal(updated.rows[0].beatmapId, 201);
  assert.equal(updated.ppPlus.ppTotal, 2000);
  await buildPlayerSkillProfilePayload(2);
  assert.equal(count('/api/v2/users/2/scores/best?mode=osu&limit=50'), unrelatedRequests, 'other players keep their cache');

  const oldPrepared = await preparePlayerSkillProfile(1, 50, { force: true });
  version = 3;
  const gate = holdNext('/player/jobs?id=1&refresh=true');
  const refreshing = refreshPlayerSkillProfile(1);
  await gate.reached;
  const duringRefresh = buildPlayerSkillProfilePayload(1);
  gate.release();
  await refreshing;
  assert.equal((await duringRefresh).rows[0].beatmapId, 301, 'info waits for an ongoing update');
  await buildPreparedPlayerSkillProfile(oldPrepared);
  assert.equal((await buildPlayerSkillProfilePayload(1)).rows[0].beatmapId, 301, 'late prepared work cannot overwrite the refresh');

  version = 4;
  failSkill = true;
  const partial = await refreshPlayerSkillProfile(1);
  assert.equal(partial.skill.updated, false);
  assert.equal(partial.ppPlus.updated, true);
  assert.equal((await preparePlayerSkillProfile(1)).cachedPayload.rows[0].beatmapId, 301, 'incomplete Skill result preserves previous profile');
  failSkill = false;
  version = 5;
  failPPlus = true;
  const inverse = await refreshPlayerSkillProfile(1);
  assert.equal(inverse.skill.updated, true);
  assert.equal(inverse.ppPlus.updated, false);
  failPPlus = false;
  const mixed = await buildPlayerSkillProfilePayload(1);
  assert.equal(mixed.rows[0].beatmapId, 501);
  assert.equal(mixed.ppPlus.ppTotal, 4000, 'failed PP+ preserves its last successful cache');

  Date.now = () => realNow() + 20 * 60_000;
  await buildPlayerSkillProfilePayload(1);
  version = 6;
  Date.now = () => realNow() + 31 * 60_000;
  assert.equal((await buildPlayerSkillProfilePayload(1)).rows[0].beatmapId, 601, 'cache hits do not renew the Skill TTL');

  version = 7;
  const sent = [];
  const event = { source: 'gui', type: 'group', groupId: '3333', userId: '2222', nickname: 'Normal member', atTargets: [], raw: {}, text: '/w update', messageId: 'public-update' };
  await processIncoming(event, async (_event, text) => sent.push(text));
  assert.ok(sent.some(text => text.includes('Skill Profile：已更新') && text.includes('PP+：已更新')), 'ordinary member can update their binding in osu-only mode');
  assert.equal(readDb().commandLogs.at(-1).status, 'ok');
  sent.length = 0;
  await processIncoming({ ...event, text: '/w update p:[Fixture Player]', messageId: 'named-update' }, async (_event, text) => sent.push(text));
  assert.ok(sent.some(text => text.includes('Skill Profile：已更新')), 'explicit names with spaces work');
  sent.length = 0;
  await processIncoming({ ...event, userId: '4444', messageId: 'missing-binding' }, async (_event, text) => sent.push(text));
  assert.ok(sent.some(text => text.includes('/w update <玩家名>')), 'missing binding gives update-specific guidance');

  version = 8;
  const ppGate = holdNext('/player/jobs?id=3');
  const oldBars = getPlayerBars(3);
  await ppGate.reached;
  version = 9;
  const newBars = refreshPlayerPPlus(3);
  ppGate.release();
  assert.equal((await oldBars).ppTotal, 8000);
  assert.equal((await newBars).ppTotal, 9000);
  assert.equal((await getPlayerBars(3)).ppTotal, 9000, 'forced PP+ follows the earlier in-flight job');

  version = 10;
  const apiGate = holdNext('/api/v2/users/4/scores/best?mode=osu&limit=50');
  const oldBp = getUserBestScores(4, 'osu', 50);
  await apiGate.reached;
  version = 11;
  const newBp = getUserBestScores(4, 'osu', 50, { force: true });
  apiGate.release();
  assert.equal((await oldBp)[0].beatmap.id, 1001);
  assert.equal((await newBp)[0].beatmap.id, 1101, 'forced BP waits for the older GET and issues a new request');
  console.log('PASS: public update, explicit names, binding guidance, both cache layers, coalescing, late writes, partial failures, fixed TTL and in-flight refresh ordering');
} finally {
  Date.now = realNow;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
