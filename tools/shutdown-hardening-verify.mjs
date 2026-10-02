// Verify that process shutdown can stop match polling without fabricating a
// match-end event, while normal user stops keep their existing notification.
import assert from 'node:assert/strict';
import { MatchListener } from '../server/osu/match.ts';

const match = {
  match: { id: 1234, start_time: '2026-01-01T00:00:00.000Z', end_time: null, name: 'shutdown fixture' },
  events: [],
  users: [],
  first_event_id: 0,
  latest_event_id: 0,
  current_game_id: null,
};

const silentEvents = [];
const silent = new MatchListener(match, 1234, (type) => {
  silentEvents.push(type);
});
await silent.stopSilently();
assert.equal(silent.isStopped, true, 'silent shutdown marks listener stopped');
assert.deepEqual(silentEvents, [], 'silent shutdown does not emit a fake match end');

const normalEvents = [];
const normal = new MatchListener(match, 1235, (type) => {
  normalEvents.push(type);
});
normal.stop('USER_STOP');
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(normalEvents, ['matchEnd'], 'user stop keeps match-end notification');

console.log('SHUTDOWN-HARDENING-VERIFY PASS');
