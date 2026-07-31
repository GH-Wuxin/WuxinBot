import { processIncoming } from '../server/bot.js';
import { readDb } from '../server/store.js';

const db = readDb();
const selfQq = db.settings.selfQq || 'REDACTED_QQ_002';

const event = {
  type: 'group',
  groupId: 'REDACTED_GROUP_006',
  userId: 'REDACTED_QQ_001',
  nickname: 'Wux1n',
  text: '[CQ:at,qq=' + selfQq + '] 进行测试，获取我的bp1',
  messageId: 'sim-bp1-img-' + Date.now(),
  atTargets: [selfQq],
  images: [],
  raw: { self_id: selfQq }
};

console.log('Simulating:', event.text);

let sendCount = 0;
const sendMessage = async (evt, text, extra) => {
  sendCount++;
  console.log('--- SEND #' + sendCount + ' ---');
  if (text) console.log('TEXT(len=' + text.length + '):', text.slice(0, 400));
  if (extra) {
    const s = JSON.stringify(extra);
    console.log('EXTRA(len=' + s.length + '):', s.slice(0, 600));
  }
};

const result = await processIncoming(event, sendMessage);
console.log('\nDone. replied=' + result.replied + ' sendCount=' + sendCount);
