/**
 * 引用图片的归属回归。
 *
 * 事故现象：群友引用了一条 Pippi 自己发的表情包，问"查询你的表情包储量"，
 * 她回"你发这张托腮看书的，我已经给你记成一号藏品了" —— 把自己发的图算到了对方头上。
 *
 * 原因：引用里的图片会被当作本轮的视觉输入，而提示只说"本轮已附带图片给你"，
 * 没说是引用里谁发的。引用块也只写了个 [图片]，不说话人。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describeQuotedMessage, quotedSpeakerLabel, visualCapabilityNotice } from '../server/bot/prompt.ts';

let failed = 0;
function check(ok, label, detail = '') {
  if (!ok) failed += 1;
  console.log((ok ? '  ok   ' : '  不符 ') + label + (detail ? '   ' + String(detail).slice(0, 120) : ''));
}

const SELF = '3312171148';
const visionDb = { settings: { visionMode: 'on', selfQq: SELF, llmProvider: 'openai-compatible', model: 'whatever' } };
const textDb = { settings: { visionMode: 'off', selfQq: SELF, llmProvider: 'deepseek', model: 'deepseek-chat' } };

// 1. 说话人判定：自己发的（userId 是 bot 或 selfQq）要认成"你自己"
check(quotedSpeakerLabel({ userId: 'bot' }, SELF) === '你自己', 'bot 发的引用认成你自己');
check(quotedSpeakerLabel({ userId: SELF }, SELF) === '你自己', 'selfQq 发的引用认成你自己');
check(quotedSpeakerLabel({ userId: '3117086599', nickname: '[SHK]2369' }, SELF) === '[SHK]2369', '别人发的引用用昵称');

// 2. 引用块要带上说话人和图片张数
const selfQuote = describeQuotedMessage({ userId: SELF, text: 'gimmick 图读不明白', images: [{ url: 'a' }] }, SELF);
check(selfQuote.includes('你自己'), '引用块写明是自己发的', selfQuote);
check(selfQuote.includes('图片 ×1'), '引用块写明有几张图', selfQuote);
check(!selfQuote.includes('QQ:'), '自己发的引用不重复标 QQ 号', selfQuote);

const otherQuote = describeQuotedMessage({ userId: '3117086599', nickname: '[SHK]2369', images: [{ url: 'a' }] }, SELF);
check(otherQuote.includes('[SHK]2369') && otherQuote.includes('QQ:3117086599'), '别人的引用带昵称和 QQ', otherQuote);

const textOnly = describeQuotedMessage({ userId: '1', nickname: 'A', text: '只有文字' }, SELF);
check(!textOnly.includes('图片'), '纯文字引用不写图片', textOnly);

// 3. 视觉提示要区分"本轮自己发的图"和"引用里的图"
const quotedOnly = visualCapabilityNotice(visionDb, {
  text: '查询你的表情包储量',
  images: [],
  quotedMessage: { userId: SELF, nickname: 'Pippi', images: [{ url: 'a' }] },
});
check(quotedOnly.includes('被引用的那条消息'), '引用图片单独说明来源', quotedOnly);
check(quotedOnly.includes('你自己'), '引用图片指明原发送者是自己', quotedOnly);
check(quotedOnly.includes('不是当前发言者刚发的'), '明确否掉"你发的"这个归因', quotedOnly);
check(!quotedOnly.startsWith('本轮已附带图片给你'), '不能沿用"本轮已附带图片"那一句', quotedOnly);

const ownImage = visualCapabilityNotice(visionDb, { text: '看图', images: [{ url: 'a' }], quotedMessage: undefined });
check(ownImage.includes('本轮已附带图片给你'), '当前消息自己的图仍按原样说明', ownImage);

// 4. 文字模型遇到引用图片：承认看不到，别编
const textOnlyModel = visualCapabilityNotice(textDb, {
  text: '查询你的表情包储量',
  images: [],
  quotedMessage: { userId: SELF, images: [{ url: 'a' }] },
});
check(textOnlyModel.includes('纯文字模型') && textOnlyModel.includes('不要描述'), '文字模型不许描述引用图片', textOnlyModel);

// 5. 接线：提示构建器必须用 describeQuotedMessage，不能退回自己拼字符串
const promptSource = fs.readFileSync(path.join(import.meta.dirname, '..', 'server', 'bot', 'prompt.ts'), 'utf8');
check(promptSource.includes('describeQuotedMessage(event.quotedMessage'), '提示构建器使用统一的引用渲染');
check(!promptSource.includes('【所回复的 QQ 消息｜${quotedSpeaker}】'), '旧的引用渲染已移除');

console.log('');
if (failed) {
  console.log('失败 ' + failed + ' 项');
  process.exit(1);
}
console.log('全部通过：引用图片归属明确，提示不再把图算到说话人头上');
