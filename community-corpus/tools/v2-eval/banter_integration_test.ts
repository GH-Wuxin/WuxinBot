// Sandbox test for the integrated banter bank (no manual injection).
// Runs through the real buildPrompt + completeChat path and checks guardrails.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDb } from '../../../server/store.js';
import { buildPrompt, getPricing, calcCost } from '../../../server/bot/prompt.js';
import { completeChat } from '../../../server/bot/llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const corpusRoot = path.resolve(__dirname, '..', '..');
const outputJsonPath = path.join(corpusRoot, 'reports', 'v2-eval', 'banter-integration-test.json');
const outputMdPath = path.join(corpusRoot, 'reports', 'v2-eval', 'banter-integration-test.md');

const SCENARIOS = [
  { text: '666', note: '极简数字反应' },
  { text: '我跪下了', note: '跪拜式感叹' },
  { text: '这也能活', note: '不可思议式吐槽' },
  { text: '难绷', note: '无语式评价' },
  { text: '？', note: '纯问号反应' },
  { text: '吓哭了', note: '夸张反应' },
  { text: '手速狗', note: '称呼式吐槽' },
  { text: '神了', note: '感叹' },
  { text: '气笑了', note: '情绪表达' },
  { text: '闹麻', note: '吐槽' },
  { text: '打串打不动了', note: 'osu 日常' },
  { text: '最近好摸鱼啊', note: '非 osu 日常' },
  { text: '6', note: '单字符数字' },
  { text: '草', note: '单字感叹' },
  { text: '乐', note: '单字评价' },
  { text: '神', note: '单字感叹' },
  { text: '绷', note: '单字缩写' },
  { text: '彳亍', note: '两字梗' },
  { text: '似了', note: '两字梗' },
  { text: '寄', note: '单字梗' },
  { text: '牛逼', note: '两字评价' },
  { text: '离谱', note: '两字评价' },
];

function guardrailFailures(text: string, input: string): string[] {
  const failures: string[] = [];
  const t = text.trim();
  // Occasional single-char / single-symbol replies are allowed (community
  // flavor). Only long verbatim echoes are treated as failures.
  if (input.trim().length >= 4 && t === input.trim()) failures.push('整句复读玩家消息');
  if (/（(?:凑近|小声|心想|歪头|笑|眨眼|尾巴|举手)[^）]*）/.test(text)) failures.push('出现括号动作描写');
  return failures;
}

function isShortReply(text: string): boolean {
  return text.trim().length <= 2;
}

async function run() {
  const db = readDb();
  const pricing = getPricing(db.settings.model);
  const group = { groupId: 'integration-test', name: '接入测试群' };
  const results: any[] = [];

  for (const scenario of SCENARIOS) {
    const event = {
      type: 'group',
      groupId: 'integration-test',
      userId: 'test-user',
      nickname: '群友',
      text: scenario.text,
      atTargets: [],
    };
    const messages = buildPrompt({ ...db, messages: [] }, group, event, { policy: 'normal' });
    const hasBank = messages[0].content.includes('【群聊高频反应】');
    const started = Date.now();
    const result = await completeChat(db, { messages, label: `banter-integration-${scenario.text}` });
    const usage = result.usage || {};
    const promptTokens = Number(usage.prompt_tokens || 0);
    const completionTokens = Number(usage.completion_tokens || 0);
    const text = result.text;
    const failures = guardrailFailures(text, scenario.text);
    results.push({
      ...scenario,
      hasBank,
      text,
      failures,
      latencyMs: result.latencyMs ?? Date.now() - started,
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: Number(usage.total_tokens || 0),
      },
      costCny: calcCost(promptTokens, completionTokens, pricing),
    });
    console.log(
      `[${scenario.text}] ${failures.length ? 'FAIL ' + failures.join(';') : 'PASS'} ${result.latencyMs ?? ''}ms -> ${text.slice(0, 40).replace(/\n/g, ' ')}`
    );
  }

  fs.mkdirSync(path.dirname(outputJsonPath), { recursive: true });
  fs.writeFileSync(outputJsonPath, JSON.stringify(results, null, 2), 'utf8');

  const passed = results.filter((r) => r.failures.length === 0).length;
  const shortCount = results.filter((r) => isShortReply(r.text)).length;
  const shortRatio = shortCount / results.length;
  const lines: string[] = [
    '# Banter 接入沙箱测试报告',
    '',
    `- 模型：${db.settings.model}`,
    `- 场景数：${results.length}，边界通过：${passed}/${results.length}`,
    `- 单字/单符号回复：${shortCount}/${results.length}（${(shortRatio * 100).toFixed(0)}%，允许少量）`,
    '- 链路：真实 buildPrompt（casual 自动注入短语库）→ completeChat',
    '',
  ];
  for (const r of results) {
    lines.push(
      `## ${r.text}（${r.note}）`,
      '',
      `短语库已注入：${r.hasBank}`,
      '',
      `> ${r.text.replace(/\n/g, '\n> ')}`,
      '',
      `边界检查：${r.failures.length ? 'FAIL — ' + r.failures.join('；') : 'PASS'}`,
      '',
      `（${r.latencyMs}ms · ${r.usage.total_tokens} tokens · ¥${r.costCny.toFixed(4)}）`,
      '',
      '---',
      '',
    );
  }
  fs.writeFileSync(outputMdPath, lines.join('\n'), 'utf8');
  console.log(`\n${passed}/${results.length} passed; short replies ${shortCount}/${results.length} -> ${outputMdPath}`);
  if (shortRatio > 0.3) {
    console.log(`WARN: short-reply ratio ${(shortRatio * 100).toFixed(0)}% exceeds 30%`);
  }
}

run().catch((error) => {
  console.error('integration test failed:', error);
  process.exitCode = 1;
});
