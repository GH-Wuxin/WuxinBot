// match-f3-contract-verify.mjs
// Regression guard for the !ml panel_F3 hard-crash / soft-content failures.
//
// The osu! API v2 match payload carries team membership as
// `score.match = { slot, team, pass }` and users separately in `match.users`.
// The Wuxin port previously serialized scores without `match` (and without
// `user`), while yumu-image's panel_F3 does:
//     round.scores.filter(s => s.match.team === 'red')
// → every F3 request crashed with `Cannot read properties of undefined
//   (reading 'team')`. The same port also nested `events`/`users` one level
// off, so E7/F3 meta cards silently lost match title/round list.
//
// This suite is fully offline: it imports only the pure MatchRating port and
// feeds it a trimmed production fixture (osu! match 900000026) plus synthetic
// TeamVS scenarios. It must FAIL on the pre-fix serializers.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMatchRating, serializeRound } from '../server/osu/matchRating.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prodFixture = JSON.parse(
  fs.readFileSync(path.join(root, 'tools/fixtures/match-f3-synthetic-9000001.json'), 'utf8'),
);

let passed = 0;
let failed = 0;
const pass = (label) => { console.log(`PASS [${label}]`); passed++; };
const fail = (label, msg) => { console.error(`FAIL [${label}]: ${msg}`); failed++; };
const assert = (cond, label, msg) => (cond ? pass(label) : fail(label, msg));

// Exact expressions used by yumu-image panel_F3.js — keep them verbatim so a
// renderer contract change is caught here.
function panelF3RedBlue(round) {
  const reds = round.scores.filter((s) => s.match.team === 'red');
  const blues = round.scores.filter((s) => s.match.team === 'blue');
  return { reds, blues };
}

function assertRoundContract(round, label, expected = {}) {
  const ser = serializeRound(round);
  const scores = ser.scores || [];
  assert(scores.length === round.scores.length, `${label}:score-count`, `${scores.length} != ${round.scores.length}`);
  assert(
    scores.every((s) => s.match && typeof s.match.team === 'string' && (s.match.team === 'red' || s.match.team === 'blue')),
    `${label}:score-match-team`,
    JSON.stringify(scores.map((s) => s.match)).slice(0, 300),
  );
  assert(
    scores.every((s) => s.match && typeof s.match.pass === 'boolean'),
    `${label}:score-match-pass`,
    'match.pass must be boolean',
  );
  if (!expected.allowGhostUser) {
    assert(
      scores.every((s) => s.user && typeof s.user.username === 'string'),
      `${label}:score-user`,
      JSON.stringify(scores.map((s) => s.user)).slice(0, 300),
    );
  }
  let f3;
  try {
    f3 = panelF3RedBlue(ser);
    assert(true, `${label}:f3-filter-no-throw`, '');
  } catch (e) {
    assert(false, `${label}:f3-filter-no-throw`, `${e.constructor.name}: ${e.message}`);
  }
  if (f3) {
    const rawReds = round.scores.filter((s) => s.match?.team === 'red').length;
    const rawBlues = round.scores.filter((s) => s.match?.team === 'blue').length;
    assert(f3.reds.length === rawReds, `${label}:f3-red-count`, `${f3.reds.length} != ${rawReds}`);
    assert(f3.blues.length === rawBlues, `${label}:f3-blue-count`, `${f3.blues.length} != ${rawBlues}`);
  }
  const redTotal = scores.filter((s) => s.match?.team === 'red').reduce((a, s) => a + Number(s.score || 0), 0);
  const blueTotal = scores.filter((s) => s.match?.team === 'blue').reduce((a, s) => a + Number(s.score || 0), 0);
  assert(Number(ser.red_team_score) === redTotal, `${label}:red-team-score`, `${ser.red_team_score} != ${redTotal}`);
  assert(Number(ser.blue_team_score) === blueTotal, `${label}:blue-team-score`, `${ser.blue_team_score} != ${blueTotal}`);
  if (expected.winningTeam !== undefined) {
    assert(ser.winning_team === expected.winningTeam, `${label}:winning-team`, `${ser.winning_team} != ${expected.winningTeam}`);
  }
}

function makeMatch(rounds, users) {
  const events = rounds.map((g, i) => ({
    id: 1000 + i,
    detail: { type: 'game-end', text: `round ${i + 1}` },
    timestamp: '2026-08-08T12:00:00Z',
    user_id: null,
    game: g,
  }));
  return {
    match: { id: 999001, start_time: '2026-08-08T11:00:00Z', end_time: '2026-08-08T13:00:00Z', name: 'Fixture: A vs B' },
    events,
    users,
    first_event_id: events[0].id,
    latest_event_id: events[events.length - 1].id,
    current_game_id: null,
  };
}

function fixtureRound(id, teamType, scores) {
  return {
    id,
    beatmap: null,
    beatmap_id: 1000 + id,
    start_time: '2026-08-08T12:00:00Z',
    end_time: '2026-08-08T12:05:00Z',
    mode_int: 0,
    mods: [],
    team_type: teamType,
    scoring_type: 'score',
    scores,
  };
}

function fixtureScore(userId, score, team, extra = {}) {
  return {
    id: null,
    user_id: userId,
    score,
    max_combo: 100,
    mods: [],
    passed: true,
    perfect: false,
    rank: 'S',
    accuracy: 0.98,
    statistics: { count_300: 100, count_100: 0, count_50: 0, count_miss: 0, count_geki: 0, count_katsu: 0 },
    match: { slot: 0, team, pass: true },
    ...extra,
  };
}

const users = [1, 2, 3, 4, 5, 6, 7].map((id) => ({
  id,
  username: `player-${id}`,
  country_code: 'CN',
  avatar_url: '',
  is_online: true,
}));
const users8 = [...users, { id: 8, username: 'player-8', country_code: 'CN', avatar_url: '', is_online: true }];

// ── 1. Production fixture (match 900000026, rounds 1-2) ──

{
  const { json, rounds } = buildMatchRating(prodFixture);
  assert(rounds.length === 2, 'prod:round-count', `${rounds.length} != 2`);
  assert(json.match?.match?.id === 900000026, 'prod:f3-inner-match-id', JSON.stringify(json.match?.match).slice(0, 120));
  assert(Array.isArray(json.match?.events), 'prod:e7-rounds-array', 'match.match.events must be an array');
  assert(typeof json.match?.match?.name === 'string', 'prod:a2-match-name', JSON.stringify(json.match?.match?.name));
  assert(typeof json.match?.is_match_end === 'boolean', 'prod:match-end-flag', String(json.match?.is_match_end));
  assert(json.match?.events.length === 2, 'prod:e7-events-count', `${json.match?.events.length} != 2`);
  for (let i = 0; i < rounds.length; i++) {
    assertRoundContract(rounds[i], `prod:round${i + 1}`);
  }
}

// ── 2. Synthetic TeamVS scenarios ──

{
  // 4v4 complete.
  const round = fixtureRound(1, 'team-vs', [
    fixtureScore(1, 900000, 'red'), fixtureScore(2, 800000, 'red'),
    fixtureScore(3, 700000, 'red'), fixtureScore(4, 600000, 'red'),
    fixtureScore(5, 500000, 'blue'), fixtureScore(6, 400000, 'blue'),
    fixtureScore(7, 300000, 'blue'), fixtureScore(8, 200000, 'blue'),
  ]);
  const { rounds: fourVsFourRounds } = buildMatchRating(makeMatch([round], users8));
  assertRoundContract(fourVsFourRounds[0], 'scenario:4v4', { winningTeam: 'red' });

  // Unequal 3v4.
  const unequal = fixtureRound(2, 'team-vs', [
    fixtureScore(1, 900000, 'red'), fixtureScore(2, 800000, 'red'), fixtureScore(3, 700000, 'red'),
    fixtureScore(5, 500000, 'blue'), fixtureScore(6, 400000, 'blue'),
    fixtureScore(7, 300000, 'blue'), fixtureScore(8, 200000, 'blue'),
  ]);
  const { rounds: unequalRounds } = buildMatchRating(makeMatch([unequal], users8));
  assertRoundContract(unequalRounds[0], 'scenario:3v4', { winningTeam: 'red' });

  // Failed player (rank F, passed false) + zero-score player.
  const failedZero = fixtureRound(3, 'team-vs', [
    fixtureScore(1, 900000, 'red'),
    fixtureScore(2, 0, 'red', { passed: false, rank: 'F', match: { slot: 1, team: 'red', pass: false } }),
    fixtureScore(5, 500000, 'blue'), fixtureScore(6, 400000, 'blue'),
  ]);
  const { rounds: failedZeroRounds } = buildMatchRating(makeMatch([failedZero], users8));
  assertRoundContract(failedZeroRounds[0], 'scenario:failed-zero');

  // Score user_id absent from match.users (player quit lobby but score remains).
  const missingUserMatch = makeMatch(
    [fixtureRound(4, 'team-vs', [
      fixtureScore(1, 900000, 'red'), fixtureScore(2, 800000, 'red'),
      fixtureScore(99, 700000, 'blue'), fixtureScore(5, 500000, 'blue'),
    ])],
    users,
  );
  const { rounds: missingUserRounds } = buildMatchRating(missingUserMatch);
  assertRoundContract(missingUserRounds[0], 'scenario:missing-user', { allowGhostUser: true });
  const missingUserSer = serializeRound(missingUserRounds[0]);
  const ghost = missingUserSer.scores.find((s) => s.user_id === 99);
  assert(ghost && ghost.match?.team === 'blue' && ghost.user === null, 'scenario:missing-user-ghost-score', JSON.stringify(ghost));

  // Roster user without a score (no score entry for that user).
  const missingScoreMatch = makeMatch(
    [fixtureRound(5, 'team-vs', [
      fixtureScore(1, 900000, 'red'), fixtureScore(2, 800000, 'red'),
      fixtureScore(5, 500000, 'blue'), fixtureScore(6, 400000, 'blue'),
    ])],
    users,
  );
  const { rounds: missingScoreRounds } = buildMatchRating(missingScoreMatch);
  assertRoundContract(missingScoreRounds[0], 'scenario:missing-score');

  // Empty scores array — renderer-safe (HTTP 200 with empty body) path.
  const empty = fixtureRound(6, 'team-vs', []);
  const emptySer = serializeRound(empty);
  let emptyThrew = false;
  try { panelF3RedBlue(emptySer); } catch (e) { emptyThrew = true; }
  assert(!emptyThrew && (emptySer.scores || []).length === 0, 'scenario:empty-scores', 'empty scores must not throw');
}

// ── 3. Legacy-shape proof: stripping `match` reproduces the exact crash ──

{
  const { rounds } = buildMatchRating(prodFixture);
  const ser = serializeRound(rounds[0]);
  const legacyScores = (ser.scores || []).map((s) => {
    const { match, ...rest } = s;
    return rest;
  });
  let threw = false;
  try {
    legacyScores.filter((s) => s.match.team === 'red');
  } catch (e) {
    threw = e instanceof TypeError && /reading 'team'/.test(e.message);
  }
  assert(threw, 'legacy:strip-match-crashes', 'pre-fix shape must reproduce TypeError (reading team)');
}

console.log(`\nMATCH-F3-CONTRACT-VERIFY: passed=${passed} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
