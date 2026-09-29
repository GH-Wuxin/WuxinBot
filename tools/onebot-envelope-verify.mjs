import assert from 'node:assert/strict';
import test from 'node:test';

const { parseOneBotEcho } = await import('../server/onebot.ts');

test('OneBot echo validation rejects coerced and contradictory envelopes', () => {
  assert.equal(parseOneBotEcho({ status: 'ok', retcode: false }).outcome, 'unknown');
  assert.equal(parseOneBotEcho({ status: 'ok', retcode: '' }).outcome, 'unknown');
  assert.equal(parseOneBotEcho({ status: 'ok', retcode: [] }).outcome, 'unknown');
  assert.equal(parseOneBotEcho({ status: 'ok', retcode: 1 }).outcome, 'unknown');
  assert.equal(parseOneBotEcho({ status: 'async', retcode: 0 }).outcome, 'unknown');
  assert.equal(parseOneBotEcho({ status: 'failed', retcode: 0 }).outcome, 'unknown');
});
