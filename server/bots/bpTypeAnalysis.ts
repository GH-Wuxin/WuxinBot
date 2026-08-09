// Natural-language BP type analysis (串图/跳图/技术/切换 proportions).
// Deterministic: osu!oracle classifies the player's real Top100 beatmaps and
// the reply is formatted from real probabilities — never LLM-fabricated.
import { getUser, getUserById, getUserBestScores } from '../osu/api.js';
import {
  classifyBeatmaps,
  formatClassifierBlock,
  type ClassifierResult,
} from '../osu/classifier.js';
import { readDb, updateDb } from '../store.js';
import {
  loadInternalOsuUser,
  resolveInternalPlayerTarget,
  type TargetResolutionExtra,
} from './executor.js';

const CACHE_TTL_MS = 24 * 3600_000;
const MAX_CACHE_ENTRIES = 100;

interface BpTypeAnalysisCacheEntry {
  osuUserId: number;
  username: string;
  distribution: Record<string, number>;
  totalClassified: number;
  classifiedAt: string;
}

function cachedAnalysis(db: any, osuUserId: number): BpTypeAnalysisCacheEntry | null {
  const entries: BpTypeAnalysisCacheEntry[] = db.osuTypeAnalyses || [];
  const entry = entries.find((item) => Number(item.osuUserId) === Number(osuUserId));
  if (!entry) return null;
  const age = Date.now() - new Date(entry.classifiedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS ? entry : null;
}

function saveAnalysis(entry: BpTypeAnalysisCacheEntry): void {
  updateDb((draft) => {
    draft.osuTypeAnalyses = draft.osuTypeAnalyses || [];
    draft.osuTypeAnalyses = draft.osuTypeAnalyses.filter(
      (item: BpTypeAnalysisCacheEntry) => Number(item.osuUserId) !== Number(entry.osuUserId),
    );
    draft.osuTypeAnalyses.push(entry);
    draft.osuTypeAnalyses = draft.osuTypeAnalyses.slice(-MAX_CACHE_ENTRIES);
  });
}

function formatCachedReply(entry: BpTypeAnalysisCacheEntry): string {
  const result: ClassifierResult = {
    distribution: entry.distribution,
    details: {},
    totalClassified: entry.totalClassified,
    errors: [],
  };
  return `${formatClassifierBlock(result)}\n分类来自 osu!oracle（aim/alt/tech/stream，标准模式，训练范围约 5★-9★）\n（24 小时内已分类，直接使用缓存）`;
}

export async function runBpTypeAnalysis(
  db: any,
  requestingUserId: string,
  explicitUsername = '',
  extra: TargetResolutionExtra = {},
): Promise<string> {
  const target = resolveInternalPlayerTarget(db, String(requestingUserId), explicitUsername, extra);
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

  const cached = cachedAnalysis(readDb(), user.id);
  if (cached) {
    return formatCachedReply(cached);
  }

  const scores = await getUserBestScores(user.id, 'osu', 100);
  const beatmapIds = scores
    .map((score) => Number(score.beatmap?.id || 0))
    .filter((id) => id > 0);
  const result = await classifyBeatmaps(beatmapIds);

  if (result.totalClassified === 0) {
    const detail = result.errors[0] || '未知错误';
    return `BP 谱面类型分析暂时不可用（osu!oracle：${detail}）。可以稍后再试，或先用 /w osu analyze 生成完整分析。`;
  }

  saveAnalysis({
    osuUserId: user.id,
    username: user.username,
    distribution: result.distribution,
    totalClassified: result.totalClassified,
    classifiedAt: new Date().toISOString(),
  });

  const block = formatClassifierBlock(result);
  return `${block}\n分类来自 osu!oracle（aim/alt/tech/stream，标准模式，训练范围约 5★-9★）`;
}

export function clearBpTypeAnalysisCache(): void {
  updateDb((draft) => {
    draft.osuTypeAnalyses = [];
  });
}
