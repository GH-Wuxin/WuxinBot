/*
 * Pippi group-chat round report.
 *
 * Turns replay result files (and optionally a judge file) into the per-round
 * report the plan asks for: metrics, target verdicts, failure distribution and
 * the same-input samples a reviewer can read.  Kept as a tool rather than
 * ad-hoc shell so that round N and round N+1 are printed by identical code --
 * a hand-rolled comparison is where "it looks better" quietly becomes the
 * evidence.
 *
 * No pattern matching anywhere in this file, matching the rule the harness and
 * the judge follow.
 *
 * Usage:
 *   node --import tsx tools/pippi-groupchat-report.mjs --results <a.json> [--results <b.json>] \
 *     [--judge <judge.json>] [--label R0 --label R1] [--out report.md] [--samples 12]
 */

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = { results: [], judge: '', labels: [], out: '', samples: 12 };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--results') { args.results.push(argv[index + 1]); index += 1; continue; }
    if (token === '--label') { args.labels.push(argv[index + 1]); index += 1; continue; }
    if (token === '--judge') { args.judge = argv[index + 1]; index += 1; continue; }
    if (token === '--out') { args.out = argv[index + 1]; index += 1; continue; }
    if (token === '--samples') { args.samples = Number(argv[index + 1]); index += 1; continue; }
  }
  return args;
}

const args = parseArgs(process.argv);
if (!args.results.length) {
  console.log('usage: --results <a.json> [--results <b.json>] [--judge <judge.json>] [--label R0 --label R1] [--out report.md]');
  process.exit(1);
}

const rounds = args.results.map((file, index) => {
  const data = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  return {
    file,
    name: args.labels[index] || data.round || path.basename(file),
    data,
    summary: data.summary || {},
    provenance: data.provenance || {},
    results: data.results || [],
  };
});

const lines = [];
const push = (text = '') => lines.push(text);

push('# Pippi 群聊轮次报告');
push('');
push('生成时间：' + new Date().toISOString());
push('');
push('对比轮次：' + rounds.map((r) => r.name + '（' + path.basename(r.file) + '，mode=' + r.data.mode + '）').join('  vs  '));
push('');

push('## 溯源');
push('');
push('| 项 | ' + rounds.map((r) => r.name).join(' | ') + ' |');
push('|---|' + rounds.map(() => '---').join('|') + '|');
const provKeys = ['short', 'dirty', 'provider', 'model', 'codexModel', 'temperature', 'maxTokensSample', 'promptSnapshotSha'];
const provLabels = {
  short: 'commit', dirty: '工作区脏', provider: 'provider', model: 'model',
  codexModel: 'codexModel', temperature: 'temperature', maxTokensSample: 'maxTokens',
  promptSnapshotSha: 'prompt 快照哈希',
};
for (const key of provKeys) {
  push('| ' + provLabels[key] + ' | ' + rounds.map((r) => String(r.provenance[key] ?? '-')).join(' | ') + ' |');
}
push('');
if (rounds.length === 2) {
  const same = rounds[0].provenance.promptSnapshotSha === rounds[1].provenance.promptSnapshotSha;
  push('**prompt 快照' + (same ? '相同 —— 两轮的差异不可能来自提示词改动。**' : '不同 —— 提示词确实变了。**'));
  push('');
}

push('## 硬指标');
push('');
push('| 指标 | ' + rounds.map((r) => r.name).join(' | ') + ' |');
push('|---|' + rounds.map(() => '---').join('|') + '|');
const rows = [
  ['用例数', (s) => s.total],
  ['门控通过率', (s) => s.gatePassRate],
  ['硬约束通过率', (s) => s.hardPassRate],
  ['均分', (s) => s.meanScore],
  ['可见字中位', (s) => s.visibleLength?.median],
  ['可见字 P90', (s) => s.visibleLength?.p90],
  ['可见字最大', (s) => s.visibleLength?.max],
  ['单条消息率', (s) => s.oneMessageRate],
  ['模型错误率', (s) => s.modelErrorRate],
  ['均延迟 ms', (s) => s.meanLatencyMs],
  ['总 token', (s) => s.totalTokens],
];
for (const [label, pick] of rows) {
  push('| ' + label + ' | ' + rounds.map((r) => String(pick(r.summary) ?? '-')).join(' | ') + ' |');
}
push('');

push('## PLAN 软指标（仅普通闲聊）');
push('');
push('| 目标 | ' + rounds.map((r) => r.name).join(' | ') + ' |');
push('|---|' + rounds.map(() => '---').join('|') + '|');
const targetRows = [
  ['可见字中位 10-35', (t) => t?.median],
  ['可见字 P90 ≤70', (t) => t?.p90],
  ['单条消息率 ≥0.90', (t) => t?.oneMessageRate],
];
for (const [label, pick] of targetRows) {
  push('| ' + label + ' | ' + rounds.map((r) => {
    const value = pick(r.summary.casualTargets);
    if (!value) return '-';
    return value.value + (value.pass ? ' ✓' : ' ✗');
  }).join(' | ') + ' |');
}
push('');
push('样本量：' + rounds.map((r) => r.name + '=' + (r.summary.casualTargets?.sample ?? '-')).join('  '));
push('');

push('## 群聊 / 私聊');
push('');
for (const round of rounds) {
  push('**' + round.name + '**');
  push('');
  push('| 渠道 | 用例 | 门控 | 硬通过 | 中位字 | P90 | 单条率 |');
  push('|---|---|---|---|---|---|---|');
  for (const [channel, value] of Object.entries(round.summary.byChannel || {})) {
    push('| ' + channel + ' | ' + value.total + ' | ' + value.gatePassRate + ' | ' + value.passRate + ' | '
      + value.lengthMedian + ' | ' + value.lengthP90 + ' | ' + value.oneMessageRate + ' |');
  }
  push('');
}

push('## 失败与警告分布');
push('');
push('| 标签 | ' + rounds.map((r) => r.name).join(' | ') + ' |');
push('|---|' + rounds.map(() => '---').join('|') + '|');
const failKeys = new Set();
const warnKeys = new Set();
for (const round of rounds) {
  for (const key of Object.keys(round.summary.failures || {})) failKeys.add(key);
  for (const key of Object.keys(round.summary.warnings || {})) warnKeys.add(key);
}
for (const key of [...failKeys].sort()) {
  push('| 失败 ' + key + ' | ' + rounds.map((r) => String(r.summary.failures?.[key] ?? 0)).join(' | ') + ' |');
}
for (const key of [...warnKeys].sort()) {
  push('| 警告 ' + key + ' | ' + rounds.map((r) => String(r.summary.warnings?.[key] ?? 0)).join(' | ') + ' |');
}
push('');

push('## 跨变体口癖（同一场景内重复措辞）');
push('');
push('| 轮次 | 场景 | 措辞 | 命中变体 |');
push('|---|---|---|---|');
for (const round of rounds) {
  const tics = round.summary.tics || [];
  if (!tics.length) { push('| ' + round.name + ' | - | （无） | - |'); continue; }
  for (const tic of tics.slice(0, 12)) {
    push('| ' + round.name + ' | ' + tic.sourceId + ' | ' + tic.gram + ' | ' + tic.variants + '/' + tic.of + ' |');
  }
}
push('');

push('## 分类明细');
push('');
for (const round of rounds) {
  push('**' + round.name + '**');
  push('');
  push('| 分类 | 用例 | 硬通过 | 门控 | 中位字 | P90 | 单条率 |');
  push('|---|---|---|---|---|---|---|');
  for (const [category, value] of Object.entries(round.summary.byCategory || {})) {
    push('| ' + category + ' | ' + value.total + ' | ' + value.passRate + ' | ' + value.gatePassRate + ' | '
      + value.lengthMedian + ' | ' + value.lengthP90 + ' | ' + value.oneMessageRate + ' |');
  }
  push('');
}

if (args.judge) {
  const judge = JSON.parse(fs.readFileSync(path.resolve(args.judge), 'utf8'));
  const summary = judge.summary || {};
  push('## 盲评（' + (summary.judgeMode === 'single' ? '单评' : '双盲 A/B') + '）');
  push('');
  push('评判模型：' + (judge.provenance?.judgeModel ?? '-') + '　temperature：' + (judge.provenance?.temperature ?? '-'));
  push('');
  if (summary.judgeMode !== 'single') {
    push('| 项 | 值 |');
    push('|---|---|');
    push('| 已评 | ' + summary.judged + ' |');
    push('| 基线胜 | ' + summary.baselineWins + ' |');
    push('| 候选胜 | ' + summary.candidateWins + ' |');
    push('| 平局 | ' + summary.ties + ' |');
    push('| 候选胜率（不计平局，目标 ≥0.70） | ' + summary.candidateWinRate + (summary.candidateWinRate >= 0.7 ? ' ✓' : ' ✗') + ' |');
    push('| 平局率 | ' + summary.tieRate + ' |');
    push('');
  }
  push('| 维度 | 基线均值 | 候选均值 |');
  push('|---|---|---|');
  for (const key of ['naturalness', 'focus', 'consistency', 'sufficiency']) {
    push('| ' + key + ' | ' + (summary.axes?.baseline?.[key]?.mean ?? '-') + ' | ' + (summary.axes?.candidate?.[key]?.mean ?? '-') + ' |');
  }
  push('');
  const baselineLabels = summary.labels?.baseline || {};
  const candidateLabels = summary.labels?.candidate || {};
  const labelKeys = [...new Set([...Object.keys(baselineLabels), ...Object.keys(candidateLabels)])];
  if (labelKeys.length) {
    push('| 法官标签 | 基线 | 候选 |');
    push('|---|---|---|');
    for (const key of labelKeys.sort()) {
      push('| ' + key + ' | ' + (baselineLabels[key] || 0) + ' | ' + (candidateLabels[key] || 0) + ' |');
    }
    push('');
  }
}

if (rounds.length === 2) {
  push('## 同输入对照样本');
  push('');
  const byId = new Map(rounds[1].results.map((record) => [record.id, record]));
  let shown = 0;
  for (const base of rounds[0].results) {
    if (shown >= args.samples) break;
    const other = byId.get(base.id);
    if (!other) continue;
    push('### ' + base.id + '　[' + base.category + '/' + base.channel + ']');
    push('');
    if (base.context?.length) push('前文：' + base.context.map((line) => '- ' + line).join('　'));
    push('对方：' + base.input);
    push('');
    push('- **' + rounds[0].name + '**（' + base.evaluation?.visibleLength + '字 ' + (base.segments?.length || 0) + '泡）：' + base.finalText);
    push('- **' + rounds[1].name + '**（' + other.evaluation?.visibleLength + '字 ' + (other.segments?.length || 0) + '泡）：' + other.finalText);
    push('');
    shown += 1;
  }
  if (!shown) push('（两轮没有共同用例 id）');
  push('');
}

for (const round of rounds) {
  push('## ' + round.name + ' 最长样本（人工复核用）');
  push('');
  const sorted = [...round.results]
    .filter((record) => record.finalText && !record.error)
    .sort((a, b) => (b.evaluation?.visibleLength || 0) - (a.evaluation?.visibleLength || 0))
    .slice(0, args.samples);
  for (const record of sorted) {
    const failures = record.evaluation?.failures || [];
    const warnings = record.evaluation?.warnings || [];
    push('- ' + record.id + ' ' + (record.evaluation?.visibleLength || 0) + '字 '
      + (failures.length ? '失败' + JSON.stringify(failures) + ' ' : '')
      + (warnings.length ? '警告' + JSON.stringify(warnings) + ' ' : '')
      + '｜对方：' + String(record.input).slice(0, 30) + '｜回复：' + String(record.finalText).slice(0, 80));
  }
  push('');
}

const text = lines.join('\n');
if (args.out) {
  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, text, 'utf8');
  console.log('报告已写入 ' + outPath + '（' + text.split('\n').length + ' 行）');
} else {
  console.log(text);
}
