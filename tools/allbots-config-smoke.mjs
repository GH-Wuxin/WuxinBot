// Smoke: all four original bots honor group-bot-config.json (false -> silent).
import { callLocalBot } from '../server/bots/localBridge.ts';

const API = 'http://127.0.0.1:8787/api/group-bot-config';
const ctx = { groupId: '770001', userId: 'REDACTED_QQ_001', nickname: 'Owner' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CASES = [
  ['yumu', '!r'],
  ['kanon', '!ping'],
  ['hydrant', '~'],
  ['lazybot', '/help'],
];

async function setBot(botId, enabled) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupId: '770001', botId, enabled }),
  });
  return res.status;
}

async function probe(label, botId, command) {
  try {
    const reply = await callLocalBot(botId, command, ctx, 15_000);
    console.log(`${label} ${botId} -> REPLY frames=${reply.frames} images=${reply.images.length} text=${String(reply.text || '').slice(0, 40)}`);
  } catch (error) {
    console.log(`${label} ${botId} -> SILENT / ${String(error?.message || error)}`);
  }
}

for (const [botId, command] of CASES) await probe('enabled ', botId, command);
for (const [botId] of CASES) await setBot(botId, false);
await sleep(7000);
for (const [botId, command] of CASES) await probe('disabled', botId, command);
for (const [botId] of CASES) await setBot(botId, true);
await sleep(7000);
for (const [botId, command] of CASES) await probe('enabled2', botId, command);
