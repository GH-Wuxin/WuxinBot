// Manual smoke for the local bot bridge (not part of verify-all; needs live bots).
// Usage: tsx tools/local-bridge-smoke.mjs
import { callLocalBot } from '../server/bots/localBridge.ts';

const ctx = { groupId: '900000007', userId: '1000000001', nickname: 'Owner' };

const cases = [
  ['yumu', '!r', 60_000],
  ['yumu', '!bs 1-5', 60_000],
  ['hydrant', '~', 60_000],
  ['hydrant', '++', 60_000],
  ['lazybot', '/help', 20_000],
  ['kanon', '!ping', 30_000],
];

for (const [botId, command, timeout] of cases) {
  try {
    const reply = await callLocalBot(botId, command, ctx, timeout);
    console.log(`\n[${botId}] ${command} → frames=${reply.frames} images=${reply.images.length}`);
    if (reply.text) console.log('  text:', reply.text.split('\n').slice(0, 8).join('\n  '));
    if (reply.images[0]) console.log('  image0:', reply.images[0].slice(0, 120));
  } catch (error) {
    console.log(`\n[${botId}] ${command} → ERROR ${String(error?.message || error)}`);
  }
}
