/**
 * 画像熔断的回归测试。
 *
 * 背景：熔断原先固定 10 分钟，上游只要一直超时，就每 10 分钟再白等一次 240 秒。
 * 现在按连续失败次数递增退避，并且单人手动重算可以绕过一次。
 *
 * 这里测的是 server/bot/profileCircuit.ts 里的真函数，不是副本；最后几条再确认
 * memory.ts 和 index.ts 确实接上了它们 —— 状态机改对了但没接线，一样是坏的。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  PROFILE_CIRCUIT_BACKOFF_MS,
  PROFILE_CIRCUIT_CLOSED,
  PROFILE_CIRCUIT_STREAK_RESET_MS,
  circuitBackoffMs,
  clearProfileCircuit,
  profileCircuitBlockReason,
  tripProfileCircuit,
} from '../server/bot/profileCircuit.ts';

let failed = 0;
function check(ok, label, detail = '') {
  if (!ok) failed += 1;
  console.log((ok ? '  ok   ' : '  不符 ') + label + (detail ? '   ' + detail : ''));
}

const MIN = 60_000;

// 退避时长：第 1/2/3/4 次连续失败分别是 10/20/40/120 分钟，之后封顶。
const BACKOFF_CASES = [
  [1, 10 * MIN], [2, 20 * MIN], [3, 40 * MIN], [4, 120 * MIN],
  [5, 120 * MIN], [12, 120 * MIN], [0, 10 * MIN], [-3, 10 * MIN], [NaN, 10 * MIN], [2.9, 20 * MIN],
];
for (const [input, expected] of BACKOFF_CASES) {
  const got = circuitBackoffMs(input);
  check(got === expected, `退避 ${String(input)} → ${got / MIN} 分钟`, `期望 ${expected / MIN} 分钟`);
}

let monotonic = true;
for (let n = 1; n < 20; n += 1) {
  if (circuitBackoffMs(n + 1) < circuitBackoffMs(n)) monotonic = false;
  if (circuitBackoffMs(n) > 120 * MIN) monotonic = false;
}
check(monotonic, '退避只增不减，且封顶 120 分钟');

const base = 1_700_000_000_000;

// 第一次失败：闭合态 → 打开 10 分钟，计数 1。
const first = tripProfileCircuit(PROFILE_CIRCUIT_CLOSED, { now: base, fingerprint: 'A', reason: '超时 240 秒' });
check(first.failures === 1, '首次失败计数为 1');
check(first.until === base + 10 * MIN, '首次失败退避 10 分钟', String((first.until - base) / MIN));
check(first.reason === '超时 240 秒' && first.lastFailureAt === base, '首次失败记录原因与时间');

// 同一套配置再次失败：计数 2，退避 20 分钟。
const second = tripProfileCircuit(first, { now: base + 11 * MIN, fingerprint: 'A', reason: '超时 240 秒' });
check(second.failures === 2, '同一配置连续失败计数累加');
check(second.until === base + 11 * MIN + 20 * MIN, '第二次失败退避 20 分钟', String((second.until - (base + 11 * MIN)) / MIN));

// 换配置：计数回到 1。
const switched = tripProfileCircuit(second, { now: base + 20 * MIN, fingerprint: 'B', reason: '容量不足' });
check(switched.failures === 1, '换模型配置后重新计数');
check(switched.until === base + 20 * MIN + 10 * MIN, '换配置后退避回到 10 分钟');

// 同一配置，但距离上次失败超过 6 小时：不再算同一段。
const stale = tripProfileCircuit(second, {
  now: second.lastFailureAt + PROFILE_CIRCUIT_STREAK_RESET_MS + 1, fingerprint: 'A', reason: '超时 240 秒',
});
check(stale.failures === 1, '超过 6 小时的空档重新计数');

// 成功清零：清完之后再坏，仍从 10 分钟起步。
const cleared = clearProfileCircuit();
check(cleared.failures === 0 && cleared.until === 0, '成功后状态归零');
const afterClear = tripProfileCircuit(cleared, { now: base, fingerprint: 'A', reason: '超时 240 秒' });
check(afterClear.failures === 1 && afterClear.until === base + 10 * MIN, '清零后再失败仍从 10 分钟起步');

// 阻塞判定：窗口内同配置阻塞，过期或换配置不阻塞。
check(profileCircuitBlockReason(first, { now: base + 1, fingerprint: 'A' }) === '超时 240 秒', '窗口内同配置被挡住');
check(profileCircuitBlockReason(first, { now: base + 10 * MIN, fingerprint: 'A' }) === '', '窗口到期自动放行');
check(profileCircuitBlockReason(first, { now: base + 1, fingerprint: 'B' }) === '', '换配置不受旧熔断影响');

// 原因长度受限，避免一条超长错误撑爆画像日志。
const longReason = tripProfileCircuit(PROFILE_CIRCUIT_CLOSED, { now: base, fingerprint: 'A', reason: 'x'.repeat(900) });
check(longReason.reason.length === 300, '熔断原因截断到 300 字');

// 封顶：连续失败很多次也不会无限拉长。
let capped = PROFILE_CIRCUIT_CLOSED;
for (let i = 0; i < 30; i += 1) capped = tripProfileCircuit(capped, { now: base + i * MIN, fingerprint: 'A', reason: '超时' });
check(capped.until - (base + 29 * MIN) === Math.max(...PROFILE_CIRCUIT_BACKOFF_MS), '连续 30 次失败仍封顶 120 分钟');

console.log('');
// 接线检查：状态机接对了，但 memory.ts 忘了用，等于没改。
const memorySource = fs.readFileSync(path.join(import.meta.dirname, '..', 'server', 'bot', 'memory.ts'), 'utf8');
const indexSource = fs.readFileSync(path.join(import.meta.dirname, '..', 'server', 'index.ts'), 'utf8');
check(memorySource.includes("from './profileCircuit.js'"), 'memory.ts 引入了状态机模块');
check(memorySource.includes('profileLlmCircuit = tripProfileCircuit('), 'memory.ts 的失败路径写入状态机');
check(memorySource.includes('profileLlmCircuit = clearProfileCircuit()'), 'memory.ts 的成功路径清零');
check(!memorySource.includes('PROFILE_LLM_CIRCUIT_MS'), '旧的固定熔断常数已移除');
check(memorySource.includes('options.bypassCircuit === true'), 'memory.ts 认 bypassCircuit 开关');
const bypassSites = indexSource.split('bypassCircuit: true').length - 1;
check(bypassSites === 1, '只有单人重算入口绕过熔断', `实际 ${bypassSites} 处`);

// 集成：走真实队列跑一次。纯函数对了、接线也对了，不代表串起来还对 ——
// 这里让供应商固定回 503，确认熔断真的挡住了下一个用户，且单人手动重算能绕过。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-profile-circuit-'));
process.env.DATA_DIR = tmpDir;
const unavailable = http.createServer((req, res) => {
  req.resume();
  res.writeHead(503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Service Unavailable' } }));
});
await new Promise((resolve) => unavailable.listen(0, '127.0.0.1', resolve));
try {
  const { ensureStore, readDb, updateDb } = await import('../server/store.ts');
  const { maybeUpdateMemoryProfile } = await import('../server/bot/memory.ts');
  ensureStore();
  const sample = (userId, index) => ({
    content: `${userId} 的有效画像样本 ${index}`,
    type: 'text', usedForProfile: true, riskLevel: 'normal', reason: '真实文本',
    context: { groupId: 'g1', messageId: `${userId}-${index}`, nearby: [], atTargets: [] },
    createdAt: new Date(Date.now() - index * 86400000).toISOString(),
  });
  const memory = (userId) => ({
    id: userId, userId, nickname: `用户${userId}`, enabled: true,
    importanceLevel: 2, messageCount: 6, profileMessageCount: 6, pendingCount: 6,
    groupsSeen: ['g1'], samples: Array.from({ length: 6 }, (_, index) => sample(userId, index)),
    summary: '', traits: '', speechStyle: '', behavior: '', preferences: '',
    manualNotes: '', profilingRule: '', profileMeta: {}, recentDynamics: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  updateDb((db) => {
    db.settings.memoryEnabled = true;
    db.settings.ownerQq = 'owner';
    db.settings.selfQq = 'bot';
    db.settings.llmProvider = 'openai-compatible';
    db.settings.apiBaseUrl = `http://127.0.0.1:${unavailable.address().port}/v1`;
    db.settings.apiKey = 'circuit-test-key';
    db.settings.model = 'circuit-test-model';
    db.memories = [memory('c1'), memory('c2')];
    db.messages = [];
    db.profileLogs = [];
    db.decisions = [];
    db.usageEvents = [];
  });
  const event = (userId) => ({
    type: 'group', groupId: 'g1', userId, nickname: `用户${userId}`,
    messageId: `circuit-${userId}`, text: '触发画像', atTargets: [],
  });

  const firstFailure = await maybeUpdateMemoryProfile(event('c1'), { kind: 'circuit-test' });
  check(firstFailure.ok === false, '供应商不可用时画像任务失败');

  const blocked = await maybeUpdateMemoryProfile(event('c2'), { kind: 'circuit-test' });
  check(blocked.skipped === true && String(blocked.reason || '').includes('熔断'), '熔断期间下一个用户被直接跳过', String(blocked.reason || ''));

  const bypassed = await maybeUpdateMemoryProfile(event('c2'), { force: true, bypassCircuit: true, kind: 'circuit-test' });
  check(!String(bypassed.reason || '').includes('熔断'), '单人手动重算绕过熔断真正发起了调用', String(bypassed.reason || ''));

  const logs = readDb().profileLogs || [];
  check(logs.some((log) => log.event === 'profile.circuit_skipped'), '跳过写进了画像日志');
  check(logs.some((log) => log.event === 'profile.circuit_bypassed'), '绕过写进了画像日志');
  const skipped = logs.find((log) => log.event === 'profile.circuit_skipped');
  check(Number(skipped?.meta?.failures) === 1, '跳过日志带上了连续失败次数', JSON.stringify(skipped?.meta || {}));
} finally {
  await new Promise((resolve) => unavailable.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('');
if (failed) {
  console.log(`失败 ${failed} 项`);
  process.exit(1);
}
console.log('全部通过：退避阶梯 ' + BACKOFF_CASES.length + ' 条 + 状态机与接线');
