// queue-merge-images-verify.mjs
// B3 regression: merging a burst of queued replies must preserve images from
// EVERY message, not just the last one. The old merge spread `last.event`,
// so an image attached to an earlier message was silently dropped.
//
// Fully OFFLINE: uses the public getQueueState()/drainReplyQueue() API with a
// recording processIncoming; no LLM or renderer is involved.

import {
  createTestDataDir,
  assertNotProduction,
  productionDbSnapshot,
  verifyProductionDbUnchanged,
} from './test-isolation.mjs';

const testDataDir = createTestDataDir('wuxin-queue-merge');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);
const prodBefore = productionDbSnapshot();

const { getQueueState, drainReplyQueue } = await import('../server/bot/queue.js');

let passed = 0;
let failed = 0;
const pass = (label) => { console.log(`PASS [${label}]`); passed++; };
const fail = (label, msg) => { console.error(`FAIL [${label}]: ${msg}`); failed++; };
const assert = (cond, label, msg) => (cond ? pass(label) : fail(label, msg));

function item(messageId, text, images = []) {
  return {
    event: {
      source: 'merge-test',
      type: 'group',
      messageId,
      groupId: 'g1',
      userId: 'u1',
      text,
      images,
    },
    sendMessage: () => {},
    decision: {},
  };
}

async function drainOnce(items) {
  const key = `group:g1:u1:${Math.random().toString(16).slice(2)}`;
  const state = getQueueState(key);
  state.queue.push(...items);
  const captured = [];
  await drainReplyQueue(key, async (event, sendMessage, decision) => {
    captured.push({ event, sendMessage, decision });
  });
  return captured;
}

// Scenario 1: images on BOTH messages — all must survive.
let captured = await drainOnce([
  item('m1', '第一张图', ['file:///tmp/a.png']),
  item('m2', '第二张图', ['file:///tmp/b.png']),
]);
assert(captured.length === 1, 's1-single-merged-reply', `expected 1 reply, got ${captured.length}`);
assert(
  captured[0].event.images?.length === 2
    && captured[0].event.images[0] === 'file:///tmp/a.png'
    && captured[0].event.images[1] === 'file:///tmp/b.png',
  's1-both-images-kept',
  `merged images = ${JSON.stringify(captured[0].event.images)}`,
);
assert(
  String(captured[0].event.text).includes('第一张图')
    && String(captured[0].event.text).includes('第二张图'),
  's1-text-merged',
  'merged text lost one of the messages',
);

// Scenario 2: image on the FIRST message only — the old code spread
// `last.event`, which had no images, so the image was dropped entirely.
captured = await drainOnce([
  item('m3', '看图', ['file:///tmp/a.png']),
  item('m4', '这是第二句', []),
]);
assert(captured.length === 1, 's2-single-merged-reply', `expected 1 reply, got ${captured.length}`);
assert(
  captured[0].event.images?.length === 1
    && captured[0].event.images[0] === 'file:///tmp/a.png',
  's2-first-image-kept',
  `merged images = ${JSON.stringify(captured[0].event.images)}`,
);

// Scenario 3: single image-only message — unchanged behavior, locked in.
captured = await drainOnce([
  item('m5', '', ['file:///tmp/c.png']),
]);
assert(captured.length === 1, 's3-single-reply', `expected 1 reply, got ${captured.length}`);
assert(
  captured[0].event.images?.length === 1
    && captured[0].event.images[0] === 'file:///tmp/c.png',
  's3-single-image-kept',
  `merged images = ${JSON.stringify(captured[0].event.images)}`,
);

verifyProductionDbUnchanged(prodBefore);

console.log(`\nqueue-merge-images-verify: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
