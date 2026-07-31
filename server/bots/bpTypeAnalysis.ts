// Natural-language BP type analysis (串图/跳图/技术/切换 proportions).
// Deterministic: osu!oracle classifies the player's real Top100 beatmaps and
// the reply is formatted from real probabilities — never LLM-fabricated.
import { getUser, getUserById, getUserBestScores } from '../osu/api.js';
import {
  classifyBeatmaps,
  formatClassifierBlock,
  type ClassifierResult,
} from '../osu/classifier.js';
import { loadInternalOsuUser, resolveInternalPlayerTarget } from './executor.js';

const CACHE_TTL_MS = 24 * 3600_000;
const cache = new Map<string, { at: number; result: ClassifierResult }>();

export async function runBpTypeAnalysis(
  db: any,
  requestingUserId: string,
  explicitUsername = ''
): Promise<string> {
  const target = resolveInternalPlayerTarget(db, String(requestingUserId), explicitUsername);
  if (!target) {
    return '要分析 BP 谱面类型，需要先绑定 osu! 账号：发 /w osu bind 你的用户名。';
  }

  let user;
  try {
    user = target.kind === 'id'
      ? await getUserById(Number(target.value), 'osu')
      : await getUser(String(target.value), 'osu');
  } catch (error) {
    return `找不到 osu! 用户：${String((error as Error)?.message || error)}`;
  }

  const key = `user:${user.id}`;
  const cached = cache.get(key);
  let result: ClassifierResult;
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    result = cached.result;
  } else {
    const scores = await getUserBestScores(user.id, 'osu', 100);
    const beatmapIds = scores
      .map((score) => Number(score.beatmap?.id || 0))
      .filter((id) => id > 0);
    result = await classifyBeatmaps(beatmapIds);
    cache.set(key, { at: Date.now(), result });
  }

  if (result.totalClassified === 0) {
    const detail = result.errors[0] || '未知错误';
    return `BP 谱面类型分析暂时不可用（osu!oracle：${detail}）。可以稍后再试，或先用 /w osu analyze 生成完整分析。`;
  }

  const block = formatClassifierBlock(result);
  const cacheNote = cached ? '\n（24 小时内已分类，直接使用缓存）' : '';
  return `${block}\n分类来自 osu!oracle（aim/alt/tech/stream，标准模式，训练范围约 5★-9★）${cacheNote}`;
}

export function clearBpTypeAnalysisCache(): void {
  cache.clear();
}
