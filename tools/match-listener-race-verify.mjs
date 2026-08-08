// match-listener-race-verify.mjs
// Deterministic race tests for osu MatchListener:
//   C1: concurrent listen() re-entry, stale-response reorder, stop-during-listen
//   B3: same-batch game event side-effect ordering
// Fully OFFLINE: a controlled local mock lets the test decide per-request
// timing and response order, so failures are reproducible on every run.

import http from 'node:http';
import {
  createTestDataDir,
  assertNotProduction,
  productionDbSnapshot,
  verifyProductionDbUnchanged,
  cleanupTestDir,
} from './test-isolation.mjs';

const testDataDir = createTestDataDir('wuxin-match-race');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);
const prodBefore = productionDbSnapshot();

// ── Controlled osu! API mock ──────────────────────────────────────────────
// Every /matches/:id request is parked in `pending`; the test resolves it
// explicitly in the order it wants (including out-of-order responses).
function createControlledMatchMock() {
  const pending = [];
  let server;
  let port = 0;
  server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const pathname = decodeURIComponent(url.pathname);
    const send = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && pathname === '/oauth/token') {
      return send({ access_token: 'race-token', expires_in: 86400, token_type: 'Bearer' });
    }
    const m = /^\/api\/v2\/matches\/(\d+)$/.exec(pathname);
    if (m) {
      const after = Number(url.searchParams.get('after') || '0');
      let settled = false;
      pending.push({
        after,
        settle: (err, body) => {
          if (settled) return;
          settled = true;
          if (err) send({ error: String(err && err.message ? err.message : err) }, 500);
          else send(body);
        },
      });
      return;
    }
    send({ error: 'not_found' }, 404);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve({
        port,
        apiBase: `http://127.0.0.1:${port}/api/v2`,
        tokenUrl: `http://127.0.0.1:${port}/oauth/token`,
        pending,
        respond: (index, body) => pending[index]?.settle(null, body),
        fail: (index, err) => pending[index]?.settle(err || new Error('mock failure')),
        close: () => new Promise((r) => {
          server.closeAllConnections?.();
          server.close(r);
        }),
      });
    });
  });
}

const mock = await createControlledMatchMock();
process.env.OSU_API_BASE_URL = mock.apiBase;
process.env.OSU_TOKEN_URL = mock.tokenUrl;
process.env.OSU_CLIENT_ID = 'race-client';
process.env.OSU_CLIENT_SECRET = 'race-secret';

const { MatchListener } = await import('../server/osu/match.ts');

const MATCH_ID = 777000001;
const T = '2026-08-08T10:00:00Z';

function round(id, endTime) {
  return {
    id,
    beatmap_id: 1000 + id,
    start_time: T,
    end_time: endTime,
    mode_int: 0,
    mods: [],
    scores: [],
    team_type: 'head-to-head',
    scoring_type: 'score',
  };
}

function event(id, game) {
  return { id, detail: { type: 'match', text: `e${id}` }, timestamp: T, user_id: null, game };
}

function matchPayload(latest, events) {
  return {
    match: { id: MATCH_ID, start_time: T, end_time: null, name: 'race-fixture' },
    events,
    users: [],
    first_event_id: 1,
    latest_event_id: latest,
    current_game_id: null,
  };
}

const BASE_MATCH = matchPayload(100, []);

// ── Test helpers ──────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const pass = (label) => { console.log(`PASS [${label}]`); passed++; };
const fail = (label, msg) => { console.error(`FAIL [${label}]: ${msg}`); failed++; };
const assert = (cond, label, msg) => (cond ? pass(label) : fail(label, msg));
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// Wait until `count` new match requests have arrived since `base`.
async function waitForRequests(base, count, timeoutMs = 3000) {
  const start = Date.now();
  while (mock.pending.length - base < count) {
    if (Date.now() - start > timeoutMs) return false;
    await settle(10);
  }
  return true;
}

// onEventCb recorder. `gate: true` parks every side-effect on a deferred so
// the test controls completion order; error/matchEnd always complete at once.
function makeRecorder(gate = false) {
  const calls = [];
  let completedSeq = 0;
  const cb = async (type, data) => {
    const key = `${type}:${data?.eventId ?? data?.beatmapId ?? ''}`;
    const priority = Number(data?.eventId ?? (data?.beatmapId ? data.beatmapId - 1000 : 0)) || 0;
    const call = { type, key, priority, done: false, resolve: () => {} };
    if (gate && type !== 'error' && type !== 'matchEnd') {
      let resolve;
      call.gate = new Promise((r) => { resolve = r; });
      call.resolve = () => resolve();
    } else {
      call.done = true;
    }
    calls.push(call);
    if (call.gate) await call.gate;
    if (call.gate) {
      call.done = true;
      call.completedSeq = ++completedSeq;
    }
    return undefined;
  };
  return { calls, cb, completedSeq: () => completedSeq };
}

function gameCalls(calls) {
  return calls.filter((c) => c.type !== 'matchEnd' && c.type !== 'error');
}

function resolvePendingSlowestFirst(calls) {
  // Deterministically mimic "an earlier event renders slower than a later
  // event": at every step resolve the pending call with the largest id.
  const pending = () => calls.filter((c) => c.gate && !c.done);
  return (async () => {
    while (pending().length > 0) {
      const next = [...pending()].sort((a, b) => b.priority - a.priority)[0];
      next.resolve();
      await settle();
    }
  })();
}

// ── C1: concurrent listen() + stale response reorder ──────────────────────
async function c1Reorder() {
  const rec = makeRecorder();
  const listener = new MatchListener(BASE_MATCH, MATCH_ID, rec.cb);
  const base = mock.pending.length;
  const p1 = listener.listen();
  assert(await waitForRequests(base, 1), 'c1:first-request-arrived');
  const p2 = listener.listen(); // simulates the 8s interval firing while #1 is in flight
  assert(await waitForRequests(base, 2), 'c1:second-request-arrived');
  assert(mock.pending.length - base === 2, 'c1:two-listeners-concurrent', `pending=${mock.pending.length - base}`);

  const newEvents = Array.from({ length: 10 }, (_, i) => event(101 + i, round(101 + i, T)));
  const oldEvents = Array.from({ length: 5 }, (_, i) => event(101 + i, round(101 + i, T)));
  mock.respond(base + 1, matchPayload(110, newEvents)); // later request answers first (newer data)
  await settle();
  mock.respond(base, matchPayload(105, oldEvents)); // earlier request answers last (stale data)
  await Promise.all([p1, p2]);
  await settle();

  assert(listener.nowEventId === 110, 'c1:stale-response-does-not-regress-state', `nowEventId=${listener.nowEventId}`);
  const g = gameCalls(rec.calls);
  assert(g.length === 10, 'c1:no-duplicate-events', `gameCalls=${g.length}`);
  listener.stop('USER_STOP');
  return listener;
}

// ── C1: no timer armed while a poll round is in flight ────────────────────
async function c1NoReentrantTimer() {
  const rec = makeRecorder();
  const listener = new MatchListener(BASE_MATCH, MATCH_ID, rec.cb);
  const base = mock.pending.length;
  listener.start();
  assert(await waitForRequests(base, 1), 'c1:request-arrived');
  assert(mock.pending.length - base === 1, 'c1:single-request-while-inflight', `pending=${mock.pending.length - base}`);
  assert(listener.timer === null, 'c1:timer-not-armed-while-inflight', `timer=${listener.timer}`);

  mock.respond(base, matchPayload(100, [])); // no new events this round
  await settle();
  assert(listener.timer !== null, 'c1:timer-armed-after-round-completes', `timer=${listener.timer}`);
  listener.stop('USER_STOP');
  assert(listener.timer === null, 'c1:timer-cleared-on-stop', `timer=${listener.timer}`);
  return listener;
}

// ── C1: stop() while listen() is awaiting the API ─────────────────────────
async function c1StopDuringListen() {
  const rec = makeRecorder();
  const listener = new MatchListener(BASE_MATCH, MATCH_ID, rec.cb);
  const base = mock.pending.length;
  listener.start();
  assert(await waitForRequests(base, 1), 'c1:stop-request-arrived');
  listener.stop('USER_STOP');
  await settle();
  mock.respond(base, matchPayload(110, [event(101, round(101, T))]));
  await settle();
  assert(listener.nowEventId === 100, 'c1:stop-prevents-state-write', `nowEventId=${listener.nowEventId}`);
  const g = gameCalls(rec.calls);
  assert(g.length === 0, 'c1:stop-prevents-late-push', `gameCalls=${g.length}`);
  return listener;
}

// ── C1: API error does not stop polling; next round recovers ──────────────
async function c1ErrorRecovers() {
  const rec = makeRecorder();
  const listener = new MatchListener(BASE_MATCH, MATCH_ID, rec.cb);
  const base = mock.pending.length;
  listener.start();
  assert(await waitForRequests(base, 1), 'c1:error-request-arrived');
  mock.fail(base, new Error('osu API 500'));
  await settle();
  assert(rec.calls.some((c) => c.type === 'error'), 'c1:error-emitted');
  assert(listener.isStopped === false, 'c1:error-does-not-stop', 'stopped after error');
  assert(listener.timer !== null, 'c1:error-still-schedules-next-round', `timer=${listener.timer}`);

  // Drive round 2 directly instead of waiting 8s for the real timer.
  // (This is exactly what the poll timer does: one listen() per round.)
  const p2 = listener.listen();
  assert(await waitForRequests(base + 1, 1), 'c1:recovery-request-sent');
  mock.respond(base + 1, matchPayload(102, [event(101, round(101, T))]));
  await p2;
  await settle();
  assert(gameCalls(rec.calls).length === 1, 'c1:recovery-pushes-event', `game=${gameCalls(rec.calls).length}`);
  listener.stop('USER_STOP');
  return listener;
}

// ── B3: same-batch game events must complete in event order ───────────────
async function b3BatchOrder() {
  const rec = makeRecorder(true);
  const listener = new MatchListener(BASE_MATCH, MATCH_ID, rec.cb);
  const base = mock.pending.length;
  const events = [
    event(101, round(101, T)),   // gameEnd round 1
    event(102, round(102, null)), // gameStart round 2 -> gameAbort
    event(103, round(103, T)),   // gameEnd round 2
  ];
  const p = listener.listen();
  assert(await waitForRequests(base, 1), 'b3:request-arrived');
  mock.respond(base, matchPayload(103, events));
  await p;
  await settle();

  await resolvePendingSlowestFirst(rec.calls);
  const order = rec.calls
    .filter((c) => c.done && c.type !== 'matchEnd' && c.type !== 'error')
    .sort((a, b) => (a.completedSeq || 0) - (b.completedSeq || 0))
    .map((c) => c.key);
  const expected = ['gameEnd:101', 'gameAbort:1102', 'gameEnd:103'];
  assert(order.join(',') === expected.join(','), 'b3:same-batch-side-effects-ordered', `got=[${order.join(',')}]`);
  const unique = new Set(order);
  assert(unique.size === order.length, 'b3:no-duplicate-side-effects', `size=${unique.size} len=${order.length}`);
  listener.stop('USER_STOP');
  return listener;
}

// ── Run ───────────────────────────────────────────────────────────────────
const listeners = [];
listeners.push(await c1Reorder());
listeners.push(await c1NoReentrantTimer());
listeners.push(await c1StopDuringListen());
listeners.push(await c1ErrorRecovers());
listeners.push(await b3BatchOrder());

// Unblock any parked recorder gates so the process can exit cleanly.
for (const rec of []) { /* parked gates already resolved by cases */ }

await mock.close();
verifyProductionDbUnchanged(prodBefore);
cleanupTestDir(testDataDir);
console.log(`\nMATCH-LISTENER-RACE-VERIFY: passed=${passed} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
