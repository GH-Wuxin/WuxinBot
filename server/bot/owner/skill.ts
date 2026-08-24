import crypto from 'node:crypto';
import { readDb, updateDb, nowIso } from '../../store.js';
import { getUser, getUserBestScores, getUserById } from '../../osu/api.js';
import { resolveOsuBindingValue } from '../../osu/commands.js';
import { normalizedScoreMods } from '../../osu/scoreMetrics.js';
import {
  formatSkillProfilerAnalysis,
  requestSkillProfilerAnalysisWithFetch,
} from '../../bots/skillProfiler.js';
import { renderSkillProfilerCard } from '../../bots/skillProfilerCard.js';
import {
  appendSkillProfilerFeedback,
  compactSkillProfilerSnapshot,
  MAX_SKILL_FEEDBACK_CHARS,
} from '../../bots/skillProfilerFeedback.js';
import type { OwnerHandlerContext, OwnerCommandResult } from './types.js';

const SUPPORTED_PROFILER_MODS = new Set(['NF', 'EZ', 'HD', 'HR', 'SD', 'HT', 'DT', 'PF']);
const DIRECT_PROFILER_MODS = new Set(['NM', 'NF', 'EZ', 'HD', 'HR', 'SD', 'DT', 'HT', 'NC', 'FL', 'PF', 'DC']);
const MOD_ORDER = ['NF', 'EZ', 'HD', 'HR', 'SD', 'DT', 'HT', 'NC', 'FL', 'PF', 'DC'];
const MAX_BP_RANK = 100;
const MAX_RECENT_RUNS = 500;

export type SkillCommandTarget =
  | { kind: 'bp'; rank: number }
  | { kind: 'bid'; beatmapId: number };

export type SkillCommandRequest =
  | { ok: true; target: SkillCommandTarget; mods: string[] }
  | { ok: false; message: string };

export function parseSkillCommandTarget(value: string): SkillCommandTarget | null {
  const raw = String(value || '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return number <= MAX_BP_RANK
    ? { kind: 'bp', rank: number }
    : { kind: 'bid', beatmapId: number };
}

function parseExplicitMods(value: string): string[] | null {
  const pieces = value.trim().toUpperCase().split(/[\s+,/|]+/).filter(Boolean);
  const mods: string[] = [];
  for (const piece of pieces) {
    if (!/^[A-Z]+$/.test(piece) || piece.length % 2 !== 0) return null;
    for (let index = 0; index < piece.length; index += 2) {
      const mod = piece.slice(index, index + 2);
      if (!DIRECT_PROFILER_MODS.has(mod)) return null;
      mods.push(mod);
    }
  }
  const unique = new Set(mods);
  // PF already contains SD; keeping both would be an invalid osu! mod state.
  if (unique.has('PF')) unique.delete('SD');
  return [...unique].sort((left, right) => MOD_ORDER.indexOf(left) - MOD_ORDER.indexOf(right));
}

export function parseSkillCommandRequest(value: string): SkillCommandRequest {
  const match = /^(\d+)(?:\s*\+\s*(.+))?$/.exec(String(value || '').trim());
  const target = parseSkillCommandTarget(match?.[1] || '');
  if (!target) {
    return { ok: false, message: '用法：/w skill <BP名次或BID> [+Mods]；例如 /w skill 4288226 +HDDT。' };
  }
  const mods = match?.[2] === undefined ? [] : parseExplicitMods(match[2]);
  if (!mods) {
    return { ok: false, message: '无法识别 Mod；示例：+HD、+HDDT、+HR、+PF。' };
  }
  if (mods.includes('FL')) {
    return { ok: false, message: 'Skill Profiler 暂不支持 FL：它需要单独的可见范围维度，不能伪装成 NM/HD 分析。' };
  }
  if (target.kind === 'bp' && mods.length) {
    return { ok: false, message: 'BP 名次会自动读取该成绩的 Mod；自选 Mod 请改用 BID，例如 /w skill 4288226 +HDDT。' };
  }
  return { ok: true, target, mods };
}

function profilerModsForScore(score: any): string[] {
  const scoreMods = normalizedScoreMods(score);
  if (scoreMods.includes('FL')) {
    throw new Error('该 BP 使用了 FL，而 Skill Profiler 暂不支持 FL，因此拒绝按非 FL 谱面误分析。');
  }
  const mods = scoreMods
    .map((mod) => mod === 'NC' ? 'DT' : mod)
    .filter((mod) => SUPPORTED_PROFILER_MODS.has(mod));
  return [...new Set(mods)];
}

async function resolveBoundBp(ctx: OwnerHandlerContext, rank: number): Promise<{
  beatmapId: number;
  mods: string[];
  sourceLabel: string;
}> {
  const binding = resolveOsuBindingValue(ctx.commandDb.osuBindings?.[String(ctx.event.userId)]);
  if (!binding) throw new Error('请先绑定 osu! 账号：/w osu bind <用户名>');
  const user = typeof binding === 'number'
    ? await getUserById(binding, 'osu')
    : await getUser(String(binding), 'osu');
  const scores = await getUserBestScores(user.id, 'osu', rank);
  const score = scores[rank - 1];
  const beatmapId = Number(score?.beatmap?.id || (score as any)?.beatmap_id || 0);
  if (!score || !Number.isSafeInteger(beatmapId) || beatmapId <= 0) {
    throw new Error(`${user.username} 没有可用的 BP#${rank}。`);
  }
  return {
    beatmapId,
    mods: profilerModsForScore(score),
    sourceLabel: `${user.username} 的 BP#${rank}`,
  };
}

function rememberProfilerRun(ctx: OwnerHandlerContext, analysis: any, sourceLabel: string): void {
  const snapshot = compactSkillProfilerSnapshot(analysis);
  updateDb((draft) => {
    draft.skillProfilerRuns ||= [];
    draft.skillProfilerRuns.push({
      id: crypto.randomUUID(),
      beatmapId: Number(analysis?.beatmap?.beatmap_id || 0),
      groupId: String(ctx.event.groupId || 'private'),
      userId: String(ctx.event.userId || ''),
      sourceMessageId: String(ctx.event.messageId || ''),
      sourceLabel,
      analysis: snapshot,
      createdAt: nowIso(),
    });
    if (draft.skillProfilerRuns.length > MAX_RECENT_RUNS) {
      draft.skillProfilerRuns = draft.skillProfilerRuns.slice(-MAX_RECENT_RUNS);
    }
  });
}

function feedbackGuidance(beatmapId: number): string {
  return [
    '',
    '对这份分析有异议或实战体感可以直接反馈：',
    `/w cd ${beatmapId} <你的反馈>`,
    `建议写清具体维度、你认为的难度和原因，例如：/w cd ${beatmapId} Reading 明显偏低，HD 低 AR 段至少应算 7★。`,
  ].join('\n');
}

export async function ownerSkillHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const request = parseSkillCommandRequest(ctx.commandArgs);
  if (request.ok === false) {
    const reason = request.message;
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reason);
    return { replied: Boolean(ctx.sendMessage), reason };
  }

  const { target } = request;

  const resolved = target.kind === 'bp'
    ? await resolveBoundBp(ctx, target.rank)
    : {
        beatmapId: target.beatmapId,
        mods: request.mods,
        sourceLabel: `BID ${target.beatmapId}${request.mods.length ? ` +${request.mods.join('')}` : ''}`,
      };
  const analysis = await requestSkillProfilerAnalysisWithFetch(resolved.beatmapId, resolved.mods);
  const fallbackText = [
    target.kind === 'bp' ? `分析来源：${resolved.sourceLabel}` : '',
    formatSkillProfilerAnalysis(analysis),
    feedbackGuidance(resolved.beatmapId),
  ].filter(Boolean).join('\n');
  rememberProfilerRun(ctx, analysis, resolved.sourceLabel);
  const rendered = await renderSkillProfilerCard(analysis);
  if (ctx.sendMessage) await ctx.sendMessage(ctx.event, rendered?.cqCode || fallbackText);
  return { replied: Boolean(ctx.sendMessage), reason: `Skill Profiler 已分析 BID ${resolved.beatmapId}` };
}

export async function ownerSkillFeedbackHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const match = /^(\d+)\s+([\s\S]+)$/.exec(String(ctx.commandArgs || '').trim());
  const beatmapId = Number(match?.[1] || 0);
  const message = String(match?.[2] || '').trim();
  if (!Number.isSafeInteger(beatmapId) || beatmapId <= MAX_BP_RANK || !message) {
    const reason = '用法：/w cd <BID> <反馈内容>；例如 /w cd 4288226 Reading 明显偏低。';
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reason);
    return { replied: Boolean(ctx.sendMessage), reason };
  }
  if (message.length > MAX_SKILL_FEEDBACK_CHARS) {
    const reason = `反馈内容最多 ${MAX_SKILL_FEEDBACK_CHARS} 个字符。`;
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reason);
    return { replied: Boolean(ctx.sendMessage), reason };
  }

  const db = readDb();
  const recent = [...(db.skillProfilerRuns || [])].reverse().find((run) =>
    Number(run?.beatmapId) === beatmapId
    && String(run?.groupId || '') === String(ctx.event.groupId || 'private'),
  );
  await appendSkillProfilerFeedback({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    beatmapId,
    message,
    groupId: String(ctx.event.groupId || 'private'),
    userId: String(ctx.event.userId || ''),
    nickname: String(ctx.event.nickname || ctx.event.userId || ''),
    sourceMessageId: String(ctx.event.messageId || ''),
    createdAt: nowIso(),
    analysis: recent?.analysis || null,
  });
  const snapshotNote = recent?.analysis
    ? '已同时关联本群最近一次该 BID 的分析版本。'
    : '本群暂未找到该 BID 的最近分析，反馈仍已保存；建议先运行一次 /w skill。';
  const reply = `已记录对 BID ${beatmapId} 的反馈。${snapshotNote}`;
  if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
  return { replied: Boolean(ctx.sendMessage), reason: `已记录 Skill Profiler 反馈 BID ${beatmapId}` };
}
