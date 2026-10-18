/**
 * 成绩卡降级时选哪一条成绩。
 *
 * 降级路径最容易犯的错：不管要画什么，一律拿"最近一次"。最近通过可能拿到
 * 一条失败记录，某谱面成绩更会画成另一张图。这里把选择逻辑抽出来，单独测。
 */
export function pickFallbackScore(
  source: 'recent_play' | 'recent_pass',
  scores: readonly any[],
): any | null {
  const list = Array.isArray(scores) ? scores : [];
  if (source === 'recent_pass') {
    return list.find(
      (entry) => entry && entry.passed !== false && String(entry.rank || '').toUpperCase() !== 'F',
    ) || null;
  }
  return list[0] || null;
}
