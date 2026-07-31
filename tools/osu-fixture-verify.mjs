// osu! offline fixture verification — validates analyzer with PP+ bars + reference system.

import { analyzeData, buildAnalysisEditorPrompt, buildAnalysisPrompt, validateAnalysisReport, validatePippiComment } from '../server/osu/analyzer.js';
import { ppToBars } from '../server/osu/pplus.js';
import { buildRecentReport, OSU_ANALYSIS_MODEL } from '../server/osu/commands.js';
import { findModSemanticsViolation, splitModCombination } from '../server/osu/wikiKnowledge.js';
import { scoreStarRating } from '../server/osu/scoreMetrics.js';
import { ok as assert } from 'node:assert/strict';

const fixture = {
  user: {
    id: 19244792, username: '[SHK]Wuxin', country_code: 'CN',
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
      created_at: '2026-06-15T00:00:00Z', user_id: 19244792, mode: 'osu' },
    { id: 2, accuracy: 0.9812, max_combo: 987, mods: ['HD'], pp: 541.6, score: 14200000, rank: 'S',
      statistics: { count_50: 1, count_100: 18, count_300: 290, count_geki: 18, count_katsu: 8, count_miss: 1 },
      beatmap: { id: 1002, difficulty_rating: 6.86, version: 'Another', mode: 'osu', ar: 9.8, bpm: 240, cs: 4.2, total_length: 200, hit_length: 150, count_circles: 250, count_sliders: 60, count_spinners: 3 },
      beatmapset: { id: 5002, title: 'Sidetracked Day', artist: 'DJ Sharpnel', creator: 'Mapper2' },
      created_at: '2026-06-10T00:00:00Z', user_id: 19244792, mode: 'osu' },
    { id: 3, accuracy: 0.9650, max_combo: 1567, mods: ['HD','DT'], pp: 315.2, score: 13500000, rank: 'A',
      statistics: { count_50: 3, count_100: 28, count_300: 410, count_geki: 30, count_katsu: 12, count_miss: 2 },
      beatmap: { id: 1003, difficulty_rating: 5.89, version: 'Expert', mode: 'osu', ar: 9, bpm: 180, cs: 4, total_length: 300, hit_length: 220, count_circles: 400, count_sliders: 90, count_spinners: 8 },
      beatmapset: { id: 5003, title: 'Dragon Night', artist: 'ZUN', creator: 'Mapper3' },
      created_at: '2026-05-20T00:00:00Z', user_id: 19244792, mode: 'osu' },
    { id: 4, accuracy: 0.9934, max_combo: 423, mods: [], pp: 298.7, score: 9800000, rank: 'SS',
      statistics: { count_50: 0, count_100: 5, count_300: 150, count_geki: 8, count_katsu: 2, count_miss: 0 },
      beatmap: { id: 1004, difficulty_rating: 4.85, version: 'Hard', mode: 'osu', ar: 8, bpm: 160, cs: 3.5, total_length: 180, hit_length: 120, count_circles: 150, count_sliders: 30, count_spinners: 2 },
      beatmapset: { id: 5004, title: 'Blue Zenith', artist: 'xi', creator: 'Mapper4' },
      created_at: '2026-04-01T00:00:00Z', user_id: 19244792, mode: 'osu' },
    { id: 5, accuracy: 0.9490, max_combo: 890, mods: ['HR'], pp: 285.3, score: 12200000, rank: 'A',
      statistics: { count_50: 5, count_100: 45, count_300: 320, count_geki: 15, count_katsu: 20, count_miss: 3 },
      beatmap: { id: 1005, difficulty_rating: 5.20, version: 'Insane', mode: 'osu', ar: 9.2, bpm: 175, cs: 4, total_length: 250, hit_length: 190, count_circles: 320, count_sliders: 70, count_spinners: 4 },
      beatmapset: { id: 5005, title: 'The Pretender', artist: 'Foo Fighters', creator: 'Mapper5' },
      created_at: '2026-03-15T00:00:00Z', user_id: 19244792, mode: 'osu' },
  ],
  recentScores: [
    { id: 10, accuracy: 0.8780, max_combo: 876, mods: ['HD','HR'], pp: null, score: 11200000, rank: 'A',
      statistics: { count_50: 5, count_100: 32, count_300: 250, count_geki: 12, count_katsu: 6, count_miss: 4 },
      beatmap: { id: 2001, difficulty_rating: 7.41, version: 'Expert', mode: 'osu', ar: 10, bpm: 220, cs: 4.5, total_length: 260, hit_length: 200, count_circles: 350, count_sliders: 75, count_spinners: 3 },
      beatmapset: { id: 6001, title: 'Through The Fire', artist: 'DragonForce', creator: 'Mapper6' },
      created_at: '2026-07-05T10:00:00Z', user_id: 19244792, mode: 'osu' },
    { id: 11, accuracy: 0.8610, max_combo: 654, mods: ['HD','HR'], pp: null, score: 8700000, rank: 'A',
      statistics: { count_50: 8, count_100: 45, count_300: 230, count_geki: 5, count_katsu: 10, count_miss: 6 },
      beatmap: { id: 2002, difficulty_rating: 7.41, version: 'Insane', mode: 'osu', ar: 10.3, bpm: 250, cs: 4.8, total_length: 210, hit_length: 160, count_circles: 280, count_sliders: 55, count_spinners: 2 },
      beatmapset: { id: 6002, title: 'Freedom Dive', artist: 'xi', creator: 'Mapper7' },
      created_at: '2026-07-04T22:00:00Z', user_id: 19244792, mode: 'osu' },
  ],
  mode: 'osu'
};

// Real [SHK]Wuxin PP+ data for normalization testing
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
assert(output.profile.includes('[SHK]Wuxin'), 'profile should contain username');
assert(output.profile.includes('10285.6'), 'profile should contain PP');
assert(output.profile.includes('6,210'), 'profile should contain rank');
assert(output.profile.includes('98.80%'), 'profile should contain hit_accuracy as percentage');
assert(output.profile.includes('48%'), 'profile should contain level progress');
console.log('Test 4 PASS: profile fields');

// Test 5: buildAnalysisPrompt (now returns { system, user })
const prompt = buildAnalysisPrompt(output, '自然、简短', { playerName: '[SHK]Wuxin', perspective: 'self' });
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
const editorPrompt = buildAnalysisEditorPrompt(output, { playerName: '[SHK]Wuxin', perspective: 'self' });
assert(editorPrompt.system.includes('只输出【结论】节点'), 'editor prompt should only request the final conclusion node');
assert(editorPrompt.system.includes('Auto 模组显示的完美游玩由你完成'), 'editor prompt should include PIPPI_CORE');
assert(editorPrompt.system.includes('当前场景：osu! 玩家分析'), 'editor prompt should include osu analysis scene');
assert(editorPrompt.user.includes('<verified_facts>'), 'editor prompt should include verified facts');
assert(!editorPrompt.user.includes('<draft>'), 'editor prompt should not anchor the model to deterministic fallback prose');
assert.equal(OSU_ANALYSIS_MODEL, 'deepseek-v4-pro', 'osu analysis should use V4 Pro');
assert(validatePippiComment(output, output.safePippiFallback).ok, 'deterministic conclusion should pass validation');
const fallbackValidation = validateAnalysisReport(output, output.safeFallback);
if (!fallbackValidation.ok) console.error('Fallback validation reasons:', fallbackValidation.reasons);
assert(fallbackValidation.ok, 'deterministic fallback should pass validation');
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
assert(!validateAnalysisReport(output, `${output.safeFallback}\n最近可能是在练图。`).ok, 'unsupported practice story should fail validation');
assert(!validateAnalysisReport(output, `${output.safeFallback}\n波动是 1.41%。`).ok, 'unknown derived number should fail validation');
assert(!validateAnalysisReport(
  output,
  `${output.safeFallback}\n对我来说，不失误只是默认状态。`
).ok, 'condescending Auto comparison should fail validation');
assert(!validateAnalysisReport(
  output,
  `${output.safeFallback}\n作为旁观者，我尊重这种清晰的自我定位。`
).ok, 'cold analyst voice should fail validation');
assert(!validateAnalysisReport(
  output,
  `${output.safeFallback}\n这是一张自带 HD 的隐身图。`
).ok, 'HD must belong to the play, not the beatmap');
assert.deepEqual(splitModCombination('NFSO'), ['NF', 'SO'], 'combined mod label should be decomposed generically');
assert.deepEqual(splitModCombination('HDHRDT'), ['HD', 'HR', 'DT'], 'multi-mod label should be decomposed generically');
assert(findModSemanticsViolation('这是张 HR 图。'), 'HR must not be assigned to the beatmap');
assert(findModSemanticsViolation('这张谱面自带 NFSO。'), 'combined mods must not be assigned to the beatmap');
assert(!validatePippiComment(
  output,
  '【结论】\n这不是普通的稳定，而是真正的强大。我很喜欢。'
).ok, 'binary contrast phrasing should fail validation');
assert(!validatePippiComment(
  output,
  '【结论】\n这是一个 HD/HDHR 主导的高准确率稳定型玩家。\nHD 与 HDHR 合计占 BP 成绩 96%，Flow 与 Accuracy 显示最高。\n数据告诉我，你在高精度节奏与稳定跟随上的潜能藏在每一页成绩里。'
).ok, 'unsupported ability inference should fail validation');
for (const phrasing of [
  '【pippi】\n看起来只是稳定，其实每一张都很漂亮。我很喜欢这批成绩。',
  '【pippi】\n这算不上惊艳，不过稳定得很清楚，我愿意认真夸一句。',
  '【pippi】\n我的夸奖可没那么便宜，不过这次确实值得。我喜欢这份稳定。',
  '【pippi】\n我本来只想看一眼，却被这些高准确率留下了。我很喜欢。',
  '【pippi】\n这批成绩很稳定。\n不过最近一组差得很远，我还要继续观察。',
  '【pippi】\nBP 里一张低于 95% 的都没有——稳定得很漂亮，我喜欢。',
  '【pippi】\n这组成绩很干净。我的夸奖没那么便宜，这次可以给你一句。',
  '【pippi】\nRecent 的 Acc 掉到 92.10%，星数跳到 7.12★。我看见变化了。',
  '【pippi】\n82 张 98% 以上，你抓稳的机会真多，我喜欢这种沉着。',
  '【pippi】\nAccuracy 高于 Speed，说明你对节奏的掌控很亮眼，我喜欢。',
  '【pippi】\n82 张 98% 以上很漂亮。等以后更多成绩出现，我再慢慢看。',
]) {
  assert(!validatePippiComment(output, phrasing.replace('【pippi】', '【结论】')).ok, `contrast rewrite should fail validation: ${phrasing}`);
}
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

console.log('\nAll osu! analyzer fixture tests PASSED.');
