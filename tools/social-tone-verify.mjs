import assert from 'node:assert/strict';
import { socialTonePrompt, socialExpressionPrompt } from '../server/bot/social/prompts.ts';

function dbFor(score, extra = {}) {
  return {
    settings: { socialV2Enabled: true, ownerQq: '90001', selfQq: '90002', ...extra },
    socialV2: {
      people: {
        '10001': {
          userId: '10001',
          familiarity: 60,
          revision: 1,
          updatedAt: new Date().toISOString(),
          affinity: { kind: 'ordinary', score },
        },
      },
      views: {},
    },
  };
}
const event = { type: 'group', groupId: '20001', userId: '10001' };

const high = socialTonePrompt(dbFor(90), event);
assert.ok(high.includes('更放松'), 'high affinity should relax the distance');
assert.ok(high.includes('更熟悉'), 'high affinity should feel familiar');
assert.ok(high.includes('当前发生的事情决定'), 'the event decides the emotional response');
assert.ok(high.includes('不要求每次表达想念、陪伴或期待'), 'high affinity must not require intimacy every time');
assert.ok(!high.includes('我陪你呀'), 'fixed intimate line must be gone');
assert.ok(!high.includes('明天还等你来'), 'fixed intimate line must be gone');
assert.ok(!high.includes('一小句'), 'no fixed sentence-count wording');

const low = socialTonePrompt(dbFor(10), event);
assert.ok(low.includes('礼貌'), 'low affinity stays polite');
assert.ok(low.includes('不表现嫌弃'), 'low affinity is not cold or disgusted');
assert.ok(!low.includes('我陪你呀'));

const middle = socialTonePrompt(dbFor(50), event);
assert.ok(middle.includes('自然友好'));
assert.ok(middle.includes('不刻意贴近'));
assert.ok(!middle.includes('不要求每次表达想念'), 'middle branch need not repeat high-affinity wording');

const owner = socialTonePrompt({ ...dbFor(10), settings: { socialV2Enabled: true, ownerQq: '10001', selfQq: '90002' } }, event);
assert.ok(owner.includes('更亲近') || owner.includes('相处较亲近'), 'Owner always gets the special/close tone');
assert.ok(!owner.includes('我陪你呀'));

assert.equal(socialTonePrompt({ settings: { socialV2Enabled: false }, socialV2: { people: {}, views: {} } }, event), '',
  'V2 disabled must produce no tone block');

const expression = socialExpressionPrompt(dbFor(90), event);
assert.ok(expression.includes('100 附近更放松'), 'affinity projection should not demand a fixed intimate performance');
assert.ok(expression.includes('当前事情决定这次是否表达开心、担心或期待'));
assert.ok(!expression.includes('表达期待。'), 'old fixed expectation wording should be gone');

console.log('social tone: affinity changes distance, current event decides emotion, fixed intimate lines removed, V2-off empty PASS');
