// match-restore-transient-verify.mjs
// B8 regression: MatchManager.restore() must not delete a persisted listener
// when the osu! API fails transiently (timeout / 5xx / network error).
// Only a definitive 404 (match no longer exists) or an ended match may
// remove the persisted entry.
//
// Fully OFFLINE: a controlled local mock decides the per-match HTTP status,
// so the old code deterministically FAILS by deleting the transient-failure
// entry, and the fixed code keeps it.

import http from 'node:http';
import {
  createTestDataDir,
  assertNotProduction,
  productionDbSnapshot,
  verifyProductionDbUnchanged,
} from './test-isolation.mjs';

const testDataDir = createTestDataDir('wuxin-match-restore');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);
const prodBefore = productionDbSnapshot();

const T = '2026-08-08T10:00:00Z';
const MATCH_TRANSIENT = 500001;
const MATCH_GONE = 500002;
const MATCH_ENDED = 500003;

// Per-match HTTP behavior for the mock osu! API.
const statusByMatch = new Map();
statusByMatch.set(MATCH_TRANSIENT, { status: 500, body: { error: 'mock server error' } });
statusByMatch.set(MATCH_GONE, { status: 404, body: { error: 'not_found' } });
statusByMatch.set(MATCH_ENDED, { status: 200, body: {
  match: { id: MATCH_ENDED, start_time: T, end_time: '2026-08-08T09:00:00Z', name: 'ended-match' },
  events: [],
  users: [],
} });

const mock = await new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && url.pathname === '/oauth/token') {
      return send(200, { access_token: 'restore-token', expires_in: 86400, token_type: 'Bearer' });
    }
    const m = /^\/api\/v2\/matches\/(\d+)$/.exec(url.pathname);
    if (m) {
      const cfg = statusByMatch.get(Number(m[1]));
      if (!cfg) return send(404, { error: 'not_found' });
      return send(cfg.status, cfg.body);
    }
    send(404, { error: 'not_found' });
  });
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({
      port,
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    });
  });
});

process.env.OSU_API_BASE_URL = `http://127.0.0.1:${mock.port}/api/v2`;
process.env.OSU_TOKEN_URL = `http://127.0.0.1:${mock.port}/oauth/token`;
process.env.OSU_CLIENT_ID = 'restore-client';
process.env.OSU_CLIENT_SECRET = 'restore-secret';

const { writeDb, readDb } = await import('../server/store.js');
const { matchManager } = await import('../server/osu/match.js');

function listenerEntry(matchId, name) {
  return {
    matchName: name,
    lastEventId: 0,
    groups: [{ groupId: 'g1', userId: 'u1', createdAt: T }],
    createdAt: T,
  };
}

let passed = 0;
let failed = 0;
const pass = (label) => { console.log(`PASS [${label}]`); passed++; };
const fail = (label, msg) => { console.error(`FAIL [${label}]: ${msg}`); failed++; };
const assert = (cond, label, msg) => (cond ? pass(label) : fail(label, msg));

// Pre-seed three persisted listeners: one hit by a transient 5xx, one that is
// definitively gone (404), one that already ended.
writeDb({
  osuMatchListeners: {
    [String(MATCH_TRANSIENT)]: listenerEntry(MATCH_TRANSIENT, 'transient-failure'),
    [String(MATCH_GONE)]: listenerEntry(MATCH_GONE, 'gone-match'),
    [String(MATCH_ENDED)]: listenerEntry(MATCH_ENDED, 'ended-match'),
  },
});

await matchManager.restore({});

const after = readDb().osuMatchListeners || {};
assert(
  after[String(MATCH_TRANSIENT)] !== undefined,
  'transient-5xx-keeps-entry',
  'restore() deleted a persisted listener after a transient osu! API 5xx',
);
assert(
  after[String(MATCH_GONE)] === undefined,
  'definitive-404-removes-entry',
  'restore() kept a listener for a match that definitively no longer exists',
);
assert(
  after[String(MATCH_ENDED)] === undefined,
  'ended-match-removes-entry',
  'restore() kept a listener for a match that already ended',
);

await mock.close();
verifyProductionDbUnchanged(prodBefore);

console.log(`\nmatch-restore-transient-verify: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
