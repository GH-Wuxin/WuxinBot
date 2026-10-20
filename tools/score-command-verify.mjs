import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

// Exercise the real router, bridge and API client without QQ or upstream traffic.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-score-verify-'));
process.env.DATA_DIR = dataDir;
process.env.BRIDGE_OUTPUT_DIR = path.join(dataDir, 'bridge');
process.env.BRIDGE_SETTLE_MS = '20';
process.env.BRIDGE_MAX_POST_REPLY_MS = '40';
process.env.OSU_CLIENT_ID = 'fixture';
process.env.OSU_CLIENT_SECRET = 'fixture';
process.env.OSU_TOKEN_URL = 'http://auth.test/oauth/token';
process.env.OSU_API_BASE_URL = 'http://api.test/api/v2';
process.env.OSU_API_MIN_INTERVAL_MS = '0';
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((resolve) => wss.once('listening', resolve));
for (const bot of ['KANON', 'YUMU', 'LAZYBOT', 'HYDRANT']) {
  process.env[`BRIDGE_URL_${bot}`] = `ws://127.0.0.1:${wss.address().port}`;
}
let bridgeMode = 'reply';
const bridgeEvents = [];
wss.on('connection', (socket) => socket.on('message', (data) => {
  const message = JSON.parse(String(data));
  if (message.post_type !== 'message') return;
  bridgeEvents.push(message);
  if (bridgeMode === 'drop') return socket.close();
  socket.send(JSON.stringify({ action: 'send_msg', params: { message: 'Kanon fixture card' }, echo: 'fixture' }));
}));

const originalFetch = globalThis.fetch;
const requests = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.href === process.env.OSU_TOKEN_URL) return json({ access_token: 'fixture', expires_in: 3600 });
  assert.equal(url.origin, 'http://api.test', `unexpected external request: ${url.origin}`);
  requests.push(url);
  if (url.pathname.startsWith('/api/v2/users/')) return json({ id: 101, username: 'Bound Player', statistics: {} });
  const score = /\/beatmaps\/(\d+)\/scores\/users\/(\d+)$/.exec(url.pathname);
  assert(score, `unexpected API path: ${url.pathname}`);
  const uid = Number(score[2]);
  if (uid === 101 || uid === 503 || (uid === 502 && url.searchParams.get('legacy_only') === '0')) return json({}, 404);
  const mods = url.searchParams.getAll('mods[]');
  return json({ score: { id: `${uid}:${score[1]}:${mods.join(',') || '*'}`, mods } });
};

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };
const source = (relative) => process.env.SCORE_VERIFY_ROOT
  ? pathToFileURL(path.join(process.env.SCORE_VERIFY_ROOT, relative)).href
  : new URL(`../${relative}`, import.meta.url).href;
try {
  const { ensureStore, readDb, writeDb } = await import(source('server/store.ts'));
  const { matchQuickCommand, parseOsuArgs, handleQuickCommand } = await import(source('server/bot/quickRouter.ts'));
  const { getUserBeatmapScore } = await import(source('server/osu/api.ts'));
  ensureStore();
  const db = structuredClone(readDb());
  db.settings.globalPaused = false;
  db.groups = [{ groupId: '991337', enabled: true, mode: 'osu' }];
  db.osuBindings = {
    '10001': { osuUserId: 101, osuUsername: 'Bound Player' },
    '10002': { osuUserId: 102, osuUsername: 'Target Player' },
    '10003': { osuUserId: 103, osuUsername: '12345' },
  };
  writeDb(db);
  const parse = (text) => {
    const match = matchQuickCommand({ text, atTargets: [] });
    assert(match);
    return { match, parsed: parseOsuArgs(match.def, match.args) };
  };
  for (const text of ['！score 3648544 +hdda', '!score 3648544+hdda', '!s 3648544 +HDDA', '/score 3648544 +hdda']) {
    check(`parse ${text}`, () => {
      const { parsed } = parse(text);
      assert.deepEqual(parsed, { username: '', scoreBeatmapId: 3648544, scoreMods: ['HD', 'DA'] });
    });
  }
  for (const text of ['!score 3648544 yRScarlet +HDDA', '/score yRScarlet 3648544+hdda']) {
    check(`named ${text}`, () => assert.deepEqual(parse(text).parsed, {
      username: 'yRScarlet', scoreBeatmapId: 3648544, scoreMods: ['HD', 'DA'],
    }));
  }
  for (const args of ['3648544 "Player 123"', '"Player 123" 3648544', 'Player 123 #3648544']) {
    check(`numeric suffix ${args}`, () => assert.equal(parse(`!score ${args}`).parsed.username, 'Player 123'));
  }
  check('numeric quoted username', () => assert.equal(parse('!score "12345" 3648544').parsed.username, '12345'));
  check('unfiltered differs from NM', () => {
    assert.equal(parse('!score 3648544').parsed.scoreMods, undefined);
    assert.deepEqual(parse('!score 3648544 +nm').parsed.scoreMods, ['NM']);
  });
  check('lazer and duplicate acronyms', () => assert.deepEqual(parse('!score 3648544 +dcdaclhdhd').parsed.scoreMods, ['DC', 'DA', 'CL', 'HD']));
  for (const args of ['', '0', '-1', '1e6', 'no-bid +HD', '3648544 +', '3648544 +HDD', '3648544 +NMHD', '3648544 "unclosed']) {
    check(`reject invalid ${args || '(empty)'}`, () => assert(parse(`!score ${args}`).parsed.error));
  }
  check('routing unchanged except Kanon bridge enabled', () => {
    assert.equal(parse('!score 1').match.def.source, 'kanon');
    assert.equal(parse('!score 1').match.def.bridge, true);
    assert.equal(parse('!s 1').match.def.source, 'yumu');
    assert.equal(parse('/score 1').match.def.source, 'lazybot');
  });
  const invoke = async (text, userId = '10001', atTargets = []) => {
    const event = { source: 'gui', type: 'group', messageId: `fixture-${passed}`, groupId: '991337', userId, nickname: 'Fixture', text, atTargets, raw: {} };
    const sent = [];
    const result = await handleQuickCommand(event, async (_event, content) => sent.push(content), db, matchQuickCommand(event), { isOwner: false, isAdmin: false });
    return { result, sent };
  };
  for (const [text, userId, atTargets, expected] of [
    ['！score 3648544 +hdda', '10001', [], '!score Bound Player #3648544 +HDDA'],
    ['!score 3648544', '10001', [], '!score Bound Player #3648544'],
    ['!score 3648544 +DC', '10001', ['10002'], '!score Target Player #3648544 +DC'],
    ['!score yRScarlet 3648544+hdda', '10001', ['10002'], '!score yRScarlet #3648544 +HDDA'],
    ['!score 3648544 +NM', '10003', [], '!score 12345 #3648544 +NM'],
  ]) {
    const output = await invoke(text, userId, atTargets);
    check(`bridge ${text} (${userId})`, () => {
      assert.equal(output.result.reason, 'bridge:kanon');
      assert.deepEqual(output.sent, ['Kanon fixture card']);
      assert.equal(bridgeEvents.at(-1).raw_message, expected);
      assert(bridgeEvents.at(-1).message.every((segment) => segment.type !== 'at'));
      assert.equal(requests.length, 0, 'bridge path must not look up +mods as a player');
    });
  }
  const beforeInvalid = bridgeEvents.length;
  const invalid = await invoke('!score 0 +hdda', '99999');
  const unbound = await invoke('!score 3648544 +hdda', '99999');
  check('invalid / unbound commands stop before network', () => {
    assert.equal(invalid.result.reason, '参数错误');
    assert.equal(unbound.result.reason, 'unbound_self');
    assert.equal(bridgeEvents.length, beforeInvalid);
    assert.equal(requests.length, 0);
  });

  const any = await getUserBeatmapScore(501, 3648544);
  const filtered = await getUserBeatmapScore(501, 3648544, 'osu', ['HD', 'DA']);
  const nm = await getUserBeatmapScore(501, 3648544, 'osu', ['NM']);
  const beforeCache = requests.length;
  const same = await getUserBeatmapScore(501, 3648544, 'osu', [' da ', 'hd', 'HD']);
  check('API query and cache keep unrestricted / HDDA / NM separate', () => {
    assert.notEqual(any.id, filtered.id);
    assert.notEqual(any.id, nm.id);
    assert.deepEqual(filtered.mods, ['DA', 'HD']);
    assert.deepEqual(nm.mods, ['NM']);
    assert.deepEqual(same, filtered);
    assert.equal(requests.length, beforeCache);
  });
  const legacy = await getUserBeatmapScore(502, 3648544, 'osu', ['HD', 'DA']);
  check('legacy retry retains mods', () => {
    assert.deepEqual(legacy.mods, ['DA', 'HD']);
    assert.deepEqual(requests.slice(-2).map((url) => url.searchParams.get('legacy_only')), ['0', '1']);
    assert(requests.slice(-2).every((url) => url.searchParams.getAll('mods[]').join(',') === 'DA,HD'));
  });
  await assert.rejects(() => getUserBeatmapScore(503, 3648544, 'osu', ['DC']), /beatmap_score_not_found/);
  check('no matching score never retries without the filter', () => {
    assert(requests.slice(-2).every((url) => url.searchParams.getAll('mods[]').join(',') === 'DC'));
  });

  bridgeMode = 'drop';
  for (const text of ['！score 3648544 +hdda', '!s 3648544 +hdda', '/score yRScarlet 3648544+hdda']) {
    const before = requests.length;
    const output = await invoke(text);
    check(`internal fallback ${text}`, () => {
      assert.equal(output.result.reason, 'score');
      const scoreRequests = requests.slice(before).filter((url) => url.pathname.includes('/scores/users/'));
      assert.equal(scoreRequests.length, 2);
      assert(scoreRequests.every((url) => url.searchParams.getAll('mods[]').join(',') === 'DA,HD'));
      assert(requests.slice(before).every((url) => !decodeURIComponent(url.pathname).includes('+hdda')));
      assert.match(output.sent[0], /\+HDDA.*没有查到成绩/);
    });
  }
  if (process.env.SCORE_VERIFY_REPORT) fs.writeFileSync(process.env.SCORE_VERIFY_REPORT, JSON.stringify({
    passed, bridgeCommands: bridgeEvents.map((event) => event.raw_message),
    requests: requests.map((url) => url.pathname + url.search), realNetwork: false, qqMessages: 0,
  }, null, 2));
  console.log(`score-command-verify: ${passed} checks passed; no external traffic or QQ messages`);
} finally {
  globalThis.fetch = originalFetch;
  for (const socket of wss.clients) socket.terminate();
  await new Promise((resolve) => wss.close(resolve));
}
