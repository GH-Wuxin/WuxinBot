import assert from 'node:assert/strict';
import { buildPrompt } from '../server/bot/prompt.ts';
import { formatMemorySampleBlocks } from '../server/bot/memory.ts';

const baseSettings = {
  ownerQq: 'owner', selfQq: 'bot-qq', model: 'deepseek-v4-flash',
  llmProvider: 'deepseek', apiBaseUrl: 'https://api.deepseek.com',
  visionMode: 'auto', contextLimit: 30, ownerPrivateContextCharBudget: 24000,
  memoryEnabled: false, ignoreSystemFacts: false, personalityPrompt: '',
  enableWebSearch: false, enableAutoModel: false, maxTokens: 300,
  commandRoles: [], commandPermissions: {}, kb: { enabled: false },
};
const at = (second) => `2026-08-21T11:${String(second).padStart(2, '0')}:00.000Z`;
const messages = [
  { id: 'a1', sourceMessageId: 'qa1', role: 'user', type: 'group', groupId: 'g1', userId: 'alice', nickname: 'Alice', content: '[图片] 7.15星 HDDT SS', inContext: true, createdAt: at(1) },
  { id: 'b1', role: 'assistant', type: 'group', groupId: 'g1', userId: 'bot', nickname: '机器人', content: '这个成绩很漂亮。', inContext: true, createdAt: at(2) },
  { id: 'a2', role: 'assistant', replyToMessageId: 'qa1', replyToUserId: 'alice', replyToNickname: 'Alice', type: 'group', groupId: 'g1', userId: 'bot', nickname: '机器人', content: 'HDDT SS 很干净。', inContext: true, createdAt: at(3) },
  { id: 'current', sourceMessageId: 'qb1', role: 'user', type: 'group', groupId: 'g1', userId: 'bob', nickname: 'Bob', content: '[CQ:at,qq=bot-qq] 你欺负我了', inContext: true, createdAt: at(4) },
];
const db = {
  settings: baseSettings,
  messages,
  users: [], memories: [], groupProfiles: [], relationshipProfiles: [],
  osuBindings: {}, experiences: {}, usageEvents: [],
};
const event = {
  source: 'onebot', type: 'group', messageId: 'qb1', groupId: 'g1',
  userId: 'bob', nickname: 'Bob', text: '[CQ:at,qq=bot-qq] 你欺负我了',
  atTargets: ['bot-qq'], images: [],
};
const prompt = buildPrompt(db, { groupId: 'g1', name: '测试群' }, event, { policy: 'normal', allowCommands: false });
const history = prompt.slice(1, -1);

assert.equal(history.length, 1, 'group history must be one explicit multi-speaker transcript');
assert.equal(history[0].role, 'user', 'old bot replies must not masquerade as a direct assistant turn with the current speaker');
assert.match(history[0].content, /Alice（QQ:alice）/);
assert.match(history[0].content, /回复 Alice（QQ:alice）/);
assert.match(history[0].content, /未记录回复对象；不得默认视为回复当前发言者/);
assert.ok(!history[0].content.includes('Bob（QQ:bob）：[CQ:at'), 'current message must appear only in the final current-user turn');
assert.match(prompt[0].content, /本轮唯一当前发言者是 Bob（QQ:bob/);
assert.match(prompt[0].content, /本轮没有引用一条具体历史消息/);
assert.match(prompt[0].content, /不要自行挑选某条旧消息补出原因/);

const memoryBlock = formatMemorySampleBlocks(
  { userId: 'bob', nickname: 'Bob' },
  [{
    content: '我今天只打了低 BPM', type: 'text', riskLevel: 'normal', reason: 'fixture',
    context: {
      atTargets: [], mentionedBot: false,
      nearby: [
        { role: 'user', userId: 'alice', nickname: 'Alice', content: '我刚打了 7.15 星 HDDT SS' },
        { role: 'user', userId: 'bob', nickname: 'Bob', content: '确实厉害' },
      ],
    },
  }],
);
assert.match(memoryBlock, /目标本人内容：我今天只打了低 BPM/);
assert.match(memoryBlock, /\[其他说话人\] Alice（QQ:alice）：我刚打了 7\.15 星 HDDT SS/);
assert.match(memoryBlock, /附近对话（只帮助理解语境；不是目标本人的画像证据/);

console.log('speaker-attribution-verify: all checks passed');
