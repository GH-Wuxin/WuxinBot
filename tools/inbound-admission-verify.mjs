import assert from 'node:assert/strict';
import {
  getInboundAdmissionStats,
  runInboundTask,
  waitForInboundTasks,
} from '../server/bot/inboundGate.ts';

const before = getInboundAdmissionStats();
const blockers = [];
let release;
const gate = new Promise((resolve) => { release = resolve; });

for (let i = 0; i < before.maxActive; i += 1) {
  blockers.push(runInboundTask(`fixture.${i}`, async () => {
    await gate;
    return i;
  }));
}

await new Promise((resolve) => setImmediate(resolve));
const saturated = getInboundAdmissionStats();
assert.equal(saturated.active, before.maxActive);
assert.equal(saturated.waiting, 0);

const queued = runInboundTask('fixture.queued', async () => 'queued');
await new Promise((resolve) => setImmediate(resolve));
assert.equal(getInboundAdmissionStats().waiting, 1);

release();
assert.deepEqual(await Promise.all(blockers), [0, 1, 2, 3, 4, 5]);
assert.equal(await queued, 'queued');
const drain = await waitForInboundTasks(500);
assert.deepEqual(drain, { drained: true, active: 0 });
assert.equal(getInboundAdmissionStats().waiting, 0);
console.log('PASS inbound admission boundary: active cap, bounded waiting and drain');
