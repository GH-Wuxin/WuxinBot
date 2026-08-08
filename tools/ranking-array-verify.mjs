// ranking-array-verify.mjs
// P2-2 regression: buildRankingArray's improvement-interval length is
// inclusive of both endpoints. A 4-day continuous improvement run
// [100, 90, 80, 70] must report length 4, not 3.

import { buildRankingArray } from '../server/bots/render.ts';

let passed = 0;
let failed = 0;
const pass = (label) => { console.log(`PASS [${label}]`); passed++; };
const fail = (label, msg) => { console.error(`FAIL [${label}]: ${msg}`); failed++; };
const assert = (cond, label, msg) => (cond ? pass(label) : fail(label, msg));
const deepEqual = (a, b, label, msg) => assert(
  JSON.stringify(a) === JSON.stringify(b),
  label,
  `${msg}: got ${JSON.stringify(a)}`,
);

// Continuous 4-day improvement: one interval spanning indices 0..3.
{
  const r = buildRankingArray({ data: [100, 90, 80, 70] });
  deepEqual(r.ranking, [100, 90, 80, 70], 'continuous-ranking', 'ranking array mangled');
  assert(r.statistics.intervals.length === 1, 'continuous-interval-count', `got ${r.statistics.intervals.length} intervals`);
  deepEqual(
    r.statistics.intervals[0],
    { start: 86, end: 89, improvement: 30, length: 4 },
    'continuous-interval',
    'interval start/end/improvement/length wrong',
  );
  assert(r.statistics.improvement === 30, 'continuous-total-improvement', `got ${r.statistics.improvement}`);
}

// Plateau separates two runs: [100, 90, 90, 80] → runs (0..1) and (2..3).
{
  const r = buildRankingArray({ data: [100, 90, 90, 80] });
  assert(r.statistics.intervals.length === 2, 'plateau-interval-count', `got ${r.statistics.intervals.length} intervals`);
  deepEqual(
    r.statistics.intervals[0],
    { start: 86, end: 87, improvement: 10, length: 2 },
    'plateau-run-1',
    'first run wrong',
  );
  deepEqual(
    r.statistics.intervals[1],
    { start: 88, end: 89, improvement: 10, length: 2 },
    'plateau-run-2',
    'second run wrong',
  );
  assert(r.statistics.improvement === 20, 'plateau-total-improvement', `got ${r.statistics.improvement}`);
}

// Zero-separated run already used the +1 branch; lock it in.
{
  const r = buildRankingArray({ data: [100, 90, 80, 0, 70] });
  assert(r.statistics.intervals.length === 1, 'zero-interval-count', `got ${r.statistics.intervals.length} intervals`);
  deepEqual(
    r.statistics.intervals[0],
    { start: 85, end: 87, improvement: 20, length: 3 },
    'zero-separated-interval',
    'zero-separated run wrong',
  );
}

// Empty / zero-only data must not fabricate intervals.
{
  const empty = buildRankingArray({ data: [] });
  deepEqual(empty.ranking, [], 'empty-ranking', 'empty input produced ranking');
  deepEqual(empty.statistics.intervals, [], 'empty-intervals', 'empty input produced intervals');

  const zeros = buildRankingArray({ data: [0, 0, 0] });
  deepEqual(zeros.ranking, [0, 0, 0], 'zeros-ranking', 'zero input produced non-zero ranking');
  deepEqual(zeros.statistics.intervals, [], 'zeros-intervals', 'zero input produced intervals');
}

console.log(`\nranking-array-verify: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
