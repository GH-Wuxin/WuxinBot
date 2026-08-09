// render-bp-cache-verify.mjs
// P1-1 regression: the rendered BP-list cache key must include the history
// snapshot dimension. Two calls with the same osuUserId but different
// history_user snapshots render different header cards, so they must not
// share a cache entry — and keying by historyUser.id alone is not enough,
// because the same user's historical snapshots share the same id.

import { bpListCacheKey } from '../server/bots/render.ts';

const apiUser = { id: 4321, username: 'CacheTest' };
const scores = [
  { id: 1, pp: 300, mods: ['HD'], ended_at: '2026-01-01T00:00:00Z', rank: 'S' },
  { id: 2, pp: 280, mods: [], ended_at: '2026-01-02T00:00:00Z', rank: 'A' },
];

const baseOptions = { ranks: [1, 2], compact: false };
const oldSnapshot = {
  id: 4321,
  username: 'CacheTest',
  statistics: { pp: 5000, global_rank: 800, hit_accuracy: 98.5, play_count: 40000 },
};
const newSnapshot = {
  id: 4321,
  username: 'CacheTest',
  statistics: { pp: 5200, global_rank: 700, hit_accuracy: 98.9, play_count: 40500 },
};

let passed = 0;
let failed = 0;
const pass = (label) => { console.log(`PASS [${label}]`); passed++; };
const fail = (label, msg) => { console.error(`FAIL [${label}]: ${msg}`); failed++; };
const assert = (cond, label, msg) => (cond ? pass(label) : fail(label, msg));

const noHistory = bpListCacheKey(apiUser, scores, baseOptions);
const oldKey = bpListCacheKey(apiUser, scores, { ...baseOptions, historyUser: oldSnapshot });
const newKey = bpListCacheKey(apiUser, scores, { ...baseOptions, historyUser: newSnapshot });

assert(
  noHistory !== oldKey,
  'with-vs-without-history',
  'cache key ignored historyUser entirely',
);
assert(
  oldKey !== newKey,
  'same-id-different-snapshot',
  'cache key only used historyUser.id; two historical snapshots of the same user collide',
);

// Canonicalization: equal snapshots must produce the same key even when the
// object property order differs (osu! API responses are not ordered).
const reorderedSnapshot = {
  statistics: { play_count: 40500, hit_accuracy: 98.9, pp: 5200, global_rank: 700 },
  username: 'CacheTest',
  id: 4321,
};
assert(
  bpListCacheKey(apiUser, scores, { ...baseOptions, historyUser: newSnapshot })
    === bpListCacheKey(apiUser, scores, { ...baseOptions, historyUser: reorderedSnapshot }),
  'canonical-order-stable',
  'equal history snapshots produced different cache keys due to object key order',
);

// Fields buildYumuUser always drops (raw profile HTML page) must not change
// the rendered card and therefore must not change the cache key.
const withPage = {
  ...oldSnapshot,
  page: '<html>' + 'x'.repeat(10 * 1024) + '</html>',
};
assert(
  bpListCacheKey(apiUser, scores, { ...baseOptions, historyUser: oldSnapshot })
    === bpListCacheKey(apiUser, scores, { ...baseOptions, historyUser: withPage }),
  'dropped-page-field-ignored',
  'historyUser.page (never rendered) changed the cache key',
);

console.log(`\nrender-bp-cache-verify: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
