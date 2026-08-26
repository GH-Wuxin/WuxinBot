import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-skill-command-'));
process.env.DATA_DIR = dataDir;
process.env.OSU_CLIENT_ID = 'fixture-client';
process.env.OSU_CLIENT_SECRET = 'fixture-secret';

const profilerPayloads = [];
const importedBids = new Set();
const importedPayloads = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/oauth/token') {
      res.end(JSON.stringify({ access_token: 'fixture-token', token_type: 'Bearer', expires_in: 3600 }));
      return;
    }
    if (req.url === '/api/v2/users/77/osu') {
      res.end(JSON.stringify({ id: 77, username: 'FixturePlayer', statistics: {}, grade_counts: {} }));
      return;
    }
    if (req.url === '/api/v2/users/@mrekk/osu') {
      res.end(JSON.stringify({ id: 88, username: 'mrekk', statistics: {}, grade_counts: {} }));
      return;
    }
    if (req.url === '/api/v2/users/@970/osu') {
      res.end(JSON.stringify({ id: 97088, username: '970', statistics: {}, grade_counts: {} }));
      return;
    }
    if (/^\/api\/v2\/users\/77\/scores\/best\?mode=osu&limit=(?:2|100)$/.test(String(req.url))) {
      res.end(JSON.stringify([
        { id: 1, mods: [], beatmap: { id: 4000001 } },
        { id: 2, mods: ['HD', 'NC'], beatmap: { id: 4288226 } },
      ]));
      return;
    }
    if (/^\/api\/v2\/users\/88\/scores\/best\?mode=osu&limit=(?:20|100)$/.test(String(req.url))) {
      res.end(JSON.stringify(Array.from({ length: 20 }, (_, index) => ({
        id: 100 + index,
        mods: index === 19 ? ['HR'] : [],
        beatmap: { id: index === 19 ? 2872154 : 4100000 + index },
      }))));
      return;
    }
    if (/^\/api\/v2\/users\/97088\/scores\/best\?mode=osu&limit=(?:1|100)$/.test(String(req.url))) {
      res.end(JSON.stringify([{ id: 97001, mods: ['HD'], beatmap: { id: 4385157 } }]));
      return;
    }
    if (req.url === '/api/analyze' && req.method === 'POST') {
      const body = JSON.parse(raw || '{}');
      if (body.beatmap_id === 5648807 && !importedBids.has(5648807)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'BID_NOT_FOUND', message: 'fixture map is absent' }));
        return;
      }
      profilerPayloads.push(body);
      const axes = Object.fromEntries(['aim_control', 'stamina', 'endurance', 'raw_speed', 'jump_aim', 'spatial_precision', 'flow_aim', 'finger_control', 'reading']
        .map((axis, index) => [axis, { stars: 4 + index / 10, confidence: 'MEDIUM', unit: 'star_equivalent' }]));
      res.end(JSON.stringify({
        status: 'OK',
        beatmap: { beatmap_id: body.beatmap_id, title: 'Fixture', version: 'Test', creator: 'Mapper', local_nm_stars: 6.5 },
        analysis_context: { difficulty: { ApproachRate: 9, OverallDifficulty: 9, CircleSize: 4 }, bpm_max: 180, duration_ms: 120000 },
        mod_context: {
          requested_mods: body.mods || [],
          effective_mods: (body.mods || []).filter((mod) => !['NF', 'SD', 'PF'].includes(mod)),
          neutral_mods: (body.mods || []).filter((mod) => ['NF', 'SD', 'PF'].includes(mod)),
        },
        axes,
        archetype: { status: 'CLASSIFIED', primary_type: 'FLOW_AIM', dominant_axes: ['flow_aim'], confidence: 'MEDIUM' },
        identity: { algorithm_id: 'FIXTURE_ALGO', map_demand_version: 'test-1' },
        warnings: [],
      }));
      return;
    }
    if (req.url === '/api/import' && req.method === 'POST') {
      const body = JSON.parse(raw || '{}');
      importedPayloads.push(body);
      importedBids.add(Number(body.beatmap_id));
      res.end(JSON.stringify({ status: 'IMPORTED', beatmap_id: body.beatmap_id }));
      return;
    }
    if (req.url === '/osu/5648807') {
      res.setHeader('Content-Type', 'text/plain');
      res.end([
        'osu file format v14', '', '[General]', 'AudioFilename: audio.mp3', '',
        '[Metadata]', 'Title:Downloaded Fixture', 'Artist:Fixture', 'Creator:Mapper',
        'Version:Test', 'BeatmapID:5648807', 'BeatmapSetID:1', '', '[Difficulty]',
        'HPDrainRate:5', 'CircleSize:4', 'OverallDifficulty:8', 'ApproachRate:9', '',
        '[TimingPoints]', '0,500,4,2,1,50,1,0', '', '[HitObjects]',
        '256,192,1000,1,0,0:0:0:0:', '',
      ].join('\n'));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'NOT_FOUND', url: req.url }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
process.env.OSU_TOKEN_URL = `http://127.0.0.1:${port}/oauth/token`;
process.env.OSU_API_BASE_URL = `http://127.0.0.1:${port}/api/v2`;
process.env.SKILL_PROFILER_URL = `http://127.0.0.1:${port}`;
process.env.OSU_BEATMAP_FILE_BASE_URL = `http://127.0.0.1:${port}/osu/`;

try {
  const { ensureStore, readDb, writeDb } = await import('../server/store.ts');
  const { processIncoming } = await import('../server/bot.ts');
  const { parsePlayerSkillComparisonRequest, parsePlayerSkillProfileRequest, parseSkillCommandRequest, parseSkillCommandTarget } = await import('../server/bot/owner/skill.ts');
  const { skillProfilerFeedbackPath } = await import('../server/bots/skillProfilerFeedback.ts');
  ensureStore();
  const db = readDb();
  db.settings.ownerQq = 'owner';
  db.settings.selfQq = 'bot';
  db.groups = [{ groupId: 'g1', name: 'Fixture', enabled: true, mode: 'mention', maxPerHour: 20, cooldownSec: 0 }];
  db.osuBindings = { player: { osuUserId: 77, osuUsername: 'FixturePlayer' } };
  writeDb(db);

  assert.deepEqual(parseSkillCommandTarget('1'), { kind: 'bp', rank: 1 });
  assert.deepEqual(parseSkillCommandTarget('100'), { kind: 'bp', rank: 100 });
  assert.deepEqual(parseSkillCommandTarget('101'), { kind: 'bid', beatmapId: 101 });
  assert.equal(parseSkillCommandTarget('1.5'), null);
  assert.deepEqual(parseSkillCommandRequest('4288226 +HDDT'), {
    ok: true,
    target: { kind: 'bid', beatmapId: 4288226 },
    mods: ['HD', 'DT'],
  });
  assert.deepEqual(parseSkillCommandRequest('4288226 +PF/HD/SD'), {
    ok: true,
    target: { kind: 'bid', beatmapId: 4288226 },
    mods: ['HD', 'PF'],
  });
  assert.match(parseSkillCommandRequest('4288226 +FL').message, /暂不支持 FL/);
  assert.match(parseSkillCommandRequest('2 +HD').message, /BP 名次会自动读取/);
  assert.deepEqual(parseSkillCommandRequest('mrekk 20'), {
    ok: true,
    target: { kind: 'named_bp', username: 'mrekk', rank: 20 },
    mods: [],
  });
  assert.deepEqual(parseSkillCommandRequest('p:[970]'), {
    ok: true,
    target: { kind: 'named_bp', username: '970', rank: 1 },
    mods: [],
  });
  assert.deepEqual(parseSkillCommandRequest('p:[970] 20'), {
    ok: true,
    target: { kind: 'named_bp', username: '970', rank: 20 },
    mods: [],
  });
  assert.deepEqual(parsePlayerSkillProfileRequest('profile'), { matched: true, player: '' });
  assert.deepEqual(parsePlayerSkillProfileRequest('profile mrekk'), { matched: true, player: 'mrekk' });
  assert.deepEqual(parsePlayerSkillProfileRequest('profile p:[970]'), { matched: true, player: '970' });
  assert.deepEqual(parsePlayerSkillProfileRequest('mrekk 20'), { matched: false });
  assert.deepEqual(parsePlayerSkillComparisonRequest('compare mrekk | [SHK]yourenegg'), {
    matched: true, left: 'mrekk', right: '[SHK]yourenegg',
  });
  assert.deepEqual(parsePlayerSkillComparisonRequest('compare p:[970] vs mrekk'), {
    matched: true, left: '970', right: 'mrekk',
  });
  assert.match(parsePlayerSkillComparisonRequest('compare mrekk').error, /玩家A/);

  const helpEntries = (await import('../server/bot/owner/help.ts')).ownerHelpEntries();
  assert.ok(helpEntries.some((entry) => entry.canonicalSyntax.includes('/w skill profile [玩家名]')));
  assert.ok(helpEntries.some((entry) => entry.canonicalSyntax.includes('compare <玩家A>')));
  assert.ok(helpEntries.some((entry) => entry.canonicalSyntax === '/w cd <BID> [+Mods] <反馈>'));

  const sent = [];
  const sendMessage = async (_event, text) => { sent.push(String(text)); };
  const event = (text, id) => ({
    source: 'onebot', type: 'group', messageId: id, groupId: 'g1', userId: 'player',
    nickname: 'Player', text, atTargets: [], raw: {},
  });

  const bp = await processIncoming(event('/w skill 2', 'skill-bp'), sendMessage);
  assert.equal(bp.replied, true);
  assert.deepEqual(profilerPayloads.at(-1), { beatmap_id: 4288226, mods: ['HD', 'DT'] });
  assert.match(sent.at(-1), /FixturePlayer 的 BP#2/);
  assert.match(sent.at(-1), /\/w cd 4288226 \+HDDT/);

  const namedBp = await processIncoming(event('/w skill mrekk 20', 'skill-named-bp'), sendMessage);
  assert.equal(namedBp.replied, true);
  assert.deepEqual(profilerPayloads.at(-1), { beatmap_id: 2872154, mods: ['HR'] });
  assert.match(sent.at(-1), /mrekk 的 BP#20/);
  assert.match(sent.at(-1), /\/w cd 2872154 \+HR/);

  const numericPlayer = await processIncoming(event('/w skill p:[970]', 'skill-numeric-player'), sendMessage);
  assert.equal(numericPlayer.replied, true);
  assert.deepEqual(profilerPayloads.at(-1), { beatmap_id: 4385157, mods: ['HD'] });
  assert.match(sent.at(-1), /970 的 BP#1/);

  const direct = await processIncoming(event('/w skill 5648807 +HDDTPF', 'skill-bid'), sendMessage);
  assert.equal(direct.replied, true);
  assert.equal(importedPayloads.length, 1);
  assert.equal(importedPayloads[0].beatmap_id, 5648807);
  assert.match(importedPayloads[0].content, /BeatmapID:5648807/);
  assert.deepEqual(profilerPayloads.at(-1), { beatmap_id: 5648807, mods: ['HD', 'DT', 'PF'] });
  assert.match(sent.at(-1), /Mods：HDDTPF（PF 对谱面需求分值无影响）/);

  const callsBeforeFl = profilerPayloads.length;
  const fl = await processIncoming(event('/w skill 5648807 +FL', 'skill-fl'), sendMessage);
  assert.equal(fl.replied, true);
  assert.equal(profilerPayloads.length, callsBeforeFl);
  assert.match(sent.at(-1), /暂不支持 FL/);

  const feedback = await processIncoming(event('/w cd 5648807 +HDDTPF Flow Aim 至少应该有 6.8★', 'skill-feedback'), sendMessage);
  assert.equal(feedback.replied, true);
  assert.match(sent.at(-1), /已记录/);
  const records = fs.readFileSync(skillProfilerFeedbackPath(), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 1);
  assert.equal(records[0].beatmapId, 5648807);
  assert.equal(records[0].schemaVersion, 2);
  assert.deepEqual(records[0].mods, ['HD', 'DT', 'PF']);
  assert.deepEqual(records[0].effectiveMods, ['HD', 'DT']);
  assert.deepEqual(records[0].neutralMods, ['PF']);
  assert.equal(records[0].message, 'Flow Aim 至少应该有 6.8★');
  assert.equal(records[0].analysis.algorithmId, 'FIXTURE_ALGO');
  assert.deepEqual(records[0].analysis.mods, ['HD', 'DT', 'PF']);
  assert.deepEqual(records[0].analysis.effectiveMods, ['HD', 'DT']);
  assert.deepEqual(records[0].analysis.neutralMods, ['PF']);

  console.log('PASS: /w skill resolves BP/BID with explicit Mods and /w cd stores correlated feedback');
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
