import assert from 'node:assert/strict';
import { getBackgroundTaskStats, runBackgroundTask, waitForBackgroundTasks } from '../server/backgroundTasks.ts';

const before = getBackgroundTaskStats();
const completed = await runBackgroundTask('fixture.success', async () => 'ok');
assert.equal(completed, 'ok');

const failed = await runBackgroundTask('fixture.failure', async () => {
  throw new Error('fixture background failure');
});
assert.equal(failed, undefined);

const after = getBackgroundTaskStats();
assert.equal(after.active, 0);
assert.equal(after.started, before.started + 2);
assert.equal(after.completed, before.completed + 1);
assert.equal(after.failed, before.failed + 1);
assert.equal(after.lastFailureLabel, 'fixture.failure');
assert.match(after.lastFailure, /fixture background failure/);

const slow = runBackgroundTask('fixture.drain', () => new Promise((resolve) => setTimeout(resolve, 30)));
const drain = await waitForBackgroundTasks(500);
assert.equal(drain.drained, true);
assert.equal(drain.active, 0);
await slow;
console.log('PASS background task boundary: completion, failure accounting and rejection containment');
