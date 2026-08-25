import type { LlmTool, ToolResult } from './types.js';

export const SKILL_PROFILER_TOOL_NAME = 'osu_analyze_beatmap_skills';
const DEFAULT_SKILL_PROFILER_URL = 'http://127.0.0.1:8767';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_OSU_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_OSU_FILE_BASE_URL = 'https://osu.ppy.sh/osu/';

const AXIS_LABELS: Readonly<Record<string, string>> = {
  aim_control: 'Aim Control',
  stamina: 'Stamina',
  endurance: 'Endurance',
  raw_speed: 'Raw Speed',
  jump_aim: 'Jump Aim',
  spatial_precision: 'Micro Precision',
  flow_aim: 'Flow Aim',
  finger_control: 'Finger Control',
  reading: 'Reading',
};

function profilerBaseUrl(): URL {
  const configured = String(process.env.SKILL_PROFILER_URL || DEFAULT_SKILL_PROFILER_URL).trim();
  const url = new URL(configured);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname.toLowerCase()) ||
    url.username ||
    url.password
  ) {
    throw new Error('SKILL_PROFILER_URL must be an unauthenticated loopback HTTP URL');
  }
  return url;
}

function profilerTimeoutMs(): number {
  const parsed = Number(process.env.SKILL_PROFILER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(parsed) ? Math.max(1_000, Math.min(60_000, Math.round(parsed))) : DEFAULT_TIMEOUT_MS;
}

async function postProfiler(pathname: string, payload: Record<string, unknown>): Promise<any> {
  const url = new URL(pathname, profilerBaseUrl());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), profilerTimeoutMs());
  timer.unref?.();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > MAX_RESPONSE_BYTES) throw new Error('SKILL_PROFILER_RESPONSE_TOO_LARGE');
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new Error('SKILL_PROFILER_RESPONSE_TOO_LARGE');
    }
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`SKILL_PROFILER_INVALID_JSON (${response.status})`);
    }
    if (!response.ok) {
      const code = String(data?.error || `HTTP_${response.status}`).slice(0, 80);
      const message = String(data?.message || 'Skill Profiler request failed').slice(0, 300);
      throw new Error(`${code}: ${message}`);
    }
    return data;
  } catch (error: any) {
    if (error?.name === 'AbortError') throw new Error('SKILL_PROFILER_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function beatmapFileBaseUrl(): URL {
  const url = new URL(String(process.env.OSU_BEATMAP_FILE_BASE_URL || DEFAULT_OSU_FILE_BASE_URL).trim());
  const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname.toLowerCase());
  const official = url.protocol === 'https:' && url.hostname.toLowerCase() === 'osu.ppy.sh';
  if ((!loopback && !official) || url.username || url.password) {
    throw new Error('OSU_BEATMAP_FILE_BASE_URL must be official osu! HTTPS or loopback HTTP');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

async function downloadOsuFile(beatmapId: number): Promise<string> {
  const url = new URL(String(beatmapId), beatmapFileBaseUrl());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      headers: { Accept: 'text/plain, application/octet-stream;q=0.9' },
      redirect: 'follow',
      signal: controller.signal,
    });
    const finalUrl = new URL(response.url);
    const finalLoopback = finalUrl.protocol === 'http:'
      && ['127.0.0.1', 'localhost'].includes(finalUrl.hostname.toLowerCase());
    const finalOfficial = finalUrl.protocol === 'https:'
      && finalUrl.hostname.toLowerCase() === 'osu.ppy.sh';
    if (!finalLoopback && !finalOfficial) throw new Error('OSU_FILE_DOWNLOAD_REDIRECT_REJECTED');
    if (!response.ok) throw new Error(`OSU_FILE_DOWNLOAD_HTTP_${response.status}`);
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > MAX_OSU_FILE_BYTES) throw new Error('OSU_FILE_TOO_LARGE');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_OSU_FILE_BYTES) throw new Error('OSU_FILE_TOO_LARGE');
    const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
    if (!text.startsWith('osu file format v')) throw new Error('OSU_FILE_INVALID_HEADER');
    const embedded = /^BeatmapID\s*:\s*(\d+)\s*$/im.exec(text);
    if (!embedded || Number(embedded[1]) !== beatmapId) throw new Error('OSU_FILE_BID_MISMATCH');
    return text;
  } catch (error: any) {
    if (error?.name === 'AbortError') throw new Error('OSU_FILE_DOWNLOAD_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatBeatmapTitle(beatmap: any): string {
  const artist = String(beatmap?.artist || '').trim();
  const title = String(beatmap?.title || '').trim();
  const version = String(beatmap?.version || '').trim();
  const creator = String(beatmap?.creator || '').trim();
  return [
    [artist, title].filter(Boolean).join(' - ') || `BID ${beatmap?.beatmap_id || '?'}`,
    version ? `[${version}]` : '',
    creator ? `(mapped by ${creator})` : '',
  ].filter(Boolean).join(' ');
}

export function formatSkillProfilerAnalysis(analysis: any): string {
  if (analysis?.status !== 'OK' || !analysis?.axes || !analysis?.beatmap) {
    throw new Error(`SKILL_PROFILER_ANALYSIS_NOT_OK: ${String(analysis?.status || 'UNKNOWN')}`);
  }
  const beatmap = analysis.beatmap;
  const modContext = analysis.mod_context || {};
  const requestedMods = Array.isArray(modContext.requested_mods) ? modContext.requested_mods : [];
  const neutralMods = Array.isArray(modContext.neutral_mods) ? modContext.neutral_mods : [];
  const mods = requestedMods.length
    ? requestedMods.join('')
    : Array.isArray(modContext.effective_mods) && modContext.effective_mods.length
      ? modContext.effective_mods.join('')
    : 'NM';
  const difficulty = analysis.analysis_context?.difficulty || beatmap.metadata?.difficulty || {};
  const bpm = finiteNumber(analysis.analysis_context?.bpm_max);
  const durationMs = finiteNumber(analysis.analysis_context?.duration_ms);
  const localStars = finiteNumber(beatmap.local_nm_stars);
  const lines = [
    'Skill Profiler 本地确定性谱面需求分析（V0.95；各维不是 osu! 官方总星数，也不是玩家能力评价）',
    `谱面：${formatBeatmapTitle(beatmap)}`,
    `BID：${beatmap.beatmap_id} · Mods：${mods}${neutralMods.length ? `（${neutralMods.join('/')} 对谱面需求分值无影响）` : ''}`,
    `环境：AR ${finiteNumber(difficulty.ApproachRate ?? difficulty.AR)?.toFixed(1) ?? '未知'} · OD ${finiteNumber(difficulty.OverallDifficulty ?? difficulty.OD)?.toFixed(1) ?? '未知'} · CS ${finiteNumber(difficulty.CircleSize ?? difficulty.CS)?.toFixed(1) ?? '未知'}${bpm === null ? '' : ` · BPM ${bpm.toFixed(1)}`}${durationMs === null ? '' : ` · 时长 ${(durationMs / 1000).toFixed(0)}s`}${localStars === null ? '' : ` · 本地 NM 总星数 ${localStars.toFixed(2)}★`}`,
    '九维需求：',
  ];
  for (const axis of Object.keys(AXIS_LABELS)) {
    const item = analysis.axes[axis] || {};
    const value = finiteNumber(item.stars);
    const unit = item.unit === 'bounded_0_10' ? '/10' : '★';
    lines.push(`- ${AXIS_LABELS[axis]}：${value === null ? '不可用' : `${value.toFixed(1)}${unit}`}（置信度 ${String(item.confidence || 'UNKNOWN')}）`);
  }
  const archetype = analysis.archetype || {};
  if (archetype.status === 'CLASSIFIED') {
    lines.push(
      `类型判断：${String(archetype.primary_type || 'UNKNOWN')}` +
      `${Array.isArray(archetype.dominant_axes) && archetype.dominant_axes.length ? `；主导维度 ${archetype.dominant_axes.map((axis: string) => AXIS_LABELS[axis] || axis).join('、')}` : ''}` +
      `（置信度 ${String(archetype.confidence || 'UNKNOWN')}）`,
    );
  }
  const warnings = Array.isArray(analysis.warnings) ? analysis.warnings.filter(Boolean).slice(0, 5) : [];
  if (warnings.length) lines.push(`警告：${warnings.map((warning: unknown) => String(warning)).join('；')}`);
  lines.push('解释时优先描述“哪些维度相对突出/这张图难在哪里”；LOW 置信度和实验性分值必须保留不确定性，不要包装成官方定论。');
  return lines.join('\n');
}

export async function requestSkillProfilerAnalysis(
  beatmapId: number,
  mods: string[] = [],
): Promise<any> {
  return postProfiler('/api/analyze', {
    beatmap_id: beatmapId,
    mods,
  });
}

export async function requestSkillProfilerAnalysisWithFetch(
  beatmapId: number,
  mods: string[] = [],
): Promise<any> {
  try {
    return await requestSkillProfilerAnalysis(beatmapId, mods);
  } catch (error: any) {
    const message = String(error?.message || error);
    if (!/^(?:BID_NOT_FOUND|OSU_FILE_MISSING):/.test(message)) throw error;
    const content = await downloadOsuFile(beatmapId);
    await postProfiler('/api/import', { beatmap_id: beatmapId, content });
    return requestSkillProfilerAnalysis(beatmapId, mods);
  }
}

export function buildSkillProfilerToolSchema(): LlmTool {
  return {
    type: 'function',
    function: {
      name: SKILL_PROFILER_TOOL_NAME,
      description: '分析一张本地已有的 osu!standard 谱面在 Aim Control、Stamina、Endurance、Raw Speed、Jump Aim、Micro Precision（小目标容错、落点稳定与微修正）、Flow Aim、Finger Control、Reading 九个维度上的需求，并判断谱面类型。用户问“这图难在哪/是什么类型/某维度多难”时调用；这是实验性谱面分析，不是玩家能力分析，也不是官方星数。',
      parameters: {
        type: 'object',
        properties: {
          beatmap_id: { type: 'integer', minimum: 1, description: 'osu! beatmap ID（BID），不是 beatmapset ID' },
          mods: {
            type: 'array',
            items: { type: 'string', enum: ['NM', 'NF', 'EZ', 'HD', 'HR', 'SD', 'HT', 'DT', 'NC', 'PF', 'DC'] },
            maxItems: 4,
            uniqueItems: true,
            description: '要分析的 Mod 列表；不填表示 NM。PF/SD/NF 会保留但不改变谱面需求分值；FL 暂不支持。只传用户明确指定的 Mod。',
          },
        },
        required: ['beatmap_id'],
      },
    },
  };
}

export async function executeSkillProfilerAnalysis(
  toolCallId: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const analysis = await requestSkillProfilerAnalysis(
      Number(args.beatmap_id),
      Array.isArray(args.mods) ? args.mods.map((mod) => String(mod)) : [],
    );
    return {
      toolCallId,
      ok: true,
      content: formatSkillProfilerAnalysis(analysis),
      metadata: {
        requestedCapability: 'beatmap_skill_profile',
        actualExecutor: 'osu_skill_profiler_v095',
        dataSource: 'local_osu_manifest',
        renderer: 'none',
        command: SKILL_PROFILER_TOOL_NAME,
        success: true,
      },
    };
  } catch (error: any) {
    const message = String(error?.message || error).slice(0, 500);
    return {
      toolCallId,
      ok: false,
      content: `Skill Profiler 分析失败：${message}`,
      error: message,
      metadata: {
        requestedCapability: 'beatmap_skill_profile',
        actualExecutor: 'osu_skill_profiler_v095',
        dataSource: 'local_osu_manifest',
        renderer: 'none',
        command: SKILL_PROFILER_TOOL_NAME,
        success: false,
      },
    };
  }
}
