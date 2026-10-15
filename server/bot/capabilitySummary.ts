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

export const CAPABILITY_SUMMARY_BUDGET = { maxLines: 6, maxPoints: 240 } as const;

/** 无论怎么压缩都要保留的那句边界。未列出 ≠ 不支持，未知 ≠ 可用。 */
export const CAPABILITY_SUMMARY_BOUNDARY = '未列出不等于不支持；未知状态不要当作可用。';

const FAMILY_LABEL: Record<string, string> = { player: '玩家', beatmap: '谱面' };

export interface CapabilitySummaryInput {
  /** 当前群此刻是否允许发图片。发送前仍要过一遍校验，所以这里只说明可用性。 */
  stickerAvailable: boolean;
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

  for (const item of CAPABILITY_CATALOG.filter((entry) => !entry.callable)) {
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
    text: '表情：本群现在' + (input.stickerAvailable ? '可以发' : '发不了') + '，最终以发送校验为准。',
    protected: true,
  });
  lines.push({
    text: '联网搜索：本轮' + (input.searchAvailable ? '可用' : '不可用') + '。',
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
  // 连限定词都放不下：保留它们，并明说这不是全量目录，而不是做尾部截断。
  return render(kept) + '\n（受预算限制，此处不是全量目录。）';
}
