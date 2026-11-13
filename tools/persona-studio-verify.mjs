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
// 判据是组装结果本身：群聊必须拿到允许完成任务的规则，且不再被硬性字数或
// 固定标点规则压住。
const groupAmbient = buildPippiPrompt({ scene: 'casual', groupCasual: true });
const groupTask = buildPippiPrompt({ scene: 'casual', groupCasual: true, addressedQuestion: true });
assert.ok(groupAmbient.includes('【群聊形态】'), '群聊应注入条件式形态规则');
assert.ok(groupAmbient.includes('对方要求解释或做事时先完成'), '群聊规则必须允许完成任务');
assert.ok(!groupAmbient.includes('多数在 10 个字以内'), '硬性长度上限不应再出现在群聊路径上');
assert.ok(!groupAmbient.includes('不要用句号结尾'), '不应再用固定标点规则压短文风');
assert.ok(groupAmbient.includes('闲聊可以短'), '闲聊仍可自然简洁');
assert.ok(!groupAmbient.includes('群聊高频反应'), '默认不再注入社区短反应词表');
assert.equal(groupAmbient, groupTask, '群聊形态不应再随 addressedQuestion 变化');

// 非 groupCasual 的旧分支也不再使用字数/标点硬规则；直接对话仍先答清楚。
const untouchedAmbient = buildPippiPrompt({ scene: 'casual' });
const untouchedQuestion = buildPippiPrompt({ scene: 'casual', addressedQuestion: true });
assert.ok(untouchedAmbient.includes('不必每次说很多'), '普通聊天不应再有字数锚点');
assert.ok(!untouchedAmbient.includes('【直接对话】'), '非直接对话不走回答形态');
assert.ok(untouchedQuestion.includes('【直接对话】'), '直接对话应使用回答形态');
assert.ok(!untouchedAmbient.includes('长度由事情决定'), '普通聊天不套用群聊任务规则');

// 命令与严肃场景只走 sceneRules，不该被形态规则渗透。
const commandPrompt = buildPippiPrompt({ scene: 'command', groupCasual: true });
assert.ok(!commandPrompt.includes('【群聊形态】'), '命令场景不该注入群聊形态规则');
assert.ok(!commandPrompt.includes('【直接对话】'), '命令场景不该注入回答形态规则');
const seriousPrompt = buildPippiPrompt({ scene: 'serious', groupCasual: true });
assert.ok(seriousPrompt.includes('当前场景：需要认真对待的对话。'), '显式 serious 场景仍保留');
assert.ok(!seriousPrompt.includes('【群聊形态】'), '严肃场景不该注入群聊形态规则');

// 人格层：夸奖不预设固定顺序，允许普通回应/不接话。
const casualPrompt = buildPippiPrompt({ scene: 'casual' });
assert.ok(!casualPrompt.includes('故意把称赞说得珍贵一点'), '不应再预设夸奖要先推辞');
assert.ok(casualPrompt.includes('被夸时怎么回应都可以'), '夸奖应允许多种自然反应');
assert.ok(!casualPrompt.includes('先接受这份认可'), '不应强制先接受');
assert.ok(!casualPrompt.includes('被夸时可以只表达开心或感谢'), '不应强制先道谢');
assert.ok(casualPrompt.includes('不需要对每条消息都给出反应'), '允许不接话或普通回应');
assert.ok(casualPrompt.includes('结合上下文能确认对方在认真求助'), '真实困难仍需认真回应');
assert.ok(casualPrompt.includes('【外观】'), '人格层应包含固定外观事实');
assert.ok(casualPrompt.includes('黑粉双色'), '外观事实应说明双色头发');
assert.ok(casualPrompt.includes('呆毛'), '外观事实应包含呆毛');
assert.ok(casualPrompt.includes('眼睛是绿色'), '外观事实应包含绿眼');
assert.ok(casualPrompt.includes('深蓝色领结'), '外观事实应包含服装');
assert.ok(casualPrompt.includes('没有蝴蝶结'), '外观事实应排除不存在的发饰');

const sections = getPippiPromptSectionCatalog();
assert.equal(sections.find((item) => item.id === 'communityBanter')?.defaultContent, '',
  '社区短反应词表默认不应注入');
assert.ok(!casualPrompt.includes('666、对、6、吓哭了'), '默认提示词不应包含社区热词表');

// Scene routing and direct-address selection may change voice, but cannot omit
// the shared style guidance. Detailed tasks remain an explicit exception.
for (const socialV2 of [false, true]) for (const scene of ['casual', 'osu_analysis', 'command', 'serious']) {
  for (const addressedQuestion of [false, true]) {
    const prompt = buildPippiPrompt({ scene, socialV2, addressedQuestion, socialTone: 'TONE', relationshipContext: 'MEMORY' });
    assert.ok(!prompt.includes('【回复长度与语气】'), '默认不注入额外长度规范');
    const edited = buildPippiPrompt({ scene, socialV2, addressedQuestion, promptSections: { replyLengthGuide: 'EDITED LENGTH' } });
    assert.ok(edited.endsWith('EDITED LENGTH'));
  }
}

// 配置兼容：空字符串覆盖必须仍然是“删除该段”，未知键不得改变默认。
const emptyScene = buildPippiPrompt({ scene: 'casual', promptSections: { sceneCasual: '' } });
assert.ok(!emptyScene.includes('当前场景：日常聊天。'), '空字符串覆盖应移除该段');
const overriddenLength = buildPippiPrompt({ scene: 'casual', promptSections: { replyLengthGuide: 'EDITED LENGTH' } });
assert.ok(overriddenLength.endsWith('EDITED LENGTH'));
assert.equal(buildPippiPrompt({ scene: 'casual', promptSections: { unknownSection: 'x' } }), casualPrompt,
  '未知配置项不应改变默认提示词');

console.log('persona studio: task-driven length and natural praise verified (no word-count/punctuation anchors, explicit serious kept)');
console.log('persona studio: natural defaults and editable layers/modules, module routing, redacted snapshots, tool visibility, and bounded retention PASS');
