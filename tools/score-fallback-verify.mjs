import assert from 'node:assert/strict';
import { pickFallbackScore } from '../server/bots/scoreFallback.ts';

const scores = [
  { id: 1, rank: 'F', passed: false },
  { id: 2, rank: 'F', passed: false },
  { id: 3, rank: 'S', passed: true },
  { id: 4, rank: 'A', passed: true },
];
assert.equal(pickFallbackScore('recent_play', scores).id, 1, '最近游玩就是最新一条，哪怕是失败');
assert.equal(pickFallbackScore('recent_pass', scores).id, 3, '最近通过必须跳过失败记录');
assert.equal(pickFallbackScore('recent_pass', [{ id: 9, rank: 'F' }]), null, '全失败时不能硬画');
assert.equal(pickFallbackScore('recent_play', []), null, '空列表返回 null');
console.log('score fallback: pass filter PASS');
