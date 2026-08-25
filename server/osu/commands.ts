// /w osu commands — bind and analyze with cooldown, queue, and @mention.

import { readDb, updateDb, nowIso } from '../store.js';
import { completeChat } from '../bot/llm.js';
import { traceEvent } from '../requestTrace.js';
import { collectPlayerData, collectPlayerOneLineData, collectRecentPlayerData } from './collector.js';
import { retrieveKnowledgeForPrompt } from '../bot/knowledgeBase.js';
import {
  buildOneLineReviewFacts,
  buildOneLineReviewPrompt,
  buildOneLineReviewStyleQuery,
  fallbackOneLineReview,
  findCopiedStyleFragment,
  normalizeOneLineReview,
  validateOneLineReview,
} from './oneLineReview.js';
import {
  analyzeData,
  buildAnalysisEditorPrompt,
  buildAnalysisRepairPrompt,
  buildAnalysisReviewerPrompt,
  buildAnalysisSectionCommentsPrompt,
  condensePippiComment,
  findConclusionSectionReuse,
  findAnalysisStyleReuse,
  formatPippiComment,
  injectAnalysisSectionComments,
  parseAnalysisSectionComments,
  parsePartialAnalysisSectionComments,
  parseReviewerVerdicts,
  sanitizeAnalysisSectionComments,
  validateAnalysisReport,
  validatePippiComment,
  validateAnalysisSectionComments,
} from './analyzer.js';
import type {
  AnalysisNarrativeContext,
  AnalysisSectionComments,
  AnalysisStyleAvoidance,
} from './analyzer.js';
import type { OsuMode, OsuScore, OsuUser } from './types.js';
import { normalizedScoreMods, scoreStarRating } from './scoreMetrics.js';
import {
  extractSkillRecord,
  resolveSkillQq,
  updateRecentSkillRecordInDb,
  upsertSkillRecordInDb,
} from '../bots/skills.js';
import { syncLazybotBinding, removeLazybotBinding } from '../bots/bindingSync.js';
import {
  OSU_SUBCOMMANDS,
  OSU_CLEAR_ACTIONS_META,
  type OsuClearActionId,
  type OsuCommandId,
} from '../bot/commands/osu.meta.js';
import { ANALYSIS_COOLDOWN, RECENT_COOLDOWN } from '../bot/commands/commandConstants.js';
import { OWNER_COMMANDS } from '../bot/commands/owner.meta.js';
import {
  canViewCommand,
  canListCommand,
  type CommandPermissions,
} from '../bot/commands/index.js';

// ── Queue (serial — only one analysis runs at a time) ──

interface QueueEntry {
  event: any;
  sendMessage: any;
  target: string | number;
  mode: OsuMode;
  userId: string;
  groupId: string;
  resolve: (result: any) => void;
}

const ANALYSIS_COOLDOWN_MS = ANALYSIS_COOLDOWN.ms;
const RECENT_COOLDOWN_MS = RECENT_COOLDOWN.ms;
const ANALYSIS_FORMAT_VERSION = 90;
const RECENT_FORMAT_VERSION = 4;
export const OSU_ANALYSIS_MODEL = 'deepseek-v4-flash';
// Independent reviewer model: deliberately a separate knob from the generator
// so the reviewer can be swapped without touching pippi's generation side.
export const OSU_REVIEW_MODEL = 'deepseek-v4-flash';
// The independent LLM reviewer catches semantic fabrication that a word-list
// validator cannot (e.g. “松一口气”“乱撞中攒出直觉”). Hard-rejected components
// are locally replaced by deterministic facts; quality opinions never degrade.
const ENABLE_RUNTIME_LLM_FACT_REVIEW = true;
let queue: QueueEntry[] = [];
let running = false;
let currentEntry: QueueEntry | null = null;
const MAX_ANALYZE_QUEUE = 8;
// Retained as a reversible tombstone while player Skill profiles replace the
// legacy report/roast experiment. Direct calls must fail before API/LLM work.
const ENABLE_OSU_ANALYZE = false;

/**
 * Normalize every osuBindings format that has existed in Wuxin's database.
 *
 * Legacy databases stored a numeric user id or a username directly. Newer
 * bindings store both as an object. Keeping this normalization at the command
 * boundary prevents an object binding from becoming "[object Object]" in an
 * osu! API request.
 */
export function resolveOsuBindingValue(binding: any): string | number | null {
  if (typeof binding === 'number' && Number.isFinite(binding) && binding > 0) {
    return binding;
  }
  if (typeof binding === 'string') {
    const value = binding.trim();
    if (!value) return null;
    return /^\d+$/.test(value) ? Number(value) : value;
  }
  if (binding && typeof binding === 'object') {
    const id = Number(binding.osuUserId ?? binding.userId ?? binding.id ?? 0);
    if (Number.isFinite(id) && id > 0) return id;
    const username = String(binding.osuUsername ?? binding.username ?? '').trim();
    if (username) return username;
  }
  return null;
}

export function osuBindingMatchesUser(
  binding: any,
  user: { id?: unknown; username?: unknown } | null | undefined,
): boolean {
  if (!binding || !user) return false;
  const resolvedId = Number(user.id ?? 0);
  const resolvedUsername = String(user.username ?? '').trim().toLocaleLowerCase();

  if (binding && typeof binding === 'object') {
    const bindingId = Number(binding.osuUserId ?? binding.userId ?? binding.id ?? 0);
    const bindingUsername = String(binding.osuUsername ?? binding.username ?? '')
      .trim()
      .toLocaleLowerCase();
    return Boolean(
      (Number.isFinite(bindingId) && bindingId > 0 && bindingId === resolvedId)
      || (bindingUsername && bindingUsername === resolvedUsername)
    );
  }

  const target = resolveOsuBindingValue(binding);
  if (typeof target === 'number') return target === resolvedId;
  return Boolean(target && String(target).trim().toLocaleLowerCase() === resolvedUsername);
}

function resolveUsername(db: any, event: any, args?: string): string | number | null {
  const provided = String(args || '').trim();
  if (provided && !provided.startsWith('--')) return provided;
  if (event.atTargets?.[0]) {
    const bindings = db.osuBindings || {};
    return resolveOsuBindingValue(bindings[String(event.atTargets[0])]);
  }
  const bindings = db.osuBindings || {};
  return resolveOsuBindingValue(bindings[String(event.userId)]);
}

function parseMode(arg?: string): OsuMode {
  const map: Record<string, OsuMode> = { std: 'osu', osu: 'osu', taiko: 'taiko', fruits: 'fruits', catch: 'fruits', mania: 'mania' };
  return map[String(arg || '').toLowerCase()] || 'osu';
}

function parseTargetAndMode(db: any, event: any, value: string): {
  target: string | number | null;
  mode: OsuMode;
} {
  const parts = String(value || '').split(/\s+/).filter(Boolean);
  const flagParts: string[] = [];
  const nameParts: string[] = [];
  for (const part of parts) {
    if (part.startsWith('--')) flagParts.push(part);
    else if (!part.startsWith('[CQ:')) nameParts.push(part);
  }

  let target: string | number | null = null;
  const atQq = event.atTargets?.[0];
  if (atQq) target = resolveOsuBindingValue(db.osuBindings?.[String(atQq)]);
  if (!target && nameParts.length > 0) target = nameParts.join(' ');
  if (!target) target = resolveUsername(db, event);

  let mode: OsuMode = 'osu';
  for (const flag of flagParts) {
    const match = flag.match(/^--mode=(.+)$/);
    if (match) mode = parseMode(match[1]);
  }
  return { target, mode };
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function buildScoreSnapshot(scores: OsuScore[]) {
  const stars = scores
    .map(scoreStarRating)
    .filter(value => value > 0);
  const accuracies = scores.map(score => Number(score.accuracy || 0));
  return {
    count: scores.length,
    averageStars: average(stars),
    averageAcc: average(accuracies),
  };
}

function modCountsLabel(scores: OsuScore[]): string {
  const counts = new Map<string, number>();
  for (const score of scores) {
    const label = score.mods?.length ? score.mods.join('') : 'NM';
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([label, count]) => `${label} ${count}`)
    .join('｜') || '无';
}

function scoreModCombination(score: OsuScore): string {
  const mods = normalizedScoreMods(score);
  return mods.length > 0 ? mods.join('') : 'NM';
}

function buildModComposition(scores: OsuScore[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const score of scores) {
    const label = scoreModCombination(score);
    counts[label] = (counts[label] || 0) + 1;
  }
  return counts;
}

function compactConclusion(value: unknown, maxLength = 360): string {
  const text = String(value || '')
    .replace(/^【结论】\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function conclusionFromSavedAnalysis(entry: any): string {
  const fullText = String(entry?.fullText || '');
  const conclusionIndex = fullText.lastIndexOf('【结论】');
  if (conclusionIndex >= 0) return compactConclusion(fullText.slice(conclusionIndex));
  return compactConclusion(entry?.summary || fullText);
}

/**
 * Build a local-only expression history for deterministic reuse checks. These
 * strings are never injected into the next player's prompt; only an anonymous
 * "rewrite the sentence skeleton" reason reaches the model after a collision.
 */
export function buildAnalysisStyleAvoidance(
  db: any,
  limit = 20,
  _exclude?: { osuUserId?: unknown; displayName?: unknown },
): AnalysisStyleAvoidance {
  // Analyze is an independent scene. Earlier versions compared every new
  // sentence against recent reports stored in db.osuAnalyses. That made the
  // wording of the current player depend on who happened to be analyzed
  // before them and progressively exhausted ordinary Chinese expressions.
  // Keep the return shape for callers, but never carry prose across runs.
  void db;
  void limit;
  void _exclude;
  return { recentExpressions: [], blockedFragments: [] };
}

function ppPlusRecord(bars: any): Record<string, number> | undefined {
  if (!bars) return undefined;
  return {
    jump: Number(bars.jump || 0),
    flow: Number(bars.flow || 0),
    speed: Number(bars.speed || 0),
    stamina: Number(bars.stamina || 0),
    precision: Number(bars.precision || 0),
    accuracy: Number(bars.accuracy || 0),
    ppTotal: Number(bars.ppTotal || 0),
  };
}

function buildRecentSkillSummary(scores: OsuScore[], baseline: any): string {
  if (scores.length === 0) return '这次 osu! API 没有返回 Recent 记录。';
  const recent = buildScoreSnapshot(scores);
  const bp = baseline?.baseline || {};
  const recentStars = recent.averageStars > 0 ? `${recent.averageStars.toFixed(2)}★` : '星数不可用';
  const bpStars = Number(bp.topAverageStars || 0) > 0
    ? `${Number(bp.topAverageStars).toFixed(2)}★`
    : '星数不可用';
  return [
    `Recent ${recent.count} 次：平均 ${recentStars}、Acc ${(recent.averageAcc * 100).toFixed(2)}%，Mods ${modCountsLabel(scores)}。`,
    `Analyze BP 基线：平均 ${bpStars}、Acc ${(Number(bp.topAverageAcc || 0) * 100).toFixed(2)}%。`,
  ].join(' ');
}

function findFullBaseline(db: any, user: OsuUser, target: string | number, mode: OsuMode): any | null {
  const candidates = (db.osuAnalyses || []) as any[];
  const targetKey = String(target).trim().toLowerCase();
  const usernameKey = String(user.username).trim().toLowerCase();
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const entry = candidates[index];
    if ((entry.mode || 'osu') !== mode || !entry.baseline) continue;
    const matchesUser = Number(entry.osuUserId || 0) === Number(user.id)
      || String(entry.target || '').trim().toLowerCase() === targetKey
      || String(entry.displayName || '').trim().toLowerCase() === usernameKey;
    if (matchesUser) return entry;
  }
  return null;
}

function lookupCachedRecent(db: any, osuUserId: number, mode: OsuMode): string | null {
  const cutoff = Date.now() - RECENT_COOLDOWN_MS;
  const entries = (db.osuRecentAnalyses || []) as any[];
  const hasRecentSkillMemory = (db.skillStore?.records || []).some((record: any) =>
    Number(record.osuUserId || 0) === Number(osuUserId) &&
    (record.mode || 'osu') === mode &&
    Boolean(String(record.recentSummary || '').trim())
  );
  if (!hasRecentSkillMemory) return null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (Number(entry.osuUserId) === Number(osuUserId) &&
        (entry.mode || 'osu') === mode &&
        Number(entry.formatVersion || 0) === RECENT_FORMAT_VERSION &&
        new Date(entry.createdAt).getTime() > cutoff &&
        entry.fullText) {
      return entry.fullText;
    }
  }
  return null;
}

export function buildRecentReport(user: OsuUser, scores: OsuScore[], baseline: any): string {
  if (scores.length === 0) {
    return [
      '【近期】',
      '这次 API 没有返回 Recent 记录。',
      '空白可不算情报。当前没有足够内容形成近期判断。'
    ].join('\n');
  }

  const recent = buildScoreSnapshot(scores);
  const top = baseline.baseline;
  return [
    `【近期 ${recent.count} 次】`,
    `平均 ${recent.averageStars.toFixed(2)}★｜Acc ${(recent.averageAcc * 100).toFixed(2)}%`,
    `Mods：${modCountsLabel(scores)}`,
    '',
    '【BP 基线对照】',
    `BP100 平均 ${Number(top.topAverageStars || 0).toFixed(2)}★｜Acc ${(Number(top.topAverageAcc || 0) * 100).toFixed(2)}%`,
    'Recent 收录近期提交，BP 收录 Best Performance 成绩。这里只并排展示数值；变化原因仍然未知。',
    '',
    '【结论】',
    `${user.username} 的近期样本与 BP 基线已经完成对照。`,
    '数值差异可以确认，状态与能力变化仍缺少直接证据。'
  ].join('\n');
}

function lookupCachedAnalysis(db: any, userId: string, target: string | number, mode: string): string | null {
  const analyses = (db.osuAnalyses || []) as any[];
  const skillRecords = (db.skillStore?.records || []) as any[];
  const cutoff = Date.now() - ANALYSIS_COOLDOWN_MS;
  for (let i = analyses.length - 1; i >= 0; i--) {
    const a = analyses[i];
    const hasSkillMemory = skillRecords.some(record =>
      (record.mode || 'osu') === (mode || 'osu') &&
      (
        (Number(a.osuUserId || 0) > 0 && Number(record.osuUserId || 0) === Number(a.osuUserId)) ||
        String(record.osuUsername || '').trim().toLowerCase() === String(a.displayName || '').trim().toLowerCase()
      )
    );
    if (String(a.userId) === String(userId) &&
        String(a.target) === String(target) &&
        (a.mode || 'osu') === (mode || 'osu') &&
        Number(a.formatVersion || 0) === ANALYSIS_FORMAT_VERSION &&
        new Date(a.createdAt).getTime() > cutoff &&
        a.fullText &&
        hasSkillMemory) {
      return a.fullText;
    }
  }
  return null;
}

export async function sendAsReply(event: any, sendMessage: any, text: string) {
  if (!sendMessage || !text) return;
  const mention = `[CQ:at,qq=${event.userId}]`;
  // Use merge-forward for long reports (>400 chars)
  if (text.length > 400) {
    const { sendForwardBlocks } = await import('../bot/reply.js');
    const title = `${event.nickname || event.userId} 的 osu! 分析报告`;
    await sendForwardBlocks(sendMessage, event, title, text);
  } else {
    await sendMessage(event, `${mention}\n${text}`);
  }
}

const SECTION_COMMENT_KEYS = ['profile', 'top', 'top5', 'mods', 'pplus', 'recent', 'classification'] as const;
type SectionCommentKey = typeof SECTION_COMMENT_KEYS[number];
type SectionCommentSource = 'llm' | 'fallback' | 'none';
type SectionCommentSources = Record<SectionCommentKey, SectionCommentSource>;

export function applyReviewerHardFallbacks(
  analysis: Pick<ReturnType<typeof analyzeData>, 'safeSectionFallbacks' | 'safePippiFallback'>,
  comments: AnalysisSectionComments | null,
  conclusion: string,
  rejects: { section: string; kind?: 'hard' | 'quality'; reason?: string }[],
): {
  comments: AnalysisSectionComments | null;
  conclusion: string;
  downgradedSections: SectionCommentKey[];
  conclusionDowngraded: boolean;
  unknownHardSection: boolean;
} {
  const nextComments = comments ? { ...comments } : null;
  const downgradedSections: SectionCommentKey[] = [];
  let conclusionDowngraded = false;
  let unknownHardSection = false;

  for (const reject of rejects) {
    if (reject.kind === 'quality') continue;
    const section = String(reject.section || '').trim().toLowerCase();
    if (section === 'conclusion') {
      conclusionDowngraded = true;
      continue;
    }
    if (SECTION_COMMENT_KEYS.includes(section as SectionCommentKey) && nextComments) {
      const key = section as SectionCommentKey;
      nextComments[key] = analysis.safeSectionFallbacks[key];
      if (!downgradedSections.includes(key)) downgradedSections.push(key);
      continue;
    }
    unknownHardSection = true;
  }

  return {
    comments: nextComments,
    conclusion: conclusionDowngraded ? analysis.safePippiFallback : conclusion,
    downgradedSections,
    conclusionDowngraded,
    unknownHardSection,
  };
}

function allSectionSources(source: SectionCommentSource): SectionCommentSources {
  return Object.fromEntries(SECTION_COMMENT_KEYS.map(key => [key, source])) as SectionCommentSources;
}

function summarizeSectionSources(sources: SectionCommentSources): 'llm' | 'mixed' | 'fallback' | 'none' {
  const unique = new Set(Object.values(sources));
  if (unique.size === 1) return [...unique][0] as 'llm' | 'fallback' | 'none';
  return 'mixed';
}

/**
 * After the third attempt, sections that still violate hard gates (numbers,
 * Mod semantics, HD terminology, identity) are blanked instead of shipped;
 * style-gate issues have been removed from the mechanical validator and are
 * the independent reviewer's job. Returns the sections to blank.
 */
function rejectedSectionKeys(reasons: string[]): Set<string> {
  const rejected = new Set<string>();
  for (const key of SECTION_COMMENT_KEYS) {
    for (const reason of reasons) {
      const targeted = reason.startsWith(`${key} `)
        || reason.startsWith(`${key}短评`)
        || reason.includes(`${key} 短评`);
      if (!targeted && !reason.startsWith('短评')) continue;
      rejected.add(key);
    }
  }
  return rejected;
}

/**
 * Generate (or rewrite) the six section comments. Rewrites only the rejected
 * sections and keep PASS sections verbatim. Never backfills with generic
 * catch-all sentences: after three attempts the latest LLM draft is kept as-is
 * (data sections always render), with the reject reasons logged for later
 * prompt tuning.
 */
async function generateAnalysisSectionComments(
  db: any,
  analysis: ReturnType<typeof analyzeData>,
  narrative: AnalysisNarrativeContext,
  personalityPrompt: string,
  styleAvoidance: AnalysisStyleAvoidance,
  previous?: {
    comments: AnalysisSectionComments;
    badSections: string[];
    reasons: string[];
    sources?: SectionCommentSources;
  }
): Promise<{
  comments: AnalysisSectionComments | null;
  source: 'llm' | 'mixed' | 'fallback' | 'none';
  sources: SectionCommentSources;
  reasons: string[];
  rejected: string;
  trace: { attempt: number; outcome: 'accepted' | 'rejected' | 'parse_error' | 'error' | 'repaired'; reasons: string[] }[];
}> {
  const prompt = buildAnalysisSectionCommentsPrompt(
    analysis,
    narrative,
    personalityPrompt,
    styleAvoidance,
  );
  let candidate = '';
  let lastParsed: AnalysisSectionComments | null = previous?.comments || null;
  let lastReasons: string[] = previous?.reasons || [];
  let badSections = new Set(previous?.badSections || []);
  let lastSources = previous?.sources
    ? { ...previous.sources }
    : (previous?.comments ? allSectionSources('llm') : allSectionSources('none'));
  const trace: { attempt: number; outcome: 'accepted' | 'rejected' | 'parse_error' | 'error' | 'repaired'; reasons: string[]; draft?: string }[] = [];

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const isFirstPass = attempt === 1 && !previous;
      const userContent = isFirstPass
        ? prompt.user
        : [
            prompt.user,
            '',
            `<rejected_sections>${badSections.size > 0 ? [...badSections].join('、') : '（见 problems）'}</rejected_sections>`,
            `<problems>${lastReasons.join('；')}</problems>`,
            `<rewrite_round>${attempt - 1}</rewrite_round>`,
            attempt >= 3
              ? '这是最后一次局部重写。只使用 verified_facts 已经原样给出的数字、数量与直接关系；不要自行做加减乘除，不写比喻，不翻译 PP+ 为具体能力，不猜动机。'
              : '从零重写被拒绝的区块，不沿用被拒句的开头、句法骨架或比喻。',
            '只输出一个合法 JSON 对象，键必须且只能是 rejected_sections 中列出的键；不要重复其余区块，不要解释。',
          ].join('\n');
      const result = await completeChat(db, {
        model: OSU_ANALYSIS_MODEL,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: userContent },
        ],
          maxTokens: 4096,
          temperature: attempt === 1 ? 0.76 : (attempt === 2 ? 0.5 : 0.35),
          timeoutMs: 60000,
          requestMaxRetries: 0,
        label: attempt === 1 ? 'osu区块短评' : `osu区块短评重写${attempt - 1}`,
      });
      candidate = String(result.text || '').trim();
      let parsedRaw: AnalysisSectionComments | null = null;
      if (lastParsed && badSections.size > 0) {
        const requestedKeys = [...badSections].filter((key): key is SectionCommentKey =>
          SECTION_COMMENT_KEYS.includes(key as SectionCommentKey)
        );
        const partial = parsePartialAnalysisSectionComments(candidate, requestedKeys);
        if (partial) {
          parsedRaw = { ...lastParsed };
          for (const key of requestedKeys) {
            parsedRaw[key] = String(partial[key] || '');
            lastSources[key] = 'llm';
          }
        }
      } else {
        parsedRaw = parseAnalysisSectionComments(candidate);
        if (parsedRaw) lastSources = allSectionSources('llm');
      }
      if (!parsedRaw) {
        lastReasons = [lastParsed && badSections.size > 0
          ? `没有输出可解析的目标区块 JSON：${[...badSections].join('、')}`
          : '没有输出可解析的七区块 JSON'];
        trace.push({ attempt, outcome: 'parse_error', reasons: [...lastReasons], draft: candidate.slice(0, 1800) });
        continue;
      }
      const sanitized = sanitizeAnalysisSectionComments(parsedRaw, narrative, analysis);
      const parsed: AnalysisSectionComments = sanitized;
      const validation = validateAnalysisSectionComments(analysis, parsed, narrative);
      const styleReasons = SECTION_COMMENT_KEYS.flatMap((key) =>
        findAnalysisStyleReuse(parsed[key], styleAvoidance).map((reason) => `${key} ${reason}`)
      );
      // 账号档案是七栏中最长的一栏；长度排序只作为重写提示，不参与硬门。
      const profileLength = String(parsed.profile || '').trim().length;
      const longestOther = SECTION_COMMENT_KEYS
        .filter((key) => key !== 'profile')
        .reduce((max, key) => Math.max(max, String(parsed[key] || '').trim().length), 0);
      const orderingReasons = profileLength > 0 && longestOther > profileLength
        ? ['profile 短评：账号档案应比其他栏目更长，重新展开这一栏']
        : [];
      const combinedReasons = [...validation.reasons, ...styleReasons, ...orderingReasons];
      lastParsed = parsed;
      // Style cooldown gets two chances to request a fresher phrasing, but it
      // must never turn an otherwise factual LLM draft into a deterministic
      // fallback. On the final attempt only hard validation can block output.
      if (combinedReasons.length === 0 || (attempt === 3 && validation.reasons.length === 0)) {
        trace.push({ attempt, outcome: 'accepted', reasons: [], draft: candidate.slice(0, 1800) });
        return {
          comments: parsed,
          source: summarizeSectionSources(lastSources),
          sources: lastSources,
          reasons: [],
          rejected: '',
          trace,
        };
      }
      lastReasons = combinedReasons;
      trace.push({ attempt, outcome: 'rejected', reasons: combinedReasons.slice(0, 12), draft: candidate.slice(0, 1800) });
      badSections = rejectedSectionKeys(combinedReasons);
      console.error(`[osu analyze] 区块短评第 ${attempt} 次未通过：`, combinedReasons);
      // 硬错误先走 LLM 定向修复（最小改动），修复结果必须重新通过机械校验；
      // 修不动才进入下一轮的整段重写。
      if (validation.reasons.length > 0 && badSections.size > 0) {
        const repaired = { ...parsed };
        let repairedAny = false;
        for (const key of badSections) {
          if (!SECTION_COMMENT_KEYS.includes(key as SectionCommentKey)) continue;
          const typedKey = key as SectionCommentKey;
          const keyReasons = validation.reasons.filter((reason) =>
            reason.startsWith(`${typedKey} `)
            || reason.startsWith(`${typedKey}短评`)
            || reason.includes(`${typedKey} 短评`)
          );
          const fixed = await repairFailedText(
            db, analysis, typedKey, String(repaired[typedKey] || ''),
            keyReasons.length > 0 ? keyReasons : validation.reasons.slice(0, 8),
            narrative,
          );
          if (fixed && fixed !== String(repaired[typedKey] || '')) {
            repaired[typedKey] = fixed;
            repairedAny = true;
          }
        }
        if (repairedAny) {
          const repairedValidation = validateAnalysisSectionComments(analysis, repaired, narrative);
          if (repairedValidation.ok) {
            lastParsed = repaired;
            trace.push({ attempt, outcome: 'repaired', reasons: [], draft: candidate.slice(0, 1800) });
            return {
              comments: repaired,
              source: summarizeSectionSources(lastSources),
              sources: lastSources,
              reasons: [],
              rejected: '',
              trace,
            };
          }
          console.error(`[osu analyze] 硬错误修复后仍未通过：`, repairedValidation.reasons);
        }
      }
    } catch (error) {
      lastReasons = [String(error?.message || error)];
      trace.push({ attempt, outcome: 'error', reasons: [...lastReasons], draft: candidate.slice(0, 1800) });
      console.error(`[osu analyze] 区块短评第 ${attempt} 次失败：`, error?.message || error);
    }
  }

  // Preserve every passing LLM section. Any section that still fails the hard
  // gates receives a small deterministic fact-only fallback instead of being
  // silently blanked. Per-section sources make that local degradation visible.
  if (lastParsed) {
    const rejectedKeys = badSections.size > 0 ? badSections : rejectedSectionKeys(lastReasons);
    if (rejectedKeys.size > 0) {
      const filtered = { ...lastParsed };
      for (const key of rejectedKeys) {
        if (!SECTION_COMMENT_KEYS.includes(key as SectionCommentKey)) continue;
        const typedKey = key as SectionCommentKey;
        filtered[typedKey] = analysis.safeSectionFallbacks[typedKey];
        lastSources[typedKey] = 'fallback';
      }
      lastParsed = filtered;
    }
    return {
      comments: lastParsed,
      source: summarizeSectionSources(lastSources),
      sources: lastSources,
      reasons: lastReasons.slice(0, 8),
      rejected: candidate.slice(0, 1800),
      trace,
    };
  }
  return {
    comments: { ...analysis.safeSectionFallbacks },
    source: 'fallback',
    sources: allSectionSources('fallback'),
    reasons: lastReasons.slice(0, 8),
    rejected: candidate.slice(0, 1800),
    trace,
  };
}

/** Deterministic pronoun rewrite for the conclusion's final fallback step. */
function normalizeConclusionPronouns(text: string): string {
  return String(text || '')
    .replace(/他(?:自己|本人)|她(?:自己|本人)/g, '它自己')
    .replace(/他的|她的/g, '它的')
    .replace(/(?<![其们])[他她](?![们])/g, '这名玩家');
}

/**
 * Surgical hard-error repair via a separate repair LLM (same model family as
 * the independent reviewer, never pippi). Returns the repaired text or null
 * when the call fails; callers must re-run the mechanical validator on the
 * result before accepting it.
 */
async function repairFailedText(
  db: any,
  analysis: ReturnType<typeof analyzeData>,
  target: SectionCommentKey | 'conclusion',
  text: string,
  reasons: string[],
  narrative: AnalysisNarrativeContext,
): Promise<string | null> {
  const trimmed = String(text || '').trim();
  if (!trimmed || reasons.length === 0) return null;
  try {
    const prompt = buildAnalysisRepairPrompt(analysis, target, trimmed, reasons, narrative);
    const result = await completeChat(db, {
      model: OSU_REVIEW_MODEL,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      maxTokens: 1024,
      temperature: 0,
      timeoutMs: 60000,
      requestMaxRetries: 0,
      label: `osu硬错误修复(${target})`,
    });
    const repaired = String(result.text || '').trim();
    return repaired || null;
  } catch (error) {
    console.error(`[osu analyze] 硬错误修复(${target})调用失败：`, error?.message || error);
    return null;
  }
}

/**
 * Generate the final 【结论】 with up to three attempts. Mechanical checks
 * (numbers/terminology) stay hard gates; on final failure the deterministic
 * fact-only fallback wins. Generic catch-all sentences are never injected.
 */
async function generateConclusion(
  db: any,
  analysis: ReturnType<typeof analyzeData>,
  narrative: AnalysisNarrativeContext,
  personalityPrompt: string,
  styleAvoidance: AnalysisStyleAvoidance,
  previous?: { text: string; reasons: string[] },
  sectionCommentsForReuse?: AnalysisSectionComments | null,
): Promise<{
  text: string;
  source: 'llm' | 'fallback';
  reasons: string[];
  rejected: string;
  trace: { attempt: number; outcome: 'accepted' | 'rejected' | 'error' | 'repaired'; reasons: string[] }[];
}> {
  const prompt = buildAnalysisEditorPrompt(analysis, narrative, personalityPrompt, styleAvoidance);
  let lastCandidate = previous?.text || '';
  let lastReasons: string[] = previous?.reasons || [];
  const trace: { attempt: number; outcome: 'accepted' | 'rejected' | 'error' | 'repaired'; reasons: string[]; draft?: string }[] = [];

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const isFirstPass = attempt === 1 && !previous;
      const userContent = isFirstPass
        ? prompt.user
        : [
            prompt.user,
            '',
            `<problems>${lastReasons.join('；')}</problems>`,
            `<rewrite_round>${attempt - 1}</rewrite_round>`,
            attempt >= 3
              ? '这是最后一次重写。只使用 verified_facts 原样提供的数字与直接关系；不自行计算，不写能力成长、玩家动机、练习建议或 Recent 原因。'
              : '从零重写这段结论，不保留被拒句的开头、句法骨架或比喻。',
            '重新输出【结论】。',
          ].join('\n');
      const result = await completeChat(db, {
        model: OSU_ANALYSIS_MODEL,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: userContent },
        ],
        maxTokens: 1024,
        temperature: attempt === 1 ? 0.66 : (attempt === 2 ? 0.46 : 0.32),
        timeoutMs: 60000,
        requestMaxRetries: 0,
        label: attempt === 1 ? 'osu分析创意稿' : `osu分析结论重写${attempt - 1}`,
      });
      const editedText = condensePippiComment(formatPippiComment(result.text), 480);
      lastCandidate = editedText;
      const validation = validatePippiComment(analysis, editedText, narrative);
      const styleReasons = findAnalysisStyleReuse(editedText, styleAvoidance);
      const reuseReasons = findConclusionSectionReuse(editedText, sectionCommentsForReuse);
      // 本轮测试：审查只查基本事实；文风/复用检查只记录，不参与拦截。
      void reuseReasons;
      // 结论必须长于账号档案栏；同样只作为重写提示。
      const profileCommentLength = String(sectionCommentsForReuse?.profile || '').trim().length;
      const conclusionBodyLength = editedText.replace(/^【结论】\s*/, '').trim().length;
      const orderingReasons = profileCommentLength > 0 && conclusionBodyLength <= profileCommentLength
        ? ['结论应比账号档案栏更长，扩写结论']
        : [];
      const combinedReasons = [...validation.reasons, ...styleReasons, ...orderingReasons];
      // Repetition is a rewrite hint, not a factual safety failure. After two
      // retries, preserve a valid LLM conclusion instead of replacing it with
      // a mechanical fact list solely because of a familiar phrase.
      if (combinedReasons.length === 0 || (attempt === 3 && validation.reasons.length === 0)) {
        trace.push({ attempt, outcome: 'accepted', reasons: [], draft: editedText });
        return { text: editedText, source: 'llm', reasons: [], rejected: '', trace };
      }
      lastReasons = combinedReasons;
      trace.push({ attempt, outcome: 'rejected', reasons: combinedReasons.slice(0, 12), draft: editedText });
      console.error(`[osu analyze] 结论第 ${attempt} 次未通过：`, combinedReasons);
      // 硬错误先走 LLM 定向修复（最小改动），修复结果必须重新通过机械校验。
      if (validation.reasons.length > 0) {
        const repaired = await repairFailedText(db, analysis, 'conclusion', editedText, validation.reasons, narrative);
        if (repaired) {
          const repairedText = condensePippiComment(formatPippiComment(repaired), 480);
          const repairedValidation = validatePippiComment(analysis, repairedText, narrative);
          if (repairedValidation.ok) {
            trace.push({ attempt, outcome: 'repaired', reasons: [], draft: repairedText });
            return { text: repairedText, source: 'llm', reasons: [], rejected: '', trace };
          }
          console.error(`[osu analyze] 结论硬错误修复后仍未通过：`, repairedValidation.reasons);
        }
      }
    } catch (error) {
      lastReasons = [String(error?.message || error)];
      trace.push({ attempt, outcome: 'error', reasons: [...lastReasons], draft: lastCandidate });
      console.error(`[osu analyze] 结论第 ${attempt} 次失败：`, error?.message || error);
    }
  }

  // Pronoun normalization fallback: a mechanically valid draft that only
  // trips the gender gate (他/她 used as anaphora for the account itself,
  // e.g. 这份账号……它自己的维度) gets a deterministic "它" rewrite instead of
  // a fact-list fallback. This is a minimal, recorded normalization — it is
  // not sentence pruning, and other hard errors still fail below.
  if (lastCandidate) {
    const normalized = normalizeConclusionPronouns(lastCandidate);
    if (normalized !== lastCandidate) {
      const validation = validatePippiComment(analysis, normalized, narrative);
      const reuse = findConclusionSectionReuse(normalized, sectionCommentsForReuse);
      void reuse;
      if (validation.ok) {
        trace.push({ attempt: 3, outcome: 'accepted', reasons: ['代词归一化后通过（他/她 → 它）'] });
        return { text: normalized, source: 'llm', reasons: [], rejected: '', trace };
      }
    }
  }

  // Never turn a rejected draft into an apparent LLM success by deleting the
  // sentences that failed validation. A partial residue is not a conclusion.
  return {
    text: analysis.safePippiFallback,
    source: 'fallback',
    reasons: lastReasons.slice(0, 8),
    rejected: lastCandidate.slice(0, 1200),
    trace,
  };
}

/**
 * Independent whole-report review. The reviewer has no persona and returns
 * per-section verdicts; REJECT carries a short reason. Null verdicts mean the
 * reviewer call failed (caller must not loop forever on that).
 */
async function reviewFullReport(
  db: any,
  analysis: ReturnType<typeof analyzeData>,
  report: string,
  narrative: AnalysisNarrativeContext,
): Promise<{ verdicts: Awaited<ReturnType<typeof parseReviewerVerdicts>>; raw: string }> {
  const prompt = buildAnalysisReviewerPrompt(analysis, report, narrative);
  let lastRaw = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const reviewStartedAt = Date.now();
    traceEvent('REVIEW', 'reviewer_started', {
      status: 'running',
      reviewer: 'osu_full_report',
      attempt,
      model: OSU_REVIEW_MODEL,
    });
    try {
      const result = await completeChat(db, {
        model: OSU_REVIEW_MODEL,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: attempt === 1
            ? prompt.user
            : `${prompt.user}\n\n上一次没有返回完整的八段判决。必须为 profile、top、top5、mods、pplus、recent、classification、conclusion 各返回且只返回一条。` },
        ],
        maxTokens: 2048,
        temperature: 0,
        timeoutMs: 60000,
        requestMaxRetries: 0,
        label: attempt === 1 ? 'osu分析独立审查' : 'osu分析独立审查重试',
        traceRole: 'reviewer',
        tracePurpose: attempt === 1 ? 'osu_full_report_review' : 'osu_full_report_review_retry',
      });
      lastRaw = String(result.text || '').trim();
      const verdicts = parseReviewerVerdicts(lastRaw);
      if (verdicts) {
        traceEvent('REVIEW', 'reviewer_completed', {
          status: 'ok',
          durationMs: Date.now() - reviewStartedAt,
          reviewer: 'osu_full_report',
          attempt,
          verdictCount: verdicts.length,
          rejectedSections: verdicts.filter((verdict) => verdict.result === 'REJECT').map((verdict) => verdict.section),
        });
        return { verdicts, raw: lastRaw };
      }
      traceEvent('REVIEW', 'reviewer_invalid_result', {
        status: 'error',
        durationMs: Date.now() - reviewStartedAt,
        reviewer: 'osu_full_report',
        attempt,
      });
      console.error(`[osu analyze] 独立审查第 ${attempt} 次未返回完整八段判决。`);
    } catch (error) {
      traceEvent('REVIEW', 'reviewer_failed', {
        status: 'error',
        durationMs: Date.now() - reviewStartedAt,
        reviewer: 'osu_full_report',
        attempt,
        error: error?.message || String(error),
      });
      console.error(`[osu analyze] 独立审查第 ${attempt} 次调用失败：`, error?.message || error);
    }
  }
  return { verdicts: null, raw: lastRaw };
}

async function runLegacyAnalysis(
  event: any, sendMessage: any,
  target: string | number, mode: OsuMode
): Promise<string> {
  const db = readDb();
  const result = await (async () => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await collectPlayerData(target, mode);
      } catch (error) {
        lastError = error;
        if (attempt >= 3) break;
        // Player/profile fetches occasionally fail during a long batch even
        // while OAuth and the service remain healthy. Retry at the Analyze
        // boundary so a single transient socket failure does not become a
        // misleading "player unavailable" report.
        await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
      }
    }
    throw lastError;
  })();
  const topSnapshot = buildScoreSnapshot(result.bestScores);
  const recentSnapshot = buildScoreSnapshot(result.recentScores);
  const analysis = analyzeData({
    user: result.user, bestScores: result.bestScores, recentScores: result.recentScores, mode,
    pplusBars: result.pplusBars, refBars: result.refBars, classification: result.classification
  });
  const callerBinding = db.osuBindings?.[String(event.userId)];
  const isSelf = osuBindingMatchesUser(callerBinding, result.user);
  const narrative = {
    playerName: result.user?.username || String(target),
    perspective: isSelf ? 'self' as const : 'unknown' as const,
  };
  const personalityPrompt = String(db.settings.personalityPrompt || '');
  const styleAvoidance = buildAnalysisStyleAvoidance(db, 20, {
    osuUserId: result.user?.id,
    displayName: result.user?.username,
  });

  // ── Generation: section observations first, then the conclusion reads the
  // same account's accepted observations. This keeps the conclusion from
  // independently inventing a second, unrelated interpretation. ──
  let sectionCommentsResult = await generateAnalysisSectionComments(
    db,
    analysis,
    narrative,
    personalityPrompt,
    styleAvoidance,
  );
  const sectionGenerationCalls = [{ trigger: 'initial', trace: sectionCommentsResult.trace }];
  const conclusionResult = await generateConclusion(
    db,
    analysis,
    narrative,
    personalityPrompt,
    styleAvoidance,
    undefined,
    sectionCommentsResult.comments,
  );
  let pippiComment = conclusionResult.text;
  let conclusionSource = conclusionResult.source;
  let lastReasons: string[] = [...conclusionResult.reasons];
  let lastRejectedConclusion = conclusionResult.rejected;
  let sectionCommentsSource = sectionCommentsResult.source;
  let sectionCommentSources = { ...sectionCommentsResult.sources };
  let sectionCommentsValidationReasons = [...sectionCommentsResult.reasons];
  let sectionCommentsRejectedDraft = sectionCommentsResult.rejected;
  const conclusionGenerationCalls = [{ trigger: 'initial', trace: conclusionResult.trace }];

  // ── Whole-report factual review: at most two targeted repair opportunities,
  // then a final factual verdict. Literary quality is decided by the generation
  // prompt and batch evaluation, not by recursively asking another model to
  // rewrite already-valid prose. Every REJECT remains visible in reviewLog. ──
  const reviewLog: {
    round: number;
    verdicts: { section: string; result: 'PASS' | 'REJECT'; kind?: 'hard' | 'quality'; reason: string }[];
    rejects: { section: string; kind?: 'hard' | 'quality'; reason: string }[];
    unavailable?: boolean;
  }[] = [];
  let reply = '';
  let finalReportFallback = false;
  let finalValidation: { ok: boolean; reasons: string[] } = { ok: false, reasons: [] };

  {
    const visible = finalReportFallback ? analysis.safePippiFallback : pippiComment;
    let report = sectionCommentsResult.comments
      ? `${injectAnalysisSectionComments(analysis.safeBody, sectionCommentsResult.comments)}\n\n${visible}`
      : `${analysis.safeBody}\n\n${visible}`;
    finalValidation = validateAnalysisReport(analysis, report, narrative);
    if (!finalValidation.ok) {
      // Comments broke the assembly: drop them, keep body + conclusion.
      if (sectionCommentsResult.comments) {
        sectionCommentsSource = 'none';
        sectionCommentSources = allSectionSources('none');
        sectionCommentsValidationReasons = finalValidation.reasons.slice(0, 8);
        sectionCommentsRejectedDraft = JSON.stringify(sectionCommentsResult.comments).slice(0, 1800);
        console.error('[osu analyze] 区块短评组装终审失败，已保留安全正文：', finalValidation.reasons);
        report = `${analysis.safeBody}\n\n${visible}`;
        finalValidation = validateAnalysisReport(analysis, report, narrative);
      }
      // Conclusion broke the assembly: fall back to the deterministic fact
      // conclusion (mechanical gates stay hard; style gates do not).
      if (!finalValidation.ok && conclusionSource === 'llm') {
        console.error('[osu analyze] 结论组装终审失败，使用确定性结论：', finalValidation.reasons);
        pippiComment = analysis.safePippiFallback;
        conclusionSource = 'fallback';
        lastReasons = ['结论未通过机械终审'];
        report = `${analysis.safeBody}\n\n${pippiComment}`;
        finalValidation = validateAnalysisReport(analysis, report, narrative);
      }
      if (!finalValidation.ok) {
        console.error('[osu analyze] 完整报告组装校验失败，使用确定性安全报告：', finalValidation.reasons);
        reply = analysis.safeFallback;
        finalReportFallback = true;
      } else {
        reply = report;
      }
    } else {
      reply = report;
    }

    // The reviewer is a final hard-error gate. A rejected component is replaced
    // locally with its deterministic fact-only fallback; passing components are
    // preserved verbatim. Unknown section labels degrade the whole report.
    if (ENABLE_RUNTIME_LLM_FACT_REVIEW && !finalReportFallback && reply) {
      const review = await reviewFullReport(db, analysis, reply, narrative);
      if (!review.verdicts) {
        reviewLog.push({ round: 1, verdicts: [], rejects: [], unavailable: true });
        console.error('[osu analyze] 独立审查未返回有效判决，仅记录。');
      } else {
        const rejects = review.verdicts.filter((v) => v.result === 'REJECT');
        const hardRejects = rejects.filter((v) => v.kind !== 'quality');
        reviewLog.push({
          round: 1,
          verdicts: review.verdicts,
          rejects: rejects.map((v) => ({ section: v.section, kind: v.kind, reason: v.reason })),
        });
        if (hardRejects.length > 0) {
          console.error(
            '[osu analyze] 独立审查发现硬错误，执行局部确定性降级：',
            hardRejects.map((v) => `${v.section}[${v.kind || 'hard'}]=${v.reason}`).join('；'),
          );
          const fallbackResult = applyReviewerHardFallbacks(
            analysis,
            sectionCommentsResult.comments,
            pippiComment,
            hardRejects,
          );
          if (fallbackResult.unknownHardSection) {
            reply = analysis.safeFallback;
            pippiComment = analysis.safePippiFallback;
            conclusionSource = 'fallback';
            sectionCommentsSource = 'none';
            sectionCommentSources = allSectionSources('none');
            finalReportFallback = true;
            finalValidation = validateAnalysisReport(analysis, reply, narrative);
          } else {
            sectionCommentsResult = {
              ...sectionCommentsResult,
              comments: fallbackResult.comments,
            };
            for (const key of fallbackResult.downgradedSections) {
              sectionCommentSources[key] = 'fallback';
            }
            sectionCommentsSource = summarizeSectionSources(sectionCommentSources);
            sectionCommentsValidationReasons.push(
              ...hardRejects.map((v) => `reviewer ${v.section}: ${v.reason}`).slice(0, 8),
            );
            pippiComment = fallbackResult.conclusion;
            if (fallbackResult.conclusionDowngraded) {
              conclusionSource = 'fallback';
              lastReasons = hardRejects
                .filter((v) => v.section === 'conclusion')
                .map((v) => `reviewer: ${v.reason}`)
                .slice(0, 8);
            }
            const reviewedReport = fallbackResult.comments
              ? `${injectAnalysisSectionComments(analysis.safeBody, fallbackResult.comments)}\n\n${pippiComment}`
              : `${analysis.safeBody}\n\n${pippiComment}`;
            finalValidation = validateAnalysisReport(analysis, reviewedReport, narrative);
            if (finalValidation.ok) {
              reply = reviewedReport;
            } else {
              reply = analysis.safeFallback;
              pippiComment = analysis.safePippiFallback;
              conclusionSource = 'fallback';
              sectionCommentsSource = 'none';
              sectionCommentSources = allSectionSources('none');
              finalReportFallback = true;
            }
          }
        }
      }
    }
  }

  if (pippiComment === analysis.safePippiFallback) {
    console.error('[osu analyze] 综合结论使用确定性安全版本。');
  }
  const visibleConclusion = finalReportFallback ? analysis.safePippiFallback : pippiComment;
  const finalSectionCommentsSource = finalReportFallback ? 'none' : sectionCommentsSource;
  const finalSectionCommentSources = finalReportFallback
    ? allSectionSources('none')
    : sectionCommentSources;
  if (!reply) throw new Error('无法生成安全的分析报告');

  const displayName = result.user?.username || String(target);
  const modComposition = buildModComposition(result.bestScores);
  const topMods = Object.entries(modComposition)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([label]) => label);
  const conclusionSummary = compactConclusion(visibleConclusion);

  // Write non-fatal errors to stderr (never shown to end users)
  if (result.errors.length > 0) {
    console.error(`[osu analyze] ${displayName} (${target}) 的非致命错误：`, result.errors);
  }

  // Persist the report and its reusable skill memory in one atomic DB write.
  updateDb((draft) => {
    const createdAt = nowIso();
    draft.osuAnalyses = draft.osuAnalyses || [];
    draft.osuAnalyses.push({
      target: String(target),
      displayName,
      mode,
      analysisType: 'full',
      analysisModel: OSU_ANALYSIS_MODEL,
      conclusionSource: finalReportFallback ? 'fallback' : conclusionSource,
      conclusionValidationReasons: finalReportFallback
        ? finalValidation.reasons.slice(0, 8)
        : (conclusionSource === 'fallback' ? lastReasons.slice(0, 8) : []),
      conclusionRejectedDraft: finalReportFallback
        ? pippiComment.slice(0, 1200)
        : (conclusionSource === 'fallback' ? lastRejectedConclusion.slice(0, 1200) : ''),
      sectionCommentsSource: finalSectionCommentsSource,
      sectionCommentSources: finalSectionCommentSources,
      sectionComments: finalSectionCommentsSource !== 'none' ? sectionCommentsResult.comments : null,
      sectionCommentsValidationReasons,
      sectionCommentsRejectedDraft,
      reviewLog,
      generationTrace: {
        sectionComments: sectionGenerationCalls,
        conclusion: conclusionGenerationCalls,
        final: {
          sectionCommentsSource: finalSectionCommentsSource,
          sectionCommentSources: finalSectionCommentSources,
          conclusionSource: finalReportFallback ? 'fallback' : conclusionSource,
          fullReportFallback: finalReportFallback,
        },
      },
      conclusionText: visibleConclusion,
      formatVersion: ANALYSIS_FORMAT_VERSION,
      osuUserId: result.user.id,
      userId: String(event.userId),
      groupId: String(event.groupId),
      createdAt,
      pp: result.user.statistics.pp,
      rank: result.user.statistics.global_rank,
      acc: result.user.statistics.hit_accuracy,
      bestCount: result.bestScores.length,
      recentCount: result.recentScores.length,
      summary: reply.slice(0, 300),
      fullText: reply,
      baseline: {
        topCount: topSnapshot.count,
        topAverageStars: topSnapshot.averageStars,
        topAverageAcc: topSnapshot.averageAcc,
        capturedAt: nowIso(),
      },
      recentSnapshot: {
        count: recentSnapshot.count,
        averageStars: recentSnapshot.averageStars,
        averageAcc: recentSnapshot.averageAcc,
      },
      ppBars: result.pplusBars ? {
        jump: result.pplusBars.jump, flow: result.pplusBars.flow,
        speed: result.pplusBars.speed, stamina: result.pplusBars.stamina,
        precision: result.pplusBars.precision, accuracy: result.pplusBars.accuracy,
        ppTotal: result.pplusBars.ppTotal,
      } : null,
      errors: result.errors
    });
    const associatedQq = resolveSkillQq({
      bindings: draft.osuBindings || {},
      requesterQq: event.userId,
      mentionedQqs: event.atTargets || [],
      osuUserId: result.user.id,
      osuUsername: result.user.username,
    });
    upsertSkillRecordInDb(draft, extractSkillRecord({
      userId: associatedQq,
      osuUsername: result.user.username,
      osuUserId: result.user.id,
      mode,
      pp: Number(result.user.statistics.pp || 0),
      rank: Number(result.user.statistics.global_rank || 0),
      countryRank: Number(result.user.statistics.country_rank || 0),
      accuracy: Number(result.user.statistics.hit_accuracy || 0),
      playCount: Number(result.user.statistics.play_count || 0),
      playTimeSeconds: Number(result.user.statistics.play_time || 0),
      level: Number(result.user.statistics.level?.current || 0),
      levelProgress: Number(result.user.statistics.level?.progress || 0),
      ppPlus: ppPlusRecord(result.pplusBars),
      modComposition,
      topMods,
      gradeCounts: result.user.grade_counts || result.user.statistics.grade_counts || {},
      summary: conclusionSummary,
    }));
  });

  return reply;
}

async function runAnalysis(
  event: any, sendMessage: any,
  target: string | number, mode: OsuMode,
): Promise<string> {
  void sendMessage;
  const db = readDb();
  const result = await (async () => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await collectPlayerOneLineData(target, mode);
      } catch (error) {
        lastError = error;
        if (attempt >= 3) break;
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
    throw lastError;
  })();

  const topSnapshot = buildScoreSnapshot(result.bestScores);
  const recentSnapshot = buildScoreSnapshot(result.recentScores);
  const facts = buildOneLineReviewFacts({
    user: result.user,
    bestScores: result.bestScores,
    recentScores: result.recentScores,
    mode,
  });
  const styleQuery = buildOneLineReviewStyleQuery(facts);
  const knowledge = retrieveKnowledgeForPrompt({
    scene: 'casual',
    text: styleQuery,
    groupId: String(event.groupId || ''),
    messageType: event.type === 'private' ? 'private' : 'group',
    settings: db.settings?.kb,
    permissions: { isOwner: false, isAdmin: false },
  });
  const styleExcerpts = knowledge.blocks
    .filter((block) => block.collection === 'community_style')
    .map((block) => block.text)
    .filter(Boolean)
    .slice(0, 5);
  const prompt = buildOneLineReviewPrompt(facts, styleExcerpts);

  let reply = '';
  let conclusionSource: 'llm' | 'fallback' = 'fallback';
  let validationReasons: string[] = [];
  let rejectedDraft = '';
  let actualModel = OSU_ANALYSIS_MODEL;
  try {
    const completion = await completeChat(db, {
      model: OSU_ANALYSIS_MODEL,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      maxTokens: 180,
      temperature: 0.78,
      timeoutMs: 45_000,
      requestMaxRetries: 0,
      retryOnEmpty: false,
      label: 'osu 一句话锐评',
      tracePurpose: 'osu_one_line_roast',
    });
    actualModel = String(completion.model || OSU_ANALYSIS_MODEL);
    const candidate = normalizeOneLineReview(completion.text);
    validationReasons = validateOneLineReview(candidate, facts);
    const copiedFragment = findCopiedStyleFragment(candidate, styleExcerpts);
    if (copiedFragment) validationReasons.push(`style_copy:${copiedFragment}`);
    if (validationReasons.length === 0) {
      reply = candidate;
      conclusionSource = 'llm';
    } else {
      rejectedDraft = candidate.slice(0, 500);
      console.error('[osu analyze] 一句话锐评未通过校验：', validationReasons);
    }
  } catch (error) {
    validationReasons = [`llm_error:${String(error?.message || error).slice(0, 180)}`];
    console.error('[osu analyze] 一句话锐评生成失败，使用确定性锐评：', error?.message || error);
  }
  if (!reply) reply = fallbackOneLineReview(facts);

  const displayName = result.user?.username || String(target);
  const modComposition = buildModComposition(result.bestScores);
  const topMods = Object.entries(modComposition)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 4)
    .map(([label]) => label);

  if (result.errors.length > 0) {
    console.error(`[osu analyze] ${displayName} (${target}) 的非致命错误：`, result.errors);
  }

  updateDb((draft) => {
    const createdAt = nowIso();
    draft.osuAnalyses = draft.osuAnalyses || [];
    draft.osuAnalyses.push({
      target: String(target),
      displayName,
      mode,
      analysisType: 'one_line_roast',
      analysisModel: actualModel,
      conclusionSource,
      conclusionValidationReasons: validationReasons.slice(0, 8),
      conclusionRejectedDraft: rejectedDraft,
      sectionCommentsSource: 'none',
      sectionComments: null,
      reviewLog: [],
      generationTrace: {
        route: knowledge.route,
        styleDocumentCount: styleExcerpts.length,
        styleDocumentIds: knowledge.blocks
          .filter((block) => block.collection === 'community_style')
          .slice(0, 5)
          .map((block) => block.documentId),
        primarySignal: facts.primarySignal,
        primarySignalReason: facts.primarySignalReason,
      },
      conclusionText: reply,
      formatVersion: ANALYSIS_FORMAT_VERSION,
      osuUserId: result.user.id,
      userId: String(event.userId),
      groupId: String(event.groupId || ''),
      createdAt,
      pp: result.user.statistics.pp,
      rank: result.user.statistics.global_rank,
      acc: result.user.statistics.hit_accuracy,
      bestCount: result.bestScores.length,
      recentCount: result.recentScores.length,
      summary: reply,
      fullText: reply,
      baseline: {
        topCount: topSnapshot.count,
        topAverageStars: topSnapshot.averageStars,
        topAverageAcc: topSnapshot.averageAcc,
        capturedAt: createdAt,
      },
      recentSnapshot: {
        count: recentSnapshot.count,
        averageStars: recentSnapshot.averageStars,
        averageAcc: recentSnapshot.averageAcc,
      },
      ppBars: null,
      errors: result.errors,
    });
    const associatedQq = resolveSkillQq({
      bindings: draft.osuBindings || {},
      requesterQq: event.userId,
      mentionedQqs: event.atTargets || [],
      osuUserId: result.user.id,
      osuUsername: result.user.username,
    });
    upsertSkillRecordInDb(draft, extractSkillRecord({
      userId: associatedQq,
      osuUsername: result.user.username,
      osuUserId: result.user.id,
      mode,
      pp: Number(result.user.statistics.pp || 0),
      rank: Number(result.user.statistics.global_rank || 0),
      countryRank: Number(result.user.statistics.country_rank || 0),
      accuracy: Number(result.user.statistics.hit_accuracy || 0),
      playCount: Number(result.user.statistics.play_count || 0),
      playTimeSeconds: Number(result.user.statistics.play_time || 0),
      level: Number(result.user.statistics.level?.current || 0),
      levelProgress: Number(result.user.statistics.level?.progress || 0),
      modComposition,
      topMods,
      gradeCounts: result.user.grade_counts || result.user.statistics.grade_counts || {},
      summary: compactConclusion(reply),
    }));
  });

  return reply;
}

async function drainQueue() {
  while (queue.length > 0) {
    currentEntry = queue.shift()!;
    running = true;
    const entry = currentEntry;
    try {
      const text = await runAnalysis(entry.event, entry.sendMessage, entry.target, entry.mode);
      await sendAsReply(entry.event, entry.sendMessage, text);
      entry.resolve({ replied: true, reason: 'osu analyze 完成', text });
    } catch (error) {
      const msg = `分析失败：${String(error?.message || error).slice(0, 300)}`;
      if (entry.sendMessage) {
        try {
          await sendAsReply(entry.event, entry.sendMessage, msg);
        } catch (sendError) {
          console.error('[osu analyze] 失败通知也未能发送：', sendError?.message || sendError);
        }
      }
      entry.resolve({ replied: true, reason: msg, error: String(error?.message || error) });
    } finally {
      running = false;
      currentEntry = null;
    }
  }
}

interface OsuCommandContext {
  event: any;
  sendMessage: any;
  permissions: any;
  subCommand: string;
  args: string;
  subFree: string;
  options: { bypassCooldown?: boolean };
  db: any;
}

type OsuHandler = (ctx: OsuCommandContext) => Promise<{ replied?: boolean; reason?: string; text?: string; error?: string }>;

async function handleOsuBind(ctx: OsuCommandContext) {
  const { event, sendMessage, subFree } = ctx;
  const username = String(subFree || '').trim();
  if (!username) {
    if (sendMessage) await sendMessage(event, '用法：/w osu bind <osu用户名>');
    return { replied: true, reason: 'osu bind 缺用户名' };
  }
  let userId: number;
  try {
    const { getUser } = await import('./api.js');
    const user = await getUser(username);
    userId = user.id;
  } catch (error) {
    const msg = `osu! 用户 "${username}" 查不到。`;
    if (sendMessage) await sendMessage(event, msg);
    return { replied: true, reason: msg };
  }
  updateDb((draft) => {
    draft.osuBindings = draft.osuBindings || {};
    draft.osuBindings[String(event.userId)] = { id: userId, username };
  });
  // Unified binding: mirror into LazyBot's token table so /ppp & friends
  // work without a separate /link. Non-fatal when the sync is unavailable.
  const syncResult = await syncLazybotBinding(event.userId, { id: userId, username });
  if (!syncResult.ok && !syncResult.skipped) {
    console.error(`[bind] LazyBot 绑定同步失败: ${syncResult.error || '未知错误'}`);
  }
  const msg = `已将 QQ 绑定到 osu! ${username}（ID: ${userId}）。`;
  if (sendMessage) await sendMessage(event, msg);
  return { replied: true, reason: msg };
}

async function handleOsuAnalyze(ctx: OsuCommandContext) {
  const { event, sendMessage, subFree, options, db } = ctx;
  if (!ENABLE_OSU_ANALYZE) {
    const message = '/w osu analyze 已停用；后续由玩家 Skill 画像替代。谱面分析仍可使用 /w skill。';
    if (sendMessage) await sendAsReply(event, sendMessage, message);
    return { replied: true, reason: 'osu analyze 已停用', text: message };
  }
  const { target, mode } = parseTargetAndMode(db, event, subFree);
  if (!target) {
    if (sendMessage) await sendMessage(event, '请先绑定 osu! 账号（/w osu bind <用户名>）或指定要分析的用户名。');
    return { replied: true, reason: 'osu analyze 无用户' };
  }

  // Check 4-hour cooldown — admin console calls bypass it.
  if (!options.bypassCooldown) {
    const cached = lookupCachedAnalysis(db, String(event.userId), target, mode);
    if (cached) {
      if (sendMessage) await sendAsReply(event, sendMessage, `（4 小时内已分析过 ${mode} 模式，显示上次结果）\n\n${cached}`);
      return { replied: true, reason: 'osu analyze 缓存命中', text: cached };
    }
  }

  // Prevent double-submit: same user can't have multiple pending analyses
  const isSameUser = (e: QueueEntry) => String(e.userId) === String(event.userId);
  if (currentEntry && isSameUser(currentEntry)) {
    if (sendMessage) await sendAsReply(event, sendMessage, '这份 BP 正在锐评，别重复催。');
    return { replied: true, reason: 'osu analyze 重复提交（正在运行）' };
  }
  if (queue.some(isSameUser)) {
    if (sendMessage) await sendAsReply(event, sendMessage, '你已经在锐评队列里了。');
    return { replied: true, reason: 'osu analyze 重复提交（已在队列）' };
  }
  if (queue.length >= MAX_ANALYZE_QUEUE) {
    if (sendMessage) await sendAsReply(event, sendMessage, `锐评队列已满（正在运行 1 个，排队最多 ${MAX_ANALYZE_QUEUE} 个），请稍后再试。`);
    return { replied: true, reason: `osu analyze 队列已满（${queue.length}/${MAX_ANALYZE_QUEUE}）` };
  }

  // Enqueue
  const position = queue.length + (running ? 1 : 0);
  if (sendMessage) {
    const statusMsg = position > 0
      ? `已加入锐评队列（前面还有 ${position} 人），到你时我会 @ 你。`
      : 'pippi 正在翻这份 BP，马上锐评…';
    await sendAsReply(event, sendMessage, statusMsg);
  }

  return new Promise((resolve) => {
    queue.push({
      event, sendMessage,
      target, mode,
      userId: String(event.userId),
      groupId: String(event.groupId),
      resolve
    });
    if (!running) drainQueue();
  });
}

async function handleOsuRecent(ctx: OsuCommandContext) {
  const { event, sendMessage, subFree, db } = ctx;
  const { target, mode } = parseTargetAndMode(db, event, subFree);
  if (!target) {
    if (sendMessage) await sendMessage(event, '请先绑定 osu! 账号，或指定要查看的用户名。');
    return { replied: true, reason: 'osu recent 无用户' };
  }

  let result;
  try {
    result = await collectRecentPlayerData(target, mode);
  } catch (error) {
    const message = `近期记录获取失败：${String(error?.message || error).slice(0, 240)}`;
    if (sendMessage) await sendAsReply(event, sendMessage, message);
    return { replied: true, reason: message, error: String(error?.message || error) };
  }

  const freshDb = readDb();
  const baseline = findFullBaseline(freshDb, result.user, target, mode);
  if (!baseline) {
    const message = `${result.user.username} 没有旧版 BP 基线；由于 /w osu analyze 已停用，目前无法生成 Recent 对照。`;
    if (sendMessage) await sendAsReply(event, sendMessage, message);
    return { replied: true, reason: 'osu recent 缺少完整分析前置', text: message };
  }

  const cached = lookupCachedRecent(freshDb, result.user.id, mode);
  if (cached) {
    if (sendMessage) await sendAsReply(event, sendMessage, cached);
    return { replied: true, reason: 'osu recent 缓存命中', text: cached };
  }

  const text = buildRecentReport(result.user, result.recentScores, baseline);
  // Append PP+ data if available
  const pplusBlock = result.pplusBars
    ? (await import('./collector.js')).formatPPlusForPrompt(result.pplusBars, [])
    : '';
  const fullText = [text, pplusBlock].filter(Boolean).join('\n\n');
  const recentSummary = buildRecentSkillSummary(result.recentScores, baseline);
  updateDb((draft) => {
    const createdAt = nowIso();
    draft.osuRecentAnalyses = draft.osuRecentAnalyses || [];
    draft.osuRecentAnalyses.push({
      target: String(target),
      displayName: result.user.username,
      osuUserId: result.user.id,
      mode,
      formatVersion: RECENT_FORMAT_VERSION,
      userId: String(event.userId),
      groupId: String(event.groupId),
      fullAnalysisCreatedAt: baseline.createdAt,
      createdAt,
      fullText: fullText,
      recentCount: result.recentScores.length,
      errors: result.errors,
    });
    draft.osuRecentAnalyses = draft.osuRecentAnalyses.slice(-500);

    const associatedQq = resolveSkillQq({
      bindings: draft.osuBindings || {},
      requesterQq: event.userId,
      mentionedQqs: event.atTargets || [],
      osuUserId: result.user.id,
      osuUsername: result.user.username,
    });
    let skillRecord = updateRecentSkillRecordInDb(draft, {
      osuUserId: result.user.id,
      osuUsername: result.user.username,
      userId: associatedQq,
      mode,
    }, recentSummary);

    // Older full analyses predate skillStore. Backfill a conservative profile
    // from the current API profile and saved full-analysis conclusion, then
    // attach Recent without inventing unavailable BP Mod counts.
    if (!skillRecord) {
      upsertSkillRecordInDb(draft, extractSkillRecord({
        userId: associatedQq,
        osuUsername: result.user.username,
        osuUserId: result.user.id,
        mode,
        pp: Number(result.user.statistics.pp || 0),
        rank: Number(result.user.statistics.global_rank || 0),
        countryRank: Number(result.user.statistics.country_rank || 0),
        accuracy: Number(result.user.statistics.hit_accuracy || 0),
        playCount: Number(result.user.statistics.play_count || 0),
        playTimeSeconds: Number(result.user.statistics.play_time || 0),
        level: Number(result.user.statistics.level?.current || 0),
        levelProgress: Number(result.user.statistics.level?.progress || 0),
        ppPlus: ppPlusRecord(baseline.ppBars),
        gradeCounts: result.user.grade_counts || result.user.statistics.grade_counts || {},
        summary: conclusionFromSavedAnalysis(baseline),
      }));
      skillRecord = updateRecentSkillRecordInDb(draft, {
        osuUserId: result.user.id,
        osuUsername: result.user.username,
        userId: associatedQq,
        mode,
      }, recentSummary);
    }
  });
  if (sendMessage) await sendAsReply(event, sendMessage, fullText);
  return { replied: true, reason: 'osu recent 完成', text: fullText };
}

async function handleClearBind(ctx: OsuCommandContext) {
  const { event, sendMessage } = ctx;
  updateDb((draft) => {
    draft.osuBindings = draft.osuBindings || {};
    delete draft.osuBindings[String(event.userId)];
  });
  const syncResult = await removeLazybotBinding(event.userId);
  if (!syncResult.ok && !syncResult.skipped) {
    console.error(`[bind] LazyBot 解绑同步失败: ${syncResult.error || '未知错误'}`);
  }
  if (sendMessage) await sendMessage(event, '已删除你的 osu! 绑定。');
  return { replied: true, reason: 'osu clear bind' };
}

async function handleClearHistory(ctx: OsuCommandContext) {
  const { event, sendMessage } = ctx;
  updateDb((draft) => {
    draft.osuAnalyses = (draft.osuAnalyses || []).filter((a: any) => String(a.userId) !== String(event.userId));
  });
  if (sendMessage) await sendMessage(event, '已删除你的所有分析历史。');
  return { replied: true, reason: 'osu clear history' };
}

async function handleClearCooldown(ctx: OsuCommandContext) {
  const { event, sendMessage, permissions, subFree } = ctx;
  if (!permissions?.isOwner) {
    if (sendMessage) await sendMessage(event, '该操作仅限 owner。');
    return { replied: true, reason: 'osu clear cooldown 非 owner' };
  }
  const targetArg = String(subFree || '').replace(/^cooldown\s*/, '').trim();
  if (!targetArg) {
    if (sendMessage) await sendMessage(event, '用法：/w osu clear cooldown <osu用户名或ID>');
    return { replied: true, reason: 'osu clear cooldown 缺目标' };
  }
  const needleId = /^\d+$/.test(targetArg) ? Number(targetArg) : 0;
  const needleLower = targetArg.toLowerCase();
  let recommendOsuId = needleId;
  if (!recommendOsuId) {
    try {
      const { getUser } = await import('./api.js');
      recommendOsuId = (await getUser(targetArg)).id;
    } catch {
      // Name resolution failed; recommend cooldown stays untouched.
    }
  }
  let removedAnalyze = 0;
  let removedRecent = 0;
  let removedRecommend = 0;
  updateDb((draft) => {
    const matches = (entry: any) => {
      const idMatch = needleId > 0 && Number(entry?.osuUserId || 0) === needleId;
      const nameMatch = [entry?.target, entry?.displayName, entry?.osuUsername]
        .some((value) => String(value || '').toLowerCase() === needleLower);
      return idMatch || nameMatch;
    };
    const beforeAnalyze = (draft.osuAnalyses || []).length;
    draft.osuAnalyses = (draft.osuAnalyses || []).filter((entry: any) => !matches(entry));
    removedAnalyze = beforeAnalyze - draft.osuAnalyses.length;
    const beforeRecent = (draft.osuRecentAnalyses || []).length;
    draft.osuRecentAnalyses = (draft.osuRecentAnalyses || []).filter((entry: any) => !matches(entry));
    removedRecent = beforeRecent - draft.osuRecentAnalyses.length;
    if (recommendOsuId > 0 && draft.osuRecommendCooldowns?.[String(recommendOsuId)] !== undefined) {
      delete draft.osuRecommendCooldowns[String(recommendOsuId)];
      removedRecommend = 1;
    }
  });
  const reply = `已清除 ${targetArg} 的冷却（完整分析 ${removedAnalyze} 条、近期 ${removedRecent} 条、推图 ${removedRecommend} 条）。推图防重复历史保留。`;
  if (sendMessage) await sendMessage(event, reply);
  return { replied: true, reason: reply };
}

async function handleClearRecommend(ctx: OsuCommandContext) {
  const { event, sendMessage, permissions, subFree } = ctx;
  if (!permissions?.isOwner) {
    if (sendMessage) await sendMessage(event, '该操作仅限 owner。');
    return { replied: true, reason: 'osu clear recommend 非 owner' };
  }
  const targetArg = String(subFree || '').replace(/^recommend\s*/, '').trim();
  if (!targetArg) {
    if (sendMessage) await sendMessage(event, '用法：/w osu clear recommend <osu用户名或ID>');
    return { replied: true, reason: 'osu clear recommend 缺目标' };
  }
  let recommendOsuId = /^\d+$/.test(targetArg) ? Number(targetArg) : 0;
  if (!recommendOsuId) {
    try {
      const { getUser } = await import('./api.js');
      recommendOsuId = (await getUser(targetArg)).id;
    } catch {
      if (sendMessage) await sendMessage(event, `找不到 osu! 用户 "${targetArg}"，无法清除推图历史。`);
      return { replied: true, reason: 'osu clear recommend 找不到目标' };
    }
  }
  const { clearRecommendHistory } = await import('./recommender.js');
  const removed = clearRecommendHistory(recommendOsuId);
  const reply = `已清除 ${targetArg} 的推图历史（防重复记录 ${removed} 条，冷却已重置）。`;
  if (sendMessage) await sendMessage(event, reply);
  return { replied: true, reason: reply };
}

async function handleClearCache(ctx: OsuCommandContext) {
  const { event, sendMessage, permissions } = ctx;
  // Global cache wipe affects every user's analysis/recent/type caches: owner
  // only. Permission is checked before any mutation.
  if (!permissions?.isOwner) {
    if (sendMessage) await sendMessage(event, '该操作仅限 owner。');
    return { replied: true, reason: 'osu clear cache 非 owner' };
  }
  updateDb((draft) => {
    draft.osuAnalyses = [];
    draft.osuRecentAnalyses = [];
    draft.osuTypeAnalyses = [];
  });
  if (sendMessage) await sendMessage(event, '已清除所有分析缓存。');
  return { replied: true, reason: 'osu clear cache' };
}

const CLEAR_ACTIONS = {
  bind: handleClearBind,
  history: handleClearHistory,
  cooldown: handleClearCooldown,
  recommend: handleClearRecommend,
  cache: handleClearCache,
} satisfies Record<OsuClearActionId, OsuHandler>;

async function handleOsuClear(ctx: OsuCommandContext) {
  const { event, sendMessage, subFree } = ctx;
  const action = String(subFree || '').trim();
  // Strict parsing: no fuzzy correction. `clear caches` / `clear cache xxx`
  // and bare `clear` all land in the usage path without executing anything.
  const key: OsuClearActionId | null = action === 'bind' ? 'bind'
    : action === 'history' ? 'history'
    : action === 'cache' ? 'cache'
    : action === 'cooldown' || action.startsWith('cooldown ') ? 'cooldown'
    : action === 'recommend' || action.startsWith('recommend ') ? 'recommend'
    : null;
  if (!key) {
    if (sendMessage) await sendMessage(event, '用法：/w osu clear bind（删除绑定）/ /w osu clear history（删除分析历史）/ /w osu clear cooldown <玩家>（取消指定玩家冷却，仅 owner）/ /w osu clear recommend <玩家>（清除指定玩家推图历史，仅 owner）/ /w osu clear cache（清除全部缓存，仅 owner）');
    return { replied: true, reason: 'osu clear 缺参数' };
  }
  return CLEAR_ACTIONS[key](ctx);
}

function renderOsuHelp(permissions: any): string {
  const perms: CommandPermissions = {
    isOwner: Boolean(permissions?.isOwner),
    isAdmin: Boolean(permissions?.isAdmin),
  };
  const lines = ['osu! 命令：'];
  for (const sub of Object.values(OSU_SUBCOMMANDS)) {
    if (!canViewCommand(sub.visibility, perms)) continue;
    if (sub.id === 'clear') {
      for (const action of Object.values(OSU_CLEAR_ACTIONS_META)) {
        if (!canViewCommand(action.visibility, perms)) continue;
        if (!canListCommand(action.visibility, action.discoverability, action.permission, perms)) continue;
        lines.push(`${action.syntax} — ${action.description}`);
      }
      continue;
    }
    lines.push(`${sub.syntax} — ${sub.description}`);
  }
  const skill = OWNER_COMMANDS.find((entry) => entry.id === 'skill');
  const feedback = OWNER_COMMANDS.find((entry) => entry.id === 'skillFeedback');
  if (skill && canListCommand(skill.visibility, skill.discoverability, skill.permission, perms)) {
    lines.push('/w skill profile [玩家名] — 用成绩质量与名次衰减后的真实 BP50 生成玩家 Skill 雷达画像');
    lines.push('/w skill compare <玩家A> | <玩家B> — 生成两名玩家的 BP50 Skill 对比图');
    lines.push('/w skill <BP名次或BID> [+Mods] — 分析自己或指定玩家的单张 BP/BID');
  }
  if (feedback && canListCommand(feedback.visibility, feedback.discoverability, feedback.permission, perms)) {
    lines.push(`${feedback.syntax} — ${feedback.description}`);
  }
  return lines.join('\n');
}

async function handleOsuHelp(ctx: OsuCommandContext) {
  const { event, sendMessage, permissions } = ctx;
  if (sendMessage) await sendMessage(event, renderOsuHelp(permissions));
  return { replied: true, reason: 'osu help' };
}

const OSU_HANDLERS = {
  bind: handleOsuBind,
  analyze: handleOsuAnalyze,
  clear: handleOsuClear,
  help: handleOsuHelp,
} satisfies Record<OsuCommandId, OsuHandler>;

export async function handleOsuCommand(
  event: any,
  sendMessage: any,
  permissions: any,
  subCommand: string,
  args: string,
  options: { bypassCooldown?: boolean } = {},
) {
  const db = readDb();
  const sub = String(subCommand || 'help').toLowerCase();
  const subFree = String(args || '').startsWith(sub + ' ') ? String(args).slice(sub.length + 1)
    : String(args || '') === sub ? '' : String(args || '');
  const handler = OSU_HANDLERS[sub as OsuCommandId];
  if (!handler) {
    if (sendMessage) await sendMessage(event, `未知 osu 子命令：${subCommand}`);
    return { replied: true, reason: `未知 osu 子命令: ${subCommand}` };
  }
  return handler({ event, sendMessage, permissions, subCommand: sub, args, subFree, options, db });
}
