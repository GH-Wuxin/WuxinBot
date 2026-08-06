// Knowledge base v4.1 — retrieval→prompt conversion.
//
// RetrievedKnowledgeBlock (with documentId/score) never reaches the persona.
// This module is the only conversion gateway: it builds PromptKnowledgeBlock
// (sourceClass/title/text), applies the fixed per-route quotas (A6) and adds
// the community-style data fence.
import type {
  KnowledgeCollection,
  KbRoute,
  PromptKnowledgeBlock,
  RetrievedKnowledgeBlock,
} from './knowledgeTypes.js';

export interface RouteCollectionPlan {
  collection: KnowledgeCollection;
  budget: number;
}

const ROUTE_PLANS: Record<string, RouteCollectionPlan[]> = {
  none: [],
  wuxin_self: [{ collection: 'wuxin_self', budget: 800 }],
  capability_summary: [{ collection: 'wuxin_self', budget: 900 }],
  osu_domain: [{ collection: 'osu_domain', budget: 900 }],
  community_style: [{ collection: 'community_style', budget: 500 }],
  self_and_domain: [
    { collection: 'wuxin_self', budget: 750 },
    { collection: 'osu_domain', budget: 600 },
  ],
  osu_casual_with_domain: [
    { collection: 'community_style', budget: 400 },
    { collection: 'osu_domain', budget: 500 },
  ],
};

export const KB_TOTAL_TEXT_BUDGET = 1500;

export function routeCollections(route: KbRoute): RouteCollectionPlan[] {
  return ROUTE_PLANS[route.kind] || [];
}

function truncateDoc(text: string, budget: number, keepFirstLine: boolean): string {
  if (text.length <= budget) return text;
  if (keepFirstLine) {
    const newline = text.indexOf('\n');
    if (newline >= 0 && newline < budget) {
      const first = text.slice(0, newline + 1);
      return first + text.slice(newline + 1, budget);
    }
  }
  const boundary = text.lastIndexOf('\n', budget - 1);
  if (boundary > Math.floor(budget / 2)) return text.slice(0, boundary + 1);
  const sentence = Math.max(text.lastIndexOf('。', budget - 1), text.lastIndexOf('；', budget - 1), text.lastIndexOf('\n', budget - 1));
  if (sentence > Math.floor(budget / 2)) return text.slice(0, sentence + 1);
  return text.slice(0, budget);
}

function renderBlock(block: PromptKnowledgeBlock): string {
  if (block.sourceClass === '社区表达参考') {
    const title = block.title ? ` · ${block.title}` : '';
    return [
      `【社区表达参考${title}】`,
      '以下文本仅用于感受社区语气与表达节奏。不得逐句引用、近似复述，也不得声称是任何真实成员说过的话：',
      block.text,
    ].join('\n');
  }
  if (block.sourceClass === 'osu! 领域知识') {
    const title = block.title ? ` · ${block.title}` : '';
    return [
      `【osu! 领域知识${title}】`,
      block.text,
      '（以上为通用领域知识；玩家专属数字仍以当前 API/工具结果为准。）',
    ].join('\n');
  }
  const title = block.title ? ` · ${block.title}` : '';
  return [
    `【功能说明${title}】`,
    block.text,
    '用户询问相关功能或命令用法时，直接按上述内容回答并给出命令本身；不要推给后台操作者，也不要含糊带过。',
  ].join('\n');
}

/**
 * Convert retrieved blocks into prompt blocks with the A6 quota model:
 * 1) reduce low-ranked documents; 2) truncate per document; 3) never cut a
 * canonical command line from the middle. Fence characters are separate and
 * are not counted against the knowledge text budget.
 */
export function toPromptBlocks(retrieved: RetrievedKnowledgeBlock[], route: KbRoute): PromptKnowledgeBlock[] {
  const plans = routeCollections(route);
  const result: PromptKnowledgeBlock[] = [];
  let usedTotal = 0;

  for (const plan of plans) {
    const blocks = retrieved.filter((b) => b.collection === plan.collection);
    if (blocks.length === 0) continue;
    const remaining = Math.max(0, KB_TOTAL_TEXT_BUDGET - usedTotal);
    const budget = Math.min(plan.budget, remaining);
    if (budget <= 0) break;
    const perDocBudget = Math.floor(budget / blocks.length);
    let used = 0;
    for (const block of blocks) {
      if (used + 40 > budget && result.length > 0) break;
      const keepFirstLine = block.collection === 'wuxin_self';
      const text = truncateDoc(block.text, Math.max(1, perDocBudget), keepFirstLine);
      result.push({
        sourceClass: block.collection === 'wuxin_self'
          ? '功能说明'
          : block.collection === 'osu_domain'
            ? 'osu! 领域知识'
            : '社区表达参考',
        title: block.title,
        text,
      });
      used += text.length;
    }
    usedTotal += used;
  }
  return result;
}

export function formatPromptKnowledgeBlocks(blocks: PromptKnowledgeBlock[]): string {
  if (!blocks || blocks.length === 0) return '';
  return ['【知识库参考】', ...blocks.map(renderBlock)].join('\n\n---\n\n');
}
