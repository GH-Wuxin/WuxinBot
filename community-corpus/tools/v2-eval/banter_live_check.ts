// One live check through the integrated persona path (no manual injection).

import { readDb } from '../../../server/store.js';
import { buildPrompt } from '../../../server/bot/prompt.js';
import { completeChat } from '../../../server/bot/llm.js';

async function run() {
  const db = readDb();
  const group = { groupId: 'live-check', name: '实调验证群' };
  const event = {
    type: 'group',
    groupId: 'live-check',
    userId: 'u1',
    nickname: '群友',
    text: '666',
    atTargets: [],
  };
  const messages = buildPrompt({ ...db, messages: [] }, group, event, { policy: 'normal' });
  const hasBank = messages[0].content.includes('【群聊高频反应】');
  const result = await completeChat(db, { messages, label: 'banter live check' });
  console.log(`prompt includes banter bank: ${hasBank}`);
  console.log('--- pippi reply ---');
  console.log(result.text);
  console.log('---');
  console.log(`model=${result.model} latency=${result.latencyMs}ms tokens=${result.usage?.total_tokens}`);
}

run().catch((error) => {
  console.error('live check failed:', error);
  process.exitCode = 1;
});
