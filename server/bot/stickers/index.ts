/**
 * 表情包资源注册表。
 *
 * 资源在 server/bot/stickers/assets/，随 server/ 一起进安装包（内置，不外挂）。
 * 路径用 import.meta.url 解析，与 server/bots/skillCard/assets 同一约定，不依赖 cwd。
 *
 * 清单由 tools/sync-stickers.mjs 从素材包生成，本模块只读不写。
 * visual-annotations.json 是对发送版原图的人工视觉审查结果，独立于生成清单维护，
 * 这样重新同步素材时不会把人工标注冲掉。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { LlmTool } from '../../bots/types.js';

export type StickerRisk = 'low' | 'medium' | 'high';
export type StickerGate = 'code' | 'loose' | 'topic';
export type StickerMode = 'random' | 'context';
export type StickerVisualIntensity = 'light' | 'medium' | 'strong' | 'extreme';

/**
 * 人工查看发送版原图后整理出的视觉标注。
 * 这是数据，不是按关键词写死的选择逻辑；模型只读这些字段即可知道图上有什么。
 */
export interface StickerVisualAnnotation {
  action: string;
  expression: string;
  cues: string[];
  visibleText?: string[];
  bestFor: string[];
  avoid: string[];
  intensity: StickerVisualIntensity;
}

export interface StickerEntry {
  id: string;
  name: string;
  category: string;
  emotion: string;
  description: string;
  risk: StickerRisk;
  caption: boolean;
  /** 多图分组键 */
  group: string;
  /**
   * random  —— 同义差分池：随机取一条（各张姿势应有区别）
   * context —— 语境分支：由语境决定取哪张，除区分物外画面应完全相同
   */
  mode: StickerMode;
  /**
   * 触发门槛，决定「什么情况能发」：
   *   code  —— 只由代码在特定分支触发，LLM 不可选（bot 状态与功能确认）
   *   loose —— LLM 可用，只查氛围：任何话题都能发，可承担「冒泡」职能
   *   topic —— LLM 可用，氛围 + 话题两个条件都要，话题不对就不成立
   */
  gate: StickerGate;
  /** 仅 gate=topic 时有值，如 ['jump']、['hr']、['pp'] */
  topics?: string[];
  visual?: StickerVisualAnnotation;
  file: string;
  sha256: string;
  size: string;
}

export interface StickerPick {
  id: string;
  name: string;
  emotion: string;
  risk: StickerRisk;
  /** 绝对路径，直接交给下发管线转 [CQ:image,file=file:///...] */
  path: string;
  entry: StickerEntry;
}

export interface ModelStickerPolicy {
  maxRisk?: StickerRisk;
  /** Defaults to loose only; code/topic require an explicit policy decision. */
  allowedGates?: readonly StickerGate[];
  /** Defaults to random only; context entries need a deterministic selector. */
  allowedModes?: readonly StickerMode[];
  /** Server-derived topics for gate=topic; the model cannot supply this itself. */
  contextTopics?: readonly string[];
}

export interface StickerCatalogValidation {
  ok: boolean;
  manifestCount: number;
  annotationCount: number;
  missingAnnotations: string[];
  extraAnnotations: string[];
  duplicateIds: string[];
  missingFiles: string[];
  hashMismatches: string[];
  invalidEntries: string[];
}

export interface StickerModelEligibility {
  ok: boolean;
  reason: 'allowed' | 'unknown_id' | 'risk' | 'gate' | 'topic' | 'mode' | 'file';
  entry?: StickerEntry;
}

const RISK_ORDER: Record<StickerRisk, number> = { low: 0, medium: 1, high: 2 };

let cache: StickerEntry[] | null = null;
let byId: Map<string, StickerEntry> | null = null;
let byGroup: Map<string, StickerEntry[]> | null = null;
let byEmotion: Map<string, StickerEntry[]> | null = null;

function loadVisualAnnotations(): Map<string, StickerVisualAnnotation> {
  const url = new URL('./visual-annotations.json', import.meta.url);
  if (!fs.existsSync(fileURLToPath(url))) return new Map();
  const raw = fs.readFileSync(url, 'utf8');
  const parsed = JSON.parse(raw) as {
    annotations?: Record<string, StickerVisualAnnotation>;
  };
  return new Map(Object.entries(parsed.annotations || {}));
}

function pngDimensions(filePath: string): { width: number; height: number } | null {
  const header = fs.readFileSync(filePath).subarray(0, 24);
  if (header.length < 24
    || !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || header.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

/**
 * Validate the asset/annotation boundary once before the model path is enabled.
 * A malformed catalogue is a deployment error, not a reason to guess at
 * runtime. The caller decides whether to fail startup or expose the report.
 */
export function validateStickerCatalog(options: { verifyHashes?: boolean } = {}): StickerCatalogValidation {
  const manifestRaw = fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8');
  const manifest = JSON.parse(manifestRaw) as { count?: number; stickers?: unknown[] };
  const annotationRaw = fs.readFileSync(new URL('./visual-annotations.json', import.meta.url), 'utf8');
  const annotationDoc = JSON.parse(annotationRaw) as { annotations?: Record<string, unknown> };
  const rawEntries = Array.isArray(manifest.stickers) ? manifest.stickers : [];
  const annotationObject = Boolean(
    annotationDoc.annotations && typeof annotationDoc.annotations === 'object' && !Array.isArray(annotationDoc.annotations),
  );
  const annotationMap = annotationObject ? annotationDoc.annotations! : {};
  const entries = rawEntries.filter((entry): entry is Partial<StickerEntry> => Boolean(entry && typeof entry === 'object'));
  const ids = entries.map((entry) => String(entry.id || ''));
  const idSet = new Set(ids.filter(Boolean));
  const duplicateIds = ids.filter((id, index) => Boolean(id) && ids.indexOf(id) !== index);
  const annotationIds = Object.keys(annotationMap);
  const missingAnnotations = [...idSet].filter((id) => !Object.prototype.hasOwnProperty.call(annotationMap, id));
  const extraAnnotations = annotationIds.filter((id) => !idSet.has(id));
  const missingFiles: string[] = [];
  const hashMismatches: string[] = [];
  const invalidEntries: string[] = [];
  const validIntensities = new Set<StickerVisualIntensity>(['light', 'medium', 'strong', 'extreme']);
  const validRisks = new Set<StickerRisk>(['low', 'medium', 'high']);
  const validGates = new Set<StickerGate>(['code', 'loose', 'topic']);
  const validModes = new Set<StickerMode>(['random', 'context']);
  const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

  const entriesValid = entries.length === rawEntries.length;
  const countValid = Number.isInteger(manifest.count)
    && Number(manifest.count) === rawEntries.length
    && rawEntries.length > 0;
  if (!entriesValid) invalidEntries.push('manifest.stickers contains null or non-object entries');
  if (!annotationObject) invalidEntries.push('annotations must be an object');

  for (const entry of entries) {
    const id = String(entry.id || '<missing-id>');
    const file = String(entry.file || '');
    if (typeof entry.id !== 'string' || !entry.id.trim()) invalidEntries.push(`${id}: missing id`);
    if (typeof entry.name !== 'string' || !entry.name.trim()) invalidEntries.push(`${id}: missing name`);
    if (typeof entry.category !== 'string' || !entry.category.trim()) invalidEntries.push(`${id}: missing category`);
    if (typeof entry.emotion !== 'string' || !entry.emotion.trim()) invalidEntries.push(`${id}: missing emotion`);
    if (typeof entry.description !== 'string' || !entry.description.trim()) invalidEntries.push(`${id}: missing description`);
    if (typeof entry.caption !== 'boolean') invalidEntries.push(`${id}: caption must be boolean`);
    if (typeof entry.group !== 'string' || !entry.group.trim()) invalidEntries.push(`${id}: missing group`);
    if (!/^[A-Za-z0-9._-]+\.png$/u.test(file)) {
      invalidEntries.push(`${id}: invalid file name`);
    } else {
      const filePath = fileURLToPath(new URL('./assets/' + file, import.meta.url));
      if (!fs.existsSync(filePath)) {
        missingFiles.push(`${id}: ${file}`);
      } else {
        const dimensions = pngDimensions(filePath);
        if (!dimensions) {
          invalidEntries.push(`${id}: file is not a readable PNG`);
        } else if (`${dimensions.width}x${dimensions.height}` !== String(entry.size || '')) {
          invalidEntries.push(`${id}: declared size ${String(entry.size || '')} does not match ${dimensions.width}x${dimensions.height}`);
        }
        if (options.verifyHashes) {
          const actualHash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
          if (typeof entry.sha256 !== 'string' || actualHash !== entry.sha256.toLowerCase()) {
            hashMismatches.push(`${id}: ${file}`);
          }
        }
      }
    }
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(entry.sha256)) invalidEntries.push(`${id}: invalid sha256`);
    if (typeof entry.size !== 'string' || !/^\d+x\d+$/u.test(entry.size)) invalidEntries.push(`${id}: invalid size`);
    if (!validRisks.has(entry.risk as StickerRisk)) invalidEntries.push(`${id}: invalid risk`);
    if (!validGates.has(entry.gate as StickerGate)) invalidEntries.push(`${id}: invalid gate`);
    if (!validModes.has(entry.mode as StickerMode)) invalidEntries.push(`${id}: invalid mode`);
    if (entry.gate === 'topic') {
      if (!stringArray(entry.topics) || entry.topics.length === 0) invalidEntries.push(`${id}: topic gate requires topics`);
    } else if (entry.topics !== undefined && !stringArray(entry.topics)) {
      invalidEntries.push(`${id}: topics must be a string array`);
    }
    const annotation = annotationMap[id] as Partial<StickerVisualAnnotation> | undefined;
    if (!annotation || typeof annotation !== 'object') continue;
    if (!String(annotation.action || '').trim()) invalidEntries.push(`${id}: missing visual.action`);
    if (!String(annotation.expression || '').trim()) invalidEntries.push(`${id}: missing visual.expression`);
    if (!stringArray(annotation.cues)) invalidEntries.push(`${id}: visual.cues must be a string array`);
    if (!stringArray(annotation.bestFor)) invalidEntries.push(`${id}: visual.bestFor must be a string array`);
    if (!stringArray(annotation.avoid)) invalidEntries.push(`${id}: visual.avoid must be a string array`);
    if (!validIntensities.has(annotation.intensity as StickerVisualIntensity)) {
      invalidEntries.push(`${id}: invalid visual.intensity`);
    }
    if (annotation.visibleText !== undefined && !stringArray(annotation.visibleText)) {
      invalidEntries.push(`${id}: visual.visibleText must be a string array`);
    }
  }

  const manifestCount = rawEntries.length;
  const annotationCount = annotationIds.length;
  return {
    ok: countValid
      && entriesValid
      && annotationObject
      && missingAnnotations.length === 0
      && extraAnnotations.length === 0
      && duplicateIds.length === 0
      && missingFiles.length === 0
      && hashMismatches.length === 0
      && invalidEntries.length === 0,
    manifestCount,
    annotationCount,
    missingAnnotations,
    extraAnnotations,
    duplicateIds: [...new Set(duplicateIds)],
    missingFiles,
    hashMismatches,
    invalidEntries,
  };
}

function load(): StickerEntry[] {
  if (cache) return cache;
  const raw = fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw) as { stickers?: StickerEntry[] };
  const list = Array.isArray(parsed.stickers) ? parsed.stickers : [];
  const visualAnnotations = loadVisualAnnotations();
  cache = list
    .filter((s) => s && typeof s.id === 'string' && typeof s.file === 'string')
    .map((s) => ({ ...s, visual: visualAnnotations.get(s.id) }));
  byId = new Map(cache.map((s) => [s.id, s]));
  byGroup = new Map();
  byEmotion = new Map();
  for (const s of cache) {
    const group = s.group || s.id;
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group)!.push(s);
    if (!byEmotion.has(s.emotion)) byEmotion.set(s.emotion, []);
    byEmotion.get(s.emotion)!.push(s);
  }
  return cache;
}

/** 全部条目（已过滤掉清单里格式不合法的行）。 */
export function listStickers(): StickerEntry[] {
  return load().slice();
}

export function stickerIds(): string[] {
  return load().map((s) => s.id);
}

/** 资源绝对路径；条目不存在或文件缺失返回 null。 */
export function stickerPath(id: string): string | null {
  load();
  const hit = byId?.get(id);
  if (!hit) return null;
  const file = fileURLToPath(new URL('./assets/' + hit.file, import.meta.url));
  return fs.existsSync(file) ? file : null;
}

function allowed(entry: StickerEntry, maxRisk: StickerRisk): boolean {
  return RISK_ORDER[entry.risk] <= RISK_ORDER[maxRisk];
}

function modelRejectionReason(entry: StickerEntry, policy: ModelStickerPolicy = {}): StickerModelEligibility['reason'] {
  const maxRisk = policy.maxRisk || 'medium';
  const allowedGates = policy.allowedGates || ['loose'];
  const allowedModes = policy.allowedModes || ['random'];
  // Code-gated stickers are a hard boundary. A caller cannot widen it by
  // passing allowedGates=['code']; only the deterministic code path may use it.
  if (entry.gate === 'code') return 'gate';
  if (!allowed(entry, maxRisk)) return 'risk';
  if (!allowedGates.includes(entry.gate)) return 'gate';
  if (entry.gate === 'topic') {
    const contextTopics = policy.contextTopics || [];
    if (!entry.topics?.some((topic) => contextTopics.includes(topic))) return 'topic';
  }
  if (!allowedModes.includes(entry.mode)) return 'mode';
  return 'allowed';
}

function modelAllowed(entry: StickerEntry, policy: ModelStickerPolicy = {}): boolean {
  return modelRejectionReason(entry, policy) === 'allowed';
}

export function explainModelStickerEligibility(
  id: string,
  policy: ModelStickerPolicy = {},
): StickerModelEligibility {
  load();
  const entry = byId?.get(String(id || '').trim());
  if (!entry) return { ok: false, reason: 'unknown_id' };
  const policyReason = modelRejectionReason(entry, policy);
  if (policyReason !== 'allowed') return { ok: false, reason: policyReason, entry };
  return stickerPath(entry.id)
    ? { ok: true, reason: 'allowed', entry }
    : { ok: false, reason: 'file', entry };
}

function toPick(entry: StickerEntry, p: string): StickerPick {
  return { id: entry.id, name: entry.name, emotion: entry.emotion, risk: entry.risk, path: p, entry };
}

/**
 * 按 key 取一张。key 依次尝试：id → group → emotion（后两者随机取一条）。
 *
 * **这是代码通路**：按 id 取时不限门槛，所以 `pickSticker('service_down')` 可用 ——
 * 状态图正是要靠代码在对应分支上这样直接触发。模型必须走 `pickForModel`。
 *
 * maxRisk 默认 medium：high 风险的互损梗不参与随机，需要显式放宽才可能被选中。
 * rng 可注入，便于测试。
 */
export function pickSticker(
  key: string,
  options: { maxRisk?: StickerRisk; rng?: () => number } = {},
): StickerPick | null {
  const maxRisk = options.maxRisk || 'medium';
  const rng = options.rng || Math.random;
  load();

  const direct = byId?.get(key);
  if (direct && allowed(direct, maxRisk)) {
    const p = stickerPath(direct.id);
    return p ? toPick(direct, p) : null;
  }

  // 两条排除，显式按 id 取不受此限：
  //  - context 分支不进随机：串/跳、鼠/板 必须按语境选，随机取会在两个不同含义之间乱跳
  //  - code 门槛不进 LLM 通路：状态图必须由代码在对应分支直接触发
  const candidates = (byGroup?.get(key) || byEmotion?.get(key) || [])
    .filter((s) => s.mode === 'random' && s.gate !== 'code' && allowed(s, maxRisk));
  if (!candidates.length) return null;
  const picked = candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))];
  const p = stickerPath(picked.id);
  return p ? toPick(picked, p) : null;
}

/**
 * 列出一个分组或情绪下的全部条目（供语境分支使用）。
 * 调用方按语境自己选，例如按 osuTypeAnalyses 的 stream/aim 选串或跳。
 */
export function listGroup(key: string): StickerEntry[] {
  load();
  return (byGroup?.get(key) || byEmotion?.get(key) || []).slice();
}

function describe(s: StickerEntry): string {
  return s.id + ' — ' + s.name + '（' + s.description + '）';
}

/**
 * 通用语境类（gate=loose）：只查氛围。轻松场合可自由用，也用来「冒泡」。
 * 这一段的指令应当写成「轻松时随便用」，与下一段完全不同。
 */
export function stickerCatalog(options: { maxRisk?: StickerRisk } = {}): string {
  const maxRisk = options.maxRisk || 'medium';
  return load()
    .filter((s) => s.gate === 'loose' && allowed(s, maxRisk))
    .map(describe)
    .join('\n');
}

/**
 * 明确语义类（gate=topic）：氛围 + 话题两个条件都要。
 * 逐条带出话题，调用方在提示词里必须写明「话题不对就绝对不发」。
 */
export function topicStickerCatalog(options: { maxRisk?: StickerRisk } = {}): string {
  const maxRisk = options.maxRisk || 'medium';
  return load()
    .filter((s) => s.gate === 'topic' && allowed(s, maxRisk))
    .map((s) => describe(s) + '｜仅当话题：' + (s.topics || []).join('/'))
    .join('\n');
}

/**
 * Data-driven candidate catalog for the future model classification/tool path.
 * Every line comes from manifest.json; no sticker id or emotion mapping is
 * duplicated in code. The default policy exposes only ordinary random loose
 * reactions with low/medium risk.
 */
export function listModelStickers(policy: ModelStickerPolicy = {}): StickerEntry[] {
  return load().filter((entry) => modelAllowed(entry, policy));
}

export function modelStickerCatalog(policy: ModelStickerPolicy = {}): string {
  return listModelStickers(policy)
    .map((entry) => JSON.stringify({
      id: entry.id,
      category: entry.category,
      emotion: entry.emotion,
      description: entry.description,
      risk: entry.risk,
      gate: entry.gate,
      mode: entry.mode,
      ...(entry.visual ? { visual: entry.visual } : {}),
      ...(entry.topics?.length ? { topics: entry.topics } : {}),
    }))
    .join('\n');
}

/** Build a tool schema from the current manifest, without a handwritten enum. */
export function buildStickerSelectionTool(policy: ModelStickerPolicy = {}): LlmTool {
  const entries = listModelStickers(policy);
  return {
    type: 'function',
    function: {
      name: 'send_sticker',
      description: [
        '根据当前语境选择一张合适的 Pippi 表情。只在确实能增加反应时调用，普通信息和严肃查询不要调用。',
        '只能从下面清单选择 sticker_id；服务端会再次校验门槛、风险和模式。',
        modelStickerCatalog(policy),
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          sticker_id: {
            type: 'string',
            enum: entries.map((entry) => entry.id),
            description: '来自清单的 sticker_id。',
          },
        },
        required: ['sticker_id'],
      },
    },
  };
}

/**
 * **模型通路**：只接受精确 sticker id，并拒绝 gate=code 的条目。
 *
 * 与 pickSticker 分开是刻意的：状态图由代码在错误分支上直接触发，若模型也能按 id
 * 取到，它就可能在一个无关的场合发「服务挂了」或「没有权限」。分组名、情绪名和给定目录以外的 id 一律拒绝。
 */
export function pickForModel(
  key: string,
  options: ModelStickerPolicy = {},
): StickerPick | null {
  load();
  const direct = byId?.get(String(key || '').trim());
  if (!direct || !modelAllowed(direct, options)) return null;
  const p = stickerPath(direct.id);
  return p ? toPick(direct, p) : null;
}

/** 代码触发类（gate=code）：只做状态校验用，不交给模型。 */
export function codeStickerIds(): string[] {
  return load().filter((s) => s.gate === 'code').map((s) => s.id);
}

export function stickerCount(): number {
  return load().length;
}

// 与 server/bot.ts 的 escapeCqParam 同一套转义。没有直接复用是因为其一为模块内私有函数，
// 其二从 stickers 反向 import bot.ts 会形成循环依赖。资源路径本身是纯 ASCII 且无逗号，
// 这里保留转义只为不依赖该前提。
function cqImageFor(filePath: string): string {
  const href = pathToFileURL(filePath).href
    .replace(/&/g, '&amp;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/,/g, '&#44;');
  return '[CQ:image,file=' + href + ']';
}

/**
 * **代码通路**：给一段文字附上表情，返回可直接交给 sendMessage 的文本。
 *
 * 状态图必须走这条路 —— 它不经过 LLM，所以 LLM 挂掉时权限拒绝、服务故障这些分支
 * 照样能发出图。图取不到（条目缺失或文件不在）时原样返回文字，不让发言失败。
 */
export function withSticker(text: string, id: string): string {
  const p = stickerPath(id);
  if (!p) return text;
  return text + '\n' + cqImageFor(p);
}
