// Banter A/B: does injecting the high-frequency reaction bank make pippi's
// replies to low-nutrition messages more natural?

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDb } from '../../../server/store.js';
import { buildPrompt, getPricing, calcCost } from '../../../server/bot/prompt.js';
import { completeChat } from '../../../server/bot/llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const corpusRoot = path.resolve(__dirname, '..', '..');
const outputJsonPath = path.join(corpusRoot, 'reports', 'v2-eval', 'banter-ab-results.json');
const outputMdPath = path.join(corpusRoot, 'reports', 'v2-eval', 'banter-ab-report.md');

const SCENARIOS = [
  { text: '666', note: '极简数字反应' },
  { text: '我跪下了', note: '跪拜式感叹' },
  { text: '这也能活', note: '不可思议式吐槽' },
  { text: '难绷', note: '无语式评价' },
  { text: '？', note: '纯问号反应' },
];

// Compact top-of-list from banter-bank.json (kept ordered by frequency).
const BANTER_PHRASES = [
  '666', '6', '66', '6666', '吓哭了', '何意味', '唉', 'ok', '我草', '还真是', '草',
  '好', '这么强', '不知道', '哈哈', '不赖', '无敌了', '难绷', '神了', '可以', '看看',
  '教我', '气笑了', '真的假的', '打什么图', '卧槽', '我服了', '好厉害', '干嘛',
  '打断施法！', '没绷住', '没事', '哇', '可惜', '我跪下了', '跳图', '嘻嘻', '什么意思',
  '好玩', '打串', '好吧', '真的吗', '开挂', '手速狗', '我去不早说', '我看看', '对啊',
  '并非', '气死我了', '到底有多强', '崩溃', '无敌', '这啥', '我也是', '啊？', '好难',
  '笑死我了', '那没事了', '别急', '爆了', '逆天', '高手', '你好厉害', '神图', '一般',
  '是这样的', '你完了', '为什么', '什么图', '开挂了', '真假', '不好玩', '啥意思',
  '原来如此', '拉我', '蛙趣', '厉害', '大神', '差不多', '我不知道', '还行', '怎么了',
  '爽', '看不懂', '串图', '不打了', '不是哥们', '不错', '服了', '哦牛逼', '哈人',
  '这倒是提醒我了', '懂你意思', '我真服了', '闹麻', '有点意思', '没了', '不是我',
  '可爱', '太难了', '是你', '羡慕', '哭了', '坏了', '我擦', '这谁', '什么情况',
  '牛魔', '上号', '人呢', '似了', '加油', '可惜了', '好强', '打不动', '笑死',
  '还有人类吗', '什么东西', '太强了', '神秘', '闹麻了', '带我', '打不过',
  '这么牛逼', '呃呃', '害怕', '试试', '难说',
];

function banterBlock(): string {
  return [
    '',
    '【群聊高频反应】',
    '以下是真实 osu! 玩家群里高频出现的短反应（已脱敏，按出现频率排序）。它们不是模板，只是社区语感：接梗、感叹、吐槽时可以自然地用这种长度的句子，不需要每次都把话说满。',
    '边界：不要只回一个词或一个符号（如单独回“？”），不要原样复读玩家的话；短句至少带一点自己的态度、评价或追问。',
    BANTER_PHRASES.join('、'),
  ].join('\n');
}

async function run() {
  const db = readDb();
  const pricing = getPricing(db.settings.model);
  const results: any[] = [];

  for (const scenario of SCENARIOS) {
    const group = { groupId: 'banter-ab', name: 'Banter A/B 测试群' };
    const event = {
      type: 'group',
      groupId: 'banter-ab',
      userId: 'banter-current-user',
      nickname: '群友',
      text: scenario.text,
      atTargets: [],
    };
    const baselineMessages = buildPrompt({ ...db, messages: [] }, group, event, { policy: 'normal' });
    const ragMessages = JSON.parse(JSON.stringify(baselineMessages));
    ragMessages[0].content += banterBlock();

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
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: Number(usage.total_tokens || 0),
        },
        costCny: calcCost(promptTokens, completionTokens, pricing),
      };
    };

    const baseline = await runChain('baseline', baselineMessages);
    const rag = await runChain('banter', ragMessages);
    results.push({ ...scenario, baseline, banter: rag });
    console.log(`[${scenario.text}] base ${baseline.latencyMs}ms / banter ${rag.latencyMs}ms`);
  }

  fs.mkdirSync(path.dirname(outputJsonPath), { recursive: true });
  fs.writeFileSync(outputJsonPath, JSON.stringify(results, null, 2), 'utf8');

  const lines: string[] = [
    '# Banter A/B 报告（高频反应短语库）',
    '',
    `- 模型：${db.settings.model}`,
    `- 场景数：${results.length}`,
    `- 短语库规模：${BANTER_PHRASES.length} 条（频率降序）`,
    '- baseline = 现有 persona 无语料；banter = 注入群聊高频反应块',
    '',
  ];
  for (const r of results) {
    lines.push(
      `## ${r.text}（${r.note}）`,
      '',
      '### baseline（无语料）',
      '',
      `> ${r.baseline.text.replace(/\n/g, '\n> ')}`,
      '',
      `（${r.baseline.latencyMs}ms · ${r.baseline.usage.total_tokens} tokens · ¥${r.baseline.costCny.toFixed(4)}）`,
      '',
      '### banter（带高频反应库）',
      '',
      `> ${r.banter.text.replace(/\n/g, '\n> ')}`,
      '',
      `（${r.banter.latencyMs}ms · ${r.banter.usage.total_tokens} tokens · ¥${r.banter.costCny.toFixed(4)}）`,
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
  console.error('banter A/B failed:', error);
  process.exitCode = 1;
});
