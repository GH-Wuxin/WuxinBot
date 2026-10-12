/*
 * Human review sheet for Pippi group-chat samples.
 *
 * The replay and judge tools produce machine numbers.  This produces the thing
 * a person actually reads: one block per scenario, showing what came in, what
 * she answered, and what the harness thought of it -- so the owner can overrule
 * the machine instead of trusting it.
 *
 * The seed's own examples are shown in a clearly marked reference block.  They
 * are style references, not answers: the seed note says so, and a reviewer who
 * treats them as the target would reward imitation over judgement.
 *
 * No pattern matching in this file.
 *
 * Usage:
 *   node --import tsx tools/pippi-groupchat-review-sheet.mjs --results <r.json> \
 *     [--seed <seed.jsonl>] [--out sheet.md] [--order category|scenario|length]
 */

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = { results: '', seed: '', out: '', order: 'category', onlyFailures: false };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--only-failures') { args.onlyFailures = true; continue; }
    if (token === '--results') { args.results = argv[index + 1]; index += 1; continue; }
    if (token === '--seed') { args.seed = argv[index + 1]; index += 1; continue; }
    if (token === '--out') { args.out = argv[index + 1]; index += 1; continue; }
    if (token === '--order') { args.order = argv[index + 1]; index += 1; continue; }
  }
  return args;
}

const args = parseArgs(process.argv);
if (!args.results) {
  console.log('usage: --results <r.json> [--seed <seed.jsonl>] [--out sheet.md] [--order category|scenario|length] [--only-failures]');
  process.exit(1);
}

// Load the seed as a lookup of style references, keyed by scenario id.
const seedById = new Map();
if (args.seed && fs.existsSync(args.seed)) {
  for (const line of fs.readFileSync(args.seed, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row.id) seedById.set(String(row.id), row);
    } catch { /* a malformed seed line must not hide the rest of the sheet */ }
  }
}

const data = JSON.parse(fs.readFileSync(path.resolve(args.results), 'utf8'));
// A case where she correctly stayed silent has no text at all.  Dropping it
// removed the one sample that proves the gate works, so a recorded decision
// counts as reviewable even when nothing was sent.
let records = (data.results || []).filter((record) => (
  record.finalText || record.error || record.decision?.shouldReply === false
));
if (args.onlyFailures) {
  records = records.filter((record) => (record.evaluation?.failures || []).length > 0);
}

const orderValue = (record) => {
  if (args.order === 'scenario') return record.sourceId;
  if (args.order === 'length') return String(100000 - (record.evaluation?.visibleLength || 0)).padStart(6, '0');
  return String(record.category) + '|' + String(record.sourceId);
};
records = [...records].sort((a, b) => orderValue(a).localeCompare(orderValue(b)));

const lines = [];
const push = (text = '') => lines.push(text);

push('# Pippi 群聊样本 · 人工审查表');
push('');
push('来源：' + path.basename(args.results) + '　轮次：' + (data.round ?? '-') + '　模式：' + (data.mode ?? '-')
  + '　用例：' + records.length + '/' + (data.results || []).length);
push('');
push('生成模型：' + (data.provenance?.codexModel ?? '-') + '　temperature：' + (data.provenance?.temperature ?? '-')
  + '　prompt 快照：' + String(data.provenance?.promptSnapshotSha ?? '-').slice(0, 16));
push('');
push('读法：**只看「对方说」和「皮皮」两行就够**。下面的机器判定仅供参考，你可以直接推翻它。');
push('');

let lastCategory = '';
for (const record of records) {
  if (args.order === 'category' && record.category !== lastCategory) {
    push('## ' + record.category);
    push('');
    lastCategory = record.category;
  }
  const failures = record.evaluation?.failures || [];
  const warnings = record.evaluation?.warnings || [];
  const verdict = [];
  if (failures.length) verdict.push('**失败** ' + failures.join(', '));
  if (warnings.length) verdict.push('警告 ' + warnings.join(', '));
  if (record.error) verdict.push('**模型错误** ' + String(record.error).slice(0, 60));
  if (record.evaluation?.rescoreDropped?.length) verdict.push('已撤销误报：' + record.evaluation.rescoreDropped.join(', '));

  push('### ' + record.sourceId + '　' + record.category + '　' + record.channel
    + '　期望：' + record.replyExpectation + (verdict.length ? '　—　' + verdict.join('；') : ''));
  push('');
  if (record.context?.length) {
    push('前文：');
    for (const line of record.context) push('- ' + line);
    push('');
  }
  push('对方说：**' + record.input + '**');
  push('');
  if (record.decision?.shouldReply === false) {
    push('皮皮：*（选择不回复）*');
  } else if (record.error) {
    push('皮皮：*（调用失败，无输出）*');
  } else {
    push('皮皮：**' + String(record.finalText || '（空）') + '**');
  }
  push('');
  const meta = [];
  meta.push('可见 ' + (record.evaluation?.visibleLength ?? 0) + ' 字');
  meta.push((record.segments?.length ?? 0) + ' 条消息');
  if (record.rewritten) meta.push('触发了二次改写');
  if (record.isWeird) meta.push('被判为异常回复');
  if ((record.providerAttempts || 0) > 1) meta.push('重试 ' + record.providerAttempts + ' 次');
  meta.push(Math.round((record.latencyMs || 0) / 1000) + 's');
  push('　' + meta.join('　·　'));
  push('');

  const seed = seedById.get(record.sourceId);
  if (seed) {
    push('<details><summary>种子参考（仅风格参照，不是标准答案）</summary>');
    push('');
    if (seed.acceptable_examples?.length) {
      push('可接受示例：');
      for (const example of seed.acceptable_examples) push('- ' + example);
      push('');
    }
    if (seed.bad_examples?.length) {
      push('典型错误写法：');
      for (const example of seed.bad_examples) push('- ' + example);
      push('');
    }
    if (seed.note) {
      push('注：' + seed.note);
      push('');
    }
    push('</details>');
    push('');
  }
}

const text = lines.join('\n');
if (args.out) {
  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, text, 'utf8');
  console.log('审查表已写入 ' + outPath + '（' + records.length + ' 个场景，' + text.split('\n').length + ' 行）');
} else {
  console.log(text);
}
