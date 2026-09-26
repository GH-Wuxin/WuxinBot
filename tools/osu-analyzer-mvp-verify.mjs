import assert from 'node:assert/strict';

const { runAnalyzerMvp, sanitizeGeneratedText } = await import('../server/osu/analyzerMvp.ts');
const { analyzeData } = await import('../server/osu/analyzer.ts');
const { OSU_SUBCOMMANDS } = await import('../server/bot/commands/osu.meta.ts');
const { OWNER_COMMANDS } = await import('../server/bot/commands/owner.meta.ts');

const user = {
  id: 900000001,
  username: 'Analyzer Fixture',
  country_code: 'CN',
  avatar_url: '',
  join_date: '2022-01-01T00:00:00Z',
  grade_counts: { ssh: 0, ss: 4, sh: 2, s: 20, a: 40 },
  statistics: {
    level: { current: 80, progress: 20 },
    global_rank: 50000,
    country_rank: 1000,
    pp: 4200,
    ranked_score: 1,
    total_score: 1,
    total_hits: 1000000,
    hit_accuracy: 98.2,
    play_count: 5000,
    play_time: 300000,
    maximum_combo: 1500,
    replays_watched_by_others: 0,
    is_ranked: true,
    grade_counts: { ss: 4, s: 20, a: 40 },
  },
  follower_count: 0,
  support_level: 0,
};

const score = (id, stars, accuracy) => ({
  id,
  accuracy,
  max_combo: 700,
  mods: [],
  pp: 250,
  score: 1000000,
  rank: 'S',
  statistics: { count_50: 0, count_100: 5, count_300: 100, count_geki: 5, count_katsu: 2, count_miss: 0 },
  beatmap: {
    id: 7000 + id,
    difficulty_rating: stars,
    version: 'Insane',
    mode: 'osu',
    ar: 9,
    bpm: 180,
    cs: 4,
    total_length: 180,
    hit_length: 150,
    count_circles: 200,
    count_sliders: 50,
    count_spinners: 0,
  },
  beatmapset: { id: 8000 + id, title: `Fixture Map ${id}`, artist: 'Fixture', creator: 'Mapper' },
  created_at: '2026-09-01T00:00:00Z',
  user_id: user.id,
  mode: 'osu',
});

const collection = {
  user,
  bestScores: [score(1, 5.8, 0.985), score(2, 5.4, 0.979)],
  recentScores: [score(3, 5.1, 0.972)],
  pplusBars: null,
  refBars: [],
  classification: null,
  errors: [],
};
const prepared = analyzeData({ ...collection, mode: 'osu' });
const db = { settings: { personalityPrompt: '' } };

const accepted = await runAnalyzerMvp(db, user.id, 'osu', { playerName: user.username, perspective: 'unknown' }, {
  collect: async () => collection,
  complete: async () => ({ text: prepared.safeFallback, model: 'fixture-model' }),
});
assert.equal(accepted.source, 'llm');
assert.equal(accepted.provider, 'deepseek');
assert.equal(accepted.model, 'fixture-model');
assert.equal(accepted.text, prepared.safeFallback);
assert.deepEqual(accepted.validationReasons, []);

const dirtyTail = `${prepared.safeFallback} boʻಡಕುба?`;
assert.equal(sanitizeGeneratedText(dirtyTail), prepared.safeFallback);
const dirtyTailWithoutSpace = `${prepared.safeFallback}ೂರಿ`;
assert.equal(sanitizeGeneratedText(dirtyTailWithoutSpace), prepared.safeFallback);
const dirtyForeignTail = `${prepared.safeFallback} звуковой конец.`;
assert.equal(sanitizeGeneratedText(dirtyForeignTail), prepared.safeFallback);
const sanitizedAccepted = await runAnalyzerMvp(db, user.id, 'osu', {}, {
  collect: async () => collection,
  complete: async () => ({ text: dirtyTail, model: 'fixture-model' }),
});
assert.equal(sanitizedAccepted.source, 'llm');
assert.equal(sanitizedAccepted.text, prepared.safeFallback);

const codexOptions = [];
const codexDb = {
  settings: {
    personalityPrompt: '',
    llmProvider: 'codex-app-server',
    codexModel: 'gpt-6-luna',
    codexReasoningEffort: 'max',
  },
};
const codexAccepted = await runAnalyzerMvp(codexDb, user.id, 'osu', {}, {
  collect: async () => collection,
  complete: async (_db, options) => {
    codexOptions.push(options);
    return { text: prepared.safeFallback, provider: 'codex-app-server', model: 'gpt-6-luna' };
  },
});
assert.equal(codexAccepted.source, 'llm');
assert.equal(codexAccepted.provider, 'codex-app-server');
assert.equal(codexAccepted.model, 'gpt-6-luna');
assert.equal(codexOptions[0].codexModel, 'gpt-6-luna');
assert.equal(codexOptions[0].codexReasoningEffort, 'low');

const rejected = await runAnalyzerMvp(db, user.id, 'osu', {}, {
  collect: async () => collection,
  complete: async () => ({ text: '编造一个没有证据支持的结论。' }),
});
assert.equal(rejected.source, 'fallback');
assert.equal(rejected.text, prepared.safeFallback);
assert.ok(rejected.validationReasons.length > 0);

assert.equal(OSU_SUBCOMMANDS.analyze.status, 'active');
const ownerMeta = OWNER_COMMANDS.find((entry) => entry.id === 'osuAnalyze');
assert.equal(ownerMeta?.status, 'active');
assert.equal(ownerMeta?.visibility, 'public');
console.log('osu analyzer MVP verify: ok');
