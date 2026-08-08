// match-cursor-stuck-verify.mjs
// C1 regression: MatchListener parks `nowEventId` at `gameStart.id - 1` while
// a game is in progress so the SAME game event's end_time mutation is still
// visible on later `after=` polls (osu! API v2 `after` is exclusive, and an
// in-progress game event is always included). The old code early-returned on
// `nowEventId === gameEvent.id - 1`, which:
//   - skipped roster events (player-joined/left/host-changed) while parked;
//   - did not deliver gameEnd when the round completed - only when the NEXT
//     game event finally appeared;
//   - lost gameEnd + matchEnd entirely if the match ended while parked.
//
// Fully OFFLINE: a scripted local mock answers each `after=` poll, so the old
// code deterministically FAILS (no gameEnd, cursor stuck at 94 forever) and
// the fixed code delivers gameEnd, advances the cursor, and stops cleanly.

import http from 'node:http';
import {
  createTestDataDir,
  assertNotProduction,
  productionDbSnapshot,
  verifyProductionDbUnchanged,
  cleanupTestDir,
} from './test-isolation.mjs';

const testDataDir = createTestDataDir('wuxin-match-cursor');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);
const prodBefore = productionDbSnapshot();

const MATCH_ID = 888000001;
const GAME_1 = 9001;
const GAME_2 = 9002;
const T = '2026-08-08T10:00:00Z';
const T_END = '2026-08-08T10:05:00Z';

function user(id) {
  return { id, username: `user${id}`, country_code: 'CN' };
}

function gameEvent(id, endTime, beatmapId = 1000 + id) {
  return {
    id,
    detail: { type: 'game', text: `game ${id}` },
    timestamp: T,
    user_id: null,
    game: {
      id,
      beatmap_id: beatmapId,
      start_time: T,
      end_time: endTime,
      mode: 'osu',
      mods: [],
      team_type: 'head-to-head',
      scoring_type: 'score',
      scores: [],
    },
  };
}

function rosterEvent(id, type, userId) {
  return {
    id,
    detail: { type, text: `${type} ${userId}` },
    timestamp: T,
    user_id: userId,
    game: null,
  };
}

function matchPayload({ events, latest, currentGameId, matchEnd = null }) {
  return {
    match: { id: MATCH_ID, start_time: T, end_time: matchEnd, name: 'cursor-fixture' },
    events,
    users: [user(1), user(2), user(3), user(4)],
    first_event_id: 1,
    latest_event_id: latest,
    current_game_id: currentGameId,
  };
}

const INITIAL = matchPayload({
  events: [gameEvent(95, null), rosterEvent(96, 'player-joined', 2)],
  latest: 96,
  currentGameId: GAME_1,
});

// Scenario A scripted responses, in poll order.
const scriptA = [
  // after=94: round 95 still in progress, roster events arrive.
  matchPayload({
    events: [gameEvent(95, null), rosterEvent(96, 'player-joined', 2), rosterEvent(97, 'player-left', 3), rosterEvent(98, 'host-changed', 1)],
    latest: 98,
    currentGameId: GAME_1,
  }),
  // after=94 again: round 95 now finished (same event id, end_time set).
  matchPayload({
    events: [gameEvent(95, T_END), rosterEvent(96, 'player-joined', 2), rosterEvent(97, 'player-left', 3), rosterEvent(98, 'host-changed', 1)],
    latest: 98,
    currentGameId: GAME_1,
  }),
  // after=98: ended round + roster events consumed in one jump; next round starts.
  matchPayload({
    events: [gameEvent(99, null), rosterEvent(100, 'player-joined', 4)],
    latest: 100,
    currentGameId: GAME_2,
  }),
  // after=98 again: next round still in progress, another roster event arrives.
  matchPayload({
    events: [gameEvent(99, null), rosterEvent(101, 'host-changed', 2)],
    latest: 101,
    currentGameId: GAME_2,
  }),
];

// Scenario B: the parked round finishes AND the whole match ends in the same
// poll; gameEnd must be delivered before matchEnd.
const scriptB = [
  matchPayload({
    events: [gameEvent(95, T_END)],
    latest: 96,
    currentGameId: GAME_1,
    matchEnd: T_END,
  }),
];

function createScriptedMock(bodies) {
  const requestedAfter = [];
  let server;
  let port = 0;
  server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const send = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && url.pathname === '/oauth/token') {
      return send({ access_token: 'cursor-token', expires_in: 86400, token_type: 'Bearer' });
    }
    const m = /^\/api\/v2\/matches\/(\d+)$/.exec(url.pathname);
    if (m) {
      const after = Number(url.searchParams.get('after') || '0');
      requestedAfter.push(after);
      const body = bodies.shift();
      if (body === undefined) {
        // Extra/unknown poll (e.g. the buggy code stuck at after=94): answer
        // with the same in-progress snapshot instead of a 500 so the test can
        // keep exercising the listener and fail on clean assertions, not noise.
        return send(matchPayload({
          events: [gameEvent(95, null), rosterEvent(96, 'player-joined', 2), rosterEvent(97, 'player-left', 3), rosterEvent(98, 'host-changed', 1)],
          latest: 98,
          currentGameId: GAME_1,
        }));
      }
      return send(body);
    }
    send({ error: 'not_found' }, 404);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve({
        port,
        requestedAfter,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
      });
    });
  });
}

// One mock serves both scenarios through a scripted queue. API_BASE and
// TOKEN_URL are module-level constants read once at import, so a second mock
// could not be reached by rebinding env vars afterwards.
const mock = await createScriptedMock([...scriptA, ...scriptB]);
process.env.OSU_API_BASE_URL = `http://127.0.0.1:${mock.port}/api/v2`;
process.env.OSU_TOKEN_URL = `http://127.0.0.1:${mock.port}/oauth/token`;
process.env.OSU_CLIENT_ID = 'cursor-client';
process.env.OSU_CLIENT_SECRET = 'cursor-secret';

const { MatchListener } = await import('../server/osu/match.ts');

let passed = 0;
let failed = 0;
const pass = (label) => { console.log(`PASS [${label}]`); passed++; };
const fail = (label, msg) => { console.error(`FAIL [${label}]: ${msg}`); failed++; };
const assert = (cond, label, msg) => (cond ? pass(label) : fail(label, msg));
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function makeRecorder() {
  const calls = [];
  const cb = async (type, data) => { calls.push({ type, data }); };
  return { calls, cb };
}

function countCalls(calls, type, eventId) {
  return calls.filter((c) => c.type === type && (eventId === undefined || c.data?.eventId === eventId)).length;
}

function sortedUserNames(calls, type, eventId) {
  const call = calls.find((c) => c.type === type && c.data?.eventId === eventId);
  return ((call?.data?.users) || []).map((u) => u.username).sort();
}

// ---- Scenario A: round completes while parked ----
{
  const rec = makeRecorder();
  const listener = new MatchListener(INITIAL, MATCH_ID, rec.cb);
  await settle();
  assert(
    countCalls(rec.calls, 'gameStart', 95) === 1,
    'a:constructor-emits-current-game-start',
    `gameStart(95) calls=${countCalls(rec.calls, 'gameStart', 95)}`,
  );

  // Poll 1: game still in progress + roster events. Must stay parked.
  await listener.listen();
  await settle();
  assert(
    countCalls(rec.calls, 'gameStart', 95) === 1,
    'a:no-duplicate-game-start-while-parked',
    `gameStart(95) calls=${countCalls(rec.calls, 'gameStart', 95)}`,
  );
  assert(listener.nowEventId === 94, 'a:parked-before-game-start', `nowEventId=${listener.nowEventId}`);

  // Poll 2: same event id now has end_time -> gameEnd must be delivered NOW.
  await listener.listen();
  await settle();
  assert(
    countCalls(rec.calls, 'gameEnd', 95) === 1,
    'a:game-end-delivered-on-round-completion',
    `gameEnd(95) calls=${countCalls(rec.calls, 'gameEnd', 95)}`,
  );
  assert(listener.nowEventId === 98, 'a:cursor-consumes-roster-with-ended-game', `nowEventId=${listener.nowEventId}`);

  // Poll 3: next round starts; must emit gameStart(99) exactly once and stay
  // parked in front of the new game event. The roster events absorbed while
  // parked (host-changed 1, player-joined 2; player-left 3 removed) must be
  // reflected in the next gameStart payload.
  await listener.listen();
  await settle();
  assert(
    countCalls(rec.calls, 'gameStart', 99) === 1,
    'a:next-game-start-delivered',
    `gameStart(99) calls=${countCalls(rec.calls, 'gameStart', 99)}`,
  );
  assert(
    sortedUserNames(rec.calls, 'gameStart', 99).join(',') === 'user1,user2,user4',
    'a:roster-events-absorbed-while-parked',
    `users=${JSON.stringify(sortedUserNames(rec.calls, 'gameStart', 99))}`,
  );
  assert(listener.nowEventId === 98, 'a:parked-on-next-game', `nowEventId=${listener.nowEventId}`);

  // Poll 4: next round still in progress; no duplicate gameStart, cursor stays.
  await listener.listen();
  await settle();
  assert(
    countCalls(rec.calls, 'gameStart', 99) === 1,
    'a:no-duplicate-next-game-start-while-parked',
    `gameStart(99) calls=${countCalls(rec.calls, 'gameStart', 99)}`,
  );
  assert(listener.nowEventId === 98, 'a:still-parked-on-next-game', `nowEventId=${listener.nowEventId}`);

  assert(
    JSON.stringify(mock.requestedAfter.slice(0, 4)) === JSON.stringify([94, 94, 98, 98]),
    'a:after-arguments-exclusive-and-advancing',
    `requested after=${JSON.stringify(mock.requestedAfter)}`,
  );
  listener.stop('USER_STOP');
}

// ---- Scenario B: match ends while parked (current_game_id still set) ----
{
  const rec = makeRecorder();
  const listener = new MatchListener(INITIAL, MATCH_ID, rec.cb);
  await settle();
  await listener.listen();
  await settle();
  assert(
    countCalls(rec.calls, 'gameEnd', 95) === 1,
    'b:final-game-end-delivered',
    `gameEnd(95) calls=${countCalls(rec.calls, 'gameEnd', 95)}`,
  );
  assert(
    countCalls(rec.calls, 'matchEnd') === 1,
    'b:match-end-delivered',
    `matchEnd calls=${countCalls(rec.calls, 'matchEnd')}`,
  );
  assert(listener.isStopped === true, 'b:listener-stopped', `isStopped=${listener.isStopped}`);
  assert(listener.nowEventId === 96, 'b:cursor-advanced', `nowEventId=${listener.nowEventId}`);
  assert(mock.requestedAfter[4] === 94, 'b:final-poll-uses-exclusive-after', `requested after=${JSON.stringify(mock.requestedAfter)}`);
}

await mock.close();
verifyProductionDbUnchanged(prodBefore);
cleanupTestDir(testDataDir);

console.log(`\nmatch-cursor-stuck-verify: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
