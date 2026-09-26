import assert from 'node:assert/strict';

import {
  buildOneLineReviewFacts,
  buildOneLineReviewPrompt,
  buildOneLineReviewStyleQuery,
  classifyGlobalRank,
  fallbackOneLineReview,
  findCopiedStyleFragment,
  normalizeOneLineReview,
  validateOneLineReview,
} from '../server/osu/oneLineReview.ts';

const user = {
  id: 42,
  username: 'FixturePlayer',
  statistics: {
    pp: 12345,
    global_rank: 123,
    hit_accuracy: 98.76,
  },
};

function score(index, { mods = ['HD'], accuracy = 0.985, pp = 500 - index, stars = 7.2 } = {}) {
  return {
    id: index,
    mods,
    accuracy,
    pp,
    modded_star_rating: stars,
    star_rating_source: 'modded',
    beatmap: { id: 1000 + index, difficulty_rating: stars },
  };
}

const bestScores = Array.from({ length: 20 }, (_, index) => score(index));
const recentScores = Array.from({ length: 8 }, (_, index) => score(100 + index, {
  mods: [],
  accuracy: 0.965,
  stars: 6.1,
  pp: 320 - index,
}));
const facts = buildOneLineReviewFacts({ user, bestScores, recentScores, mode: 'osu' });

assert.equal(facts.primarySignal, 'mod_dependency');
assert.equal(facts.rankTier, 'elite_three_digit');
assert.equal(classifyGlobalRank(1).rankTier, 'world_title_contender');
assert.equal(classifyGlobalRank(950).rankTier, 'three_digit');
assert.equal(classifyGlobalRank(2500).rankTier, 'top_four_digit');
assert.equal(classifyGlobalRank(7500).rankTier, 'four_digit');
assert.equal(classifyGlobalRank(75_000).rankTier, 'five_digit');
assert.equal(facts.modCounts[0].label, 'HD');
assert.equal(facts.modCounts[0].count, 20);
assert.match(buildOneLineReviewStyleQuery(facts), /HD/);

const excerpts = ['S1 手感确实一坨\nS2 还几把99acc'];
const prompt = buildOneLineReviewPrompt(facts, excerpts);
assert.match(prompt.system, /社区语料只用于学习/);
assert.match(prompt.user, /手感确实一坨/);
assert.doesNotMatch(prompt.user, /PP\+ 六维|完整玩家分析|osu!oracle/);

const normalized = normalizeOneLineReview('锐评：第一句。\n第二句！第三句？');
assert.equal(normalized, '第一句。第二句！');
assert.deepEqual(validateOneLineReview('这份BP偏科得连遮羞布都懒得留。'), []);
assert.deepEqual(validateOneLineReview('20张HD把BP焊死在7.20★。', facts), []);
assert.deepEqual(validateOneLineReview('20张HD把BP焊死了。', facts), ['insufficient_evidence_kinds']);
assert.equal(
  findCopiedStyleFragment('手感确实一坨还几把99acc。', excerpts),
  '手感确实一坨还几',
);
assert.equal(findCopiedStyleFragment('这份BP偏科得连遮羞布都懒得留。', excerpts), null);

const fallback = fallbackOneLineReview(facts);
assert.equal(fallback.includes('\n'), false);
assert.deepEqual(validateOneLineReview(fallback, facts), []);
assert.match(fallback, /HD|偏科/);

console.log('osu one-line review verify: ok');
