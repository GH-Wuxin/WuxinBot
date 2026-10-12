/*
 * Re-score a stored replay result under a corrected rule set.
 *
 * Why: the replay harness originally checked `requiredFacts` by looking for the
 * literal text inside the reply.  Those fields are semantic criteria, not
 * strings -- "保留pippi身份", "不能把别人的成绩归给当前发言者" -- so every one of
 * them was reported missing and R0 was already running when that was found.
 * The reply texts in a result file are the expensive, non-reproducible part;
 * the scoring is not.  Discarding a finished run to fix a scorer would throw
 * away an hour of real model output for nothing.
 *
 * This rewrites only the scoring fields.  `finalText`, `rawText`, `decision`,
 * `segments`, `usage` and every other observation are copied through
 * untouched, and the change is recorded in `provenance.rescore` so a reader can
 * always tell a re-scored file from a freshly measured one.
 *
 * No pattern matching in this file.
 *
 * Usage:
 *   node --import tsx tools/pippi-groupchat-rescore.mjs --results <in.json> \
 *     --drop-failure missing_fact [--drop-failure other] --out <out.json>
 */

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = { results: '', out: '', drop: [], reason: '', onlySources: null };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--results') { args.results = argv[index + 1]; index += 1; continue; }
    if (token === '--out') { args.out = argv[index + 1]; index += 1; continue; }
    if (token === '--drop-failure') { args.drop.push(argv[index + 1]); index += 1; continue; }
    if (token === '--reason') { args.reason = argv[index + 1]; index += 1; continue; }
    if (token === '--only-sources') {
      args.onlySources = new Set(String(argv[index + 1]).split(',').map((v) => v.trim()).filter(Boolean));
      index += 1; continue;
    }
  }
  return args;
}

const args = parseArgs(process.argv);
if (!args.results || !args.out || (!args.drop.length && !args.onlySources)) {
  console.log('usage: --results <in.json> [--drop-failure <label>]... [--only-sources a,b] --out <out.json> [--reason text]');
  process.exit(1);
}

const dropped = new Set(args.drop);
const data = JSON.parse(fs.readFileSync(path.resolve(args.results), 'utf8'));
const originalFailures = { ...(data.summary?.failures || {}) };

// Cropping to a scenario subset exists so a full-suite baseline can be compared
// against a short experiment arm on exactly the same cases.  Comparing a
// 270-case average with a 60-case average would be measuring the case mix.
const sourceRecords = (data.results || []).filter((record) => (
  !args.onlySources || args.onlySources.has(String(record.sourceId))
));

let changed = 0;
const records = sourceRecords.map((record) => {
  const evaluation = record.evaluation;
  if (!evaluation) return record;
  const kept = (evaluation.failures || []).filter((label) => !dropped.has(label));
  const removed = (evaluation.failures || []).filter((label) => dropped.has(label));
  if (!removed.length) return record;
  changed += 1;
  const warnings = evaluation.warnings || [];
  return {
    ...record,
    evaluation: {
      ...evaluation,
      failures: kept,
      pass: kept.length === 0,
      // Same penalty formula the harness uses, so a re-scored file stays
      // comparable with a freshly measured one.
      score: Math.max(0, 100 - kept.length * 30 - warnings.length * 6),
      rescoreDropped: removed,
    },
  };
});

// Rebuild the aggregates that a failure label feeds into.
const failureCounts = {};
const warningCounts = {};
let hardPass = 0;
let gatePass = 0;
const scores = [];
const categoryStats = {};
const channelStats = {};
for (const record of records) {
  const evaluation = record.evaluation;
  if (!evaluation) continue;
  for (const label of evaluation.failures || []) failureCounts[label] = (failureCounts[label] || 0) + 1;
  for (const label of evaluation.warnings || []) warningCounts[label] = (warningCounts[label] || 0) + 1;
  if (!(evaluation.failures || []).includes('wrong_gate')) gatePass += 1;
  if (evaluation.pass) hardPass += 1;
  scores.push(evaluation.score);
  for (const [bucket, key] of [[categoryStats, record.category], [channelStats, record.channel]]) {
    const entry = bucket[key] || { total: 0, pass: 0 };
    entry.total += 1;
    if (evaluation.pass) entry.pass += 1;
    bucket[key] = entry;
  }
}

const total = records.filter((record) => record.evaluation).length;
const errors = records.filter((record) => record.error).length;
const summary = { ...(data.summary || {}) };
summary.failures = failureCounts;
summary.warnings = warningCounts;
summary.hardPassRate = total ? Number((hardPass / total).toFixed(4)) : 0;
summary.gatePassRate = total ? Number((gatePass / total).toFixed(4)) : 0;
summary.qualityPassRate = total > errors ? Number((hardPass / (total - errors)).toFixed(4)) : 0;
summary.meanScore = scores.length ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)) : 0;
for (const [bucket, key] of [[categoryStats, 'byCategory'], [channelStats, 'byChannel']]) {
  const target = summary[key] || {};
  for (const [name, entry] of Object.entries(bucket)) {
    if (target[name]) {
      target[name] = { ...target[name], passRate: entry.total ? Number((entry.pass / entry.total).toFixed(4)) : 0 };
    }
  }
  summary[key] = target;
}

const output = {
  ...data,
  provenance: {
    ...(data.provenance || {}),
    rescore: {
      rescoredAt: new Date().toISOString(),
      sourceFile: path.basename(args.results),
      keptSources: args.onlySources ? [...args.onlySources] : null,
      recordsBefore: (data.results || []).length,
      droppedFailures: args.drop,
      recordsAffected: changed,
      failuresBefore: originalFailures,
      reason: args.reason || 'scorer corrected after the run finished',
    },
  },
  summary,
  results: records,
};

const outPath = path.resolve(args.out);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
console.log('复评完成：影响 ' + changed + ' 条，硬通过率 ' + (data.summary?.hardPassRate ?? '?') + ' -> ' + summary.hardPassRate);
console.log('写入 ' + outPath);
