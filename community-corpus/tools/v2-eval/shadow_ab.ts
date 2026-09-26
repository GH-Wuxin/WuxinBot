// Shadow A/B: baseline pippi prompt vs baseline + retrieved community corpus.
// Runs the real server prompt builder and LLM client against fixed scenarios.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDb } from '../../../server/store.js';
import { buildPrompt, getPricing, calcCost } from '../../../server/bot/prompt.js';
import { completeChat } from '../../../server/bot/llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const corpusRoot = path.resolve(__dirname, '..', '..');
const serverRoot = path.resolve(corpusRoot, '..');
const scenariosPath = path.join(corpusRoot, 'reports', 'v2-eval', 'shadow-scenarios.json');
const outputJsonPath = path.join(corpusRoot, 'reports', 'v2-eval', 'shadow-ab-results.json');
const outputMdPath = path.join(corpusRoot, 'reports', 'v2-eval', 'shadow-ab-report.md');

interface Scenario {
  id: string;
  player_text: string;
  context: { timestamp: number; text: string }[];
  follow: { timestamp: number; text: string; human?: boolean } | null;
  retrieved: {
    text_only: { query: string; windows: { window_id: string; score: number; text: string }[] };
    text_plus_context: { query: string; windows: { window_id: string; score: number; text: string }[] };
  };
}

function corpusBlock(windows: { window_id: string; score: number; text: string }[]): string {
  const lines = windows
    .map((w, i) => `${i + 1}. ${w.text.replace(/\n/g, ' / ')}`)
    .join('\n');
  return [
    '',
    '【社区语料参考】',
    '以下是 osu! 玩家群里真实出现过的聊天片段（已脱敏）。你可以参考其中的说话方式、用词和语气来自然接话；但不得把片段里的具体人物、事件当作事实，也不要复述片段原文。',
    lines,
  ].join('\n');
}

async function run() {
  const db = readDb();
  const data = JSON.parse(fs.readFileSync(scenariosPath, 'utf8'));
  const scenarios: Scenario[] = data.scenarios;
  const pricing = getPricing(db.settings.model);
  const results: any[] = [];

  for (const scenario of scenarios) {
    const group = { groupId: 'shadow-ab', name: 'Shadow A/B 测试群' };
    const event = {
      type: 'group',
      groupId: 'shadow-ab',
      userId: 'shadow-current-user',
      nickname: '群友',
      text: scenario.player_text,
      atTargets: [],
    };
    const userPolicy = { policy: 'normal' };
    const history = scenario.context.map((c, i) => ({
      role: 'user' as const,
      content: c.text,
      createdAt: new Date(c.timestamp).toISOString(),
      nickname: '群友',
      userId: `shadow-u${i}`,
    }));

    // Build a fake db whose message history is the scenario context.
    const scenarioDb = { ...db, messages: history };
    const baselineMessages = buildPrompt(scenarioDb, group, event, userPolicy);

    const runChain = async (label: string, messages: any[]) => {
      const started = Date.now();
      const result = await completeChat(db, { messages, label });
      const usage = result.usage || {};
      const promptTokens = Number(usage.prompt_tokens || 0);
      const completionTokens = Number(usage.completion_tokens || 0);
      return {
        label,
        text: result.text,
        latencyMs: result.latencyMs ?? Date.now() - started,
        model: result.model,
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: Number(usage.total_tokens || 0),
        },
        costCny: calcCost(promptTokens, completionTokens, pricing),
      };
    };

    const baseline = await runChain('baseline', baselineMessages);

    const ragTextOnlyMessages = JSON.parse(JSON.stringify(baselineMessages));
    ragTextOnlyMessages[0].content += corpusBlock(scenario.retrieved.text_only.windows);
    const ragTextOnly = await runChain('rag_text_only', ragTextOnlyMessages);

    const ragCtxMessages = JSON.parse(JSON.stringify(baselineMessages));
    ragCtxMessages[0].content += corpusBlock(scenario.retrieved.text_plus_context.windows);
    const ragCtx = await runChain('rag_text_plus_context', ragCtxMessages);

    results.push({
      id: scenario.id,
      player_text: scenario.player_text,
      context: scenario.context,
      follow: scenario.follow,
      retrieved: {
        text_only: {
          query: scenario.retrieved.text_only.query,
          windows: scenario.retrieved.text_only.windows.map((w) => ({
            window_id: w.window_id,
            score: w.score,
          })),
        },
        text_plus_context: {
          query: scenario.retrieved.text_plus_context.query,
          windows: scenario.retrieved.text_plus_context.windows.map((w) => ({
            window_id: w.window_id,
            score: w.score,
          })),
        },
      },
      baseline,
      rag_text_only: ragTextOnly,
      rag_text_plus_context: ragCtx,
    });
    console.log(
      `[${scenario.id}] base ${baseline.latencyMs}ms / rag-text ${ragTextOnly.latencyMs}ms / rag-ctx ${ragCtx.latencyMs}ms`
    );
  }

  fs.mkdirSync(path.dirname(outputJsonPath), { recursive: true });
  fs.writeFileSync(outputJsonPath, JSON.stringify(results, null, 2), 'utf8');

  // Markdown report
  const lines: string[] = [
    '# Shadow A/B 对照报告（V2 社区语料）',
    '',
    `- 模型：${db.settings.model}`,
    `- 场景数：${results.length}`,
    `- 索引：24 条已批准 style_ready 窗口`,
    `- 三条链：baseline（无语料）、rag_text_only（只按玩家消息检索）、rag_text_plus_context（按消息+前文检索）`,
    `- 每场景输入与上下文完全相同，唯一差异是 system prompt 是否注入语料片段`,
    '',
  ];
  for (const r of results) {
    const contextText = r.context.map((c: { text: string }) => c.text).join(' / ');
    lines.push(
      `## ${r.id}：${r.player_text}`,
      '',
      '### 输入',
      '',
      `玩家：${r.player_text}`,
      '',
      `前文：${contextText}`,
      '',
      '### 离线检索',
      '',
      '只按玩家消息：',
      '',
      r.retrieved.text_only.windows.length
        ? r.retrieved.text_only.windows
            .map((w) => `- ${w.window_id}（score ${w.score}）`)
            .join('\n')
        : '（无）',
      '',
      '按消息+前文：',
      '',
      r.retrieved.text_plus_context.windows.length
        ? r.retrieved.text_plus_context.windows
            .map((w) => `- ${w.window_id}（score ${w.score}）`)
            .join('\n')
        : '（无）',
      '',
      '### 原群后续（参考）',
      '',
      r.follow ? `${r.follow.human ? '玩家' : 'Bot'}：${r.follow.text}` : '（无文字后续）',
      '',
      '### baseline（无语料）',
      '',
      `> ${r.baseline.text.replace(/\n/g, '\n> ')}`,
      '',
      `（${r.baseline.latencyMs}ms · ${r.baseline.usage.total_tokens} tokens · ¥${r.baseline.costCny.toFixed(4)}）`,
      '',
      '### RAG text_only（只按玩家消息检索）',
      '',
      `> ${r.rag_text_only.text.replace(/\n/g, '\n> ')}`,
      '',
      `（rag_text_only：${r.rag_text_only.latencyMs}ms · ${r.rag_text_only.usage.total_tokens} tokens · ¥${r.rag_text_only.costCny.toFixed(4)}）`,
      '',
      '### RAG text_plus_context（按消息+前文检索）',
      '',
      `> ${r.rag_text_plus_context.text.replace(/\n/g, '\n> ')}`,
      '',
      `（rag_text_plus_context：${r.rag_text_plus_context.latencyMs}ms · ${r.rag_text_plus_context.usage.total_tokens} tokens · ¥${r.rag_text_plus_context.costCny.toFixed(4)}）`,
      '',
      '---',
      '',
    );
  }
  fs.writeFileSync(outputMdPath, lines.join('\n'), 'utf8');
  console.log(`wrote -> ${outputJsonPath}`);
  console.log(`wrote -> ${outputMdPath}`);
}

run().catch((error) => {
  console.error('shadow A/B failed:', error);
  process.exitCode = 1;
});
