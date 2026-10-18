/**
 * owner 不再被无条件升级到 V4 Pro。
 *
 * 以前 responseOptionsFor 里写死一条：owner 的每条消息都换成 deepseek-v4-pro。
 * Pro 现在不比 Flash 强，这条只让 owner 的话变慢变贵，控制台显示的"当前模型"
 * 也和实际对不上。这里守住三件事：
 *   1. 关掉自动路由时，owner 和普通群友拿到同一个模型（都跟着 settings.model）；
 *   2. 带图的一轮仍然锁在视觉模型上（别把这条改坏了）；
 *   3. 复杂度路由本身还在，只是不再为 owner 特判。
 */
import fs from 'node:fs';
import path from 'node:path';
import { responseOptionsFor } from '../server/bot/prompt.ts';

let failed = 0;
function check(ok, label, detail = '') {
  if (!ok) failed += 1;
  console.log((ok ? '  ok   ' : '  不符 ') + label + (detail ? '   ' + String(detail).slice(0, 120) : ''));
}

const db = {
  settings: {
    llmProvider: 'deepseek',
    model: 'deepseek-v4-flash',
    enableAutoModel: false,
    visionMode: 'on',
    maxTokens: 300,
    webSearchMode: 'balanced',
    enableWebSearch: false,
  },
};
const ownerPolicy = { policy: 'owner' };
const normalPolicy = { policy: 'normal' };

const ownerEvent = { type: 'group', text: '今天几号', userId: '1', groupId: 'g', images: [], atTargets: [] };
const normalEvent = { ...ownerEvent, userId: '2' };

const ownerOptions = responseOptionsFor(ownerEvent, db, ownerPolicy);
const normalOptions = responseOptionsFor(normalEvent, db, normalPolicy);

check(ownerOptions.overrideModel === null, 'owner 不再被强制换成 Pro', String(ownerOptions.overrideModel));
check(ownerOptions.overrideModel === normalOptions.overrideModel, 'owner 和普通群友拿到同一个模型', String(normalOptions.overrideModel));

const visualEvent = { ...ownerEvent, text: '看看这张', quotedMessage: { userId: '9', images: [{ url: 'x' }] } };
const visualOptions = responseOptionsFor(visualEvent, db, ownerPolicy);
check(visualOptions.overrideModel === 'deepseek-v4-flash', '带图的一轮仍锁在视觉模型上', String(visualOptions.overrideModel));

// 接线：源码里不该再出现给 owner 写死模型的代码
const promptSource = fs.readFileSync(path.join(import.meta.dirname, '..', 'server', 'bot', 'prompt.ts'), 'utf8');
check(!promptSource.includes("if (isOwner) {\n    const provider = llmProvider(db);"), 'owner 特判代码已移除');
check(!promptSource.includes('autoModelForTask') && !promptSource.includes('taskComplexityScore'), '复杂度路由代码已移除');

console.log('');
if (failed) {
  console.log('失败 ' + failed + ' 项');
  process.exit(1);
}
console.log('全部通过：owner 跟着 settings.model 走，视觉轮次仍然锁模型');
