/**
 * 画像任务的失败分类回归测试。
 *
 * 背景：队列是串行的，而熔断器原先只认 401/403。「容量不足」和「调用超时」不熔断，
 * 于是每个排队任务都要自己等满 240 秒 —— 13 个任务将近一小时，看着像卡死。
 *
 * 这里直接调用 memory.ts 里的真实判断函数，不用副本。
 * 用例取自线上 /api/profile-logs 的实际错误消息。
 */
import { isProfileCircuitWorthyError, isProfileModelUnavailableError, isProfileTimeoutError } from '../server/bot/memory.ts';

// [错误消息, 是否应当触发熔断, 说明]
const CASES = [
  ['Selected model is at capacity. Please try a different model.', true, '线上实际出现 4 次'],
  ['Codex App Server 调用超时 240 秒', true, '线上实际出现 20 次'],
  ['workspace routing discovery timed out', true, "'timed out' 中间有空格，曾漏判"],
  ['429 Too Many Requests', true, 'HTTP 状态码限流'],
  ['503 Service Unavailable', true, 'HTTP 状态码不可用'],
  ['Invalid API key', true, '认证失败，原有逻辑'],
  ['image too large', false, '输入问题，重试无意义但不算上游不可用'],
  ['模型返回了空结果', false, '内容问题，不该熔断'],
];

let failed = 0;
for (const [message, expected, note] of CASES) {
  const error = { message };
  const got = isProfileCircuitWorthyError(error);
  const ok = got === expected;
  if (!ok) failed += 1;
  const kind = isProfileModelUnavailableError(error) ? '上游不可用'
    : isProfileTimeoutError(error) ? '超时'
    : '认证或其它';
  console.log((ok ? '  ok   ' : '  不符 ') + String(expected).padEnd(6) + kind.padEnd(12) + message.slice(0, 52) + '   ' + note);
}

// 状态码字段也要认
const byStatus = [{ status: 429, message: 'whatever' }, { status: 503, message: '' }, { code: 529, message: '' }];
for (const error of byStatus) {
  if (!isProfileCircuitWorthyError(error)) { console.log('  不符  状态码 ' + JSON.stringify(error) + ' 未触发熔断'); failed += 1; }
}

console.log('');
if (failed) {
  console.log('失败 ' + failed + ' 项');
  process.exit(1);
}
console.log('全部通过：' + CASES.length + ' 条消息 + 3 个状态码');
