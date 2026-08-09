// osu! offline fixture verification — validates analyzer with PP+ bars + reference system.

import {
  analyzeData,
  buildAnalysisEditorPrompt,
  buildAnalysisPrompt,
  buildAnalysisRepairPrompt,
  buildAnalysisReviewerPrompt,
  buildAnalysisSectionCommentsPrompt,
  findConclusionSectionReuse,
  findAnalysisStyleReuse,
  parseAnalysisSectionComments,
  parsePartialAnalysisSectionComments,
  sanitizeAnalysisSectionComments,
  validateAnalysisSectionComments,
  validateAnalysisReport,
  validatePippiComment,
} from '../server/osu/analyzer.js';
import { ppToBars } from '../server/osu/pplus.js';
import {
  applyReviewerHardFallbacks,
  buildRecentReport,
  buildAnalysisStyleAvoidance,
  OSU_ANALYSIS_MODEL,
  osuBindingMatchesUser,
  resolveOsuBindingValue,
} from '../server/osu/commands.js';
import { buildPippiPrompt } from '../server/bot/persona.js';
import { buildOsuTopicKnowledge } from '../server/osu/knowledge/index.js';
import { findModSemanticsViolation, splitModCombination } from '../server/osu/wikiKnowledge.js';
import { scoreStarRating } from '../server/osu/scoreMetrics.js';
import { ok as assert } from 'node:assert/strict';

const fixture = {
  user: {
    id: 10000001, username: '[TST]Alpha', country_code: 'CN',
    join_date: '2023-01-15T00:00:00+00:00',
    grade_counts: { ssh: 12, ss: 85, sh: 23, s: 340, a: 1200 },
    statistics: {
      level: { current: 101, progress: 48 },
      global_rank: 6210, country_rank: 87,
      pp: 10285.6, ranked_score: 8500000000, total_score: 45000000000,
      total_hits: 12000000, hit_accuracy: 98.80,
      play_count: 15420, play_time: 3400000, maximum_combo: 2345,
      replays_watched_by_others: 340, is_ranked: true,
      grade_counts: { ss: 85, s: 340, a: 1200 }
    }, follower_count: 56, support_level: 0
  },
  bestScores: [
    { id: 1, accuracy: 0.9875, max_combo: 1234, mods: ['HD','HR'], pp: 563.9, score: 15000000, rank: 'S',
      statistics: { count_50: 0, count_100: 12, count_300: 345, count_geki: 23, count_katsu: 5, count_miss: 0 },
      beatmap: { id: 1001, difficulty_rating: 6.60, version: 'Insane', mode: 'osu', ar: 9.5, bpm: 200, cs: 4, total_length: 240, hit_length: 180, count_circles: 300, count_sliders: 80, count_spinners: 5 },
      beatmapset: { id: 5001, title: 'Humiliation Supreme', artist: 'Camellia', creator: 'Mapper1' },
      created_at: '2026-06-15T00:00:00Z', user_id: 10000001, mode: 'osu' },
    { id: 2, accuracy: 0.9812, max_combo: 987, mods: ['HD'], pp: 541.6, score: 14200000, rank: 'S',
      statistics: { count_50: 1, count_100: 18, count_300: 290, count_geki: 18, count_katsu: 8, count_miss: 1 },
      beatmap: { id: 1002, difficulty_rating: 6.86, version: 'Another', mode: 'osu', ar: 9.8, bpm: 240, cs: 4.2, total_length: 200, hit_length: 150, count_circles: 250, count_sliders: 60, count_spinners: 3 },
      beatmapset: { id: 5002, title: 'Sidetracked Day', artist: 'DJ Sharpnel', creator: 'Mapper2' },
      created_at: '2026-06-10T00:00:00Z', user_id: 10000001, mode: 'osu' },
    { id: 3, accuracy: 0.9650, max_combo: 1567, mods: ['HD','DT'], pp: 315.2, score: 13500000, rank: 'A',
      statistics: { count_50: 3, count_100: 28, count_300: 410, count_geki: 30, count_katsu: 12, count_miss: 2 },
      beatmap: { id: 1003, difficulty_rating: 5.89, version: 'Expert', mode: 'osu', ar: 9, bpm: 180, cs: 4, total_length: 300, hit_length: 220, count_circles: 400, count_sliders: 90, count_spinners: 8 },
      beatmapset: { id: 5003, title: 'Dragon Night', artist: 'ZUN', creator: 'Mapper3' },
      created_at: '2026-05-20T00:00:00Z', user_id: 10000001, mode: 'osu' },
    { id: 4, accuracy: 0.9934, max_combo: 423, mods: [], pp: 298.7, score: 9800000, rank: 'SS',
      statistics: { count_50: 0, count_100: 5, count_300: 150, count_geki: 8, count_katsu: 2, count_miss: 0 },
      beatmap: { id: 1004, difficulty_rating: 4.85, version: 'Hard', mode: 'osu', ar: 8, bpm: 160, cs: 3.5, total_length: 180, hit_length: 120, count_circles: 150, count_sliders: 30, count_spinners: 2 },
      beatmapset: { id: 5004, title: 'Blue Zenith', artist: 'xi', creator: 'Mapper4' },
      created_at: '2026-04-01T00:00:00Z', user_id: 10000001, mode: 'osu' },
    { id: 5, accuracy: 0.9490, max_combo: 890, mods: ['HR'], pp: 285.3, score: 12200000, rank: 'A',
      statistics: { count_50: 5, count_100: 45, count_300: 320, count_geki: 15, count_katsu: 20, count_miss: 3 },
      beatmap: { id: 1005, difficulty_rating: 5.20, version: 'Insane', mode: 'osu', ar: 9.2, bpm: 175, cs: 4, total_length: 250, hit_length: 190, count_circles: 320, count_sliders: 70, count_spinners: 4 },
      beatmapset: { id: 5005, title: 'The Pretender', artist: 'Foo Fighters', creator: 'Mapper5' },
      created_at: '2026-03-15T00:00:00Z', user_id: 10000001, mode: 'osu' },
  ],
  recentScores: [
    { id: 10, accuracy: 0.8780, max_combo: 876, mods: ['HD','HR'], pp: null, score: 11200000, rank: 'A',
      statistics: { count_50: 5, count_100: 32, count_300: 250, count_geki: 12, count_katsu: 6, count_miss: 4 },
      beatmap: { id: 2001, difficulty_rating: 7.41, version: 'Expert', mode: 'osu', ar: 10, bpm: 220, cs: 4.5, total_length: 260, hit_length: 200, count_circles: 350, count_sliders: 75, count_spinners: 3 },
      beatmapset: { id: 6001, title: 'Through The Fire', artist: 'DragonForce', creator: 'Mapper6' },
      created_at: '2026-07-05T10:00:00Z', user_id: 10000001, mode: 'osu' },
    { id: 11, accuracy: 0.8610, max_combo: 654, mods: ['HD','HR'], pp: null, score: 8700000, rank: 'A',
      statistics: { count_50: 8, count_100: 45, count_300: 230, count_geki: 5, count_katsu: 10, count_miss: 6 },
      beatmap: { id: 2002, difficulty_rating: 7.41, version: 'Insane', mode: 'osu', ar: 10.3, bpm: 250, cs: 4.8, total_length: 210, hit_length: 160, count_circles: 280, count_sliders: 55, count_spinners: 2 },
      beatmapset: { id: 6002, title: 'Freedom Dive', artist: 'xi', creator: 'Mapper7' },
      created_at: '2026-07-04T22:00:00Z', user_id: 10000001, mode: 'osu' },
  ],
  mode: 'osu'
};

// Real [TST]Alpha PP+ data for normalization testing
const playerBars = ppToBars({
  pp: 10597, ppAim: 5982,
  ppJumpAim: 3046, ppFlowAim: 5796,
  ppPrecision: 2146, ppSpeed: 2300, ppStamina: 2137, ppAcc: 2938
});

// Test 1: normalizeBars produces correct values
assert(playerBars.flow > playerBars.jump, 'Flow bar should exceed Jump bar for Wuxin');
assert(playerBars.accuracy > 10, 'Accuracy bar should be elite level');
assert(playerBars.jump < 6, 'Jump bar should be relatively low');
assert(playerBars.speed < 5, 'Speed bar should be below expert baseline');
console.log('Test 1 PASS: normalization correct');
console.log('  Flow:', playerBars.flow.toFixed(2), 'Jump:', playerBars.jump.toFixed(2), 'Acc:', playerBars.accuracy.toFixed(2));

// Binding compatibility: old numeric/string values and the current object
// format must all resolve without leaking "[object Object]" into API calls.
assert(resolveOsuBindingValue(10000001) === 10000001);
assert(resolveOsuBindingValue('10000001') === 10000001);
assert(resolveOsuBindingValue('[TST]Alpha') === '[TST]Alpha');
assert(resolveOsuBindingValue({ id: 10000001, username: '[TST]Alpha' }) === 10000001);
assert(resolveOsuBindingValue({ username: '[TST]Alpha' }) === '[TST]Alpha');
assert(resolveOsuBindingValue({}) === null);
assert(osuBindingMatchesUser(10000001, fixture.user));
assert(osuBindingMatchesUser('10000001', fixture.user));
assert(osuBindingMatchesUser('[tst]alpha', fixture.user));
assert(osuBindingMatchesUser({ id: 10000001, username: '[TST]Alpha' }, fixture.user));
assert(!osuBindingMatchesUser({ id: 1, username: 'someone else' }, fixture.user));
console.log('Test 1c PASS: all osu binding formats resolve and self-match');

// Test 1b: raw values above the benchmark are NOT clamped (text consumers need headroom)
const overLimitBars = ppToBars({
  pp: 32000, ppAim: 20000,
  ppJumpAim: 16000, ppFlowAim: 12000,
  ppPrecision: 9000, ppSpeed: 10000, ppStamina: 9000, ppAcc: 6000
});
assert(overLimitBars.jump > 15, 'Jump bar should exceed 15 when raw value is above benchmark');
assert(overLimitBars.flow > 15, 'Flow bar should exceed 15 when raw value is above benchmark');
assert(overLimitBars.accuracy > 15, 'Accuracy bar should exceed 15 when raw value is above benchmark');
console.log('Test 1b PASS: over-benchmark bars keep headroom');
console.log('  Jump:', overLimitBars.jump.toFixed(2), 'Flow:', overLimitBars.flow.toFixed(2), 'Acc:', overLimitBars.accuracy.toFixed(2));

// Test 2: analyzeData with PP+ bars
const output = analyzeData({ ...fixture, pplusBars: playerBars, refBars: [] });
const sections = ['profile', 'ppBreakdown', 'modsProfile', 'starDistribution', 'accuracyProfile', 'timeProfile', 'gradeProfile', 'recentForm', 'pplusSection', 'safeFacts', 'safeBody', 'safePippiFallback', 'safeFallback'];
for (const key of sections) {
  assert(typeof output[key] === 'string', `${key} should be a string`);
  assert(output[key].length > 0, `${key} should not be empty`);
}
console.log('Test 2 PASS: all sections populated with PP+ data');
assert(output.pplusSection.includes('12.'), 'pplusSection should contain Flow bar value');
assert(output.pplusSection.includes('LazyBot'), 'pplusSection should mention LazyBot normalization');
console.log('Test 3 PASS: PP+ section content');

// Test 4: profile contains expected fields
assert(output.profile.includes('[TST]Alpha'), 'profile should contain username');
assert(output.profile.includes('10285.6'), 'profile should contain PP');
assert(output.profile.includes('6,210'), 'profile should contain rank');
assert(output.profile.includes('98.80%'), 'profile should contain hit_accuracy as percentage');
assert(output.profile.includes('48%'), 'profile should contain level progress');
console.log('Test 4 PASS: profile fields');

// Test 5: buildAnalysisPrompt (now returns { system, user })
const prompt = buildAnalysisPrompt(output, '自然、简短', { playerName: '[TST]Alpha', perspective: 'self' });
assert(typeof prompt.system === 'string', 'should have system prompt');
assert(typeof prompt.user === 'string', 'should have user prompt');
assert(prompt.system.includes('pippi'), 'system prompt should contain pippi identity');
assert(prompt.system.includes('osu!'), 'system prompt should mention osu!');
assert(prompt.system.includes('身份存在于语气里'), 'system prompt should keep identity in prose instead of a fixed signature');
assert(prompt.system.includes('发起者已绑定到本次分析账号'), 'system prompt should describe self-analysis perspective');
assert(prompt.user.includes('PP+'), 'user prompt should mention PP+');
assert(prompt.system.includes('Recent 与 BP 样本性质不同'), 'system prompt should constrain recent-vs-BP inference');
assert(prompt.system.includes('谱面（beatmap）和成绩（score）是不同对象'), 'system prompt should include osu! Wiki score/beatmap grounding');
assert(prompt.system.includes('Best Performance'), 'system prompt should ground BP terminology');
assert(prompt.user.includes('<verified_facts>'), 'user prompt should delimit verified facts');
assert(!prompt.user.includes('Humiliation Supreme'), 'verified prompt should not expose map titles');
assert(prompt.user.length > 500, 'user prompt should be long enough');
console.log('Test 5 PASS: analysis prompt with pippi persona');

// Test 6: no PP+ data (graceful degradation)
const noPP = analyzeData({ ...fixture, pplusBars: null, refBars: [] });
assert(noPP.pplusSection.includes('不可用'), 'should note PP+ unavailable');
console.log('Test 6 PASS: PP+ unavailable handling');

// Test 7: reference bars in prompt
const refOutput = analyzeData({
  ...fixture,
  pplusBars: playerBars,
  refBars: [{ label: 'oliwakami', bars: { ...playerBars, jump: 10.85, flow: 10.04 } }]
});
const refPrompt = buildAnalysisPrompt(refOutput, '人设');
assert(refPrompt.user.includes('参考'), 'prompt should include reference data');
console.log('Test 7 PASS: reference player handling');

// Test 8: editor prompt + deterministic validation/fallback
const editorPrompt = buildAnalysisEditorPrompt(output, { playerName: '[TST]Alpha', perspective: 'self' });
assert(editorPrompt.system.includes('只输出【结论】节点'), 'editor prompt should only request the final conclusion node');
assert(
  editorPrompt.system.includes('pippi 是一名活泼、自信、反应很快的少女')
    && editorPrompt.system.includes('Auto 是她熟悉的完美世界'),
  'editor prompt should include the compact pippi analysis identity',
);
assert(editorPrompt.system.includes('当前场景：osu! 玩家分析'), 'editor prompt should include osu analysis scene');
assert(editorPrompt.user.includes('<verified_facts>'), 'editor prompt should include verified facts');
assert(editorPrompt.user.includes('BP 样本成熟度:'), 'editor prompt must retain concrete sample-maturity boundaries');
assert(editorPrompt.user.includes('BP 准确率判读:'), 'editor prompt must retain concrete accuracy boundaries');
assert(editorPrompt.user.includes('PP+ 解释权限:'), 'editor prompt must retain PP+ interpretation boundaries');
assert(!editorPrompt.user.includes('<draft>'), 'editor prompt should not anchor the model to deterministic fallback prose');
assert.equal(OSU_ANALYSIS_MODEL, 'deepseek-v4-flash', 'osu analysis should use the production V4 Flash model');
assert(validatePippiComment(output, output.safePippiFallback).ok, 'deterministic conclusion should pass validation');
const fallbackValidation = validateAnalysisReport(output, output.safeFallback);
if (!fallbackValidation.ok) console.error('Fallback validation reasons:', fallbackValidation.reasons);
assert(fallbackValidation.ok, 'deterministic fallback should pass validation');
const reviewerFallback = applyReviewerHardFallbacks(
  output,
  { ...output.safeSectionFallbacks, top5: '这是一条会被事实审查拒绝的 LLM 短评。' },
  '【结论】这是一条会被事实审查拒绝的 LLM 结论。',
  [
    { section: 'top5', kind: 'hard', reason: 'BP5 Mod 数量矛盾' },
    { section: 'conclusion', kind: 'hard', reason: '结论事实矛盾' },
  ],
);
assert(reviewerFallback.comments?.top5 === output.safeSectionFallbacks.top5, 'reviewer hard reject must replace only the rejected section');
assert(reviewerFallback.comments?.profile === output.safeSectionFallbacks.profile, 'reviewer fallback must preserve passing sections');
assert(reviewerFallback.conclusion === output.safePippiFallback, 'reviewer hard reject must replace a rejected conclusion');
assert(reviewerFallback.downgradedSections.length === 1 && reviewerFallback.downgradedSections[0] === 'top5', 'reviewer fallback must report the downgraded section');
assert(reviewerFallback.conclusionDowngraded && !reviewerFallback.unknownHardSection, 'known reviewer sections must degrade locally');
const unknownReviewerFallback = applyReviewerHardFallbacks(
  output,
  { ...output.safeSectionFallbacks },
  output.safePippiFallback,
  [{ section: 'unexpected', kind: 'hard', reason: 'unknown section' }],
);
assert(unknownReviewerFallback.unknownHardSection, 'unknown reviewer section must force whole-report safety fallback');
assert(!output.safeFallback.includes('不失误只是默认状态'), 'fallback should not belittle players with Auto standards');
assert(output.safeFallback.includes('【账号档案 · std】'), 'full report should include account profile');
assert(output.safeFallback.includes('【BP5】'), 'full report should include BP5');
assert(!output.safeFallback.includes('【Top'), 'visible report should not use Top as the BP label');
assert(output.safeFallback.includes('【Mods】'), 'full report should include mod statistics');
assert(output.safeFallback.includes('Precision'), 'full report should include all PP+ dimensions');
assert(!output.safeFallback.includes('【数据边界】'), 'full report should keep evidence boundaries internal');
assert(output.safeFacts.includes('未提供 replay'), 'internal facts should retain the evidence boundary');
assert(output.safeFallback.includes('【结论】'), 'full report should include a conclusion');
assert(!/pippi\s*[：:]|【pippi/i.test(output.safeFallback), 'visible report should not repeat the sender identity');
assert(!output.safeBody.includes('别再把自己算作普通路人'), 'deterministic body should not inject canned persona lines');
assert(output.safeFallback.length > 500, 'full report should preserve comprehensive information');
assert(!/不是[^。\n]{0,40}(?:而是|只是|是)|并非[^。\n]{0,40}(?:而是|只是|是)|不只是[^。\n]{0,40}(?:更是|还)|不仅[^。\n]{0,40}(?:而且|还|也)|不等于|与其[^。\n]{0,40}不如/.test(output.safeFallback), 'fallback should avoid binary contrast phrasing');
assert(!validatePippiComment(output, '【结论】\n全球排名 #6,210。最近就是在练图，所以这份差值很正常。').ok, 'unsupported practice story should fail component validation');
assert(!validatePippiComment(output, '【结论】\n全球排名 #6,210。当前波动是 1.41%，这就是账号的主要特征。').ok, 'unknown derived number should fail component validation');
assert(!validatePippiComment(output, '【结论】\n全球排名 #6,210。这是一张自带 HD 的隐身图，所以当前成绩构成很鲜明。').ok, 'HD must belong to the play, not the beatmap');
assert.deepEqual(splitModCombination('NFSO'), ['NF', 'SO'], 'combined mod label should be decomposed generically');
assert.deepEqual(splitModCombination('HDHRDT'), ['HD', 'HR', 'DT'], 'multi-mod label should be decomposed generically');
assert(findModSemanticsViolation('这是张 HR 图。'), 'HR must not be assigned to the beatmap');
assert(findModSemanticsViolation('这张谱面自带 NFSO。'), 'combined mods must not be assigned to the beatmap');
assert(!validatePippiComment(
  output,
  '【结论】\n这是一个 HD/HDHR 主导的高准确率玩家。HD 与 HDHR 合计占 BP 成绩 96%，Flow 与 Accuracy 显示最高。\n数据告诉我，你的潜能藏在每一页成绩里。'
).ok, 'unsupported ability inference should fail validation');
// Validator no longer rejects neutral-but-factual conclusions, digits, PP+
// synthesis, contrast phrasing, questions, or stage-parentheses.
assert(validatePippiComment(
  output,
  '【结论】\n全球排名 #6,210。BP5 平均 5.88★，最高 563.9pp，HDHR 组合 1 张；Recent 与 BP 有可见差异，原因未知。这份记录值得多看两眼，也值得认真夸一句。'
).ok, 'plain factual conclusion should pass validation');
assert(validatePippiComment(
  output,
  '【结论】\n全球排名 #6,210。PP+ 最高两项为 Flow 与 Accuracy，最低项为 Speed，六维均在 15 基准线以内；BP5 与 HD 构成另有对照。这份记录值得多看两眼，也愿意认真夸一句。'
).ok, 'conclusion may synthesize PP+ dimensions');
assert(validatePippiComment(
  output,
  '【结论】\n全球排名 #6,210。BP 的准确率覆盖、BP5 与 HD 构成已经形成可见观察。这不是普通的稳定，而是真正的强大。我很喜欢，想再多看两眼，也愿意认真夸一句。'
).ok, 'contrast phrasing alone should not fail validation');
assert(validatePippiComment(
  output,
  '【结论】\n全球排名 #6,210。BP 的准确率覆盖是不是很显眼？HDDT 是否集中？Recent 的差异又该怎么看？这些数字值得认真夸一句。'
).ok, 'multiple questions should not fail validation');
assert(validatePippiComment(
  output,
  '【结论】\n全球排名 #6,210。BP 的准确率覆盖、BP5 与 HD 构成都有可见信息。这批成绩很干净（挑眉）。我很喜欢，想再多看两眼，也愿意认真夸一句。'
).ok, 'stage parentheses should not fail validation');
console.log('Test 8 PASS: fact editor validation and safe fallback');

// Test 9: compact Recent report uses full-analysis baseline
const recentReport = buildRecentReport(fixture.user, fixture.recentScores, {
  baseline: {
    topAverageStars: 6.55,
    topAverageAcc: 0.9862,
  }
});
assert(recentReport.includes('【近期 2 次】'), 'recent report should use compact QQ heading');
assert(recentReport.includes('【完整档案对照】'), 'recent report should include full-analysis baseline');
assert(recentReport.includes('【结论】'), 'recent report should include a conclusion');
assert(!/pippi\s*[：:]|【pippi/i.test(recentReport), 'recent report should not repeat the sender identity');
assert(!recentReport.includes('【PP+】'), 'recent report should not repeat PP+');
assert(recentReport.length < 400, 'recent report should fit in one QQ message');
console.log('Test 9 PASS: compact Recent report');

// Test 10: analyzer must prefer official Mod-adjusted star rating over base beatmap stars
const moddedScore = {
  ...fixture.bestScores[0],
  beatmap: { ...fixture.bestScores[0].beatmap, difficulty_rating: 5.10 },
  mods: ['DT'],
  modded_star_rating: 7.25,
  star_rating_source: 'modded',
};
assert.equal(scoreStarRating(moddedScore), 7.25, 'verified Mod-adjusted stars should win over base stars');
const moddedOutput = analyzeData({
  ...fixture,
  bestScores: [moddedScore],
  recentScores: [],
  pplusBars: playerBars,
  refBars: [],
});
assert(moddedOutput.safeFallback.includes('7.25★'), 'visible report should use official Mod-adjusted stars');
assert.equal(
  scoreStarRating({ ...moddedScore, modded_star_rating: undefined, star_rating_source: 'unavailable' }),
  0,
  'failed Mod attribute lookup must not fall back to base stars'
);
console.log('Test 10 PASS: official Mod-adjusted star rating precedence');

// Test 11: fixed regression profiles — extreme, mid, sparse, and validator scope
const makeUser = (overrides) => ({
  ...fixture.user,
  ...overrides,
  statistics: { ...fixture.user.statistics, ...(overrides?.statistics || {}) },
});
const makeScore = (base, overrides) => ({
  ...base,
  ...overrides,
  beatmap: { ...base.beatmap, ...(overrides?.beatmap || {}) },
  beatmapset: { ...base.beatmapset, ...(overrides?.beatmapset || {}) },
});

const mrekkFixture = {
  ...fixture,
  user: makeUser({
    id: 7562902, username: 'mrekk', country_code: 'AU', join_date: '2015-12-13T00:00:00+00:00',
    grade_counts: { ssh: 56, ss: 36, sh: 1453, s: 379, a: 2522 },
    statistics: { global_rank: 1, country_rank: 1, pp: 32138.7, hit_accuracy: 98.2565, play_count: 240107, maximum_combo: 3000 },
  }),
  bestScores: [
    makeScore(fixture.bestScores[0], { id: 101, accuracy: 0.9744, mods: ['HD', 'DT'], pp: 1857.1, beatmap: { difficulty_rating: 12.14, version: "Meal's Ultra" } }),
    makeScore(fixture.bestScores[1], { id: 102, accuracy: 0.9818, mods: ['HD', 'NC'], pp: 1781.7, beatmap: { difficulty_rating: 13.23 } }),
    makeScore(fixture.bestScores[2], { id: 103, accuracy: 0.9908, mods: ['HD', 'DT'], pp: 1771.5, beatmap: { difficulty_rating: 12.45 } }),
    makeScore(fixture.bestScores[3], { id: 104, accuracy: 0.9891, mods: ['HD', 'DT'], pp: 1747.9, beatmap: { difficulty_rating: 11.73 } }),
    makeScore(fixture.bestScores[4], { id: 105, accuracy: 0.9670, mods: ['HD', 'HR', 'NC'], pp: 1723.3, beatmap: { difficulty_rating: 13.55 } }),
  ],
  pplusBars: overLimitBars,
  refBars: [],
};

const mouseFixture = {
  ...fixture,
  user: makeUser({ id: 15119977, username: 'MouseR1ez', statistics: { global_rank: 71, pp: 19349.4 } }),
  pplusBars: null,
  refBars: [],
};

const gnFixture = {
  ...fixture,
  user: makeUser({ id: 895581, username: '-GN', country_code: 'NO', statistics: { global_rank: 1195, pp: 13404.6 } }),
  recentScores: [],
  pplusBars: null,
  refBars: [],
};

const balancedFixture = {
  ...fixture,
  user: makeUser({ id: 7777777, username: 'BalancedPlayer', statistics: { global_rank: 250000, pp: 1450.2 } }),
  bestScores: [
    makeScore(fixture.bestScores[0], { id: 201, accuracy: 0.9721, mods: [], pp: 402.1, beatmap: { difficulty_rating: 5.45 } }),
    makeScore(fixture.bestScores[1], { id: 202, accuracy: 0.9654, mods: [], pp: 388.7, beatmap: { difficulty_rating: 5.62 } }),
    makeScore(fixture.bestScores[2], { id: 203, accuracy: 0.9588, mods: [], pp: 361.2, beatmap: { difficulty_rating: 5.30 } }),
    makeScore(fixture.bestScores[3], { id: 204, accuracy: 0.9490, mods: ['HD'], pp: 342.9, beatmap: { difficulty_rating: 5.18 } }),
    makeScore(fixture.bestScores[4], { id: 205, accuracy: 0.9412, mods: ['HR'], pp: 331.4, beatmap: { difficulty_rating: 5.02 } }),
  ],
  pplusBars: { flow: 8.2, accuracy: 9.1, precision: 7.4, stamina: 6.2, jump: 8.8, speed: 7.0, ppTotal: 1500 },
  refBars: [],
};

const sparseFixture = {
  ...fixture,
  user: makeUser({ id: 8888888, username: 'SparsePlayer', statistics: { global_rank: 0, country_rank: 0, pp: 210.5 } }),
  bestScores: [
    makeScore(fixture.bestScores[0], { id: 301, accuracy: 0.9210, mods: [], pp: 142.3, beatmap: { difficulty_rating: 4.12 } }),
    makeScore(fixture.bestScores[1], { id: 302, accuracy: 0.8870, mods: [], pp: 68.2, beatmap: { difficulty_rating: 3.55 } }),
  ],
  recentScores: [],
  pplusBars: null,
  refBars: [],
};

const assertCleanBody = (out, label) => {
  for (const judgement of ['这种稳定很清楚', '最鲜明的方向已经很清楚', '整体来看是一个', '全部达到 520pp', 'HD 与 HDHR 合计']) {
    assert(!out.safeBody.includes(judgement), `${label}: safeBody must not contain judgement/legacy text: ${judgement}`);
  }
};

const mrekkOut = analyzeData(mrekkFixture);
assertCleanBody(mrekkOut, 'mrekk');
assert(mrekkOut.safeBody.includes('PP 统计：最低 1723.3｜最高 1857.1｜平均 1776.3｜跨度 133.8'), 'mrekk: BP5 PP stats with min/max/avg/span');
assert(mrekkOut.safeBody.includes('包含统计：含 HD 5 张｜含 HR 1 张｜含 DT/NC 5 张｜纯 NM 0 张'), 'mrekk: mod containment statistics');
assert(mrekkOut.safeBody.includes('超出 15 基准线'), 'mrekk: PP+ benchmark excess is visible');
assert(mrekkOut.safePippiFallback.includes('全球排名第 1'), 'mrekk: fallback names rank #1');
assert(mrekkOut.safePippiFallback.includes('超出 15 基准线'), 'mrekk: fallback includes PP+ benchmark excess');
assert(!mrekkOut.safePippiFallback.includes('稳定型玩家'), 'mrekk: fallback must not use fixed "stable player" label');
assert(validateAnalysisReport(mrekkOut, mrekkOut.safeFallback).ok, 'mrekk: deterministic fallback report should pass validation');
console.log('Test 11a PASS: mrekk extreme profile');

const mouseOut = analyzeData(mouseFixture);
assertCleanBody(mouseOut, 'MouseR1ez');
assert(mouseOut.safeBody.includes('这次没有可用数据'), 'MouseR1ez: PP+ unavailable block');
assert(!mouseOut.safePippiFallback.includes('基准线'), 'MouseR1ez: fallback omits PP+ when unavailable');
assert(validateAnalysisReport(mouseOut, mouseOut.safeFallback).ok, 'MouseR1ez: fallback report should pass validation');
console.log('Test 11b PASS: MouseR1ez profile without PP+');

const gnOut = analyzeData(gnFixture);
assertCleanBody(gnOut, '-GN');
assert(gnOut.safeBody.includes('这次 API 没有返回近期记录'), '-GN: empty recent block');
assert(gnOut.safePippiFallback.includes('全球排名 #1,195'), '-GN: fallback keeps rank');
assert(validateAnalysisReport(gnOut, gnOut.safeFallback).ok, '-GN: fallback report should pass validation');
console.log('Test 11c PASS: -GN profile with empty recent and no PP+');

const balancedOut = analyzeData(balancedFixture);
assertCleanBody(balancedOut, 'balanced');
assert(balancedOut.safeBody.includes('含 DT/NC 0 张｜纯 NM 3 张'), 'balanced: mod containment with NM majority');
assert(balancedOut.safePippiFallback.includes('全球排名 #250,000'), 'balanced: fallback keeps rank');
assert(balancedOut.safePippiFallback.includes('均在 15 基准线以内'), 'balanced: fallback reports PP+ within benchmark');
assert(validateAnalysisReport(balancedOut, balancedOut.safeFallback).ok, 'balanced: fallback report should pass validation');
console.log('Test 11d PASS: balanced mid-tier profile');

const sparseOut = analyzeData(sparseFixture);
assertCleanBody(sparseOut, 'sparse');
assert(!sparseOut.safePippiFallback.includes('全球排名'), 'sparse: no rank sentence when unranked');
assert(sparseOut.safePippiFallback.includes('BP2 平均'), 'sparse: fallback still reports available BP stats');
assert(sparseOut.safeBody.includes('这次 API 没有返回近期记录'), 'sparse: empty recent block');
assert(buildAnalysisSectionCommentsPrompt(sparseOut).user.includes('BP 样本成熟度:'), 'sparse generation must see that the BP sample is immature');
assert(buildAnalysisSectionCommentsPrompt(sparseOut).user.includes('Recent 样本: 0次'), 'sparse generation must see the empty-Recent boundary');
const rankedSparseOut = analyzeData({
  ...sparseFixture,
  user: {
    ...sparseFixture.user,
    statistics: {
      ...sparseFixture.user.statistics,
      global_rank: 1557261,
      country_rank: 59347,
      pp: 196.4,
    },
  },
});
const rankedSparseConclusionPrompt = buildAnalysisEditorPrompt(rankedSparseOut);
assert(!rankedSparseConclusionPrompt.user.includes('全球排名 #1,557,261'), 'sparse conclusions must not be forced to interpret a very late rank');
assert(rankedSparseConclusionPrompt.user.includes('账号总 PP 196.4pp'), 'sparse conclusions should use total PP as their weight anchor');
console.log('Test 11e PASS: sparse-data profile');

// Validator scope: kept checks still block real errors.
assert(!validatePippiComment(mrekkOut, '【结论】\nBP 中没有任何 HD 成绩，这份成绩值得多看两眼，也值得认真夸一句。').ok, 'validator: absolute "no HD" claim must still fail');
assert(!validatePippiComment(mrekkOut, '【结论】\n这组数据说明他最近在练图，状态正在上升，值得多看两眼。').ok, 'validator: invented practice/reason must still fail');
assert(!validatePippiComment(mrekkOut, '【结论】\n这位玩家的舒适区在 12★ 以上，我得多看两眼。').ok, 'validator: invented comfort zone must still fail');
assert(!validatePippiComment(mrekkOut, '【结论】\n全球排名第 1，BP5 平均 13.57★，这份成绩值得多看两眼。').ok, 'validator: unknown derived number must still fail');
assert(!validatePippiComment(mrekkOut, '【pippi】\n全球排名第 1，这份成绩值得多看两眼。').ok, 'validator: identity signature must still fail');
assert(!validatePippiComment(mrekkOut, '【结论】\n他是一名高准确率玩家，他的成绩值得多看两眼。').ok, 'validator: gender guess for unknown perspective must still fail');
console.log('Test 11f PASS: validator scope keeps factual/semantic/identity checks');

// Test 12: pippi keeps a compact osu! knowledge core in every scene, while
// detailed knowledge is retrieved only when the current message asks for it.
for (const scene of ['casual', 'command', 'serious', 'osu_analysis']) {
  const personaPrompt = buildPippiPrompt({ scene });
  assert(personaPrompt.includes('谱面保存 BPM'), `${scene}: permanent osu! core knowledge must be present`);
  assert(personaPrompt.includes('Best Performance'), `${scene}: BP terminology must be permanent knowledge`);
}
const ezFlKnowledge = buildOsuTopicKnowledge('EZDT 和 FL 成绩怎么看？');
assert(ezFlKnowledge.includes('EZ 会降低 AR、OD、CS 和 HP'), 'EZ topic should retrieve official semantics');
assert(ezFlKnowledge.includes('FL 会限制可见区域'), 'FL topic should retrieve official semantics');
assert(!buildOsuTopicKnowledge('今天吃什么').includes('当前相关的特殊 Mod 知识'), 'unrelated chat should not receive detailed Mod knowledge');
console.log('Test 12 PASS: permanent core plus topic knowledge routing');

// Test 13: special Mods are counted programmatically and injected into both
// verified facts and the analysis prompt; BP5 counts must remain explicit.
const specialModFixture = {
  ...fixture,
  bestScores: [
    makeScore(fixture.bestScores[0], { mods: ['EZ', 'FL'] }),
    makeScore(fixture.bestScores[1], { mods: ['EZ', 'HD'] }),
    ...fixture.bestScores.slice(2),
  ],
  pplusBars: playerBars,
  refBars: [],
};
const specialModOut = analyzeData(specialModFixture);
assert(specialModOut.safeFacts.includes('EZ 2张｜BP5 中 2张｜平均'), 'EZ count, BP5 count and averages should be verified');
assert(specialModOut.safeFacts.includes('FL 1张｜BP5 中 1张｜平均'), 'FL count, BP5 count and averages should be verified');
assert(specialModOut.knowledgeContext.includes('EZ 会降低 AR、OD、CS 和 HP'), 'analysis should receive EZ semantics');
assert(specialModOut.knowledgeContext.includes('FL 会限制可见区域'), 'analysis should receive FL semantics');
const specialPrompt = buildAnalysisSectionCommentsPrompt(specialModOut, { playerName: '[TST]Alpha', perspective: 'self' });
assert(specialPrompt.system.includes('rank、pp、BP 体量和成绩结构'), 'rank and pp scale must reach section generation');
assert(specialPrompt.user.includes('BP 特殊 Mod 信号'), 'special Mod facts must reach section generation');
console.log('Test 13 PASS: special Mod statistics and prompt injection');

// Test 14: every Analyze is independent. Prior reports must not become hidden
// generation state or mechanically forbid ordinary wording in the next run.
const styleDb = {
  osuAnalyses: [{
    analysisType: 'full',
    osuUserId: 7562902,
    displayName: 'mrekk',
    sectionComments: {
      profile: '全球第一还把两万多 pp 摆在这里，pippi 可要认真看了。',
      top: '十星区挤满 BP，难度栏今天没有给人类留台阶。',
      top5: '五张高位成绩咬得很紧，这个分数带站得很稳。',
      mods: 'DT 系把前排占满了，速度按钮看来很忙。',
      pplus: '六维一起越过基准线，雷达图已经快装不下啦。',
      recent: 'Recent 还在高难区晃，最近也没打算安静。',
      classification: 'aim 占了主要位置，其他分类仍然留下少量分布。',
    },
    conclusionText: '【结论】\n这是站在世界第一位置上的高难 DT 账号，pippi 会把这份档案单独收好。',
  }],
};
const avoidance = buildAnalysisStyleAvoidance(styleDb);
assert.equal(avoidance.recentExpressions.length, 0, 'prior reports must not enter the current Analyze context');
assert.equal(findAnalysisStyleReuse('五张高位成绩咬得很紧，这个分数带站得很稳。', avoidance).length, 0, 'prior wording must not become a cross-run hard gate');
assert.equal(findAnalysisStyleReuse('前半句换成另一组数据。五张高位成绩咬得很紧，这个分数带站得很稳。', avoidance).length, 0, 'current wording must not depend on the order of earlier reports');
assert(findAnalysisStyleReuse('Flow 和 Accuracy 拉开六维差距，串图留下的痕迹很醒目。', avoidance).length === 0, 'unrelated account-specific wording should pass');
assert.equal(findAnalysisStyleReuse('这组数据很整齐，记住了。', avoidance).length, 0, 'style preferences belong to generation/review, not a hard cross-run gate');
const excludedAvoidance = buildAnalysisStyleAvoidance(styleDb, 20, { osuUserId: 7562902, displayName: 'mrekk' });
assert.equal(excludedAvoidance.recentExpressions.length, 0, 'same-player reruns must also be independent');
const cooledPrompt = buildAnalysisEditorPrompt(output, { playerName: '[TST]Alpha', perspective: 'self' }, '', avoidance);
assert(!cooledPrompt.system.includes('全球第一还把两万多 pp 摆在这里'), 'other-player output must never enter the current prompt');
assert(!cooledPrompt.system.includes('mrekk'), 'other-player identity must never enter the current prompt');
console.log('Test 14 PASS: Analyze independence without cross-run style state');

// Test 15: the independent reviewer is factual-only. Literary preferences are
// evaluated by the batch harness, not fed back into production rewrites.
const reviewerPrompt = buildAnalysisReviewerPrompt(output, output.safeFallback, { playerName: '[TST]Alpha', perspective: 'self' });
assert(reviewerPrompt.system.includes('事实质检员'), 'reviewer must identify its factual-only role');
assert(reviewerPrompt.system.includes('只查可证明的基本事实错误'), 'reviewer must not act as a prose editor');
assert(reviewerPrompt.system.includes('基于数据的常识推断'), 'reviewer must allow data-grounded light inference');
assert(!reviewerPrompt.system.includes('kind=quality'), 'reviewer must not emit quality rewrites');
console.log('Test 15 PASS: reviewer is factual-only and preserves reserved curiosity');

// Test 16: targeted section rewrites can return only rejected keys, and every
// analyzer output carries a complete fact-only local fallback map.
const partial = parsePartialAnalysisSectionComments('{"top5":"五张成绩的相邻结构已经重新核对。","mods":"当前 BP 的精确组合与包含统计已分开描述。"}', ['top5', 'mods']);
assert(partial?.top5 && partial?.mods, 'targeted parser should accept exactly the requested section keys');
const plannedPartial = parsePartialAnalysisSectionComments('{"top5":{"evidence":"BP5 相邻差","judgment":"检查孤峰","comment":"头部结构已经按相邻差重新比较。"}}', ['top5']);
assert.equal(plannedPartial?.top5, '头部结构已经按相邻差重新比较。', 'section parser should expose only the planned comment field');
const doubleEncoded = parseAnalysisSectionComments(JSON.stringify({
  profile: JSON.stringify({ evidence: 'rank', judgment: '分量', comment: '账号档案的分量已经单独判断。' }),
  top: { evidence: 'BP', judgment: '覆盖', comment: 'BP 的覆盖和区间已经一起比较。' },
  top5: { evidence: 'BP5', judgment: '孤峰', comment: 'BP5 的相邻差已经重新判断。' },
  mods: { evidence: 'Mods', judgment: '主体', comment: 'Mod 主体与少量例外已经分开。' },
  pplus: { evidence: 'PP+', judgment: '形状', comment: '六维只评价当前相对形状。' },
  recent: { evidence: 'Recent', judgment: '差异', comment: 'Recent 的可见差异保留原因未知。' },
  classification: { evidence: '分类', judgment: '分量', comment: '第一类与第二类的分量已经比较。' },
}));
assert.equal(doubleEncoded?.profile, '账号档案的分量已经单独判断。', 'double-encoded section JSON must be unwrapped before display');
const normalizedCounts = sanitizeAnalysisSectionComments({
  profile: '一百次游玩只是当前体量。', top: '六十八张成绩构成主体。', top5: '五张之间需要比较。',
  mods: '二十六张 HDHRDT 形成可见分量。', pplus: '六维只看相对形状。', recent: '五十条 Recent 仍需和 BP 比较。',
  classification: '七十九张 aim 是当前主体。',
});
assert.equal(normalizedCounts.profile, '100次游玩只是当前体量。', 'Chinese cardinal quantities should normalize to auditable digits');
assert.equal(normalizedCounts.classification, '79张 aim 是当前主体。', 'classification counts should normalize to digits');
const naturalZeroCount = sanitizeAnalysisSectionComments({ ...normalizedCounts, mods: '纯 NM 一张没有，其他组合按精确口径统计。' });
assert.equal(naturalZeroCount.mods, '纯 NM 一张没有，其他组合按精确口径统计。', 'natural zero-count phrasing must not become “1张没有”');
assert(Object.keys(output.safeSectionFallbacks).length === 7, 'all seven section fallbacks must exist');
assert(Object.values(output.safeSectionFallbacks).every(value => String(value).length >= 12), 'section fallbacks must be readable, non-empty facts');
console.log('Test 16 PASS: targeted rewrites and local section fallbacks');

// Test 17: mechanical gates cover the factual regressions found in the first
// Flash batch without turning prose style into a hard requirement.
const baseComments = {
  profile: '全球排名与 pp 已经足够说明当前账号的位置，累计游玩数据也有明确记录。',
  top: 'BP 的星数范围与准确率覆盖需要一起看，不能只拿平均值下结论。',
  top5: 'BP5 的 pp 跨度和 Mod 构成各有内部对照，头名是否孤立要按相邻差判断。',
  mods: '精确组合与包含统计已经分开，当前构成只描述进入 BP 的这些成绩。',
  pplus: '六维内部的相对高低已经拉开，但较低的显示条仍然只是当前形状。',
  recent: 'Recent 与 BP 有可见数值差异，原因没有数据支持，暂时保持未知。',
  classification: '第一类与第二类都保留了分量，当前分类只描述这批 BP。',
};
const onlineTimeComments = { ...baseComments, profile: '这个账号已经积累了很长的在线时长，其他字段也很完整。' };
assert(!validateAnalysisSectionComments(output, onlineTimeComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'play_time must not be renamed online time');
const roundedPlayCountComments = { ...baseComments, profile: '全球排名和 6万次游玩一起看，账号体量已经很清楚。' };
assert(!validateAnalysisSectionComments(output, roundedPlayCountComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'exact play count must not be compressed into Arabic ten-thousand shorthand');
// 2026-08-02 减法：PP+ 能力化/偏好/机制类语义判断从机械 validator 移除，
// 交由 LLM reviewer 审计。以下表达不再触发机械拒绝。
const pplusAbilityComments = { ...baseComments, pplus: 'Speed 是六维最低项，所以速度不是这人的菜。' };
assert(validateAnalysisSectionComments(output, pplusAbilityComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'PP+ ability-style prose is reviewer territory, not a word-list gate');
const pplusTranslatedAbilityComments = { ...baseComments, pplus: 'Jump 和 Accuracy 是六维最高项，所以这是个擅长单点跳跃、点得准的玩家。' };
assert(validateAnalysisSectionComments(output, pplusTranslatedAbilityComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'PP+ translation is reviewer territory');
const pplusMetaphorAbilityComments = { ...baseComments, pplus: '这个六维形状很像短图准、长串吃力的玩家。' };
assert(validateAnalysisSectionComments(output, pplusMetaphorAbilityComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'PP+ shape metaphors are reviewer territory');
const pplusLiveAbilityComments = { ...baseComments, pplus: 'Jump 一柱擎天，Accuracy 垫底，这形状在说爆发优先、容错靠边。' };
assert(validateAnalysisSectionComments(output, pplusLiveAbilityComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'PP+ mechanism prose is reviewer territory');
const wrongBoundPplusValueComments = { ...baseComments, pplus: 'Accuracy 12.01 是六维最高项，Flow 11.39 紧随其后。' };
assert(!validateAnalysisSectionComments(output, wrongBoundPplusValueComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'a valid PP+ number must not be reassigned to another dimension');
const derivedPplusRatioComments = { ...baseComments, pplus: 'Flow 比 Speed 高出近 3 倍，六维形状并不均匀。' };
assert(!validateAnalysisSectionComments(output, derivedPplusRatioComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'PP+ prose must not invent a ratio absent from verified facts');
const modMotivationComments = { ...baseComments, mods: 'NM 是主食，少量 HR 像是偶尔开着玩，至少愿意加压。' };
assert(validateAnalysisSectionComments(output, modMotivationComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'Mod motivation prose is reviewer territory');
const nfPurposeComments = { ...baseComments, mods: '这些 NF 像是开着不死去够更高难度的图。' };
assert(validateAnalysisSectionComments(output, nfPurposeComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'NF purpose prose is reviewer territory');
const historyInferenceComments = { ...baseComments, profile: '这个体量下还能长期保持 98.80% Acc，准确率没有被时间磨掉。' };
assert(validateAnalysisSectionComments(output, historyInferenceComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'history-style prose is reviewer territory');
const derivedYearComments = { ...baseComments, profile: '这个 1 年多的账号已经进入活跃玩家中坚。' };
assert(!validateAnalysisSectionComments(output, derivedYearComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'account age must not be converted into an unverified year shorthand');
const levelHistoryComments = { ...baseComments, profile: '等级 101（48%）说明这个账号还在持续往前推，不是打完就扔的号。' };
assert(validateAnalysisSectionComments(output, levelHistoryComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'level persistence prose is reviewer territory');
const gradeAccRelationComments = { ...baseComments, profile: 'A 有 1200 张、S 只有 340 张，这和总 Acc 98.80% 形成反差。' };
assert(validateAnalysisSectionComments(output, gradeAccRelationComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'grade/Acc relation prose is reviewer territory');
const top5StateStoryComments = { ...baseComments, top5: 'BP5 的分数靠得很近，看起来不像同一次状态打出来的。' };
assert(validateAnalysisSectionComments(output, top5StateStoryComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'BP5 state story is reviewer territory');
const top5MasteryComments = { ...baseComments, top5: 'BP5 最高星那张 Acc 较低，看来还没有完全吃透。' };
assert(validateAnalysisSectionComments(output, top5MasteryComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'BP5 mastery prose is reviewer territory');
const topAccCorrelationComments = { ...baseComments, top: '这批 BP 里更高难度的几张 Acc 明显下降。' };
assert(!validateAnalysisSectionComments(output, topAccCorrelationComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'aggregate star and Acc summaries must not become a per-band correlation');
const leakedJsonComments = { ...baseComments, top: '{"evidence":"BP100","judgment":"覆盖","comment":"内部 JSON 不应显示"}' };
assert(!validateAnalysisSectionComments(output, leakedJsonComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'internal planned JSON must never appear as a visible comment');
const bodyMechanismComments = { ...baseComments, profile: '才玩了一小会儿就已经手不抖、眼不花，起步很稳。' };
assert(!validateAnalysisSectionComments(sparseOut, bodyMechanismComments, { playerName: 'SparsePlayer', perspective: 'other' }).ok, 'sparse accounts must not receive invented body-mechanism praise');
const falsePplusBenchmarkComments = { ...baseComments, pplus: 'Accuracy 11.39 连同最低项一起越过了 15 基准线，六维整体很高。' };
assert(!validateAnalysisSectionComments(output, falsePplusBenchmarkComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'PP+ values below 15 must not be described as over the benchmark');
const falseStableSparseComments = { ...baseComments, top: '这批 BP 成绩已经相当扎实，整个列表都收稳了。' };
assert(validateAnalysisSectionComments(sparseOut, falseStableSparseComments, { playerName: 'SparsePlayer', perspective: 'other' }).ok, 'stability claims are reviewer territory');
const missedLowAccFocusComments = { ...baseComments, top: '这批 BP 从 3.55★ 到 4.12★，难度范围已经列得很清楚。' };
assert(validateAnalysisSectionComments(sparseOut, missedLowAccFocusComments, { playerName: 'SparsePlayer', perspective: 'other' }).ok, 'missing a low-Acc focus note is not a mechanical error');
const falseAccSparseComments = { ...baseComments, profile: '总 Acc 摆在这里，说明这个人已经很有准头。' };
assert(validateAnalysisSectionComments(sparseOut, falseAccSparseComments, { playerName: 'SparsePlayer', perspective: 'other' }).ok, 'accuracy-strength prose is reviewer territory');
const prematureDirectionComments = { ...baseComments, classification: '这批分类已经有了自己的形状，账号方向很明确。' };
assert(validateAnalysisSectionComments(sparseOut, prematureDirectionComments, { playerName: 'SparsePlayer', perspective: 'other' }).ok, 'maturity/direction claims are reviewer territory');
const sparseBehaviourComments = { ...baseComments, profile: '这是闷头打图、不怎么刷 Acc 的起步型玩家，正玩得开心。' };
assert(validateAnalysisSectionComments(sparseOut, sparseBehaviourComments, { playerName: 'SparsePlayer', perspective: 'other' }).ok, 'behavior/emotion prose is reviewer territory');
const sparseAdviceComments = { ...baseComments, top: '这个阶段先把准度钉住更实在，接下来肯磨准度就会涨 pp。' };
assert(validateAnalysisSectionComments(sparseOut, sparseAdviceComments, { playerName: 'SparsePlayer', perspective: 'other' }).ok, 'training advice / future prediction is reviewer territory');
const unknownTargetPronounComments = { ...baseComments, profile: '数据说明他已经站在当前排名位置，账号字段也很完整。' };
assert(!validateAnalysisSectionComments(output, unknownTargetPronounComments, { playerName: 'SomeoneElse', perspective: 'unknown' }).ok, 'unknown target gender must not leak through mid-sentence pronouns');
const bp5ScaledCountConclusion = '【结论】\n\n全球排名 #1，总 PP 32138.7pp。两股力量在 BP5 里各占 83 张中的 83%，谁也不肯让谁。这个账号的 BP 结构相当极端，Mod 覆盖也很夸张。';
assert(!validatePippiComment(output, bp5ScaledCountConclusion, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'BP-level counts must not be attached to BP5 (only 5 scores exist)');
const emptyRecentAdviceComments = { ...baseComments, recent: 'Recent 目前没有记录，多打几场让数据开口说话吧。' };
assert(validateAnalysisSectionComments(sparseOut, emptyRecentAdviceComments, { playerName: 'SparsePlayer', perspective: 'other' }).ok, 'play-more advice is reviewer territory');
const emptyRecentStoryComments = { ...baseComments, recent: 'Recent 一条都没有，是没在打还是没同步，目前看不出来。' };
assert(validateAnalysisSectionComments(sparseOut, emptyRecentStoryComments, { playerName: 'SparsePlayer', perspective: 'other' }).ok, 'empty Recent light inference is reviewer territory');
const emptyRecentReservedStoryComments = { ...baseComments, recent: '最近记录是空的，看不出是歇着还是压根没打。' };
assert(validateAnalysisSectionComments(sparseOut, emptyRecentReservedStoryComments, { playerName: 'SparsePlayer', perspective: 'other' }).ok, 'empty Recent reserved inference is reviewer territory');
const sameBandRecentComments = { ...baseComments, recent: 'Recent 和 BP 落在同一批难度区间，Acc 差异仍然没有已知原因。' };
assert(!validateAnalysisSectionComments(output, sameBandRecentComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'similar aggregate stars must not become the same difficulty band');
const emptyRecentTraceComments = { ...baseComments, recent: 'Recent 暂时没留下新痕迹，看起来也不急着追新成绩。' };
assert(validateAnalysisSectionComments(sparseOut, emptyRecentTraceComments, { playerName: 'SparsePlayer', perspective: 'other' }).ok, 'empty Recent trace/attitude prose is reviewer territory');
const pileCountHistoryComments = { ...baseComments, profile: '这个位置不是靠堆次数能摸到的，15420 次游玩慢慢积累出了家底。' };
assert(validateAnalysisSectionComments(sparseOut, pileCountHistoryComments, { playerName: 'SparsePlayer', perspective: 'other' }).ok, 'pile-volume prose is reviewer territory');
const starAttitudeComments = { ...baseComments, top: 'BP 的难度下限本身就是一种态度，6.60★ 已经成了日常。' };
assert(validateAnalysisSectionComments(output, starAttitudeComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'star attitude prose is reviewer territory');
const nmMainGroundComments = { ...baseComments, mods: '纯 NM 是绝对主场，不带 Mod 硬打才看得出真实底子。' };
assert(validateAnalysisSectionComments(output, nmMainGroundComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'NM main-ground prose is reviewer territory');
const pplusAimAbilityComments = { ...baseComments, pplus: 'Flow 和 Jump 的形状说明这份账号靠稳定瞄准撑起来，加速也按得住。' };
assert(validateAnalysisSectionComments(output, pplusAimAbilityComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'PP+ ability prose is reviewer territory');
const top5RhythmStoryComments = { ...baseComments, top5: 'BP5 像两种状态，同一种节奏里还能稳定输出。' };
assert(validateAnalysisSectionComments(output, top5RhythmStoryComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'BP5 state prose is reviewer territory');
const fanActionComments = { ...baseComments, classification: '这个分布真迷人，我都想凑过去看看屏幕了。' };
assert(validateAnalysisSectionComments(output, fanActionComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'fan/stage-action prose is style territory');
const translatedClassificationComments = { ...baseComments, classification: 'aim 是跳跃主菜，stream 是耐力配菜，这就是纯跳跃玩家。' };
assert(validateAnalysisSectionComments(output, translatedClassificationComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'classification ability prose is reviewer territory');
const classificationFoodComments = { ...baseComments, classification: 'stream 是主食，其他分类只是零星点缀。' };
assert(validateAnalysisSectionComments(output, classificationFoodComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'classification food metaphors are reviewer territory');
const unsettledOut = analyzeData({
  ...sparseFixture,
  bestScores: [
    makeScore(fixture.bestScores[0], { id: 401, accuracy: 0.9927, mods: [], pp: 142.3, beatmap: { difficulty_rating: 4.12 } }),
    makeScore(fixture.bestScores[1], { id: 402, accuracy: 0.9210, mods: [], pp: 68.2, beatmap: { difficulty_rating: 3.55 } }),
    makeScore(fixture.bestScores[2], { id: 403, accuracy: 0.8870, mods: [], pp: 51.4, beatmap: { difficulty_rating: 3.21 } }),
  ],
});
const unsettledButCleanBp1Comments = { ...baseComments, top: '整体结果还没收稳，不过 BP1 那张 99.27% 很干净。' };
assert(validateAnalysisSectionComments(unsettledOut, unsettledButCleanBp1Comments, { playerName: 'SparsePlayer', perspective: 'other' }).ok, 'negative overall stability plus a clean BP1 must remain legal');
const falseOverallStableComments = { ...baseComments, top: '这个账号底子很稳，整体成绩已经收稳。' };
assert(validateAnalysisSectionComments(unsettledOut, falseOverallStableComments, { playerName: 'SparsePlayer', perspective: 'other' }).ok, 'stability wording is reviewer territory, not a mechanical gate');
const groupTierComments = { ...baseComments, profile: '全球排名已经进入活跃玩家中坚，还超过了绝大多数活跃玩家。' };
assert(!validateAnalysisSectionComments(output, groupTierComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'rank must not invent active-player population tiers');
const accPlayCountRelationComments = { ...baseComments, profile: '总 Acc 98.80% 配着 15,420 次游玩还能保持，数字本身很耐看。' };
assert(validateAnalysisSectionComments(output, accPlayCountRelationComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'Acc/play-count relation prose is reviewer territory');
const falseBp1FullComments = { ...baseComments, top5: 'BP1 那张 98.75% 低星图打满得很干净。' };
assert(!validateAnalysisSectionComments(output, falseBp1FullComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'sub-100 BP1 must not be described as full accuracy');
const chinesePplusDecimalComments = { ...baseComments, pplus: 'Flow 十二点零一站在六维最前面，和 Accuracy 的形状拉开了距离。' };
assert(!validateAnalysisSectionComments(output, chinesePplusDecimalComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'PP+ exact decimals must stay machine-auditable Arabic numerals');
const wrongExactModComments = { ...baseComments, mods: '精确组合 HD 有 2 张，另外几种组合也保留了分量。' };
assert(!validateAnalysisSectionComments(output, wrongExactModComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'exact Mod counts must not be confused with containment counts');
const noNmOut = analyzeData({
  ...fixture,
  bestScores: fixture.bestScores.map((score, index) => makeScore(score, { mods: index % 2 === 0 ? ['HD', 'HR'] : ['HD'] })),
  pplusBars: playerBars,
  refBars: [],
});
const truthfulNoNmComments = {
  ...baseComments,
  mods: '五张全部含 HD，其中 3 张含 HR；纯 NM 一张都没有。',
};
const truthfulNoNmValidation = validateAnalysisSectionComments(noNmOut, truthfulNoNmComments, { playerName: '[TST]Alpha', perspective: 'self' });
if (!truthfulNoNmValidation.ok) console.error('truthful no-NM reasons:', truthfulNoNmValidation.reasons);
assert(truthfulNoNmValidation.ok, 'a truthful no-NM sentence must not be misread as claiming there is no HR');
const classificationOut = analyzeData({ ...fixture, classification: { distribution: { aim: 3, stream: 1, alt: 1 }, source: 'fixture' } });
const falseAllClassificationComments = { ...baseComments, pplus: 'Jump 在六维里靠前，BP 里全是 aim，两个现象摆在一起很显眼。' };
assert(!validateAnalysisSectionComments(classificationOut, falseAllClassificationComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'classification totals must be enforced even when referenced from the PP+ section');
const wrongEachClassificationComments = { ...baseComments, classification: 'aim、stream、alt 各有 3 张，当前分类很平均。' };
assert(!validateAnalysisSectionComments(classificationOut, wrongEachClassificationComments, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'each-count phrasing must respect every classification label');
assert(validatePippiComment(
  output,
  '【结论】\n全球排名 #6,210。BP 的星数上限与 Acc 覆盖有可见对照，HD 构成、PP+ 六维和 Recent 也各有信息。这份账号把几组差异摆得很清楚，值得认真看。',
  { playerName: '[TST]Alpha', perspective: 'self' }
).ok, 'a beatmap star upper bound must not be confused with the PP+ 15 baseline');
assert(!validatePippiComment(mrekkOut, '【结论】\n全球 #1 的分量当然特殊，全世界只有这个人的 Jump 能到这种高度。', { playerName: 'mrekk', perspective: 'other' }).ok, 'global rank must not become an unsupported PP+ single-dimension world record');
assert(!validatePippiComment(mrekkOut, '【结论】\n全球 #1、32138.7pp 已经站在塔尖，别人一辈子也够不到这里的一张图。', { playerName: 'mrekk', perspective: 'other' }).ok, 'top-player praise must not belittle everyone else');
assert(!validatePippiComment(output, '【结论】\nHD 与高 Acc 构成了当前 BP 的主要形状，其他部分仍然保持未知。', { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'conclusion must include rank or pp in its weight judgement');
assert(!validatePippiComment(output, '【结论】\nBP5 的跨度为 43.3pp，HD 与高 Acc 构成当前主要形状。', { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'a BP score or gap must not masquerade as account total pp weight');
assert(!validatePippiComment(output, '【结论】\n全球 #6,210。Recent 的星数和 BP 接近，Acc 有可见落差，原因未知。', { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'rank plus Recent alone must not masquerade as a cross-section conclusion');
assert(validatePippiComment(sparseOut, '【结论】\n210.5pp 的账号，这批 BP 里只有 2 张，星数在 3.55★ 到 4.12★ 之间。等记录再多一点，再看会往 alt 深处还是难度高处走。', { playerName: 'SparsePlayer', perspective: 'other' }).ok, 'future-direction prose is reviewer territory');
const correctExactModCount = { ...baseComments, top5: 'BP5 里只有 1 张 HDDT；其余成绩的 pp 与 Acc 仍要逐张比较。' };
assert(validateAnalysisSectionComments(output, correctExactModCount, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'exact HDDT count must not be confused with all scores containing HD');
const wrongExactModCount = { ...baseComments, top5: 'BP5 里有 2 张 HDDT；其余成绩的 pp 与 Acc 仍要逐张比较。' };
assert(!validateAnalysisSectionComments(output, wrongExactModCount, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'wrong exact BP5 Mod count must be rejected');
const wrongContainedHrCount = { ...baseComments, top5: 'BP5 里四张都带 HR，内部 Acc 还需要逐张比较。' };
assert(!validateAnalysisSectionComments(output, wrongContainedHrCount, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'top-five containment counts must recognize 都带 phrasing');
console.log('Test 17 PASS: first-batch factual regressions are mechanically gated');

// 2026-08-02 减法后补充的硬门回归：
// - "连1张 98% 以上都没撑住" 与简报（2 张）矛盾
const noAbove98Variant = { ...baseComments, top: '这批 BP 里连1张 98% 以上 Acc 都没撑住，整体结构还需要再看。' };
assert(!validateAnalysisSectionComments(output, noAbove98Variant, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'claiming zero 98% scores must still fail when verified facts show some');
// - 精确组合覆盖全部 BP 断言（NM 89 张不能写成覆盖全部 100 张）
const nmCoversAll = { ...baseComments, mods: 'NM 覆盖了 BP 全部 100 张，其他组合只是零星点缀。' };
assert(!validateAnalysisSectionComments(output, nmCoversAll, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'an exact Mod combo below the BP count must not be claimed to cover all BP');
// - normalizeChineseQuantities 不得损坏阿拉伯数字后的“万”
const mixedWanComments = { ...baseComments, profile: '近 3 万 pp 的体量就摆在这，账号字段也很完整。' };
const mixedWanSanitized = sanitizeAnalysisSectionComments(mixedWanComments, { playerName: '[TST]Alpha', perspective: 'self' }, output);
assert(mixedWanSanitized.profile.includes('3 万'), 'Arabic digit followed by 万 must survive quantity normalization');
// - “隐身”不得作为 HD 的称呼
const hiddenNickname = { ...baseComments, mods: 'HD 和 HDHR 占了 96 张，这人对隐身的偏爱挺明显。' };
assert(!validateAnalysisSectionComments(output, hiddenNickname, { playerName: '[TST]Alpha', perspective: 'self' }).ok, 'HD must not be renamed to 隐身 in any context');

// Test 18: v80 relationship gates and conclusion architecture. The conclusion
// may reuse compact facts, but it must not receive or copy full section prose.
const modRelationshipOut = analyzeData({
  ...fixture,
  bestScores: [
    makeScore(fixture.bestScores[0], { mods: ['NF'] }),
    makeScore(fixture.bestScores[1], { mods: ['PF'] }),
    ...fixture.bestScores.slice(2),
  ],
});
const inventedNfPfRelationship = {
  ...baseComments,
  mods: 'NF 那张 PF 成绩很显眼，两种 Mod 在同一张记录里碰面。',
};
assert(
  !validateAnalysisSectionComments(modRelationshipOut, inventedNfPfRelationship, { playerName: '[TST]Alpha', perspective: 'self' }).ok,
  'separate NF and PF scores must not be merged into one score',
);
const genuineNfPfOut = analyzeData({
  ...fixture,
  bestScores: [
    makeScore(fixture.bestScores[0], { mods: ['NF', 'PF'] }),
    ...fixture.bestScores.slice(1),
  ],
});
const genuineNfPfRelationship = {
  ...baseComments,
  mods: 'NF 和 PF 在同一张 NFPF 成绩里出现，精确组合与其他记录仍然分开统计。',
};
assert(
  validateAnalysisSectionComments(genuineNfPfOut, genuineNfPfRelationship, { playerName: '[TST]Alpha', perspective: 'self' }).ok,
  'a real NFPF exact combination must not be rejected',
);
const multiStyleAbility = { ...baseComments, mods: 'HD、HR 和 DT 三种玩法都站得住，当前构成很全面。' };
assert(
  validateAnalysisSectionComments(output, multiStyleAbility, { playerName: '[TST]Alpha', perspective: 'self' }).ok,
  'playstyle-ability prose is reviewer territory',
);
const pplusTowerAbility = { ...baseComments, pplus: '速度和耐力把塔尖撑高，稳定准度又把这个位置托住了。' };
assert(
  validateAnalysisSectionComments(mrekkOut, pplusTowerAbility, { playerName: 'mrekk', perspective: 'other' }).ok,
  'PP+ rank-mechanism prose is reviewer territory',
);
const singleScoreAccuracyAbility = { ...baseComments, top5: 'BP1 那张 99.27% Acc 很干净，准头已经有意思了。' };
assert(
  validateAnalysisSectionComments(unsettledOut, singleScoreAccuracyAbility, { playerName: 'SparsePlayer', perspective: 'other' }).ok,
  'single-score accuracy prose is reviewer territory',
);

const reportLocalComments = {
  ...baseComments,
  mods: 'HD 与 HDHR 合计占据当前 BP 的绝大部分，这条主轴已经十分鲜明。',
};
assert(
  findConclusionSectionReuse(
    '【结论】\n全球排名 #6,210。HD 与 HDHR 合计占据当前 BP 的绝大部分，这条主轴已经十分鲜明。',
    reportLocalComments,
  ).length > 0,
  'a full section sentence copied into the conclusion must be detected',
);
assert(
  findConclusionSectionReuse(
    '【结论】\n全球排名 #6,210。HD 与 HDHR 是高位成绩的主要构成，六维和分类还留下了另一层对照。',
    reportLocalComments,
  ).length === 0,
  'reusing a short factual Mod phrase in a new synthesis must remain legal',
);
const classificationBoundaryOut = {
  ...classificationOut,
  safeFacts: classificationOut.safeFacts.replace(
    /谱面类型样本:[^\n]*/,
    '谱面类型样本: BP100；aim 81张（81%） | stream 10张（10%） | alt 7张（7%） | tech 2张（2%）',
  ),
};
const correctClassificationBoundary = validateAnalysisSectionComments(
  classificationBoundaryOut,
  { ...baseComments, classification: 'aim 81张占据明显主体，stream 10张仍保留第二层分量。' },
  { playerName: 'BoundaryPlayer', perspective: 'other' },
);
if (!correctClassificationBoundary.ok) console.error('classification boundary reasons:', correctClassificationBoundary.reasons);
assert(
  correctClassificationBoundary.ok,
  'classification validator must not read the tail of 81 as a false 1-count',
);
assert(
  !validateAnalysisSectionComments(
    classificationBoundaryOut,
    { ...baseComments, classification: 'aim 1张占据明显主体，stream 10张仍保留第二层分量。' },
    { playerName: 'BoundaryPlayer', perspective: 'other' },
  ).ok,
  'a genuinely wrong classification count must still be rejected',
);
const factualReviewerPrompt = buildAnalysisReviewerPrompt(
  output,
  `${output.safeBody}\n\n【结论】\n全球排名 #6,210。`,
  { playerName: '[TST]Alpha', perspective: 'self' },
);
assert(factualReviewerPrompt.system.includes('只查可证明的基本事实错误'), 'reviewer must stay factual-only');
assert(!factualReviewerPrompt.system.includes('kind=quality'), 'reviewer must not drive literary rewrites');
assert(!factualReviewerPrompt.system.includes('模板或冷分析师'), 'reviewer must not contain the old prose-quality maze');
console.log('Test 18 PASS: v83 independent analysis and factual-only reviewer');

// Test 19: the hard-error repairer is a separate, surgical fixer (not pippi).
const repairPrompt = buildAnalysisRepairPrompt(
  output,
  'top',
  'BP 里 68 张在 6★ 以上。',
  ['top 短评：数字与核准值不符'],
  { playerName: '[TST]Alpha', perspective: 'self' },
);
assert(repairPrompt.system.includes('硬错误修复员'), 'repairer must identify its hard-error-only role');
assert(repairPrompt.system.includes('最小改动'), 'repairer must prefer surgical edits over rewrites');
assert(repairPrompt.user.includes('<errors>'), 'repairer must receive the exact mechanical reasons');
assert(repairPrompt.user.includes('<verified_facts>'), 'repairer must receive the verified facts');
console.log('Test 19 PASS: independent hard-error repairer prompt');

console.log('\nAll osu! analyzer fixture tests PASSED.');
