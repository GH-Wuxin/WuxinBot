import assert from 'node:assert/strict';
import http from 'node:http';

let observedPayload;
const axes = Object.fromEntries([
  ['aim_control', 8.9, 'LOW', 'star_equivalent'],
  ['stamina', 9.2, 'LOW', 'bounded_0_10'],
  ['endurance', 8.7, 'LOW', 'bounded_0_10'],
  ['raw_speed', 4.6, 'MEDIUM', 'star_equivalent'],
  ['jump_aim', 11.2, 'MEDIUM', 'star_equivalent'],
  ['spatial_precision', 5.3, 'LOW', 'star_equivalent'],
  ['flow_aim', 6.0, 'LOW', 'star_equivalent'],
  ['finger_control', 5.7, 'MEDIUM', 'star_equivalent'],
  ['reading', 8.2, 'LOW', 'star_equivalent'],
].map(([key, stars, confidence, unit]) => [key, { status: 'EMITTED', stars, confidence, unit }]));

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url !== '/api/analyze' || req.method !== 'POST') {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'NOT_FOUND' }));
      return;
    }
    observedPayload = JSON.parse(raw || '{}');
    if (observedPayload.beatmap_id === 404) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'BID_NOT_FOUND', message: 'fixture map is absent' }));
      return;
    }
    res.end(JSON.stringify({
      schema_version: 'map_demand_bid_analysis_v0.1.0',
      status: 'OK',
      beatmap: {
        beatmap_id: observedPayload.beatmap_id,
        beatmapset_id: 2053038,
        artist: 'Fixture Artist', title: 'Fixture Title', version: 'Fixture Diff', creator: 'Fixture Mapper',
        local_nm_stars: 9.8257,
        path_abs: 'G:\\private\\Songs\\fixture.osu',
        relative_path: 'private/fixture.osu',
      },
      analysis_context: {
        bpm_max: 260, duration_ms: 216000,
        difficulty: { ApproachRate: 10, OverallDifficulty: 10, CircleSize: 4 },
      },
      mod_context: { effective_mods: observedPayload.mods || [] },
      axes,
      archetype: {
        status: 'CLASSIFIED', primary_type: 'JUMP_AIM_DOMINANT', dominant_axes: ['jump_aim'], confidence: 'HIGH',
      },
      identity: { algorithm_id: 'MAP_DEMAND_ATOMIC_V07', map_demand_version: '0.9.0' },
      warnings: [],
    }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
process.env.SKILL_PROFILER_URL = `http://127.0.0.1:${port}`;

try {
  const { validateOperation } = await import('../server/bots/guard.ts');
  const { executeToolCall, runToolLoop } = await import('../server/bots/executor.ts');
  const { buildBotToolSchemas } = await import('../server/bots/registry.ts');

  assert.equal(validateOperation({
    type: 'osu_analyze_beatmap_skills', params: { beatmap_id: 4288226, mods: ['HD'] },
  }).ok, true, 'valid BID and supported mods pass the trusted guard');
  assert.equal(validateOperation({
    type: 'osu_analyze_beatmap_skills', params: { beatmap_id: 0, mods: [] },
  }).ok, false, 'invalid BID is rejected before the adapter');
  assert.equal(validateOperation({
    type: 'osu_analyze_beatmap_skills', params: { beatmap_id: 4288226, mods: ['FL'] },
  }).ok, false, 'unsupported mods fail closed');

  const registry = {
    updatedAt: '',
    bots: [{ id: 'yumu', name: '雨沐', description: 'fixture', qq: '', channel: 'internal', enabled: true, commands: [] }],
  };
  const tools = buildBotToolSchemas(registry, { surface: 'v2' });
  assert.ok(tools.some((tool) => tool.function.name === 'osu_analyze_beatmap_skills'));

  const call = {
    id: 'skill-profiler-fixture', type: 'function',
    function: { name: 'osu_analyze_beatmap_skills', arguments: JSON.stringify({ beatmap_id: 4288226, mods: ['HD'] }) },
  };
  const direct = await executeToolCall(call, { db: {}, userId: 'fixture-user' });
  assert.equal(direct.ok, true);
  assert.deepEqual(observedPayload, { beatmap_id: 4288226, mods: ['HD'] }, 'adapter forwards only the validated contract');
  assert.match(direct.content, /九维需求/);
  assert.match(direct.content, /Jump Aim：11\.2★/);
  assert.match(direct.content, /Stamina：9\.2\/10/);
  assert.match(direct.content, /V0\.92\.2/);
  assert.ok(!direct.content.includes('G:\\private'), 'absolute local path never reaches model evidence');
  assert.ok(!direct.content.includes('private/fixture.osu'), 'relative local path never reaches model evidence');
  assert.equal(direct.metadata.actualExecutor, 'osu_skill_profiler_v0922');

  let round = 0;
  let envelope;
  const loop = await runToolLoop(async (_db, options) => {
    round += 1;
    if (round === 1) {
      return {
        text: '', usage: {},
        raw: { choices: [{ message: { content: '', tool_calls: [call] } }] },
      };
    }
    const toolMessage = options.messages.findLast((message) => message.role === 'tool');
    envelope = JSON.parse(toolMessage.content);
    return {
      text: '这张图最突出的需求是 Jump Aim，同时 Aim Control 和 Reading 也很高；不过这些是实验性估计。',
      usage: {},
      raw: { choices: [{ message: { content: '这张图最突出的需求是 Jump Aim，同时 Aim Control 和 Reading 也很高；不过这些是实验性估计。' } }] },
    };
  }, {
    db: {}, messages: [{ role: 'user', content: '分析 BID 4288226 HD 难在哪' }], tools,
    userId: 'fixture-user', maxIterations: 3, structuredToolResults: true,
    continueAfterDirectPayload: true, deduplicateToolCalls: true,
    executeToolCallFn: executeToolCall,
  });
  assert.equal(loop.toolCallsMade, 1, 'Profiler participates in the normal Agent V2 loop');
  assert.equal(envelope.status, 'success');
  assert.equal(envelope.tool.name, 'osu_analyze_beatmap_skills');
  assert.equal(envelope.evidence.metadata.actualExecutor, 'osu_skill_profiler_v0922');
  assert.match(loop.text, /实验性估计/);

  const missing = await executeToolCall({
    id: 'skill-profiler-missing', type: 'function',
    function: { name: 'osu_analyze_beatmap_skills', arguments: JSON.stringify({ beatmap_id: 404, mods: [] }) },
  }, { db: {}, userId: 'fixture-user' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /BID_NOT_FOUND/);

  console.log('PASS: Skill Profiler is a guarded, path-safe Agent V2 tool with structured evidence');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
