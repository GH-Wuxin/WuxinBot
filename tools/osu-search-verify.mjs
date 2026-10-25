import assert from 'node:assert/strict';
import http from 'node:http';
import { createTestDataDir, assertNotProduction, cleanupTestDir } from './test-isolation.mjs';

const dir = createTestDataDir('wuxin-osu-search');
assertNotProduction(dir);
process.env.OSU_CLIENT_ID = 'fixture-client';
process.env.OSU_CLIENT_SECRET = 'fixture-secret';
process.env.OSU_API_MIN_INTERVAL_MS = '0';
const requests = [], inventories = [], envelopes = [];
let scenario = 'search', llmCalls = 0;
const wiki = { title: 'Accuracy', path: 'Gameplay/Accuracy', locale: 'en', available_locales: ['en', 'zh'], markdown: 'Accuracy uses judgement weights.\n' + 'Detailed explanation. '.repeat(210) + 'END_OF_ORIGINAL' };
const build = { version: '20261025', display_version: '2026.1025', created_at: '2026-10-25T00:00:00Z', update_stream: { name: 'lazer' }, changelog_entries: [{ category: 'Gameplay', title: 'Fix scoring', message_markdown: 'A **scoring** fix.' }] };
const map = { id: 123, title: 'Fixture song', artist: 'Artist', creator: 'Mapper', status: 'ranked', beatmaps: [{ id: 456, version: 'Hard', mode: 'mania', difficulty_rating: 3.5 }] };
const call = (name, args, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const url = new URL(req.url, 'http://127.0.0.1'); requests.push(url);
  if (process.env.OSU_SEARCH_TEST_DEBUG) console.log('fixture', url.pathname);
  res.setHeader('Content-Type', 'application/json');
  const json = value => res.end(JSON.stringify(value));
  if (url.pathname === '/oauth/token') return json({ access_token: 'fixture-token', expires_in: 3600 });
  if (url.pathname === '/api/v2/search') return json({ wiki_page: { data: url.searchParams.get('query') === 'no-match' ? [] : [wiki], total: 1 } });
  if (url.pathname.endsWith('/Oversize')) return json({ markdown: 'x'.repeat(2 * 1024 * 1024) });
  if (url.pathname.endsWith('/Redirect')) { res.writeHead(302, { Location: '/forbidden-target' }); return res.end(); }
  if (url.pathname.endsWith('/Slow')) {
    res.write('{"markdown":"'); // Headers arrived; the response body still needs a deadline.
    const timer = setInterval(() => res.write('x'), 100);
    res.on('close', () => clearInterval(timer)); return;
  }
  if (url.pathname.endsWith('/Missing')) { res.statusCode = 404; return json({ error: 'missing' }); }
  if (url.pathname.startsWith('/api/v2/wiki/')) return json(url.pathname.endsWith('/Long') ? { ...wiki, markdown: 'x'.repeat(19000) } : wiki);
  if (url.pathname === '/api/v2/news') return json({ news_posts: [{ id: 2, title: 'New Featured Artist', slug: '2026-10-25-artist', preview: 'Latest music', published_at: '2026-10-25T00:00:00Z' }], news_sidebar: { current_year: 2026, news_posts: [{ id: 1, title: 'World Cup 2026', slug: '2026-01-01-world-cup', published_at: '2026-01-01T00:00:00Z' }] } });
  if (url.pathname.startsWith('/api/v2/news/')) return json({ title: 'World Cup', content_markdown: '**Official** news body', published_at: '2026-01-01T00:00:00Z' });
  if (url.pathname === '/api/v2/changelog') return json({ builds: [build] });
  if (url.pathname.startsWith('/api/v2/changelog/')) return json(build);
  if (url.pathname === '/api/v2/beatmapsets/search') return json({ beatmapsets: [map] });
  if (url.pathname === '/api/v2/beatmapsets/123') return json(map);
  if (url.pathname === '/api/v2/forums/2') return json({ forum: { name: 'General Discussion' }, topics: [{ id: 123, title: 'Reading practice', post_count: 12, last_post_id: 12, updated_at: '2026-10-26T00:00:00Z' }] });
  if (url.pathname === '/api/v2/forums/topics/123') return json({ topic: { title: 'Reading practice', post_count: 12 }, posts:
    (url.searchParams.get('sort') === 'id_desc' ? [12, 11] : [1, 2]).map(id => ({ id, user_id: 42, created_at: '2026-10-26T00:00:00Z', body: { raw: `Player opinion ${id}` } })) });
  if (url.pathname === '/v1/chat/completions') {
    const input = JSON.parse(raw);
    if (String(input.messages?.[0]?.content).includes('社交判断器')) return json({ choices: [{ message: { role: 'assistant', content: JSON.stringify({
      action: 'reply', addressee: 'bot', reason: '正常资料查询', evidenceIds: [], affinityDelta: 0, familiarityDelta: 0,
      summary: null, preferredNames: null, style: null, mood: null }) }, finish_reason: 'stop' }], usage: { total_tokens: 10 } });
    llmCalls++;
    const body = JSON.parse(raw), results = body.messages.filter(m => m.role === 'tool');
    inventories.push((body.tools || []).map(t => t.function.name));
    for (const entry of results) envelopes.push(entry.content);
    assert.ok(!body.messages[0].content.includes('本轮没有可用的网页搜索工具'));
    let calls = [], content = '';
    if (scenario === 'limit' && results.length < 4) calls = Array.from({ length: results.length ? 2 : 3 }, (_, i) => call('read_osu', { url: `https://osu.ppy.sh/wiki/en/Test${i + results.length}` }, `limit-${i + results.length}`));
    else if (!results.length) calls = [call('search_osu', { kind: 'wiki', query: 'accuracy' })];
    else if (results.length === 1 && scenario !== 'limit') calls = [call('read_osu', { url: 'https://osu.ppy.sh/wiki/zh/Gameplay/Accuracy' })];
    else {
      const evidence = body.messages.map(r => r.content).join('\n').match(/reading:[a-f0-9]{32}/)?.[0];
      content = JSON.stringify({ reply: '准确率按判定加权计算。来源：https://osu.ppy.sh/wiki/zh/Gameplay/Accuracy',
        self: evidence ? { evidenceIds: [evidence], remember: { fact: '读了准确率的官方说明', impression: '权重差别挺直观' } } : null });
    }
    return json({ id: `model-${llmCalls}`, model: 'fixture-model', choices: [{ index: 0, message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  }
  res.statusCode = 404; json({ error: 'unexpected fixture request' });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.OSU_API_BASE_URL = base + '/api/v2';
process.env.OSU_TOKEN_URL = base + '/oauth/token';

try {
  const { ensureStore, readDb, updateDb, normalizeDb } = await import('../server/store.ts');
  const { searchOsu, readOsuArticle, executeOsuSearchTool, isOsuSearchAvailable, buildOsuSearchTools } = await import('../server/osu/search.ts');
  ensureStore();
  updateDb(db => {
    Object.assign(db.settings, { osuSearchEnabled: true,
      ownerQq: '10001', selfQq: '10002', llmProvider: 'openai-compatible', apiKey: 'fixture-key', apiBaseUrl: base + '/v1',
      model: 'fixture-model', agentRuntimeMode: 'model_first', thinkingNoticeMode: 'off', memoryEnabled: false,
      stickerDeliveryMode: 'off', botRegistry: { updatedAt: new Date().toISOString(), bots: [] } });
  });
  assert.equal(isOsuSearchAvailable(readDb()), true, 'must work without generic search or Docker');
  assert.deepEqual(buildOsuSearchTools().map(t => t.function.name), ['search_osu', 'read_osu']);
  const found = await searchOsu({ kind: 'wiki', query: 'accuracy' });
  assert.equal(found.results[0].url, 'https://osu.ppy.sh/wiki/zh/Gameplay/Accuracy');
  const beforeCache = requests.length;
  await searchOsu({ kind: 'wiki', query: 'accuracy' });
  assert.equal(requests.length, beforeCache, 'repeated public queries should use bounded memory cache');
  assert.ok((await readOsuArticle(found.results[0].url)).text.includes('judgement weights'));
  const news = await searchOsu({ kind: 'news', query: 'World Cup', year: 2026 });
  assert.equal(news.results.length, 1, 'annual title index must find articles outside latest summaries');
  assert.ok(news.coverage.includes('不是历年全文搜索'));
  assert.ok((await readOsuArticle(news.results[0].url)).text.includes('Official'));
  await readOsuArticle('https://osu.ppy.sh/home/news/1');
  assert.ok(requests.some(u => u.pathname === '/api/v2/news/1' && u.searchParams.get('key') === 'id'));
  const changes = await searchOsu({ kind: 'changelog', query: 'scoring', stream: 'lazer' });
  assert.equal(changes.results.length, 1);
  assert.ok((await readOsuArticle(changes.results[0].url)).text.includes('scoring'));
  const forums = await searchOsu({ kind: 'forum', forumId: 2, query: 'reading' });
  assert.equal(forums.results[0].url, 'https://osu.ppy.sh/community/forums/topics/123');
  const first = await readOsuArticle(forums.results[0].url), latest = await readOsuArticle(forums.results[0].url, true);
  assert.ok(first.text.includes('Player opinion 1')); assert.equal(first.truncated, true);
  assert.ok(latest.text.indexOf('opinion 11') < latest.text.indexOf('opinion 12')); assert.match(latest.coverage, /最近/);
  assert.ok(requests.some(u => u.pathname === '/api/v2/forums/topics/123' && u.searchParams.get('sort') === 'id_desc'));
  const reading = await executeOsuSearchTool(call('read_osu', { url: forums.results[0].url }), { db: readDb() });
  assert.match(reading.metadata.reading.id, /^reading:/);
  assert.equal((await executeOsuSearchTool(call('search_osu', { kind: 'forum', forumId: 2 }), { db: readDb() })).metadata?.reading, undefined);
  const maps = await searchOsu({ kind: 'beatmaps', query: 'Fixture song', mode: 'mania' });
  assert.ok(requests.some(u => u.searchParams.get('m') === '3'));
  assert.ok((await readOsuArticle(maps.results[0].url + '#mania/456')).text.includes('3.5'));
  assert.equal((await readOsuArticle('https://osu.ppy.sh/wiki/en/Long')).truncated, true);

  const beforeInvalid = requests.length;
  for (const url of ['http://osu.ppy.sh/wiki/en/A', 'https://osu.ppy.sh.evil.test/wiki/en/A', 'https://127.0.0.1/wiki/en/A',
    'https://name:secret@osu.ppy.sh/wiki/en/A', 'https://osu.ppy.sh:444/wiki/en/A', 'https://osu.ppy.sh/wiki/en/A?redirect=1',
    'https://osu.ppy.sh/wiki/en/%2Fetc', 'https://osu.ppy.sh/wiki/en/%252e%252e', 'https://osu.ppy.sh/community/forums/1']) {
    await assert.rejects(() => readOsuArticle(url));
  }
  for (const args of [{ kind: 'web' }, { kind: 'wiki', query: '' }, { kind: 'news', query: '[CQ:at,qq=1]' },
    { kind: 'wiki', query: 'x'.repeat(161) }, { kind: 'news', year: 2000 }, { kind: 'news', url: 'http://localhost' }]) {
    await assert.rejects(() => searchOsu(args));
  }
  assert.equal(requests.length, beforeInvalid, 'invalid URLs and args must never make requests');
  await assert.rejects(() => readOsuArticle('https://osu.ppy.sh/wiki/en/Redirect'));
  assert.ok(!requests.some(u => u.pathname === '/forbidden-target'), 'redirects must not be followed');
  await assert.rejects(() => readOsuArticle('https://osu.ppy.sh/wiki/en/Oversize'), /读取上限/);
  const slowStarted = Date.now();
  await assert.rejects(() => readOsuArticle('https://osu.ppy.sh/wiki/en/Slow'));
  assert.ok(Date.now() - slowStarted < 20000, 'body streaming must stop at the deadline');
  const noMatch = await executeOsuSearchTool(call('search_osu', { kind: 'wiki', query: 'no-match' }), { db: readDb() });
  assert.equal(noMatch.ok, false);
  assert.ok(noMatch.content.includes('coverage'));
  const failed = await executeOsuSearchTool(call('read_osu', { url: 'https://osu.ppy.sh/wiki/en/Missing' }), { db: readDb() });
  assert.equal(failed.ok, false);
  assert.equal(readDb().searchLogs.at(-1).ok, false, 'failures must be observable');
  assert.ok(readDb().searchLogs.every(l => l.queryHash && !l.query && !l.url));

  const { processIncoming } = await import('../server/bot.ts');
  const run = async (id, confirmed = false) => {
    const sends = [];
    const result = await processIncoming({ source: 'gui', type: 'private', messageId: `osu-search-${id}`, groupId: 'private',
      userId: '10001', nickname: 'Owner', text: '联网搜索 osu! 准确率规则，给我官方来源', atTargets: [], images: [], raw: {} },
    async (_event, text) => { sends.push(String(text)); return confirmed === true || confirmed === 'notice-only' && String(text).includes('正在思考')
      ? { outcome: 'confirmed_success', messageId: `sent-${id}` } : undefined; });
    assert.equal(result.replied, true);
    return sends.join('\n');
  };
  updateDb(db => { db.settings.socialV2Enabled = true; });
  assert.ok((await run('independent')).includes('https://osu.ppy.sh/wiki/zh/Gameplay/Accuracy'));
  assert.equal(llmCalls, 3, 'search, read, synthesize must form one conversation');
  assert.equal(readDb().socialV2.self.experiences.length, 1);
  assert.equal(readDb().socialV2.self.experiences[0].shared.length, 0, 'unknown delivery cannot claim sharing');
  updateDb(db => { db.settings.thinkingNoticeMode = 'simple'; });
  await run('notice-only', 'notice-only');
  assert.equal(readDb().socialV2.self.experiences[0].shared.length, 0, 'thinking notice confirmation is not answer confirmation');
  updateDb(db => { db.settings.thinkingNoticeMode = 'off'; });
  await run('confirmed', true);
  assert.equal(readDb().socialV2.self.experiences.length, 1, 'same source must not create another experience');
  assert.equal(readDb().socialV2.self.experiences[0].shared[0].messageId, 'sent-confirmed');
  assert.ok(inventories.every(names => names.includes('search_osu') && names.includes('read_osu') && !names.includes('search_web')));
  assert.ok(envelopes.some(e => e.includes('judgement weights') && e.includes('仅作证据')));
  assert.ok(envelopes.some(e => e.includes('END_OF_ORIGINAL')), 'article evidence must survive the old 4000-character tool cap');
  scenario = 'limit';
  await run('limit');
  assert.equal(requests.filter(u => u.pathname.startsWith('/api/v2/wiki/en/Test')).length, 4, 'per-turn budget must include reads');
  assert.ok(envelopes.some(e => e.includes('osu_search_call_limit')));
  const legacy = structuredClone(readDb());
  Object.assign(legacy.settings, { enableWebSearch: true, searchProvider: 'searxng', searchBaseUrl: base + '/unexpected-general-search' });
  legacy.settings.commandPermissions = { search: 'owner' };
  const migrated = normalizeDb(legacy);
  assert.ok(!('searchProvider' in migrated.settings), 'retired configuration must be discarded on loading');
  assert.equal(migrated.settings.commandPermissions.sysfacts, 'owner', 'shared sysfacts permission must retain its restriction');
  assert.ok(!('search' in migrated.settings.commandPermissions));
  updateDb(db => { db.settings.osuSearchEnabled = false; });
  const beforeDisabled = requests.length;
  const disabled = await executeOsuSearchTool(call('search_osu', { kind: 'wiki', query: 'not-cached' }), { db: readDb() });
  assert.equal(disabled.ok, false); assert.equal(requests.length, beforeDisabled);
  console.log('PASS osu search: four official sources, original text, cache, URL/size/deadline limits, real conversation loop, budgets, retired generic settings');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  cleanupTestDir(dir);
}
