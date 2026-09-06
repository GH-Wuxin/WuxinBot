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
import { renderPlayerSkillComparison, renderPlayerSkillProfile } from '../../bots/playerSkillProfile.js';
import { renderPlayerRecentSkillProfile } from '../../bots/playerRecentSkillProfile.js';
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
  | { kind: 'named_bp'; username: string; rank: number }
  | { kind: 'bid'; beatmapId: number };

export type SkillCommandRequest =
  | { ok: true; target: SkillCommandTarget; mods: string[] }
  | { ok: false; message: string };

export type PlayerSkillProfileRequest = { matched: true; player: string } | { matched: false };
export type PlayerRecentSkillRequest = { matched: true; player: string } | { matched: false };
export type PlayerSkillComparisonRequest =
  | { matched: true; left: string; right: string; error?: undefined }
  | { matched: true; left: ''; right: ''; error: string }
  | { matched: false };

function unwrapExplicitPlayer(value: string): string {
  const raw = String(value || '').trim();
  return String(/^p:\[(\d+)\]$/i.exec(raw)?.[1] || raw).trim();
}

export function parsePlayerSkillProfileRequest(value: string): PlayerSkillProfileRequest {
  const match = /^profile(?:\s+([\s\S]+))?$/i.exec(String(value || '').trim());
  if (!match) return { matched: false };
  const raw = String(match[1] || '').trim();
  const explicit = /^p:\[(\d+)\]$/i.exec(raw);
  return { matched: true, player: String(explicit?.[1] || raw).trim() };
}

export function parsePlayerRecentSkillRequest(value: string): PlayerRecentSkillRequest {
  const match = /^recent(?:\s+([\s\S]+))?$/i.exec(String(value || '').trim());
  if (!match) return { matched: false };
  const raw = String(match[1] || '').trim();
  const explicit = /^p:\[(\d+)\]$/i.exec(raw);
  return { matched: true, player: String(explicit?.[1] || raw).trim() };
}

export function parsePlayerSkillComparisonRequest(value: string): PlayerSkillComparisonRequest {
  const raw = String(value || '').trim();
  if (!/^compare(?:\s|$)/i.test(raw)) return { matched: false };
  const body = raw.replace(/^compare\s*/i, '');
  const players = /^((?:p:\[\d+\])|(?:\S+))\s+((?:p:\[\d+\])|(?:\S+))$/i.exec(body);
  const left = unwrapExplicitPlayer(String(players?.[1] || ''));
  const right = unwrapExplicitPlayer(String(players?.[2] || ''));
  if (!left || !right) {
    return { matched: true, left: '', right: '', error: '用法：/w skill compare <玩家A> <玩家B>；玩家名含空格时请改用 p:[玩家ID]，例如 /w skill compare mrekk p:[970]。' };
  }
  return { matched: true, left, right };
}

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
  const raw = String(value || '').trim();
  const numericMatch = /^(\d+)(?:\s*\+\s*(.+))?$/.exec(raw);
  const numericTarget = parseSkillCommandTarget(numericMatch?.[1] || '');
  let target: SkillCommandTarget | null = numericTarget;
  let mods: string[] | null = numericMatch?.[2] === undefined ? [] : parseExplicitMods(numericMatch[2]);
  if (!numericMatch) {
    const explicitPlayerMatch = /^p:\[([^\]]+)\](?:\s+(\d+))?$/i.exec(raw);
    const namedBpMatch = explicitPlayerMatch ? null : /^(.+?)\s+(\d+)$/.exec(raw);
    const username = String(explicitPlayerMatch?.[1] || namedBpMatch?.[1] || '').trim();
    const rank = explicitPlayerMatch && explicitPlayerMatch[2] === undefined
      ? 1
      : Number(explicitPlayerMatch?.[2] || namedBpMatch?.[2] || 0);
    if (username && Number.isSafeInteger(rank) && rank >= 1 && rank <= MAX_BP_RANK) {
      target = { kind: 'named_bp', username, rank };
      mods = [];
    }
  }
  if (!target) {
    return {
      ok: false,
      message: '用法：/w skill <BP名次或BID> [+Mods]，或 /w skill <玩家名> <BP名次>；纯数字玩家名请用 p:[玩家名]，例如 /w skill p:[970] 20。',
    };
  }
  if (!mods) {
    return { ok: false, message: '无法识别 Mod；示例：+HD、+HDDT、+HR、+PF。' };
  }
  if (mods.includes('FL')) {
    return { ok: false, message: 'Skill Profiler 暂不支持 FL：它需要单独的可见范围维度，不能伪装成 NM/HD 分析。' };
  }
  if (target.kind !== 'bid' && mods.length) {
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
  const rawBinding = ctx.commandDb.osuBindings?.[String(ctx.event.userId)];
  // A BP lookup only needs the score list. Avoid fetching the full
  // `/users/:id/osu` profile first: that endpoint is the one most often
  // throttled, and modern bindings already contain the stable ID/username.
  if (rawBinding && typeof rawBinding === 'object') {
    const id = Number(rawBinding.osuUserId ?? rawBinding.userId ?? rawBinding.id ?? 0);
    if (Number.isSafeInteger(id) && id > 0) {
      const username = String(rawBinding.osuUsername ?? rawBinding.username ?? '').trim() || `osu#${id}`;
      const scores = await getUserBestScores(id, 'osu', MAX_BP_RANK);
      return resolveUserBp({ id, username }, rank, scores);
    }
  }

  const binding = resolveOsuBindingValue(rawBinding);
  if (!binding) throw new Error('请先绑定 osu! 账号：/w osu bind <用户名>');
  if (typeof binding === 'number') {
    const scores = await getUserBestScores(binding, 'osu', MAX_BP_RANK);
    return resolveUserBp({ id: binding, username: `osu#${binding}` }, rank, scores);
  }
  const user = await getUser(String(binding), 'osu');
  return resolveUserBp(user, rank);
}

async function resolveNamedBp(username: string, rank: number): Promise<{
  beatmapId: number;
  mods: string[];
  sourceLabel: string;
}> {
  const numericId = /^\d+$/.test(username) ? Number(username) : 0;
  const user = Number.isSafeInteger(numericId) && numericId > 0
    ? await getUserById(numericId, 'osu')
    : await getUser(username, 'osu');
  return resolveUserBp(user, rank);
}

async function resolveUserBp(
  user: { id: number; username: string },
  rank: number,
  preloadedScores?: any[],
): Promise<{
  beatmapId: number;
  mods: string[];
  sourceLabel: string;
}> {
  // Always fill the BP100 cache. Fetching `limit=rank` made every different
  // `/w skill <rank>` command use a different cache key and repeatedly hit the
  // osu! API for the same player.
  const scores = preloadedScores || await getUserBestScores(user.id, 'osu', MAX_BP_RANK);
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

function modSuffix(mods: string[]): string {
  return mods.length ? ` +${mods.join('')}` : '';
}

function modLabel(mods: string[]): string {
  return mods.length ? `+${mods.join('')}` : 'NM';
}

function feedbackGuidance(beatmapId: number, mods: string[]): string {
  const command = `/w cd ${beatmapId}${modSuffix(mods)}`;
  return [
    '',
    '对这份分析有异议或实战体感可以直接反馈：',
    `${command} <你的反馈>`,
    `建议写清具体维度、你认为的难度和原因，例如：${command} Reading 明显偏低，低 AR 段至少应算 7★。`,
  ].join('\n');
}

async function resolveProfileUser(ctx: OwnerHandlerContext, explicitPlayer: string): Promise<{ id: number; username: string }> {
  if (explicitPlayer) {
    const numericId = /^\d+$/.test(explicitPlayer) ? Number(explicitPlayer) : 0;
    return Number.isSafeInteger(numericId) && numericId > 0
      ? getUserById(numericId, 'osu')
      : getUser(explicitPlayer, 'osu');
  }
  const rawBinding = ctx.commandDb.osuBindings?.[String(ctx.event.userId)];
  // A structured binding already contains the stable player identity. Do not
  // make an extra user-profile request before the real BP/profile work starts:
  // after a process restart that request also forces a fresh OAuth token and a
  // transient token-network failure used to make the entire command fail before
  // the user even saw the "正在生成" progress message.
  if (rawBinding && typeof rawBinding === 'object') {
    const id = Number(rawBinding.osuUserId ?? rawBinding.userId ?? rawBinding.id ?? 0);
    const username = String(rawBinding.osuUsername ?? rawBinding.username ?? '').trim();
    if (Number.isSafeInteger(id) && id > 0) {
      return { id, username: username || `osu#${id}` };
    }
    if (username) return getUser(username, 'osu');
  }
  const binding = resolveOsuBindingValue(rawBinding);
  if (!binding) throw new Error('请先绑定 osu! 账号：/w osu bind <用户名>，或使用 /w skill profile <玩家名>。');
  return typeof binding === 'number'
    ? getUserById(binding, 'osu')
    : getUser(String(binding), 'osu');
}

export async function ownerSkillHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const comparisonRequest = parsePlayerSkillComparisonRequest(ctx.commandArgs);
  if (comparisonRequest.matched) {
    if (comparisonRequest.error) {
      if (ctx.sendMessage) await ctx.sendMessage(ctx.event, comparisonRequest.error);
      return { replied: Boolean(ctx.sendMessage), reason: comparisonRequest.error };
    }
    const [left, right] = await Promise.all([
      resolveProfileUser(ctx, comparisonRequest.left),
      resolveProfileUser(ctx, comparisonRequest.right),
    ]);
    if (left.id === right.id) throw new Error('请选择两个不同的玩家进行 Skill 对比。');
    if (ctx.sendMessage) {
      await ctx.sendMessage(ctx.event, `正在用成绩质量与 BP 衰减对比 ${left.username} 和 ${right.username} 的 BP50，首次生成可能需要一两分钟……`);
    }
    const rendered = await renderPlayerSkillComparison(left.id, right.id, 50);
    if (!rendered) throw new Error('玩家 Skill 对比渲染器当前未连接，请稍后再试。');
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, rendered.cqCode);
    return { replied: Boolean(ctx.sendMessage), reason: `已生成 ${left.username} 与 ${right.username} 的 BP50 Skill 对比` };
  }

  const recentRequest = parsePlayerRecentSkillRequest(ctx.commandArgs);
  if (recentRequest.matched) {
    const user = await resolveProfileUser(ctx, recentRequest.player);
    if (ctx.sendMessage) {
      await ctx.sendMessage(ctx.event, `正在生成 ${user.username} 的 Recent Skill：优先读取最近 50 条，完成谱面不足时最多回溯 5 天……`);
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('RECENT_SKILL_TIMEOUT')), 150_000);
        timer.unref?.();
      });
      const rendered = await Promise.race([renderPlayerRecentSkillProfile(user.id), timeout]);
      if (ctx.sendMessage) await ctx.sendMessage(ctx.event, rendered.cqCode);
      return { replied: Boolean(ctx.sendMessage), reason: `已生成 ${user.username} 的 Recent Skill 画像` };
    } catch (error: any) {
      const message = String(error?.message || error);
      if (message === 'RECENT_SKILL_TIMEOUT') throw new Error('Recent Skill 生成超时；已保留成功的谱面分析缓存，请稍后重试。');
      const insufficient = /^RECENT_SKILL_INSUFFICIENT(?:_AFTER_FILTER)?:([0-9]+)$/.exec(message);
      if (insufficient) throw new Error(`近期证据不足：回溯 5 天后只有 ${insufficient[1]} 张有效完成谱面，至少需要 5 张。`);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const profileRequest = parsePlayerSkillProfileRequest(ctx.commandArgs);
  if (profileRequest.matched) {
    const user = await resolveProfileUser(ctx, profileRequest.player);
    if (ctx.sendMessage) {
      await ctx.sendMessage(ctx.event, `正在按成绩质量与 BP 衰减分析 ${user.username} 的真实 BP50，首次会逐张计算，请求追踪中可查看进度……`);
    }
    const rendered = await renderPlayerSkillProfile(user.id, 50);
    if (!rendered) throw new Error('玩家 Skill 画像渲染器当前未连接，请稍后再试。');
    const sample = rendered.payload.sample as { valid: number; requested: number; failed: number };
    const partial = sample.failed > 0
      ? `\n本次仅 ${sample.valid}/${sample.requested} 张纳入画像，存在超时或证据不足；可重试，已完成的谱面会复用缓存。`
      : '';
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, rendered.cqCode + partial);
    return { replied: Boolean(ctx.sendMessage), reason: `已生成 ${user.username} 的 BP50 Skill 画像（${sample.valid}/${sample.requested} 有效）` };
  }

  const request = parseSkillCommandRequest(ctx.commandArgs);
  if (request.ok === false) {
    const reason = request.message;
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reason);
    return { replied: Boolean(ctx.sendMessage), reason };
  }

  const { target } = request;

  const resolved = target.kind === 'bp'
    ? await resolveBoundBp(ctx, target.rank)
    : target.kind === 'named_bp'
      ? await resolveNamedBp(target.username, target.rank)
      : {
        beatmapId: target.beatmapId,
        mods: request.mods,
        sourceLabel: `BID ${target.beatmapId}${request.mods.length ? ` +${request.mods.join('')}` : ''}`,
      };
  const analysis = await requestSkillProfilerAnalysisWithFetch(resolved.beatmapId, resolved.mods);
  const fallbackText = [
    target.kind !== 'bid' ? `分析来源：${resolved.sourceLabel}` : '',
    formatSkillProfilerAnalysis(analysis),
    feedbackGuidance(resolved.beatmapId, resolved.mods),
  ].filter(Boolean).join('\n');
  rememberProfilerRun(ctx, analysis, resolved.sourceLabel);
  const rendered = await renderSkillProfilerCard(analysis);
  if (ctx.sendMessage) await ctx.sendMessage(ctx.event, rendered?.cqCode || fallbackText);
  return { replied: Boolean(ctx.sendMessage), reason: `Skill Profiler 已分析 BID ${resolved.beatmapId}` };
}

export async function ownerSkillFeedbackHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const match = /^(\d+)(?:\s+\+\s*(\S+))?\s+([\s\S]+)$/.exec(String(ctx.commandArgs || '').trim());
  const beatmapId = Number(match?.[1] || 0);
  const mods = match?.[2] === undefined ? [] : parseExplicitMods(match[2]);
  const message = String(match?.[3] || '').trim();
  if (!Number.isSafeInteger(beatmapId) || beatmapId <= MAX_BP_RANK || !message) {
    const reason = '用法：/w cd <BID> [+Mods] <反馈内容>；例如 /w cd 4288226 +HD Reading 明显偏低。';
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reason);
    return { replied: Boolean(ctx.sendMessage), reason };
  }
  if (!mods) {
    const reason = '无法识别 Mod；示例：+HD、+HDDT、+HR、+PF。不写 Mod 表示 NM。';
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reason);
    return { replied: Boolean(ctx.sendMessage), reason };
  }
  if (mods.includes('FL')) {
    const reason = 'Skill Profiler 暂不支持 FL，因此不能记录为已有分析的 Mod 反馈。';
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
    && String(run?.groupId || '') === String(ctx.event.groupId || 'private')
    && JSON.stringify(Array.isArray(run?.analysis?.mods) ? run.analysis.mods : []) === JSON.stringify(mods),
  );
  await appendSkillProfilerFeedback({
    schemaVersion: 2,
    id: crypto.randomUUID(),
    beatmapId,
    mods,
    effectiveMods: Array.isArray(recent?.analysis?.effectiveMods) ? recent.analysis.effectiveMods.map(String) : [],
    neutralMods: Array.isArray(recent?.analysis?.neutralMods) ? recent.analysis.neutralMods.map(String) : [],
    message,
    groupId: String(ctx.event.groupId || 'private'),
    userId: String(ctx.event.userId || ''),
    nickname: String(ctx.event.nickname || ctx.event.userId || ''),
    sourceMessageId: String(ctx.event.messageId || ''),
    createdAt: nowIso(),
    analysis: recent?.analysis || null,
  });
  const snapshotNote = recent?.analysis
    ? `已同时关联本群最近一次该 BID ${modLabel(mods)} 的分析版本。`
    : `本群暂未找到该 BID ${modLabel(mods)} 的最近分析，反馈仍已保存；建议先运行对应 Mod 的 /w skill。`;
  const reply = `已记录对 BID ${beatmapId} ${modLabel(mods)} 的反馈。${snapshotNote}`;
  if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
  return { replied: Boolean(ctx.sendMessage), reason: `已记录 Skill Profiler 反馈 BID ${beatmapId}` };
}
