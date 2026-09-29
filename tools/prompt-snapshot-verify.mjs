import assert from 'node:assert/strict';
import test from 'node:test';

const studio = await import('../server/promptStudio.ts?prompt-snapshot-verify');

function snapshot(id, messages) {
  studio.beginPromptCall({ id, messages });
  return studio.listPromptCalls(32).find((call) => call.id === id);
}

test('prompt snapshot tail budget zero is an actual empty tail', () => {
  studio.clearPromptCallsForTest();
  const leading = Array.from({ length: 32 }, (_, index) => ({ role: 'system', content: `head-${index}` }));
  const input = [...leading, { role: 'user', content: 'tail' }];
  const captured = snapshot('tail-zero', input);
  assert.equal(captured.retainedMessageCount, 32);
  assert.equal(captured.droppedMessageCount, 1);
  assert.equal(captured.truncated, true);
  assert.equal(captured.messages.at(-1).content, 'head-31');
  assert.equal(input.length, 33, 'snapshot must not mutate original messages');
});

test('prompt snapshot count accounting stays honest around the 32-message cap', () => {
  studio.clearPromptCallsForTest();
  for (const [headCount, tailCount] of [[31, 1], [32, 1], [32, 100], [33, 1]]) {
    const messages = [
      ...Array.from({ length: headCount }, (_, index) => ({ role: 'system', content: `head-${index}` })),
      ...Array.from({ length: tailCount }, (_, index) => ({ role: 'user', content: `tail-${index}` })),
    ];
    const captured = snapshot(`count-${headCount}-${tailCount}`, messages);
    assert.ok(captured.retainedMessageCount <= 32);
    assert.equal(
      captured.originalMessageCount,
      captured.retainedMessageCount + captured.droppedMessageCount,
    );
    if (captured.droppedMessageCount > 0) assert.equal(captured.truncated, true);
  }
});
