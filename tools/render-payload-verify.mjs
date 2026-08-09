import assert from 'node:assert/strict';
import { buildYumuScore, buildYumuUser } from '../server/bots/render.ts';

const user = {
  id: 123,
  username: 'ProtocolTest',
  avatar_url: 'https://example.invalid/avatar.png',
  country_code: 'CN',
  country: { code: 'CN', name: 'China' },
  join_date: '2020-01-01T00:00:00Z',
  rank_history: { mode: 'osu', data: [1000, 900] },
  statistics: {
    pp: 10_000,
    global_rank: 6_000,
    country_rank: 80,
    hit_accuracy: 98.75,
    play_count: 50_000,
    play_time: 3_600,
    total_hits: 1_000_000,
    level: { current: 101, progress: 25 }
  }
};

const score = {
  id: 456,
  user_id: 123,
  mode: 'osu',
  pp: 500.25,
  accuracy: 0.9875,
  max_combo: 1200,
  score: 987_654,
  rank: 'S',
  mods: ['HD', 'DT'],
  created_at: '2026-01-01T00:00:00Z',
  statistics: {
    count_300: 1000,
    count_100: 10,
    count_50: 1,
    count_miss: 2
  },
  beatmap: {
    id: 789,
    beatmapset_id: 790,
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
    id: 790,
    title: 'A Song',
    artist: 'An Artist',
    creator: 'A Mapper',
    covers: { 'list@2x': 'https://example.invalid/list.jpg' },
    status: 'ranked'
  },
  modded_star_rating: 7.48,
  star_rating_source: 'modded'
};

const yumuUser = buildYumuUser(user);
assert.equal(yumuUser.pp, 10_000);
assert.equal(yumuUser.global_rank, 6_000);
assert.equal(yumuUser.accuracy, 98.75);
assert.equal(yumuUser.level_current, 101);
assert.equal(yumuUser.statistics.level_current, 101);
assert.equal(yumuUser.statistics.play_time, 3_600, 'play_time must remain seconds');

const yumuScore = await buildYumuScore(score, user);
assert.equal(yumuScore.beatmap.difficulty_rating, 7.48, 'rendered star rating must be Mod-adjusted');
assert.equal(yumuScore.beatmap.original_rating, 4.9, 'base star rating is retained only as the original value');
assert.equal(yumuScore.beatmapset.title, 'A Song', 'beatmapset must exist at score level');
assert.equal(yumuScore.beatmap.beatmapset.title, 'A Song');
assert.equal(yumuScore.accuracy, 0.9875, 'score accuracy must remain a 0..1 ratio');
assert.equal(yumuScore.legacy_accuracy, 0.9875);
assert.equal(yumuScore.statistics.great, 1000);
assert.equal(yumuScore.statistics.ok, 10);
assert.equal(yumuScore.statistics.meh, 1);
assert.equal(yumuScore.statistics.miss, 2);
assert.equal(yumuScore.maximum_statistics.great, 1313);
assert.equal(yumuScore.legacy_rank, 'S');

console.log('render payload verify passed');
