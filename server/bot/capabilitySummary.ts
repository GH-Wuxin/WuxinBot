/**
 * 本轮能力摘要。
 *
 * 目的只有一个：让她对自己「现在会什么」的认识与实际运行状态一致。产品支持、
 * 当前开放、需要命令、暂不可用、尚未实现，这几种状态不能混为一谈。
 *
 * 三条纪律：
 *
 * 1. 全部从已有元数据聚合，不新写一份人工功能清单。数据源是能力目录
 *    （CAPABILITY_CATALOG，其中 callable 就是这个能力能不能被直接调用）和
 *    命令目录（QUICK_DEFS，其中 status=active 才是当前开放的）。
 * 2. 有硬预算。常驻摘要每轮都要占提示词，所以行数与长度都有上限，超了按优先级
 *    删；但带限定词的句子（「仅命令」「当前不可用」）永远不删、不截断 ——
 *    把「支持但当前不可用」压成「支持」比不写更糟。
 * 3. 不重复工具清单。本轮实际暴露的工具是另一处写进去的，这里只说「按本轮已列
 *    工具调用」，避免同一件事写两遍。也因此这里不需要知道本轮的 toolsForTurn。
 */
import { CAPABILITY_CATALOG } from '../bots/capabilityCatalog.js';
import { QUICK_DEFS } from './commands/quick.meta.js';
import type { StickerAvailability } from './stickers/delivery.js';

/** 四种状态的说法。每一种都不宣称「一定发得出去」。 */
const STICKER_STATE_TEXT: Record<StickerAvailability, string> = {
  off: '表情：本群现在发不了（功能关闭），最终以发送校验为准。',
  'dry-run': '表情：本群目前只演练、不会真的发出，最终以发送校验为准。',
  'group-closed': '表情：本群不在开放范围内，发不了，最终以发送校验为准。',
  live: '表情：本群现在可以发，最终以发送校验为准。',
};

export const CAPABILITY_SUMMARY_BUDGET = { maxLines: 6, maxPoints: 240 } as const;

/** 无论怎么压缩都要保留的那句边界。未列出 ≠ 不支持，未知 ≠ 可用。 */
export const CAPABILITY_SUMMARY_BOUNDARY = '未列出不等于不支持；未知状态不要当作可用。';

const FAMILY_LABEL: Record<string, string> = { player: '玩家', beatmap: '谱面' };

export interface CapabilitySummaryInput {
  /**
   * 当前群此刻的表情可用状态。取自 stickerAvailabilityForGroup —— 与发送器同源。
   * 二值表达不了「仅演练」，而那个中间态恰恰是最容易被说错的。
   */
  stickerState: StickerAvailability;
  /** 本轮是否挂了联网搜索工具。 */
  searchAvailable: boolean;
}

interface SummaryLine {
  text: string;
  /** 带限定词的句子。宁可整条删掉后面的行，也不动这些。 */
  protected: boolean;
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

/** 只能经命令调用的能力：取当前开放的那条命令的首个别名当入口提示。 */
function commandOnlyHint(capability: string): string {
  const command = QUICK_DEFS.find((def) => def.capability === capability && def.status === 'active');
  const alias = command?.aliases?.[0];
  return alias ? '!' + alias : '';
}

function buildLines(input: CapabilitySummaryInput): SummaryLine[] {
  const lines: SummaryLine[] = [{ text: '【本轮能力】', protected: true }];

  const callableFamilies = [...new Set(
    CAPABILITY_CATALOG.filter((item) => item.callable).map((item) => item.family),
  )].map((family) => FAMILY_LABEL[family] || family);
  if (callableFamilies.length) {
    lines.push({ text: callableFamilies.join('与') + '查询、推图：按本轮已列工具调用。', protected: false });
  }

  // 只列「本来就要靠命令开启」的能力。工具面退役的那些（recent/info/skill）
  // 不是命令功能，列出来会让她误以为自己还有这些入口，也会把预算挤爆。
  for (const item of CAPABILITY_CATALOG.filter((entry) => !entry.callable && entry.commandOnly)) {
    const hint = commandOnlyHint(item.name);
    // 取描述的第一个语块，不在句子中间截断 —— 截出来的半个括号比不写更糟。
    // 全角括号后面通常是参数写法，那部分由命令提示承担。
    const label = item.description.split('（')[0].trim();
    lines.push({
      text: label + '：仅命令' + (hint ? ' ' + hint : '') + '，不由闲聊直接开启。',
      protected: true,
    });
  }

  lines.push({
    text: STICKER_STATE_TEXT[input.stickerState] || STICKER_STATE_TEXT.off,
    protected: true,
  });
  lines.push({
    text: 'osu! 官方搜索：本轮' + (input.searchAvailable ? '可用' : '不可用') + '。',
    protected: false,
  });
  lines.push({ text: CAPABILITY_SUMMARY_BOUNDARY, protected: true });
  return lines;
}

/**
 * 拼出本轮能力摘要，并保证不超预算。
 * 超预算时从后往前删非保护行；连保护行都放不下就只留保护行并说明这不是全量目录。
 */
export function buildCapabilitySummary(input: CapabilitySummaryInput): string {
  const all = buildLines(input);
  const render = (lines: SummaryLine[]) => lines.map((line) => line.text).join('\n');
  const fitsText = (text: string) => unicodeLength(text) <= CAPABILITY_SUMMARY_BUDGET.maxPoints
    && text.split('\n').length <= CAPABILITY_SUMMARY_BUDGET.maxLines;
  if (unicodeLength(render(all)) <= CAPABILITY_SUMMARY_BUDGET.maxPoints
    && all.length <= CAPABILITY_SUMMARY_BUDGET.maxLines) {
    return render(all);
  }
  let kept = [...all];
  while (kept.length > 1) {
    const index = kept.map((line, at) => ({ line, at })).reverse()
      .find((entry) => !entry.line.protected)?.at;
    if (index === undefined) break;
    kept.splice(index, 1);
    if (unicodeLength(render(kept)) <= CAPABILITY_SUMMARY_BUDGET.maxPoints
      && kept.length <= CAPABILITY_SUMMARY_BUDGET.maxLines) {
      return render(kept);
    }
  }
  // 连限定词都放不下：改用最精简的说法。
  // 这里以前是 `render(kept) + '（受预算限制…）'` —— 那会把已经超限的内容再
  // 加长，「无论如何都不超预算」这个契约就不成立了。要保住的是「不误导能力
  // 状态」这条语义，不是要求每一句都完整常驻，所以压缩而不是截断。
  const compact = '【本轮能力】' + compactSticker(input.stickerState)
    + '；osu!资料搜索' + (input.searchAvailable ? '可用' : '不可用') + '。' + CAPABILITY_SUMMARY_BOUNDARY;
  if (fitsText(compact)) return compact;
  // 连边界句都放不下（预算被配得极小）—— 那就不输出，而不是输出一个超预算的东西。
  return fitsText(CAPABILITY_SUMMARY_BOUNDARY) ? CAPABILITY_SUMMARY_BOUNDARY : '';
}

/** 状态的最短说法，用于预算放不下完整句时。仍然不宣称「一定发得出去」。 */
function compactSticker(state: StickerAvailability): string {
  if (state === 'live') return '表情可发';
  if (state === 'dry-run') return '表情仅演练';
  if (state === 'group-closed') return '表情本群未开';
  return '表情关闭';
}
