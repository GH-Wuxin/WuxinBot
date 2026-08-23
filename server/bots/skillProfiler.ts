import type { LlmTool, ToolResult } from './types.js';

export const SKILL_PROFILER_TOOL_NAME = 'osu_analyze_beatmap_skills';
const DEFAULT_SKILL_PROFILER_URL = 'http://127.0.0.1:8767';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

const AXIS_LABELS: Readonly<Record<string, string>> = {
  aim_control: 'Aim Control',
  stamina: 'Stamina',
  endurance: 'Endurance',
  raw_speed: 'Raw Speed',
  jump_aim: 'Jump Aim',
  spatial_precision: 'Spatial Precision',
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

function formatAnalysisEvidence(analysis: any): string {
  if (analysis?.status !== 'OK' || !analysis?.axes || !analysis?.beatmap) {
    throw new Error(`SKILL_PROFILER_ANALYSIS_NOT_OK: ${String(analysis?.status || 'UNKNOWN')}`);
  }
  const beatmap = analysis.beatmap;
  const modContext = analysis.mod_context || {};
  const mods = Array.isArray(modContext.effective_mods) && modContext.effective_mods.length
    ? modContext.effective_mods.join('')
    : 'NM';
  const difficulty = analysis.analysis_context?.difficulty || beatmap.metadata?.difficulty || {};
  const bpm = finiteNumber(analysis.analysis_context?.bpm_max);
  const durationMs = finiteNumber(analysis.analysis_context?.duration_ms);
  const localStars = finiteNumber(beatmap.local_nm_stars);
  const lines = [
    'Skill Profiler 本地确定性谱面需求分析（实验性 V0.9；各维不是 osu! 官方总星数，也不是玩家能力评价）',
    `谱面：${formatBeatmapTitle(beatmap)}`,
    `BID：${beatmap.beatmap_id} · Mods：${mods}`,
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
  lines.push(`算法身份：${String(analysis.identity?.algorithm_id || 'UNKNOWN')} / Map Demand ${String(analysis.identity?.map_demand_version || 'UNKNOWN')}`);
  lines.push('解释时优先描述“哪些维度相对突出/这张图难在哪里”；LOW 置信度和实验性分值必须保留不确定性，不要包装成官方定论。');
  return lines.join('\n');
}

export function buildSkillProfilerToolSchema(): LlmTool {
  return {
    type: 'function',
    function: {
      name: SKILL_PROFILER_TOOL_NAME,
      description: '分析一张本地已有的 osu!standard 谱面在 Aim Control、Stamina、Endurance、Raw Speed、Jump Aim、Spatial Precision、Flow Aim、Finger Control、Reading 九个维度上的需求，并判断谱面类型。用户问“这图难在哪/是什么类型/某维度多难”时调用；这是实验性谱面分析，不是玩家能力分析，也不是官方星数。',
      parameters: {
        type: 'object',
        properties: {
          beatmap_id: { type: 'integer', minimum: 1, description: 'osu! beatmap ID（BID），不是 beatmapset ID' },
          mods: {
            type: 'array',
            items: { type: 'string', enum: ['NM', 'EZ', 'HD', 'HR', 'HT', 'DT'] },
            maxItems: 4,
            uniqueItems: true,
            description: '要分析的 Mod 列表；不填表示 NM。只传用户明确指定的 Mod。',
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
    const analysis = await postProfiler('/api/analyze', {
      beatmap_id: args.beatmap_id,
      mods: args.mods || [],
    });
    return {
      toolCallId,
      ok: true,
      content: formatAnalysisEvidence(analysis),
      metadata: {
        requestedCapability: 'beatmap_skill_profile',
        actualExecutor: 'osu_skill_profiler_v09',
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
        actualExecutor: 'osu_skill_profiler_v09',
        dataSource: 'local_osu_manifest',
        renderer: 'none',
        command: SKILL_PROFILER_TOOL_NAME,
        success: false,
      },
    };
  }
}
