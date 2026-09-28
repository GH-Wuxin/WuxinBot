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

console.log('persona studio: built-in default prompts unchanged; editable layers/modules, module routing, redacted snapshots, tool visibility, and bounded retention PASS');
