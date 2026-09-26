// onebot-lifecycle-verify.mjs — OneBot WebSocket connection lifecycle checks.
//
// Exercises the real server/onebot.ts module against local WS servers:
// - missing / invalid WS URLs never throw and never leave stale state
// - replacing a still-CONNECTING socket cannot crash the process
// - close resets stale account/API/heartbeat evidence
// - error+close produce exactly one reconnect with fast exponential backoff
// - shutdown clears the pending reconnect timer
//
// Isolation is identical to the other *-verify tools: DATA_DIR points at a
// temporary directory and production DB writes are forbidden.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-onebot-lifecycle-'));
process.env.DATA_DIR = testDataDir;

let failed = 0;
let passed = 0;

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`PASS: ${message}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

let uncaught = '';
process.on('uncaughtException', (error) => {
  uncaught = String(error?.message || error);
  console.error(`UNCAUGHT: ${uncaught}`);
});

const { ensureStore, updateDb } = await import('../server/store.ts');
const { connectOneBot, getOneBotStatus, probeGetStatus, shutdownOneBot } = await import('../server/onebot.ts');

ensureStore();

async function main() {
  updateDb((db) => {
    db.settings.oneBotWsUrl = '';
    db.settings.oneBotHttpUrl = 'http://127.0.0.1:9';
    db.settings.oneBotAccessToken = '';
  });

  console.log('=== missing WS URL ===');
  connectOneBot();
  {
    const s = getOneBotStatus();
    assertEqual(s.transportConnected, false, 'missing URL -> transport disconnected');
    assertEqual(s.connected, false, 'missing URL -> compat disconnected');
    assert(String(s.lastError || '').includes('没有填写 OneBot WebSocket 地址'), 'missing URL records an explicit error');
  }

  console.log('\n=== invalid / non-WS URL does not throw ===');
  for (const url of ['http://127.0.0.1:9', 'not a websocket url']) {
    updateDb((db) => { db.settings.oneBotWsUrl = url; });
    let threw = false;
    try { connectOneBot(); } catch { threw = true; }
    assert(!threw, `connectOneBot must not throw for invalid URL (${url})`);
    const s = getOneBotStatus();
    assertEqual(s.transportConnected, false, `invalid URL leaves transport disconnected (${url})`);
  }
  updateDb((db) => { db.settings.oneBotWsUrl = ''; });

  console.log('\n=== get_status probe sends the configured token ===');
  {
    const seenAuthorization = [];
    const statusServer = http.createServer((req, res) => {
      seenAuthorization.push(String(req.headers.authorization || ''));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { online: true, good: true } }));
    });
    await new Promise((resolve) => statusServer.listen(0, '127.0.0.1', resolve));
    updateDb((db) => {
      db.settings.oneBotHttpUrl = `http://127.0.0.1:${statusServer.address().port}`;
      db.settings.oneBotAccessToken = 'lifecycle-test-token';
    });
    await probeGetStatus();
    assert(
      seenAuthorization.some((header) => header === 'Bearer lifecycle-test-token'),
      `get_status probe carries the access token (got ${JSON.stringify(seenAuthorization)})`,
    );
    assertEqual(getOneBotStatus().apiReachable, true, 'authenticated get_status marks the API reachable');
    await new Promise((resolve) => statusServer.close(resolve));
    updateDb((db) => { db.settings.oneBotAccessToken = ''; });
  }

  console.log('\n=== error+close schedules exactly one reconnect ===');
  {
    const httpServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('not a websocket');
    });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = httpServer.address().port;
    updateDb((db) => { db.settings.oneBotWsUrl = `ws://127.0.0.1:${port}`; });

    connectOneBot();
    await sleep(200); // let the handshake fail with 'error' then 'close'
    await new Promise((resolve) => {
      httpServer.closeAllConnections?.();
      httpServer.close(resolve);
    });

    const connections = [];
    const wss = new WebSocketServer({ port, host: '127.0.0.1' });
    wss.on('connection', (client) => { connections.push(client); });
    await new Promise((resolve) => wss.once('listening', resolve));

    await waitFor(() => getOneBotStatus().transportConnected, 3000, 'reconnect after error+close');
    await sleep(50);
    assertEqual(getOneBotStatus().reconnectCount, 1, 'error+close schedules exactly one reconnect');
    assertEqual(connections.length, 1, 'only one connection reached the server');
    await sleep(3000); // a duplicate second timer would reconnect again here
    assertEqual(getOneBotStatus().reconnectCount, 1, 'no duplicate reconnect follows error+close');
    assertEqual(connections.length, 1, 'no duplicate server connection follows error+close');

    shutdownOneBot();
    await new Promise((resolve) => wss.close(resolve));
  }

  console.log('\n=== accept-then-close keeps backing off ===');
  {
    shutdownOneBot(); // reset the backoff counter for a fresh lifecycle
    const opens = [];
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', (client) => {
      opens.push(Date.now());
      setTimeout(() => client.close(1000, 'accept-close'), 20);
    });
    await new Promise((resolve) => wss.once('listening', resolve));
    updateDb((db) => { db.settings.oneBotWsUrl = `ws://127.0.0.1:${wss.address().port}`; });

    connectOneBot();
    await waitFor(() => opens.length >= 3, 9000, 'three accept-close connection attempts');
    const firstGap = opens[1] - opens[0];
    const secondGap = opens[2] - opens[1];
    assert(
      secondGap > firstGap + 200,
      `accept-close backoff must grow (gaps ${firstGap}ms -> ${secondGap}ms)`,
    );

    shutdownOneBot();
    await new Promise((resolve) => wss.close(resolve));
  }

  console.log('\n=== close resets stale evidence, reconnect once with backoff ===');
  {
    const connections = [];
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', (client) => {
      connections.push(client);
    });
    await new Promise((resolve) => wss.once('listening', resolve));
    const wsPort = wss.address().port;
    updateDb((db) => { db.settings.oneBotWsUrl = `ws://127.0.0.1:${wsPort}`; });

    connectOneBot();
    await waitFor(() => getOneBotStatus().transportConnected, 3000, 'first WS open');
    const firstClient = connections[0];
    firstClient.send(JSON.stringify({
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      status: { online: true, good: true },
    }));
    await waitFor(() => getOneBotStatus().accountOnline === true, 3000, 'heartbeat online observed');

    const countBeforeClose = getOneBotStatus().reconnectCount;
    const apiBeforeClose = getOneBotStatus().apiReachable;
    const closedAt = Date.now();
    firstClient.close(1000, 'test close');
    await waitFor(() => !getOneBotStatus().transportConnected, 2000, 'transport marked closed');
    {
      const s = getOneBotStatus();
      assertEqual(s.accountOnline, null, 'close resets stale accountOnline');
      assertEqual(s.apiReachable, apiBeforeClose, 'close preserves independent get_status evidence');
      assertEqual(s.heartbeatGood, null, 'close resets stale heartbeatGood');
      assertEqual(s.heartbeatFresh, false, 'close clears heartbeat freshness');
    }

    await waitFor(() => getOneBotStatus().transportConnected, 3000, 'automatic reconnect open');
    const reconnectDelay = Date.now() - closedAt;
    assert(reconnectDelay < 1800, `first automatic reconnect uses the 1s base backoff (<1.8s, got ${reconnectDelay}ms)`);
    await sleep(50);
    assertEqual(
      getOneBotStatus().reconnectCount,
      countBeforeClose + 1,
      'one close event produces exactly one reconnect',
    );
    assert(connections.length >= 2, 'server observed the reconnected socket');

    // Second close: prove shutdown cancels the pending reconnect timer.
    const secondClient = connections[connections.length - 1];
    const countBeforeShutdown = getOneBotStatus().reconnectCount;
    secondClient.close(1000, 'shutdown test');
    await waitFor(() => !getOneBotStatus().transportConnected, 2000, 'second close observed');
    await sleep(50); // let the close handler schedule its reconnect timer
    shutdownOneBot();
    const connectionCountAtShutdown = connections.length;
    await sleep(2600); // second backoff step (2s + jitter) would reconnect by now
    assertEqual(getOneBotStatus().reconnectCount, countBeforeShutdown, 'shutdown cancels pending reconnect timer');
    assertEqual(connections.length, connectionCountAtShutdown, 'shutdown prevents another server connection attempt');
    assertEqual(getOneBotStatus().transportConnected, false, 'shutdown leaves transport disconnected');

    await new Promise((resolve) => wss.close(resolve));
  }

  console.log('\n=== replacing a CONNECTING socket cannot crash ===');
  {
    const httpServer = http.createServer((_req, res) => {
      // Never upgrade: both WS clients stay CONNECTING until replaced/closed.
      setTimeout(() => { res.writeHead(200); res.end('not a websocket'); }, 200);
    });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const httpPort = httpServer.address().port;
    updateDb((db) => { db.settings.oneBotWsUrl = `ws://127.0.0.1:${httpPort}`; });

    connectOneBot();
    await sleep(30); // first socket is CONNECTING
    connectOneBot(); // replace the CONNECTING socket (old code crashed here)
    await sleep(350); // let both sockets fail and close
    shutdownOneBot();

    assert(uncaught === '', `replacing a CONNECTING socket must not crash (got: ${uncaught || 'no crash'})`);
    assertEqual(getOneBotStatus().transportConnected, false, 'replaced CONNECTING socket is not reported connected');
    await new Promise((resolve) => httpServer.close(resolve));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
}).finally(() => {
  try { shutdownOneBot(); } catch { /* already stopped */ }
  fs.rmSync(testDataDir, { recursive: true, force: true });
});
