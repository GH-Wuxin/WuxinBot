// Smoke: yumu honors the shared group-bot-config.json (yumu=false -> silent).
import { callLocalBot } from '../server/bots/localBridge.ts';

const API = 'http://127.0.0.1:8787/api/group-bot-config';
const ctx = { groupId: '770001', userId: 'REDACTED_QQ_001', nickname: 'Owner' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setYumu(enabled) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupId: '770001', botId: 'yumu', enabled }),
  });
  console.log(`set 770001 yumu=${enabled} -> HTTP ${res.status}`);
}

async function probe(label) {
  try {
    const reply = await callLocalBot('yumu', '!r', ctx, 25_000);
    console.log(`${label} -> REPLY frames=${reply.frames} images=${reply.images.length}`);
  } catch (error) {
    console.log(`${label} -> SILENT / ${String(error?.message || error)}`);
  }
}

await probe('enabled-before');
await setYumu(false);
await sleep(7000);
await probe('disabled');
await setYumu(true);
await sleep(7000);
await probe('enabled-after');
