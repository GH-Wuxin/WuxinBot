// /w osu commands — bind and analyze with cooldown, queue, and @mention.

import { readDb, updateDb, nowIso } from '../store.js';
import { completeChat } from '../bot/llm.js';
import { collectPlayerData, collectRecentPlayerData } from './collector.js';
import {
  analyzeData,
  buildAnalysisEditorPrompt,
  buildAnalysisReviewPrompt,
  buildAnalysisSectionCommentsPrompt,
  condensePippiComment,
  formatPippiComment,
  injectAnalysisSectionComments,
  parseAnalysisSectionComments,
  pruneInvalidPippiSentences,
  sanitizeAnalysisSectionComments,
  validateAnalysisReport,
  validatePippiComment,
  validateAnalysisSectionComments,
} from './analyzer.js';
import type { AnalysisNarrativeContext, AnalysisSectionComments } from './analyzer.js';
import type { OsuMode, OsuScore, OsuUser } from './types.js';
import { normalizedScoreMods, scoreStarRating } from './scoreMetrics.js';
import {
  extractSkillRecord,
  resolveSkillQq,
  updateRecentSkillRecordInDb,
  upsertSkillRecordInDb,
} from '../bots/skills.js';

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

const ANALYSIS_COOLDOWN_MS = 4 * 3600 * 1000;
const RECENT_COOLDOWN_MS = 10 * 60 * 1000;
const ANALYSIS_FORMAT_VERSION = 64;
const RECENT_FORMAT_VERSION = 4;
export const OSU_ANALYSIS_MODEL = 'deepseek-v4-pro';
let queue: QueueEntry[] = [];
let running = false;
let currentEntry: QueueEntry | null = null;
const MAX_ANALYZE_QUEUE = 8;

function resolveUsername(db: any, event: any, args?: string): string | number | null {
  const provided = String(args || '').trim();
  if (provided && !provided.startsWith('--')) return provided;
  if (event.atTargets?.[0]) {
    const bindings = db.osuBindings || {};
    return bindings[String(event.atTargets[0])] || null;
  }
  const bindings = db.osuBindings || {};
  return bindings[String(event.userId)] || null;
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
  if (atQq) target = db.osuBindings?.[String(atQq)] || null;
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

function compactConclusion(value: unknown, maxLength = 220): string {
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
    `完整档案 BP 对照：平均 ${bpStars}、Acc ${(Number(bp.topAverageAcc || 0) * 100).toFixed(2)}%。`,
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
    '【完整档案对照】',
    `BP100 平均 ${Number(top.topAverageStars || 0).toFixed(2)}★｜Acc ${(Number(top.topAverageAcc || 0) * 100).toFixed(2)}%`,
    'Recent 收录近期提交，BP 收录 Best Performance 成绩。这里只并排展示数值；变化原因仍然未知。',
    '',
    '【结论】',
    `${user.username} 的近期样本与完整档案已经完成对照。`,
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

async function generateAnalysisSectionComments(
  db: any,
  analysis: ReturnType<typeof analyzeData>,
  narrative: AnalysisNarrativeContext,
  personalityPrompt: string
): Promise<{
  comments: AnalysisSectionComments | null;
  source: 'llm' | 'mixed' | 'none';
  reasons: string[];
  rejected: string;
}> {
  const prompt = buildAnalysisSectionCommentsPrompt(
    analysis,
    narrative,
    personalityPrompt
  );
  let candidate = '';
  let lastParsed: AnalysisSectionComments | null = null;
  let lastReasons: string[] = [];

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const userContent = attempt === 1
        ? prompt.user
        : [
            prompt.user,
            '',
            '<rejected_json>',
            candidate,
            '</rejected_json>',
            '',
            `<problems>${lastReasons.join('；')}</problems>`,
            '修正这些问题，保留已经自然的互动和玩笑。重新输出完整合法 JSON，不要解释。',
          ].join('\n');
      const result = await completeChat(db, {
        model: OSU_ANALYSIS_MODEL,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: userContent },
        ],
        maxTokens: 4096,
        temperature: attempt === 1 ? 0.72 : (attempt === 2 ? 0.38 : 0.18),
        timeoutMs: 90000,
        label: attempt === 1 ? 'osu区块短评' : `osu区块短评重试${attempt - 1}`,
      });
      candidate = String(result.text || '').trim();
      const parsedRaw = parseAnalysisSectionComments(candidate);
      if (!parsedRaw) {
        lastReasons = ['没有输出可解析的六区块 JSON'];
        continue;
      }
      const parsed = sanitizeAnalysisSectionComments(parsedRaw, narrative);
      lastParsed = parsed;
      const validation = validateAnalysisSectionComments(analysis, parsed, narrative);
      if (validation.ok) {
        if (attempt === 1) {
          candidate = JSON.stringify(parsed);
          lastReasons = ['创意稿机械校验通过；仍需逐句完成一次独立事实与术语终审'];
          continue;
        }
        return {
          comments: parsed,
          source: 'llm',
          reasons: [],
          rejected: '',
        };
      }
      lastReasons = validation.reasons;
      console.error(`[osu analyze] 区块短评第 ${attempt} 次未通过：`, validation.reasons);
    } catch (error) {
      lastReasons = [String(error?.message || error)];
      console.error(`[osu analyze] 区块短评第 ${attempt} 次失败：`, error?.message || error);
    }
  }

  if (lastParsed) {
    const mixedFallbacks: AnalysisSectionComments = {
      profile: '档案里的排名和评级已经够有分量了。好，这个名字我可记住了！',
      top: '星数与准确率的整体结构摆得很清楚。嗯，这一页确实值得我多看两眼。',
      top5: '五张高位成绩排得很整齐。行，这一页的共同风格已经藏不住了。',
      mods: 'Mod 构成把高位成绩的重心写在明面上了。偏得这么理直气壮，我当然会注意到。',
      pplus: '六维的高低差把当前成绩侧重点摆得很直白。好啦，这个形状我记住了！',
      recent: '近期样本与 BP 对照留下了变化。这一点我先记下，下次再看看它往哪边走。',
    };
    const patched = { ...lastParsed };
    const sectionKeys = ['profile', 'top', 'top5', 'mods', 'pplus', 'recent'] as const;
    const badKeys = new Set(
      sectionKeys.filter(key => lastReasons.some(
        reason => reason.startsWith(`${key} `) || reason.includes(`${key} 短评`)
      ))
    );
    if (lastReasons.some(reason => reason.includes('问句过多'))) {
      let remainingQuestions = 2;
      for (const key of sectionKeys) {
        const count = (patched[key].match(/[？?]/g) || []).length;
        if (count > remainingQuestions) {
          badKeys.add(key);
        } else {
          remainingQuestions -= count;
        }
      }
    }
    for (const key of badKeys) patched[key] = mixedFallbacks[key];
    if (badKeys.size > 0 && validateAnalysisSectionComments(analysis, patched, narrative).ok) {
      return {
        comments: patched,
        source: 'mixed',
        reasons: lastReasons.slice(0, 8),
        rejected: candidate.slice(0, 1800),
      };
    }
  }

  return {
    comments: null,
    source: 'none',
    reasons: lastReasons.slice(0, 8),
    rejected: candidate.slice(0, 1800),
  };
}

async function runAnalysis(
  event: any, sendMessage: any,
  target: string | number, mode: OsuMode
): Promise<string> {
  const db = readDb();
  const result = await (async () => {
    try {
      return await collectPlayerData(target, mode);
    } catch (error) {
      // Transient network/API failures are common under load; retry once
      // before declaring the whole analysis dead.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return collectPlayerData(target, mode);
    }
  })();
  const topSnapshot = buildScoreSnapshot(result.bestScores);
  const recentSnapshot = buildScoreSnapshot(result.recentScores);
  const analysis = analyzeData({
    user: result.user, bestScores: result.bestScores, recentScores: result.recentScores, mode,
    pplusBars: result.pplusBars, refBars: result.refBars
  });
  // Inject beatmap classification as a standalone section after BP100
  let classificationBlock = '';
  const topChinese: Record<string, string> = { aim: '跳图', stream: '串图', tech: '技术', alt: '切换' };
  if (result.classification?.distribution && Object.keys(result.classification.distribution).length > 0) {
    const dist = result.classification.distribution;
    const total = Object.values(dist).reduce((a, b) => a + b, 0);
    const entries = Object.entries(dist).sort((a, b) => b[1] - a[1]);
    const clsLines = entries.map(([cls, count]) =>
      `  ${cls.padEnd(8)} ${Math.round(count / total * 100)}%（${count} 张）`);
    classificationBlock = [
      '【谱面类型分布】',
      `BP${total} 分类统计（osu!oracle）：`,
      ...clsLines,
      '',
      `整体来看是一个${topChinese[entries[0]?.[0]] || '未知'}倾向明显的号。`,
    ].join('\n');
  }
  if (classificationBlock) {
    analysis.safeFacts += '\n\n' + classificationBlock;
    analysis.safeBody += '\n\n' + classificationBlock;
    analysis.safeFallback += '\n\n' + classificationBlock;
  }
  const callerBinding = db.osuBindings?.[String(event.userId)];
  const callerBindingText = String(callerBinding || '').trim().toLocaleLowerCase();
  const resolvedUserId = String(result.user?.id || '').trim().toLocaleLowerCase();
  const resolvedUsername = String(result.user?.username || '').trim().toLocaleLowerCase();
  const isSelf = Boolean(
    callerBindingText &&
    (callerBindingText === resolvedUserId || callerBindingText === resolvedUsername)
  );
  const narrative = {
    playerName: result.user?.username || String(target),
    perspective: isSelf ? 'self' as const : 'unknown' as const,
  };
  const personalityPrompt = String(db.settings.personalityPrompt || '');
  const sectionCommentsPromise = generateAnalysisSectionComments(
    db,
    analysis,
    narrative,
    personalityPrompt
  );
  let pippiComment = analysis.safePippiFallback;
  const editorPrompt = buildAnalysisEditorPrompt(
    analysis,
    narrative,
    personalityPrompt
  );
  let lastReasons: string[] = [];
  let lastRejectedConclusion = '';
  let creativeCandidate = '';
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const isCreativePass = !creativeCandidate;
      const reviewPrompt = isCreativePass
        ? null
        : buildAnalysisReviewPrompt(analysis, creativeCandidate, lastReasons, narrative);
      const edited = await completeChat(db, {
        model: OSU_ANALYSIS_MODEL,
        messages: isCreativePass
          ? [
              { role: 'system', content: editorPrompt.system },
              { role: 'user', content: editorPrompt.user },
            ]
          : [
              { role: 'system', content: reviewPrompt!.system },
              { role: 'user', content: reviewPrompt!.user },
            ],
        maxTokens: 4096,
        temperature: isCreativePass ? 0.58 : (attempt === 2 ? 0.08 : (attempt === 3 ? 0.04 : 0.02)),
        timeoutMs: 90000,
        label: isCreativePass ? 'osu分析创意稿' : `osu分析事实终审${attempt - 1}`
      });
      const editedText = condensePippiComment(formatPippiComment(edited.text), 115);
      const validation = validatePippiComment(analysis, editedText, narrative);
      if (isCreativePass) {
        creativeCandidate = editedText;
        lastRejectedConclusion = editedText;
        lastReasons = validation.ok
          ? ['创意稿需要独立完成一次语义事实终审']
          : validation.reasons;
        continue;
      }
      if (validation.ok) {
        pippiComment = editedText;
        break;
      }
      const prunedText = pruneInvalidPippiSentences(analysis, editedText, narrative);
      if (validatePippiComment(analysis, prunedText, narrative).ok) {
        pippiComment = prunedText;
        break;
      }
      creativeCandidate = editedText;
      lastRejectedConclusion = editedText;
      lastReasons = validation.reasons;
      console.error(`[osu analyze] pippi 终稿第 ${attempt} 次未通过：`, validation.reasons);
    } catch (error) {
      lastReasons = [String(error?.message || error)];
      console.error(`[osu analyze] pippi 终稿第 ${attempt} 次失败：`, error?.message || error);
    }
  }
  if (pippiComment === analysis.safePippiFallback) {
    console.error('[osu analyze] 综合结论使用确定性安全版本。');
  }
  const conclusionSource = pippiComment === analysis.safePippiFallback ? 'fallback' : 'llm';
  let reply = `${analysis.safeBody}\n\n${pippiComment}`;
  const finalValidation = validateAnalysisReport(analysis, reply, narrative);
  let finalReportFallback = false;
  if (!finalValidation.ok) {
    console.error('[osu analyze] 完整报告组装校验失败，使用确定性安全报告：', finalValidation.reasons);
    reply = analysis.safeFallback;
    finalReportFallback = true;
  }
  if (!reply) throw new Error('无法生成安全的分析报告');

  const sectionCommentsResult = await sectionCommentsPromise;
  const visibleConclusion = finalReportFallback ? analysis.safePippiFallback : pippiComment;
  let sectionCommentsSource = sectionCommentsResult.source;
  let sectionCommentsValidationReasons = [...sectionCommentsResult.reasons];
  let sectionCommentsRejectedDraft = sectionCommentsResult.rejected;
  if (sectionCommentsResult.comments) {
    const reportWithComments = `${injectAnalysisSectionComments(analysis.safeBody, sectionCommentsResult.comments)}\n\n${visibleConclusion}`;
    const commentsFinalValidation = validateAnalysisReport(analysis, reportWithComments, narrative);
    if (commentsFinalValidation.ok) {
      reply = reportWithComments;
    } else {
      sectionCommentsSource = 'none';
      sectionCommentsValidationReasons = commentsFinalValidation.reasons.slice(0, 8);
      sectionCommentsRejectedDraft = JSON.stringify(sectionCommentsResult.comments).slice(0, 1800);
      console.error('[osu analyze] 区块短评组装终审失败，已保留安全正文：', commentsFinalValidation.reasons);
    }
  }

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
      sectionCommentsSource,
      sectionCommentsValidationReasons,
      sectionCommentsRejectedDraft,
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

async function drainQueue() {
  while (queue.length > 0) {
    currentEntry = queue.shift()!;
    running = true;
    try {
      const text = await runAnalysis(currentEntry.event, currentEntry.sendMessage, currentEntry.target, currentEntry.mode);
      await sendAsReply(currentEntry.event, currentEntry.sendMessage, text);
      currentEntry.resolve({ replied: true, reason: 'osu analyze 完成', text });
    } catch (error) {
      const msg = `分析失败：${String(error?.message || error).slice(0, 300)}`;
      if (currentEntry.sendMessage) await sendAsReply(currentEntry.event, currentEntry.sendMessage, msg);
      currentEntry.resolve({ replied: true, reason: msg, error: String(error?.message || error) });
    }
    running = false;
    currentEntry = null;
  }
}

export async function handleOsuCommand(
  event: any,
  sendMessage: any,
  _permissions: any,
  subCommand: string,
  args: string,
  options: { bypassCooldown?: boolean } = {},
) {
  const db = readDb();

  const subFree = String(args || '').startsWith(subCommand + ' ') ? String(args).slice(subCommand.length + 1)
    : String(args || '') === subCommand ? '' : String(args || '');

  // /w osu bind <username>
  if (subCommand === 'bind') {
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
    const msg = `已将 QQ 绑定到 osu! ${username}（ID: ${userId}）。`;
    if (sendMessage) await sendMessage(event, msg);
    return { replied: true, reason: msg };
  }

  // /w osu analyze [@某人|用户名] [--mode=...]
  if (subCommand === 'analyze') {
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
      if (sendMessage) await sendAsReply(event, sendMessage, '你的分析正在生成中，请等待完成。');
      return { replied: true, reason: 'osu analyze 重复提交（正在运行）' };
    }
    if (queue.some(isSameUser)) {
      if (sendMessage) await sendAsReply(event, sendMessage, '你已在分析队列中，请等待。');
      return { replied: true, reason: 'osu analyze 重复提交（已在队列）' };
    }
    if (queue.length >= MAX_ANALYZE_QUEUE) {
      if (sendMessage) await sendAsReply(event, sendMessage, `分析队列已满（正在运行 1 个，排队最多 ${MAX_ANALYZE_QUEUE} 个），请稍后再试。`);
      return { replied: true, reason: `osu analyze 队列已满（${queue.length}/${MAX_ANALYZE_QUEUE}）` };
    }

    // Enqueue
    const position = queue.length + (running ? 1 : 0);
    if (sendMessage) {
      const statusMsg = position > 0
        ? `已加入分析队列（前面还有 ${position} 人），到你时我会 @ 你。`
        : `pippi 正在检查这份成绩，完成后 @ 你（约 3-4 分钟）…`;
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

  // /w osu recent [@某人|用户名] [--mode=...]
  if (subCommand === 'recent') {
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
      const message = `先用 /w osu analyze ${result.user.username} 建立完整档案吧。pippi 得先知道该拿近期记录和什么对照。`;
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

  // /w osu clear [bind|history]
  if (subCommand === 'clear') {
    const action = String(subFree || '').trim();
    if (action === 'bind') {
      updateDb((draft) => {
        draft.osuBindings = draft.osuBindings || {};
        delete draft.osuBindings[String(event.userId)];
      });
      if (sendMessage) await sendMessage(event, '已删除你的 osu! 绑定。');
      return { replied: true, reason: 'osu clear bind' };
    }
    if (action === 'history') {
      updateDb((draft) => {
        draft.osuAnalyses = (draft.osuAnalyses || []).filter((a: any) => String(a.userId) !== String(event.userId));
      });
      if (sendMessage) await sendMessage(event, '已删除你的所有分析历史。');
      return { replied: true, reason: 'osu clear history' };
    }
    if (action === 'cache') {
      updateDb((draft) => {
        draft.osuAnalyses = [];
        draft.osuRecentAnalyses = [];
        draft.osuTypeAnalyses = [];
      });
      if (sendMessage) await sendMessage(event, '已清除所有分析缓存。');
      return { replied: true, reason: 'osu clear cache' };
    }
    if (sendMessage) await sendMessage(event, '用法：/w osu clear bind（删除绑定）/ /w osu clear history（删除分析历史）/ /w osu clear cache（清除全部缓存，仅管理员）');
    return { replied: true, reason: 'osu clear 缺参数' };
  }

  // /w osu help
  if (subCommand === 'help' || subCommand === '' || !subCommand) {
    const help = [
      'osu! 命令：',
      '/w osu bind <用户名> — 绑定 QQ 到 osu! 账号',
      '/w osu analyze [用户名] [--mode=std/taiko/catch/mania] — 完整分析（4h 冷却）',
      '/w osu recent [用户名] [--mode=std/taiko/catch/mania] — 近期短评（需先完整分析）',
      '/w osu clear bind — 删除绑定',
      '/w osu clear history — 删除分析历史',
    ].join('\n');
    if (sendMessage) await sendMessage(event, help);
    return { replied: true, reason: 'osu help' };
  }

  if (sendMessage) await sendMessage(event, `未知 osu 子命令：${subCommand}`);
  return { replied: true, reason: `未知 osu 子命令: ${subCommand}` };
}
