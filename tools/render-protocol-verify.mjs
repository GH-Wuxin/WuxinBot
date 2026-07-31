import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { RenderServer } from '../server/bots/renderServer.ts';
import { getHealth } from '../server/health.ts';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('condition timed out');
}

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
const server = new RenderServer(0);
server.start();
await once(server, 'ready');

const port = server.getListeningPort();
assert.ok(Number.isInteger(port) && port > 0, 'temporary render server must expose its bound port');

const client = new WebSocket(`ws://127.0.0.1:${port}`);
await once(client, 'open');
assert.equal(server.hasClients(), false, 'an unauthenticated socket must not count as a renderer');

client.send(JSON.stringify({ type: 'AUTH', pid: 424242 }));
await waitUntil(() => server.hasClients());
client.send(JSON.stringify({ type: 'HEARTBEAT', pid: 424242, timestamp: Date.now() }));

// Binary response: yumu-image prefixes the image with the canonical 36-byte UUID.
const firstMessage = once(client, 'message');
let firstSettled = false;
const firstRender = server.renderPanel('panel_Gamma', { panel: 'info', user: { id: 1 } })
  .finally(() => { firstSettled = true; });
const [firstRaw, firstIsBinary] = await firstMessage;
assert.equal(firstIsBinary, false);
const firstTask = JSON.parse(firstRaw.toString());
assert.match(firstTask.messageId, /^[0-9a-f-]{36}$/i);
assert.equal(Buffer.byteLength(firstTask.messageId), 36, 'messageId must match RenderWebsocket.kt binary header');
assert.equal(firstTask.path, 'panel_Gamma');

// A former 32-character, hyphenless header must not accidentally resolve the task.
client.send(Buffer.concat([
  Buffer.from(firstTask.messageId.replaceAll('-', ''), 'utf8'),
  jpeg
]));
await delay(40);
assert.equal(firstSettled, false, '32-byte IDs must not be accepted as 36-byte protocol headers');

client.send(Buffer.concat([Buffer.from(firstTask.messageId, 'utf8'), jpeg]));
assert.deepEqual(await firstRender, jpeg);

// Text error response: renderer failures must reject the matching pending task.
const errorMessage = once(client, 'message');
const failedRender = server.renderPanel('panel_missing', { value: 1 });
const [errorRaw] = await errorMessage;
const errorTask = JSON.parse(errorRaw.toString());
client.send(JSON.stringify({
  messageId: errorTask.messageId,
  status: 'error',
  error: '找不到对应的面板路由'
}));
await assert.rejects(failedRender, /找不到对应的面板路由/);

// Outbound task JSON is limited before it enters the pending map.
await assert.rejects(
  server.renderPanel('panel_Gamma', { huge: 'x'.repeat(4 * 1024 * 1024 + 1) }),
  /超过 4096 KiB/
);
assert.equal(server.pending.size, 0, 'completed and rejected tasks must leave no pending entries');
assert(
  getHealth().osu.renderFailures >= 2,
  'render failures must be counted for health observability',
);

// A disconnect must promptly reject work assigned to that renderer.
const disconnectMessage = once(client, 'message');
const disconnectedOutcome = server.renderPanel('panel_Gamma', { panel: 'score' }).then(
  (value) => ({ value, error: null }),
  (error) => ({ value: null, error })
);
await disconnectMessage;
assert.equal(server.pending.size, 1, 'exactly the disconnect test task should be pending');
client.terminate();
const outcome = await disconnectedOutcome;
assert.match(String(outcome.error?.message || ''), /断开|错误/);
await waitUntil(() => !server.hasClients());

await server.stop();
console.log('render protocol verify passed');
