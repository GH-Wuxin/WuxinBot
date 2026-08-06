// intent-verify.mjs — unit tests for detectRequiredOsuTool intent classifier.
// Exit 0 on all pass, non-zero on any failure.

const { detectRequiredOsuTool, hasFallbackRecommendIntent, looksLikeRecommendationReply } = await import('../server/bots/intent.ts');

let passed = 0;
let failed = 0;

function expectMatch(label, text, expectedCapability, expectedRange = null) {
  const result = detectRequiredOsuTool(text);
  if (!result) {
    console.error(`FAIL [${label}]: "${text}" → null (expected ${expectedCapability})`);
    failed++;
    return;
  }
  if (result.toolName !== 'query_osu') {
    console.error(`FAIL [${label}]: "${text}" → toolName=${result.toolName} (expected query_osu)`);
    failed++;
    return;
  }
  if (result.args.capability !== expectedCapability) {
    console.error(`FAIL [${label}]: "${text}" → capability=${result.args.capability} (expected ${expectedCapability})`);
    failed++;
    return;
  }
  if (expectedRange) {
    for (const [k, v] of Object.entries(expectedRange)) {
      if (result.args[k] !== v) {
        console.error(`FAIL [${label}]: "${text}" → ${k}=${result.args[k]} (expected ${v})`);
        failed++;
        return;
      }
    }
  }
  console.log(`PASS [${label}]: "${text}" → query_osu/${expectedCapability}${expectedRange ? ' ' + JSON.stringify(expectedRange) : ''}`);
  passed++;
}

function expectNull(label, text) {
  const result = detectRequiredOsuTool(text);
  if (result !== null) {
    console.error(`FAIL [${label}]: "${text}" → query_osu/${result.args.capability} (expected null)`);
    failed++;
    return;
  }
  console.log(`PASS [${label}]: "${text}" → null`);
  passed++;
}

console.log('=== BP queries (must match) ===');
expectMatch('bp-self-1', '看看我bp1', 'bp');
expectMatch('bp-self-2', '我的bp1', 'bp');
expectMatch('bp-self-3', '查一下bp1到bp10', 'bp');
expectMatch('bp-self-4', '看看我的bp', 'bp');
expectMatch('bp-self-5', '查查我的bp', 'bp');
expectMatch('bp-self-6', '帮查bp', 'bp');
expectMatch('bp-self-7', 'bp1', 'bp');
expectMatch('bp-self-8', 'bp #1', 'bp');
expectMatch('bp-self-9', 'my bp', 'bp');
expectMatch('bp-self-10', '看看我bp10', 'bp');
expectMatch('bp-self-11', '看一下我的bp', 'bp');
expectMatch('bp-self-12', '查下我的bp', 'bp');
expectMatch('bp-self-13', '帮我查一下bp', 'bp');
expectMatch('bp-self-14', '帮我看看bp', 'bp');
expectMatch('bp-self-15', 'show my bp', 'bp');
expectMatch('bp-self-16', '拉一下bp', 'bp');

console.log('\n=== Recent queries (must match) ===');
expectMatch('recent-self-1', '看看我最近一次成绩', 'recent');
expectMatch('recent-self-2', '我的recent', 'recent');
expectMatch('recent-self-3', '看看我的re', 'recent');
expectMatch('recent-self-4', '查一下我的recent', 'recent');
expectMatch('recent-self-5', '最近成绩', 'recent');
expectMatch('recent-self-6', '帮我查recent', 'recent');

console.log('\n=== Profile queries (must match) ===');
expectMatch('profile-self-1', '看看我的玩家资料', 'info');
expectMatch('profile-self-2', '我的info', 'info');
expectMatch('profile-self-3', '查我的osu资料', 'info');
expectMatch('profile-self-4', '查一下我的玩家信息', 'info');
expectMatch('profile-self-5', '我的profile', 'info');

console.log('\n=== Recommend queries (must match) ===');
expectMatch('reco-1', '给我推点我能打的pp图', 'recommend');
expectMatch('reco-2', '给我推点图', 'recommend');
expectMatch('reco-3', '推几张适合我的图', 'recommend');
expectMatch('reco-4', '推荐点我打得动的图', 'recommend');
expectMatch('reco-5', '有什么图能打', 'recommend');
expectMatch('reco-6', '有没有我能打的图', 'recommend');
expectMatch('reco-7', '打什么图', 'recommend');

console.log('\n=== Recommend guard helpers ===');
function expectBool(label, actual, expected) {
  if (actual === expected) {
    console.log(`PASS [${label}]`);
    passed++;
  } else {
    console.error(`FAIL [${label}]: got ${actual}, expected ${expected}`);
    failed++;
  }
}
expectBool('guard-fallback-1', hasFallbackRecommendIntent('给我推点我能打的pp图'), true);
expectBool('guard-fallback-2', hasFallbackRecommendIntent('别推图了'), false);
expectBool('guard-fallback-3', hasFallbackRecommendIntent('推荐一下这个图'), false);
expectBool('guard-fallback-4', hasFallbackRecommendIntent('帮我推个图床链接'), false);
expectBool('guard-reply-1', looksLikeRecommendationReply('给你挑了三张图：Epitaph、FD、Yomi'), true);
expectBool('guard-reply-2', looksLikeRecommendationReply('BID 1234567'), true);
expectBool('guard-reply-3', looksLikeRecommendationReply('今天天气不错'), false);
expectBool('guard-reply-4', looksLikeRecommendationReply('这张图挺适合你的'), false);

console.log('\n=== BP range queries ===');
expectMatch('bp-range-1', '查一下bp1到bp10', 'bp', { bp_start: 1, bp_end: 10 });
expectMatch('bp-range-2', 'bp1-10', 'bp', { bp_start: 1, bp_end: 10 });
expectMatch('bp-range-3', '看看我bp1到bp5', 'bp', { bp_start: 1, bp_end: 5 });
expectMatch('bp-range-4', '查一下我的bp1到bp100', 'bp', { bp_start: 1, bp_end: 100 });
expectMatch('bp-range-5', '!bs 1-100', 'bp', { bp_start: 1, bp_end: 100 });
expectMatch('bp-range-6', '我的bs', 'bp');
expectMatch('bp-range-7', 'bs1', 'bp', { bp_rank: 1 });

const officialBsIntent = detectRequiredOsuTool('!bs 1-100');
if (officialBsIntent?.args.compact !== true) {
  console.error('FAIL [official-bs-style]: !bs 1-100 must set compact=true');
  failed++;
} else {
  console.log('PASS [official-bs-style]: !bs 1-100 → compact=true');
  passed++;
}

console.log('\n=== Must NOT match (BP-adjacent but not queries) ===');
expectNull('no-match-1', '看看我为什么bp这么偏科');
expectNull('no-match-2', '分析我的bp结构');
expectNull('no-match-3', '为什么我的成绩不涨pp');
expectNull('no-match-4', '这个人的比赛成绩怎么样');
expectNull('no-match-5', 'pippi你记得我的bp1吗');
expectNull('no-match-6', '结构是什么');
expectNull('no-match-7', '怎么查osu成绩');

console.log('\n=== Must NOT match (casual chat) ===');
expectNull('chat-1', '你好');
expectNull('chat-2', '今天天气不错');
expectNull('chat-3', '哈哈哈哈');
expectNull('chat-4', 'pippi你在吗');
expectNull('chat-5', '我是谁');
expectNull('chat-6', '帮我写个代码');
expectNull('chat-7', '推荐几首好听的歌');
expectNull('chat-8', '你知道osu吗');
expectNull('chat-9', '我该不该打这张图');
expectNull('chat-10', '能不能帮我看看');
expectNull('chat-11', '别推图了');
expectNull('chat-12', '推荐一下这个图');
expectNull('chat-13', '帮我推个图床链接');

console.log('\n=== Must NOT match (analysis/investigation) ===');
expectNull('analysis-1', '分析一下我的osu水平');
expectNull('analysis-2', '我的bp为什么这么差');
expectNull('analysis-3', '怎么提升我的accuracy');
expectNull('analysis-4', '为什么这张图打不好');
expectNull('analysis-5', '你觉得我适合打什么图');
expectNull('analysis-6', '帮我分析一下我的bp分布');

console.log(`\n${'='.repeat(40)}`);
console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  console.error('INTENT-VERIFY FAILED');
  process.exit(1);
}
console.log('INTENT-VERIFY PASSED');
process.exit(0);
