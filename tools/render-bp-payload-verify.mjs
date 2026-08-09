import assert from 'node:assert/strict';
import { buildYumuBestScoresPayload, buildYumuUser } from '../server/bots/render.ts';

const user = {
  id: 123,
  username: 'PayloadTest',
  avatar_url: 'https://example.invalid/avatar.png',
  cover_url: 'https://example.invalid/cover.png',
  country_code: 'CN',
  country: { code: 'CN', name: 'China' },
  statistics: {
    pp: 10_000,
    global_rank: 6_000,
    country_rank: 80,
    hit_accuracy: 98.75,
    play_count: 50_000,
    play_time: 3_600,
    total_hits: 1_000_000,
    level: { current: 101, progress: 25 }
  },
  // A real /users response contains many fields. This verifies that the full
  // profile is not repeated in every score as if it were a MicroUser.
  badges: Array.from({ length: 100 }, (_, id) => ({
    id,
    description: 'x'.repeat(200)
  })),
  // Real /users responses carry the player's profile page as raw HTML; it can
  // be ~80-100 KiB and must never be shipped into a render payload.
  page: '<html>' + 'x'.repeat(100 * 1024) + '</html>',
  user_achievements: Array.from({ length: 60 }, (_, id) => ({ id, name: `Achievement ${id}` })),
  monthly_playcounts: Array.from({ length: 120 }, (_, id) => ({ start_date: `2025-${id}`, count: 999 })),
  matchmaking_stats: [{ rating: 1234 }],
  account_history: [{ type: 'note', description: 'x'.repeat(2000) }],
  team: { id: 1, name: 'Test Team' }
};

const score = (id, pp, rank, mods, stars) => ({
  id,
  user_id: user.id,
  mode: 'osu',
  pp,
  accuracy: 0.9875,
  max_combo: 1200,
  score: 987_654,
  rank,
  mods,
  created_at: '2026-01-01T00:00:00Z',
  statistics: {
    count_300: 1000,
    count_100: 10,
    count_50: 1,
    count_miss: 2
  },
  beatmap: {
    id,
    beatmapset_id: id + 1,
    mode: 'osu',
    difficulty_rating: 4.9,
    version: 'Insane',
    accuracy: 8.5,
    ar: 9,
    cs: 4,
    drain: 6,
    bpm: 180,
    max_combo: 1300,
    count_circles: 700,
    count_sliders: 600,
    count_spinners: 13
  },
  beatmapset: {
    id: id + 1,
    title: `Song ${id}`,
    artist: 'Artist',
    creator: 'Mapper',
    covers: { 'list@2x': 'https://example.invalid/list.jpg' },
    status: 'ranked'
  },
  modded_star_rating: stars,
  star_rating_source: 'modded'
});

const scores = Array.from({ length: 10 }, (_, index) => score(
  1001 + index,
  500 - index * 10,
  index === 1 ? 'SSH' : 'S',
  index % 2 === 0 ? ['HD', 'HR'] : ['HD'],
  7.4 - index * 0.02
));

const payload = await buildYumuBestScoresPayload(user, scores, {
  startRank: 6,
  compact: false
});

assert.equal(payload.panel, 'BS');
assert.equal(payload.compact, false);
assert.deepEqual(payload.rank, [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
assert.equal(payload.history_user, null);
assert.equal(payload.scores.length, 10);
assert.equal(payload.scores[0].legacy_accuracy, 0.9875);
assert.equal(payload.scores[0].beatmap.difficulty_rating, 7.4);
assert.equal(payload.scores[0].beatmap.original_rating, 4.9);
assert.equal(payload.scores[0].beatmapset_id, 1002);
assert.equal(payload.scores[0].beatmap.mode_int, 0);
assert.deepEqual(
  payload.scores[0].mods.map((mod) => mod.acronym),
  ['HD', 'HR'],
  'panel_A4 requires LazerMod objects rather than legacy string Mods'
);
assert.equal(payload.scores[0].user.username, 'PayloadTest');
assert.equal(payload.scores[0].user.badges, undefined, 'scores must carry MicroUser, not a full user profile');
assert(payload.user.badges.length === 100, 'the full user belongs only in the panel header');
assert.equal(payload.user.page, undefined, 'user page HTML must be stripped from render payloads');
assert(
  Buffer.byteLength(JSON.stringify(payload), 'utf8') < 128 * 1024,
  'a normal BP payload must fit the renderer request limit'
);

const compactUser = buildYumuUser(user, { panelCompact: true });
assert.equal(compactUser.page, undefined);
assert.equal(compactUser.user_achievements, undefined);
assert.equal(compactUser.monthly_playcounts, undefined);
assert.equal(compactUser.matchmaking_stats, undefined);
assert.equal(compactUser.account_history, undefined);
assert.equal(compactUser.team, undefined);
assert.equal(compactUser.statistics.pp, 10_000, 'compact user keeps the fields panels need');

const hundred = Array.from({ length: 100 }, (_, index) => score(3000 + index, 400 - index, 'S', ['HD'], 7));
const payload100 = await buildYumuBestScoresPayload(user, hundred, { startRank: 1, compact: true });
assert.equal(payload100.compact, true, 'official !bs style must request the compact five-column panel');
assert.equal(payload100.scores.length, 100, 'a 100-score request stays in a single panel');
assert(
  Buffer.byteLength(JSON.stringify(payload100), 'utf8') < 4 * 1024 * 1024,
  'a 100-score payload must fit the 4 MiB render task limit',
);

console.log('render BP payload verify passed');
