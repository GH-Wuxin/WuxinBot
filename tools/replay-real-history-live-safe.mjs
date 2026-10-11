import { readDb } from '../server/store.ts';

const DESTINATION_GROUP_ID = '1083681153';
const BOT_QQ = '3312171148';
const SOURCE_GROUPS = ['682910196', '712531032', '885215108'];
const API_URL = 'http://127.0.0.1:8787/api/onebot/event';

// Source groups are labels for selecting text only. They must never become the
// destination of the injected OneBot event.
if (SOURCE_GROUPS.includes(DESTINATION_GROUP_ID)) {
  throw new Error('安全检查失败：测试群不能同时出现在来源群列表中');
}
if (process.env.WUXIN_STICKER_LIVE_AUTHORIZED !== '1') {
  throw new Error('拒绝执行真实群灰度：请显式设置 WUXIN_STICKER_LIVE_AUTHORIZED=1');
}

const db = readDb();
const messages = Array.isArray(db.messages) ? db.messages : [];
const requestedSamples = [
  { sourceGroupId: '712531032', fragment: '你怎麼這麼強' },
  { sourceGroupId: '682910196', fragment: 'pippi害我choke一次' },
  { sourceGroupId: '885215108', fragment: '我还真没研究过' },
];

function findSourceMessage({ sourceGroupId, fragment }) {
  return messages.find((message) =>
    String(message.groupId) === sourceGroupId
    && message.role === 'user'
    && String(message.content || '').includes(fragment)
    && !String(message.content || '').includes('[图片]')
  );
}

async function sendOneSample(sample, sampleIndex) {
  const source = findSourceMessage(sample);
  if (!source) return { ok: false, sampleIndex, sourceGroupId: sample.sourceGroupId, error: 'source_message_not_found' };

  const event = {
    post_type: 'message',
    message_type: 'group',
    time: Math.floor(Date.now() / 1000),
    self_id: Number(BOT_QQ),
    message_id: Number(String(Date.now()).slice(-9)) + sampleIndex,
    // This is the only destination assignment in this script.
    group_id: Number(DESTINATION_GROUP_ID),
    user_id: Number(source.userId),
    message: `[CQ:at,qq=${BOT_QQ}] ${String(source.content || '').replace(/^\[CQ:at,[^\]]+\]\s*/u, '')}`,
    raw_message: `[CQ:at,qq=${BOT_QQ}] ${String(source.content || '').replace(/^\[CQ:at,[^\]]+\]\s*/u, '')}`,
    sender: {
      user_id: Number(source.userId),
      nickname: String(source.nickname || source.userId),
      card: String(source.nickname || source.userId),
      role: 'member',
    },
  };
  if (String(event.group_id) !== DESTINATION_GROUP_ID) {
    throw new Error(`安全检查失败：目标群变成 ${event.group_id}`);
  }

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(180_000),
  });
  const payload = await response.json();
  const result = payload?.result?.result || payload?.result || {};
  return {
    ok: response.ok && payload?.ok !== false,
    sampleIndex,
    sourceGroupId: sample.sourceGroupId,
    destinationGroupId: DESTINATION_GROUP_ID,
    input: String(source.content || '').slice(0, 280),
    replied: Boolean(result.replied),
    hasImage: (result.segments || []).some((segment) => /\[CQ:image,/iu.test(String(segment))),
    stickerCount: Array.isArray(result.stickers) ? result.stickers.length : 0,
    segmentCount: Array.isArray(result.segments) ? result.segments.length : 0,
    text: String(result.text || '').slice(0, 360),
    reason: String(result.reason || ''),
  };
}

const results = [];
for (const [index, sample] of requestedSamples.entries()) {
  results.push(await sendOneSample(sample, index));
}

console.log(JSON.stringify({
  ok: results.every((result) => result.ok),
  destinationGroupId: DESTINATION_GROUP_ID,
  sentCount: results.length,
  imageCount: results.filter((result) => result.hasImage).length,
  results,
}, null, 2));

