import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createTestDataDir, cleanupTestDir } from './test-isolation.mjs';

const dataDir = createTestDataDir('wuxin-health-runtime');
const { fetchBoundedBody } = await import('../server/httpBody.ts');
const { CodexAppServerClient } = await import('../server/codexAppServer.ts');
const { recentVisionImageMessages } = await import('../server/bot/gate.ts');
const queue = await import('../server/bot/queue.ts');
const store = await import('../server/store.ts');
const { sendOptionalNotice } = await import('../server/bot/notice.ts');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

try {
  let unhandled = false;
  const onUnhandled = () => { unhandled = true; };
  process.on('unhandledRejection', onUnhandled);
  await new Promise(resolve => setTimeout(() => {
    void sendOptionalNotice(async () => { throw new Error('notification delivery failed'); });
    setImmediate(resolve);
  }, 0));
  process.off('unhandledRejection', onUnhandled);
  assert.equal(unhandled, false);
  console.log('PASS real optional notice: timer rejection stays local');
  const children = [];
  const fakeSpawn = () => {
    const child = new EventEmitter();
    Object.assign(child, { killed: false, exitCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    child.kill = () => { child.killed = true; };
    child.requests = [];
    child.stdin.on('data', bytes => {
      const rpc = JSON.parse(String(bytes));
      child.requests.push(rpc);
      if (rpc.method !== 'initialize' && rpc.id) child.stdout.write(JSON.stringify({ id: rpc.id, result: { ok: true } }) + '\n');
    });
    child.handshake = () => {
      const rpc = child.requests.find(r => r.method === 'initialize');
      assert.ok(rpc);
      child.stdout.write(JSON.stringify({ id: rpc.id, result: {} }) + '\n');
    };
    children.push(child);
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const client = new CodexAppServerClient(fakeSpawn);
  const first = client.request('account/read');
  const second = client.request('model/list');
  await new Promise(r => setImmediate(r));
  assert.equal(children.length, 1);
  assert.deepEqual(children[0].requests.map(r => r.method), ['initialize']);
  children[0].handshake();
  await Promise.all([first, second]);
  assert.equal(children[0].requests[1].method, 'initialized');
  client.shutdown();
  const next = client.request('account/read');
  await new Promise(r => setImmediate(r));
  children[0].emit('exit', 1, null);
  children[1].handshake();
  await next;
  let failedTurn = false;
  const off = client.onFailure(() => { failedTurn = true; });
  children[1].emit('exit', 1, null);
  assert.equal(failedTurn, true);
  off(); client.shutdown();
  console.log('PASS real Codex client: handshake barrier, old-process isolation, exit notification');

  const state = queue.getQueueState('fixture');
  state.locked = true;
  const hold = deferred();
  const event = id => ({ event: { type: 'private', userId: 'u', groupId: 'private', text: id, messageId: id }, decision: { shouldReply: true } });
  state.queue.push(event('A'));
  let active = 0, maxActive = 0, calls = 0;
  const worker = async () => {
    calls++; active++; maxActive = Math.max(maxActive, active);
    if (calls === 1) await hold.promise;
    active--;
    if (calls === 2) throw new Error('replay failure');
  };
  const draining = queue.drainReplyQueue('fixture', worker);
  await queue.drainReplyQueue('fixture', worker);
  assert.equal(queue.getQueueState('fixture'), state);
  assert.equal(state.locked, true);
  state.queue.push(event('B'));
  hold.resolve(); await draining;
  assert.equal(calls, 2); assert.equal(maxActive, 1);
  assert.equal(queue.getReplyQueueStats().fixture, undefined);
  const early = queue.getQueueState('early'); early.locked = true; early.queue.push(event('C'));
  await queue.drainReplyQueue('early', async () => ({ replied: false }));
  assert.equal(queue.getReplyQueueStats().early, undefined);
  console.log('PASS real queue: overlapping drains, replay failure and early return release ownership');

  const img = (userId, inContext) => ({ id: userId, type: 'private', groupId: 'private', userId, inContext, createdAt: new Date().toISOString(), media: { images: [{ url: 'https://example.invalid/image' }] } });
  const messages = [img('other', true), img('owner', false)];
  assert.deepEqual(recentVisionImageMessages({ messages }, { type: 'private', groupId: 'private', userId: 'owner' }), []);
  messages.push(img('owner', true));
  assert.equal(recentVisionImageMessages({ messages }, { type: 'private', groupId: 'private', userId: 'owner' }).length, 1);
  console.log('PASS real image selector: private isolation and context exclusions');

  const timers = [];
  const server = http.createServer((req, res) => {
    res.writeHead(200); res.flushHeaders();
    if (req.url === '/large') res.end('x'.repeat(4096));
    else timers.push(setTimeout(() => res.end('late'), 500));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const start = Date.now();
    await assert.rejects(fetchBoundedBody(base + '/slow', {}, 100, 1024));
    assert.ok(Date.now() - start < 450);
    await assert.rejects(fetchBoundedBody(base + '/large', {}, 1000, 1024), /byte limit/);
  } finally { timers.forEach(clearTimeout); server.closeAllConnections(); await new Promise(r => server.close(r)); }
  console.log('PASS real HTTP reader: slow body deadline and streaming byte cap');

  store.ensureStore();
  const previous = store.readDb().settings.model;
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('injected ENOSPC'); };
  try { assert.throws(() => store.updateDb(db => { db.settings.model = 'uncommitted'; }), /ENOSPC/); }
  finally { fs.renameSync = rename; }
  assert.equal(store.readDb().settings.model, previous);
  console.log('PASS real store: persistence failure invalidates mutated cache');
} finally {
  cleanupTestDir(dataDir);
}
