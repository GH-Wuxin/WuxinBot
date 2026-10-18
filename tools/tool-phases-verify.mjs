/**
 * 两层工具面：第一层纯文本并发，第二层只发图。
 */
import assert from 'node:assert/strict';
import { buildBotToolSchemas } from '../server/bots/registry.ts';
import { capabilityForAgentToolName, normalizeAgentToolCall, osuCapabilityForToolCall } from '../server/bots/agentToolContracts.ts';
import { runToolLoop } from '../server/bots/executor.ts';

const registry = {
  updatedAt: '',
  bots: [{ id: 'yumu', name: '雨沐', channel: 'internal', enabled: true, commands: [] }],
};

const textTools = buildBotToolSchemas(registry, { surface: 'v2', phase: 'text' });
const imageTools = buildBotToolSchemas(registry, { surface: 'v2', phase: 'image' });

const textNames = textTools.map((tool) => tool.function.name);
const imageNames = imageTools.map((tool) => tool.function.name);
assert.equal(imageNames.length, 7, '第二层应当有七个发图工具');
assert.ok(imageNames.every((name) => name.startsWith('osu_send_')), '第二层只暴露发图工具');
assert.ok(!textNames.some((name) => name.startsWith('osu_send_')), '第一层看不到发图工具');
assert.ok(textNames.includes('osu_beatmap_skill') && textNames.includes('osu_compare_skill'), '第一层包含技能文本工具');

// 发图工具也要能被路由到执行器：名字 → 能力 → query_osu。
assert.equal(capabilityForAgentToolName('osu_send_score_card'), 'score_image');
const normalized = normalizeAgentToolCall({
  id: 'n1', type: 'function',
  function: { name: 'osu_send_score_card', arguments: JSON.stringify({ source: 'bp', bp_rank: 2 }) },
});
assert.equal(normalized.function.name, 'query_osu');
assert.deepEqual(JSON.parse(normalized.function.arguments), { capability: 'score_image', source: 'bp', bp_rank: 2 });
assert.equal(osuCapabilityForToolCall(normalized), 'score_image');

const scoreImage = imageTools.find((tool) => tool.function.name === 'osu_send_score_card');
assert.deepEqual(scoreImage.function.parameters.required, ['source'], 'score_image 必须指定 source');
assert.deepEqual(
  scoreImage.function.parameters.properties.source.enum,
  ['bp', 'bp_range', 'recent_play', 'recent_pass', 'beatmap_score'],
);

// 并发：两个只读调用必须在同一批里并行，而不是串行叠加。
let inFlight = 0;
let peak = 0;
const order = [];
const roundTools = [];
let round = 0;
const result = await runToolLoop(async (_db, options) => {
  round += 1;
  roundTools.push((options.tools || []).map((tool) => tool.function.name));
  if (round === 1) {
    return {
      text: '', usage: {},
      raw: { choices: [{ message: { content: '', tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'osu_get_best_score', arguments: JSON.stringify({ bp_rank: 1 }) } },
        { id: 'c2', type: 'function', function: { name: 'osu_get_player', arguments: '{}' } },
      ] } }] },
    };
  }
  if (round === 2) {
    return {
      text: '', usage: {},
      raw: { choices: [{ message: { content: '', tool_calls: [
        { id: 'c3', type: 'function', function: { name: 'osu_send_score_card', arguments: JSON.stringify({ source: 'bp', bp_rank: 1 }) } },
      ] } }] },
    };
  }
  return { text: '图在下面', usage: {}, raw: { choices: [{ message: { content: '图在下面' } }] } };
}, {
  db: { settings: {} },
  messages: [{ role: 'user', content: '看看我的 BP1，顺便来张图' }],
  tools: textTools,
  imageTools,
  userId: 'u1',
  maxIterations: 4,
  structuredToolResults: true,
  continueAfterDirectPayload: true,
  executeToolCallFn: async (toolCall) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 25));
    inFlight -= 1;
    order.push(toolCall.function.name);
    if (toolCall.function.name === 'osu_send_score_card') {
      return { toolCallId: toolCall.id, ok: true, content: '已出图：BP1', images: ['[CQ:image,file=file:///bp1.png]'] };
    }
    return { toolCallId: toolCall.id, ok: true, content: toolCall.function.name + ' ok' };
  },
});

assert.equal(peak, 2, '两个只读调用应当并发执行');
assert.deepEqual(order.slice(0, 2).sort(), ['osu_get_best_score', 'osu_get_player']);
assert.ok(roundTools[0].includes('osu_get_best_score'), '第一轮是文本工具面');
assert.ok(!roundTools[0].some((name) => name.startsWith('osu_send_')), '第一轮看不到图片工具');
assert.ok(roundTools[1].some((name) => name.startsWith('osu_send_')), '第二批之前图片工具已进入工具面');
assert.ok(roundTools[1].includes('osu_get_beatmap'), '文本工具仍可用来做链式补查');
assert.deepEqual(result.images, ['[CQ:image,file=file:///bp1.png]'], '图片进入交付集合');

console.log('tool phases: text batch parallel + image phase PASS');
