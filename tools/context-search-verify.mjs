import assert from 'node:assert/strict';
import { selectAdaptiveGroupContext } from '../server/bot/contextSearch.ts';

const now = Date.now();
const message = (index, content, overrides = {}) => ({
  id: `row-${index}`,
  sourceMessageId: `qq-${index}`,
  role: 'user',
  type: 'group',
  groupId: 'g1',
  userId: `u${index % 3}`,
  nickname: `N${index % 3}`,
  content,
  inContext: true,
  createdAt: new Date(now - (100 - index) * 1000).toISOString(),
  ...overrides,
});

const messages = [];
for (let index = 0; index < 45; index += 1) messages.push(message(index, `普通闲聊 ${index}`));
messages[5] = message(5, '我们之前讨论 bonus pp 的计算方式');
messages[6] = message(6, 'bonus pp 会随着有效成绩数量增长');
messages[8] = message(8, '[图片]', { media: { images: [{ type: 'image', url: 'https://example.invalid/old.png' }] } });
messages.push(message(45, '继续刚才关于 bonus pp 的话题', { sourceMessageId: 'current' }));

const db = {
  settings: {
    contextLimit: 5,
    groupContextSearchEnabled: true,
    groupContextSearchPoolSize: 40,
    groupContextSearchMaxExtra: 9,
    groupContextSearchCharBudget: 4000,
  },
  messages,
};

const baseEvent = {
  source: 'onebot', type: 'group', messageId: 'current', groupId: 'g1',
  userId: 'u0', nickname: 'N0', text: '今天吃什么', atTargets: [],
};

const recentOnly = selectAdaptiveGroupContext(db, baseEvent);
assert.equal(recentOnly.stats.expanded, false);
assert.deepEqual(recentOnly.messages.map((item) => item.id), ['row-40', 'row-41', 'row-42', 'row-43', 'row-44']);
assert.ok(!recentOnly.messages.some((item) => item.sourceMessageId === 'current'), 'current event must not be duplicated in history');

const expanded = selectAdaptiveGroupContext(db, { ...baseEvent, text: '继续刚才关于 bonus pp 的话题' });
assert.equal(expanded.stats.expanded, true);
assert.ok(expanded.messages.some((item) => item.id === 'row-5'));
assert.ok(expanded.messages.some((item) => item.id === 'row-6'));
assert.deepEqual(expanded.messages.slice(-5).map((item) => item.id), ['row-40', 'row-41', 'row-42', 'row-43', 'row-44']);
assert.ok(expanded.stats.retrievedCount <= 9);

const quoted = selectAdaptiveGroupContext(db, {
  ...baseEvent,
  text: '这是什么意思',
  replyMessageId: 'qq-8',
  quotedMessage: { messageId: 'qq-8', text: '', images: [{ type: 'image', url: 'https://example.invalid/old.png' }] },
});
assert.equal(quoted.stats.reason, 'quoted_message');
assert.ok(quoted.messages.some((item) => item.id === 'row-8'));

const disabled = selectAdaptiveGroupContext({
  ...db,
  settings: { ...db.settings, groupContextSearchEnabled: false },
}, { ...baseEvent, text: '继续刚才的话题' });
assert.equal(disabled.stats.reason, 'disabled');
assert.equal(disabled.stats.retrievedCount, 0);

console.log('context-search-verify: all checks passed');
