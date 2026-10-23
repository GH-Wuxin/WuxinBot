import assert from 'node:assert/strict';
import {
  buildPippiPrompt,
  getPippiPromptSectionCatalog,
} from '../server/bot/persona.ts';
import {
  applyModulePersonality,
  beginPromptCall,
  clearPromptCallsForTest,
  finishPromptCall,
  getPersonaStudioCatalog,
  listPromptCalls,
  resolvePromptModule,
} from '../server/promptStudio.ts';

for (const scene of ['casual', 'osu_analysis', 'command', 'serious']) {
  assert.equal(
    buildPippiPrompt({ scene }),
    buildPippiPrompt({ scene, promptSections: {} }),
    `empty prompt-section settings must preserve the ${scene} prompt byte-for-byte`,
  );
}

const defaults = getPippiPromptSectionCatalog();
assert.ok(defaults.length >= 8, 'studio exposes built-in persona layers');
const customScene = getPippiPromptSectionCatalog({ sceneCasual: 'CUSTOM SCENE' });
assert.equal(customScene.find((item) => item.id === 'sceneCasual')?.currentContent, 'CUSTOM SCENE');
assert.equal(customScene.find((item) => item.id === 'sceneCasual')?.isOverridden, true);
const editedPrompt = buildPippiPrompt({ scene: 'casual', promptSections: { sceneCasual: 'CUSTOM SCENE' } });
assert.ok(editedPrompt.includes('CUSTOM SCENE'));
assert.ok(!editedPrompt.includes('当前场景：日常聊天。'));

const sameMessages = [{ role: 'system', content: 'system prompt' }, { role: 'user', content: 'hello' }];
assert.equal(applyModulePersonality(sameMessages, 'conversation', {}), sameMessages, 'empty module override must not alter messages');
const injected = applyModulePersonality(sameMessages, 'conversation', { conversation: 'short, candid Pippi reactions' });
assert.ok(injected[0].content.includes('【该模块的人格补充】'));
assert.ok(injected[0].content.endsWith('short, candid Pippi reactions'));
assert.ok(injected[0].content.includes('不得覆盖任务目标、事实边界、安全约束、输出格式或工具使用规则'));
assert.equal(sameMessages[0].content, 'system prompt', 'overlay must not mutate caller-owned messages');
const noSystem = applyModulePersonality([{ role: 'user', content: 'x' }], 'general', { general: 'voice' });
assert.equal(noSystem[0].role, 'system', 'overlay creates a system layer when absent');

assert.equal(resolvePromptModule({ label: 'Bot Harness', tracePurpose: 'conversation_reply' }).id, 'conversation');
assert.equal(resolvePromptModule({ label: 'osu分析独立审查重试' }).id, 'osu_review');
assert.equal(resolvePromptModule({ label: 'osu硬错误修复(profile)' }).id, 'osu_repair');
assert.equal(resolvePromptModule({ label: '图片记忆摘要' }).id, 'player_profile');
assert.equal(resolvePromptModule({ tracePurpose: 'tool_planning' }).id, 'agent_tools');
assert.ok(getPersonaStudioCatalog({ personaModulePrompts: { conversation: 'custom' } })
  .find((item) => item.id === 'conversation')?.isOverridden);

clearPromptCallsForTest();
const callId = beginPromptCall({
  id: 'capture-1',
  options: { label: 'Bot Harness', tracePurpose: 'conversation_reply', tool_choice: 'auto' },
  messages: [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz and data:image/png;base64,AAAA' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } }] },
  ],
  tools: [{ type: 'function', function: { name: 'query_osu', parameters: { type: 'object' } } }],
});
assert.equal(callId, 'capture-1');
finishPromptCall(callId, {
  status: 'ok', provider: 'test', model: 'fixture', durationMs: 12,
  response: { content: 'done', toolCalls: [{ name: 'query_osu', arguments: { capability: 'bp' } }], reasoning: 'must not be exposed', usage: { totalTokens: 4 } },
});
const captured = listPromptCalls(1)[0];
assert.equal(captured.moduleId, 'conversation');
assert.ok(!JSON.stringify(captured).includes('abcdefghijklmnopqrstuvwxyz'));
assert.ok(!JSON.stringify(captured).includes('AAAA'));
assert.ok(!JSON.stringify(captured).includes('BBBB'));
assert.ok(!JSON.stringify(captured).includes('must not be exposed'));
assert.ok(captured.tools.includes('query_osu'));
assert.ok(captured.response.toolCalls.includes('query_osu'));
const clippedId = beginPromptCall({ id: 'capture-long', messages: [{ role: 'system', content: 'x'.repeat(13_000) }] });
const clippedCall = listPromptCalls(1)[0];
assert.equal(clippedId, 'capture-long');
assert.equal(clippedCall.messages[0].truncated, true, 'long prompt snapshots must be visibly marked as clipped');
assert.ok(clippedCall.messages[0].content.includes('[快照已截断]'));

for (let index = 0; index < 40; index += 1) beginPromptCall({ id: `bounded-${index}`, messages: [] });
assert.equal(listPromptCalls(100).length, 32, 'prompt-call history must stay bounded');
clearPromptCallsForTest();

// ── F4：群聊形态由任务性质决定，不再按「有没有问号 / 有没有 @」二选一 ──
// 判据是组装结果本身：群聊必须拿到允许完成任务的规则，且不再被硬性长度上限压住。
const groupAmbient = buildPippiPrompt({ scene: 'casual', groupCasual: true });
const groupTask = buildPippiPrompt({ scene: 'casual', groupCasual: true, addressedQuestion: true });
assert.ok(groupAmbient.includes('【群聊形态】'), '群聊应注入条件式形态规则');
assert.ok(groupAmbient.includes('先完成要求'), '群聊规则必须允许完成任务');
assert.ok(groupAmbient.includes('长度由事情决定'), '长度应由任务性质决定');
assert.ok(!groupAmbient.includes('多数在 10 个字以内'), '硬性长度上限不应再出现在群聊路径上');
assert.ok(!groupAmbient.includes('多数十字以内'), '同上，兼容旧措辞');
assert.ok(groupAmbient.includes('不要用句号结尾'), '标点风格与长度无关，必须保留');
assert.ok(groupAmbient.includes('闲聊接话'), '闲聊的短回复默认仍要保留');
assert.ok(groupAmbient.includes('社区短反应只用于闲聊'), '短反应不得替代答案或执行结果');
assert.equal(groupAmbient, groupTask, '群聊形态不应再随 addressedQuestion 变化');

// 未纳入本次修改的路径必须保持原样：不传 groupCasual 时仍是原来的二选一。
const untouchedAmbient = buildPippiPrompt({ scene: 'casual' });
const untouchedQuestion = buildPippiPrompt({ scene: 'casual', addressedQuestion: true });
assert.ok(untouchedAmbient.includes('多数在 10 个字以内'), '未纳入修改的路径必须保持原样');
assert.ok(untouchedQuestion.includes('【回答提问】'), '未纳入修改的路径仍用回答形态');
// 注意不能用「【群聊形态】」区分：旧版 CASUAL_FORM_GUIDE 开头也是这四个字。
assert.ok(!untouchedAmbient.includes('长度由事情决定'), '未纳入修改的路径不该拿到新的群聊规则');

// 命令与严肃场景本来就只走 sceneRules，不该被形态规则渗透。
const commandPrompt = buildPippiPrompt({ scene: 'command', groupCasual: true });
assert.ok(!commandPrompt.includes('【群聊形态】'), '命令场景不该注入群聊形态规则');
assert.ok(!commandPrompt.includes('【回答提问】'), '命令场景不该注入回答形态规则');
const seriousPrompt = buildPippiPrompt({ scene: 'serious', groupCasual: true });
assert.ok(!seriousPrompt.includes('【群聊形态】'), '严肃场景不该注入群聊形态规则');

// Scene routing and addressed-question selection may change voice, but cannot
// omit the shared length preference. Detailed tasks remain an explicit exception.
for (const socialV2 of [false, true]) for (const scene of ['casual', 'osu_analysis', 'command', 'serious']) {
  for (const addressedQuestion of [false, true]) {
    const prompt = buildPippiPrompt({ scene, socialV2, addressedQuestion, socialTone: 'TONE', relationshipContext: 'MEMORY' });
    assert.ok(prompt.includes('【回复长度：提及也默认短句】'));
    assert.ok(prompt.includes('用户明确要求详细说明或创作长文'));
    assert.ok(prompt.indexOf('【回复长度：提及也默认短句】') > prompt.indexOf('MEMORY'));
    const edited = buildPippiPrompt({ scene, socialV2, addressedQuestion, promptSections: { replyLengthGuide: 'EDITED LENGTH' } });
    assert.ok(edited.endsWith('EDITED LENGTH'));
  }
}

console.log('persona studio: F4 group-casual form rule verified (task-driven length, punctuation style kept, untouched paths unchanged)');
console.log('persona studio: built-in default prompts unchanged; editable layers/modules, module routing, redacted snapshots, tool visibility, and bounded retention PASS');
