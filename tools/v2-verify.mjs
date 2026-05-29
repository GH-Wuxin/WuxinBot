/**
 * profileAntiRecencyV2 灰度开关验证测试
 *
 * 验证 clusterSamplesByTopic + computeTopicWeights 的行为：
 * 1. 单场景高频话题 → short-term (isCrossSession=false)
 * 2. 跨天话题 → long-term (isCrossSession=true)
 * 3. 权重计算正确
 */

import { clusterSamplesByTopic, computeTopicWeights } from '../server/bot/memory.ts';

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function sample(content, groupId, day) {
  return {
    content,
    type: 'text',
    usedForProfile: true,
    riskLevel: 'normal',
    reason: 'test',
    context: { groupId, messageId: `msg-${Math.random().toString(16).slice(2)}`, mentionedBot: false, atTargets: [], speakerName: 'test', nearby: [] },
    createdAt: `${day}T12:00:00.000Z`,
  };
}

async function main() {
  // === Test 1: Single-session topic → short-term ===
  const cs2Samples = [
    sample('今天CS2打了一把好局', 'g1', '2026-05-28'),
    sample('CS2新出的皮肤好看', 'g1', '2026-05-28'),
    sample('晚上继续打CS2', 'g1', '2026-05-28'),
  ];

  const clusters1 = clusterSamplesByTopic(cs2Samples);
  assert(clusters1.length >= 1, 'should form at least 1 cluster');

  const weights1 = computeTopicWeights(clusters1);
  const cs2Cluster = weights1.find((tw) => tw.cluster.keywords.some((k) => /cs2/i.test(k)));
  assert(cs2Cluster, 'should find CS2 cluster');
  assert(cs2Cluster.isCrossSession === false, 'single-day CS2 should NOT be cross-session');
  assert(cs2Cluster.uniqueDays === 1, 'should be 1 unique day');

  console.log('PASS: single-session topic → short-term (isCrossSession=false)');

  // === Test 2: Cross-day topic → long-term ===
  const crossDaySamples = [
    sample('今天CS2打了一把好局', 'g1', '2026-05-26'),
    sample('CS2新出的皮肤好看', 'g1', '2026-05-27'),
    sample('晚上继续打CS2', 'g1', '2026-05-28'),
  ];

  const clusters2 = clusterSamplesByTopic(crossDaySamples);
  const weights2 = computeTopicWeights(clusters2);
  const crossCluster = weights2.find((tw) => tw.cluster.keywords.some((k) => /cs2/i.test(k)));
  assert(crossCluster, 'should find CS2 cluster');
  assert(crossCluster.isCrossSession === true, 'cross-day CS2 should be cross-session');
  assert(crossCluster.uniqueDays >= 2, 'should be >=2 unique days');
  assert(crossCluster.weight > cs2Cluster.weight, 'cross-day weight should be higher than single-day');

  console.log('PASS: cross-day topic → long-term (isCrossSession=true, weight higher)');

  // === Test 3: Mixed topics — some short, some long ===
  // Use consistent phrasing so bigram clustering works (tokenizeCJK uses bigrams)
  const mixedSamples = [
    // Long-term: CS2 across 3 days + 2 groups (special term, high overlap)
    sample('今天CS2打了一把好局', 'g1', '2026-05-25'),
    sample('CS2新出的皮肤好看', 'g2', '2026-05-27'),
    sample('晚上继续打CS2排位', 'g1', '2026-05-28'),
    // Short-term: 天气 only 1 day
    sample('今天天气好热啊', 'g1', '2026-05-28'),
    sample('天气热得不想出门', 'g1', '2026-05-28'),
  ];

  const clusters3 = clusterSamplesByTopic(mixedSamples);
  const weights3 = computeTopicWeights(clusters3);

  const longTerm = weights3.filter((tw) => tw.isCrossSession);
  const shortTerm = weights3.filter((tw) => !tw.isCrossSession);

  assert(longTerm.length >= 1, `should have at least 1 long-term cluster, got ${longTerm.length} (clusters: ${JSON.stringify(weights3.map((tw) => ({ k: tw.cluster.keywords.slice(0, 3), days: tw.uniqueDays, cross: tw.isCrossSession })))})`);
  assert(shortTerm.length >= 1, 'should have at least 1 short-term cluster');

  console.log(`PASS: mixed topics → ${longTerm.length} long-term, ${shortTerm.length} short-term clusters`);

  // === Test 4: Cross-group bonus ===
  // Use overlapping phrasing so Jaccard >= 0.25
  const crossGroupSamples = [
    sample('今天天气不错啊', 'g1', '2026-05-28'),
    sample('今天天气不错呀', 'g2', '2026-05-28'),
  ];

  const clusters4 = clusterSamplesByTopic(crossGroupSamples);
  const weights4 = computeTopicWeights(clusters4);
  const weather4 = weights4.find((tw) => tw.cluster.keywords.some((k) => /天气/.test(k)));
  assert(weather4, 'should find weather cluster');
  assert(weather4.uniqueGroups >= 2, `should be cross-group, got ${weather4.uniqueGroups}`);
  // crossGroupBonus is internal to computeTopicWeights, check via weight increase
  // weight = sampleCount * 0.08 + crossGroupBonus (0.15 for cross-group)
  // 2 samples * 0.08 = 0.16, with bonus = 0.31
  assert(weather4.weight > 0.16, `weight should include cross-group bonus, got ${weather4.weight}`);

  console.log('PASS: cross-group bonus applied');

  // === Test 5: Token/keyword extraction ===
  const tokenSamples = [
    sample('我用React写了个组件', 'g1', '2026-05-28'),
    sample('React的hooks真好用', 'g1', '2026-05-28'),
  ];

  const clusters5 = clusterSamplesByTopic(tokenSamples);
  const react5 = clusters5.find((c) => c.keywords.some((k) => /react/i.test(k)));
  assert(react5, 'should extract "react" as special term');
  assert(react5.samples.length === 2, 'both samples should cluster together');

  console.log('PASS: special terms (React) extracted and clustered');

  // === Summary ===
  console.log('\nAll V2 verification tests PASSED.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
