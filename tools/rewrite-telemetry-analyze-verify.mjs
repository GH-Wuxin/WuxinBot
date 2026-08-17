#!/usr/bin/env node
// WUXINBOT_REWRITE_TELEMETRY_ANALYZER_V01 verifier
// Synthetic telemetry tests. No network, no LLM, no production DB.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(condition, label) {
  if (condition) { console.log(`PASS ${label}`); }
  else { console.error(`FAIL ${label}`); failures++; }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function makeEvent(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    kind: 'rewrite-reply',
    eventType: 'group',
    eligible: true,
    invoked: false,
    skipReason: undefined,
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    usageAvailable: false,
    latencyMs: null,
    result: 'SKIPPED',
    originalChars: 50,
    rewrittenChars: 50,
    contentChanged: false,
    originalHash: 'a'.repeat(64),
    rewrittenHash: 'a'.repeat(64),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function writeTmpDb(events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewrite-telemetry-verify-'));
  process.env.DATA_DIR = dir;
  const dbPath = path.join(dir, 'db.json');
  fs.writeFileSync(dbPath, JSON.stringify({
    settings: {},
    groups: [],
    users: [],
    memories: [],
    groupProfiles: [],
    relationshipProfiles: [],
    pendingPairCounts: {},
    trustScores: {},
    messages: [],
    decisions: [],
    commandLogs: [],
    adminActions: [],
    usageEvents: events,
    usage: { totalTokens: 0, promptTokens: 0, completionTokens: 0, requests: 0, replies: 0, errors: 0 },
  }, null, 2), 'utf8');
  return dir;
}

function runAnalyzer(dir) {
  const outputDir = path.join(dir, 'output');
  // Run the analyzer as a subprocess to avoid module cache issues
  const result = spawnSync(process.execPath, [
    '--import', 'tsx',
    path.join(REPO_ROOT, 'tools', 'rewrite-telemetry-analyze.mjs'),
    '--output', outputDir,
  ], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATA_DIR: dir, NODE_ENV: 'test' },
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });

  if (result.status !== 0) {
    console.error('Analyzer stderr:', result.stderr);
    return null;
  }

  const jsonPath = path.join(outputDir, 'report.json');
  if (!fs.existsSync(jsonPath)) return null;
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ── Tests ─────────────────────────────────────────────────────────────────

async function testZeroRecords() {
  const dir = writeTmpDb([]);
  try {
    const report = runAnalyzer(dir);
    check(report !== null, 'zero: analyzer ran');
    check(report.status === 'NO_DATA', 'zero: status is NO_DATA');
    check(report.event_count === 0, 'zero: event_count is 0');
    check(report.data_quality.total_records_seen === 0, 'zero: no records seen');
    // JSON must be strict
    const jsonStr = JSON.stringify(report);
    check(!jsonStr.includes('NaN'), 'zero: no NaN in JSON');
    check(!jsonStr.includes('Infinity'), 'zero: no Infinity in JSON');
  } finally { cleanup(dir); }
}

async function testOneSkipped() {
  const dir = writeTmpDb([makeEvent({ eligible: false, invoked: false, result: 'SKIPPED', skipReason: 'long_form' })]);
  try {
    const report = runAnalyzer(dir);
    check(report.status === 'OK', 'skipped: status OK');
    check(report.analysis.counts.total_events === 1, 'skipped: 1 event');
    check(report.analysis.counts.eligible === 0, 'skipped: not eligible');
    check(report.analysis.counts.invoked === 0, 'skipped: not invoked');
    check(report.analysis.result_distribution.SKIPPED === 1, 'skipped: result is SKIPPED');
    check(report.analysis.skip_reasons.length === 1, 'skipped: 1 skip reason');
    check(report.analysis.skip_reasons[0].skip_reason === 'long_form', 'skipped: reason is long_form');
  } finally { cleanup(dir); }
}

async function testEligibleButNotInvoked() {
  const dir = writeTmpDb([makeEvent({ eligible: true, invoked: false, result: 'SKIPPED', skipReason: 'identity_question_deterministic' })]);
  try {
    const report = runAnalyzer(dir);
    check(report.analysis.counts.eligible === 1, 'eligible-not-invoked: eligible');
    check(report.analysis.counts.invoked === 0, 'eligible-not-invoked: not invoked');
    check(report.analysis.core_rates.eligibility_rate === 100, 'eligible-not-invoked: 100% eligibility');
    check(report.analysis.core_rates.invocation_rate_given_eligible === 0, 'eligible-not-invoked: 0% invocation given eligible');
  } finally { cleanup(dir); }
}

async function testInvokedUnchanged() {
  const dir = writeTmpDb([makeEvent({
    eligible: true, invoked: true, result: 'UNCHANGED',
    usageAvailable: true, inputTokens: 100, outputTokens: 30, cachedInputTokens: 50,
    latencyMs: 1200, originalChars: 50, rewrittenChars: 50,
  })]);
  try {
    const report = runAnalyzer(dir);
    check(report.analysis.result_distribution.UNCHANGED === 1, 'unchanged: count');
    check(report.analysis.core_rates.change_rate_given_invoked === 0, 'unchanged: 0% change rate');
    check(report.analysis.core_rates.unchanged_rate_given_invoked === 100, 'unchanged: 100% unchanged rate');
    check(report.analysis.usage.input_tokens.total === 100, 'unchanged: input tokens');
  } finally { cleanup(dir); }
}

async function testInvokedChanged() {
  const dir = writeTmpDb([makeEvent({
    eligible: true, invoked: true, result: 'CHANGED',
    usageAvailable: true, inputTokens: 120, outputTokens: 45, latencyMs: 800,
    originalChars: 60, rewrittenChars: 48, contentChanged: true,
  })]);
  try {
    const report = runAnalyzer(dir);
    check(report.analysis.result_distribution.CHANGED === 1, 'changed: count');
    check(report.analysis.core_rates.change_rate_given_invoked === 100, 'changed: 100% change rate');
    check(report.analysis.char_impact.delta_chars.mean === -12, 'changed: delta -12');
  } finally { cleanup(dir); }
}

async function testErrorFallback() {
  const dir = writeTmpDb([makeEvent({
    eligible: true, invoked: true, result: 'ERROR_FALLBACK',
    latencyMs: 5000, originalChars: 70, rewrittenChars: 70,
  })]);
  try {
    const report = runAnalyzer(dir);
    check(report.analysis.result_distribution.ERROR_FALLBACK === 1, 'error_fallback: count');
    check(report.analysis.core_rates.fallback_rate_given_invoked === 100, 'error_fallback: 100% fallback rate');
  } finally { cleanup(dir); }
}

async function testEmptyFallback() {
  const dir = writeTmpDb([makeEvent({ eligible: true, invoked: true, result: 'EMPTY_FALLBACK' })]);
  try {
    const report = runAnalyzer(dir);
    check(report.analysis.result_distribution.EMPTY_FALLBACK === 1, 'empty_fallback: count');
  } finally { cleanup(dir); }
}

async function testTimeoutFallback() {
  const dir = writeTmpDb([makeEvent({ eligible: true, invoked: true, result: 'TIMEOUT_FALLBACK', latencyMs: 30000 })]);
  try {
    const report = runAnalyzer(dir);
    check(report.analysis.result_distribution.TIMEOUT_FALLBACK === 1, 'timeout_fallback: count');
  } finally { cleanup(dir); }
}

async function testOtherFallback() {
  const dir = writeTmpDb([makeEvent({ eligible: true, invoked: true, result: 'OTHER_FALLBACK' })]);
  try {
    const report = runAnalyzer(dir);
    check(report.analysis.result_distribution.OTHER_FALLBACK === 1, 'other_fallback: count');
  } finally { cleanup(dir); }
}

async function testUnknownResult() {
  const dir = writeTmpDb([makeEvent({ eligible: true, invoked: true, result: 'WEIRD_NEW_RESULT' })]);
  try {
    const report = runAnalyzer(dir);
    check(report.analysis.result_distribution.UNKNOWN_RESULT === 1, 'unknown: counted as UNKNOWN_RESULT');
    check(report.data_quality.unknown_result_records === 1, 'unknown: data quality flag');
  } finally { cleanup(dir); }
}

async function testUsageAvailable() {
  const dir = writeTmpDb([makeEvent({
    eligible: true, invoked: true, result: 'CHANGED',
    usageAvailable: true, inputTokens: 200, outputTokens: 60, cachedInputTokens: 100,
  })]);
  try {
    const report = runAnalyzer(dir);
    check(report.analysis.usage.usage_available_count === 1, 'usage: available count');
    check(report.analysis.usage.input_tokens.total === 200, 'usage: input total');
    check(report.analysis.usage.output_tokens.total === 60, 'usage: output total');
    check(report.analysis.usage.cached_input_tokens.total === 100, 'usage: cached total');
    check(report.analysis.total_known_tokens === 260, 'usage: total known tokens (input+output)');
  } finally { cleanup(dir); }
}

async function testUsageUnavailable() {
  const dir = writeTmpDb([makeEvent({
    eligible: true, invoked: true, result: 'UNCHANGED',
    usageAvailable: false, inputTokens: null, outputTokens: null,
  })]);
  try {
    const report = runAnalyzer(dir);
    check(report.analysis.usage.usage_available_count === 0, 'no_usage: available count 0');
    check(report.analysis.usage.usage_missing_count === 1, 'no_usage: missing count 1');
  } finally { cleanup(dir); }
}

async function testZeroDenominator() {
  // No invoked events -> rates should be null
  const dir = writeTmpDb([makeEvent({ eligible: false, invoked: false, result: 'SKIPPED' })]);
  try {
    const report = runAnalyzer(dir);
    check(report.analysis.core_rates.change_rate_given_invoked === null, 'zero_denom: null rate');
    check(report.analysis.core_rates.fallback_rate_given_invoked === null, 'zero_denom: null fallback rate');
  } finally { cleanup(dir); }
}

async function testLatencyPercentiles() {
  const events = [];
  for (let i = 1; i <= 20; i++) {
    events.push(makeEvent({ eligible: true, invoked: true, result: 'CHANGED', latencyMs: i * 100 }));
  }
  const dir = writeTmpDb(events);
  try {
    const report = runAnalyzer(dir);
    const lat = report.analysis.latency.all_invoked;
    check(lat.count === 20, 'latency: 20 events');
    check(lat.p50 === 1050, `latency: p50=1050 got ${lat.p50}`);
    check(lat.p95 === 1905, `latency: p95=1905 got ${lat.p95}`);
    check(lat.max === 2000, 'latency: max=2000');
  } finally { cleanup(dir); }
}

async function testTokenPercentiles() {
  const events = [];
  for (let i = 1; i <= 10; i++) {
    events.push(makeEvent({ eligible: true, invoked: true, result: 'CHANGED', usageAvailable: true, inputTokens: i * 50, outputTokens: i * 10 }));
  }
  const dir = writeTmpDb(events);
  try {
    const report = runAnalyzer(dir);
    const inp = report.analysis.usage.input_tokens;
    check(inp.count === 10, 'token_pct: 10 events');
    check(inp.total === 2750, `token_pct: input total=2750 got ${inp.total}`);
    check(inp.p50 === 275, `token_pct: input p50=275 got ${inp.p50}`);
  } finally { cleanup(dir); }
}

async function testCharsDelta() {
  const dir = writeTmpDb([
    makeEvent({ eligible: true, invoked: true, result: 'CHANGED', originalChars: 100, rewrittenChars: 80 }),
    makeEvent({ eligible: true, invoked: true, result: 'CHANGED', originalChars: 50, rewrittenChars: 60 }),
    makeEvent({ eligible: true, invoked: true, result: 'UNCHANGED', originalChars: 40, rewrittenChars: 40 }),
  ]);
  try {
    const report = runAnalyzer(dir);
    const ci = report.analysis.char_impact;
    check(ci.total_with_char_data === 3, 'chars: 3 events');
    check(ci.delta_chars.mean === round((-20 + 10 + 0) / 3), `chars: mean delta got ${ci.delta_chars.mean}`);
    check(ci.expansion_rate === round(100 / 3), `chars: expansion rate got ${ci.expansion_rate}`);
    check(ci.shrink_rate === round(100 / 3), `chars: shrink rate got ${ci.shrink_rate}`);
    check(ci.same_length_rate === round(100 / 3), `chars: same length rate got ${ci.same_length_rate}`);
  } finally { cleanup(dir); }
}

async function testMultipleProviders() {
  const dir = writeTmpDb([
    makeEvent({ eligible: true, invoked: true, result: 'CHANGED', provider: 'deepseek', model: 'deepseek-v4-flash' }),
    makeEvent({ eligible: true, invoked: true, result: 'UNCHANGED', provider: 'openai', model: 'gpt-4o' }),
    makeEvent({ eligible: true, invoked: true, result: 'CHANGED', provider: 'deepseek', model: 'deepseek-v4-flash' }),
  ]);
  try {
    const report = runAnalyzer(dir);
    const pb = report.analysis.provider_breakdown;
    check(pb.length === 2, 'providers: 2 providers');
    const ds = pb.find((p) => p.provider === 'deepseek');
    const oai = pb.find((p) => p.provider === 'openai');
    check(ds && ds.events === 2, 'providers: deepseek has 2 events');
    check(ds && ds.changed === 2, 'providers: deepseek 2 changed');
    check(oai && oai.events === 1, 'providers: openai has 1 event');
  } finally { cleanup(dir); }
}

async function testMalformedRecord() {
  // Mix valid and malformed events
  const events = [
    makeEvent({ eligible: true, invoked: true, result: 'CHANGED' }),
    null, // malformed
    { kind: 'rewrite-reply' }, // missing result -> malformed
    { result: 'CHANGED' }, // missing kind -> malformed
  ];
  const dir = writeTmpDb(events);
  try {
    const report = runAnalyzer(dir);
    check(report.data_quality.malformed_records === 1, 'malformed: 1 malformed (missing result)');
    check(report.data_quality.valid_records === 1, 'malformed: 1 valid');
    check(report.event_count === 2, 'malformed: all kind-matched events counted (valid + malformed)');
  } finally { cleanup(dir); }
}

async function testNegativeTokenHandled() {
  const dir = writeTmpDb([makeEvent({
    eligible: true, invoked: true, result: 'CHANGED',
    usageAvailable: true, inputTokens: -50, outputTokens: -10,
  })]);
  try {
    const report = runAnalyzer(dir);
    check(report.data_quality.invalid_negative_tokens === 2, 'neg_token: 2 invalid values');
    // Tokens should be excluded from stats
    check(report.analysis.usage.input_tokens.count === 0, 'neg_token: excluded from input stats');
  } finally { cleanup(dir); }
}

async function testNegativeLatencyHandled() {
  const dir = writeTmpDb([makeEvent({
    eligible: true, invoked: true, result: 'CHANGED', latencyMs: -100,
  })]);
  try {
    const report = runAnalyzer(dir);
    check(report.data_quality.invalid_negative_latency === 1, 'neg_latency: flagged');
    check(report.analysis.latency.all_invoked.count === 0, 'neg_latency: excluded from stats');
  } finally { cleanup(dir); }
}

async function testMissingCreatedAt() {
  const dir = writeTmpDb([makeEvent({ eligible: true, invoked: true, result: 'CHANGED', createdAt: undefined })]);
  try {
    const report = runAnalyzer(dir);
    check(report.data_quality.missing_created_at === 1, 'missing_created: flagged');
    // Event should still be counted (not filtered out)
    check(report.event_count === 1, 'missing_created: still counted');
  } finally { cleanup(dir); }
}

async function testTimeFilter() {
  const now = Date.now();
  const events = [
    makeEvent({ eligible: true, invoked: true, result: 'CHANGED', createdAt: new Date(now - 2 * 86400000).toISOString() }),
    makeEvent({ eligible: true, invoked: true, result: 'UNCHANGED', createdAt: new Date(now - 1 * 3600000).toISOString() }),
  ];
  const dir = writeTmpDb(events);
  try {
    // Run with --since 24h
    const outputDir = path.join(dir, 'output');
    const result = spawnSync(process.execPath, [
      '--import', 'tsx',
      path.join(REPO_ROOT, 'tools', 'rewrite-telemetry-analyze.mjs'),
      '--since', '24h',
      '--output', outputDir,
    ], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATA_DIR: dir, NODE_ENV: 'test' },
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    check(result.status === 0, 'time_filter: exit 0');
    const report = JSON.parse(fs.readFileSync(path.join(outputDir, 'report.json'), 'utf8'));
    check(report.event_count === 1, 'time_filter: only recent event');
    check(report.analysis.result_distribution.UNCHANGED === 1, 'time_filter: UNCHANGED in window');
  } finally { cleanup(dir); }
}

async function testStrictJson() {
  const dir = writeTmpDb([makeEvent({ eligible: true, invoked: true, result: 'CHANGED' })]);
  try {
    const report = runAnalyzer(dir);
    const jsonStr = JSON.stringify(report);
    check(!jsonStr.includes('NaN'), 'strict_json: no NaN');
    check(!jsonStr.includes('undefined'), 'strict_json: no undefined');
    check(!jsonStr.includes('Infinity'), 'strict_json: no Infinity');
    // Must be parseable
    const parsed = JSON.parse(jsonStr);
    check(parsed.status === 'OK', 'strict_json: roundtrip OK');
  } finally { cleanup(dir); }
}

async function testDeterministic() {
  const events = [
    makeEvent({ eligible: true, invoked: true, result: 'CHANGED', latencyMs: 500 }),
    makeEvent({ eligible: false, invoked: false, result: 'SKIPPED', skipReason: 'long_form' }),
  ];
  const dir1 = writeTmpDb(events.map((e) => ({ ...e })));
  const dir2 = writeTmpDb(events.map((e) => ({ ...e })));
  try {
    const r1 = runAnalyzer(dir1);
    const r2 = runAnalyzer(dir2);
    // Ignore generated_at and paths
    const normalize = (r) => JSON.stringify({ ...r, generated_at: 'X', window: { ...r.window } });
    check(normalize(r1) === normalize(r2), 'deterministic: same input -> same output');
  } finally { cleanup(dir1); cleanup(dir2); }
}

async function testMissingCreatedAtNoWindow() {
  // No time filter: missing createdAt should be included in metrics
  const now = Date.now();
  const events = [
    makeEvent({ eligible: true, invoked: true, result: 'CHANGED', createdAt: new Date(now - 1000).toISOString() }),
    makeEvent({ eligible: true, invoked: true, result: 'UNCHANGED', createdAt: undefined }), // missing
    makeEvent({ eligible: true, invoked: true, result: 'CHANGED', createdAt: 'not-a-date' }), // invalid
  ];
  const dir = writeTmpDb(events);
  try {
    const report = runAnalyzer(dir);
    check(report.event_count === 3, 'missing_created_no_window: all 3 events in metrics');
    check(report.data_quality.missing_created_at === 1, 'missing_created_no_window: 1 missing in dq');
    check(report.analysis.result_distribution.CHANGED === 2, 'missing_created_no_window: 2 CHANGED');
  } finally { cleanup(dir); }
}

async function testMissingCreatedAtWithWindow() {
  // With --since 1h: missing/invalid createdAt must NOT enter window metrics
  const now = Date.now();
  const events = [
    makeEvent({ eligible: true, invoked: true, result: 'CHANGED', createdAt: new Date(now - 1000).toISOString() }),
    makeEvent({ eligible: true, invoked: true, result: 'UNCHANGED', createdAt: undefined }), // missing
    makeEvent({ eligible: true, invoked: true, result: 'CHANGED', createdAt: 'not-a-date' }), // invalid
  ];
  const dir = writeTmpDb(events);
  try {
    const outputDir = path.join(dir, 'output');
    const result = spawnSync(process.execPath, [
      '--import', 'tsx',
      path.join(REPO_ROOT, 'tools', 'rewrite-telemetry-analyze.mjs'),
      '--since', '1h',
      '--output', outputDir,
    ], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATA_DIR: dir, NODE_ENV: 'test' },
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    check(result.status === 0, 'missing_created_with_window: exit 0');
    const report = JSON.parse(fs.readFileSync(path.join(outputDir, 'report.json'), 'utf8'));
    check(report.event_count === 1, 'missing_created_with_window: only 1 event with valid createdAt in window');
    check(report.analysis.result_distribution.CHANGED === 1, 'missing_created_with_window: 1 CHANGED in metrics');
    // Data quality must still cover ALL 3 records
    check(report.data_quality.total_records_seen === 3, 'missing_created_with_window: dq sees all 3');
    check(report.data_quality.missing_created_at === 1, 'missing_created_with_window: dq flags 1 missing');
  } finally { cleanup(dir); }
}

function round(v) { return Math.round(v * 100) / 100; }

// ── Run ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Rewrite Telemetry Analyzer Verifier ===\n');

  await testZeroRecords();
  await testOneSkipped();
  await testEligibleButNotInvoked();
  await testInvokedUnchanged();
  await testInvokedChanged();
  await testErrorFallback();
  await testEmptyFallback();
  await testTimeoutFallback();
  await testOtherFallback();
  await testUnknownResult();
  await testUsageAvailable();
  await testUsageUnavailable();
  await testZeroDenominator();
  await testLatencyPercentiles();
  await testTokenPercentiles();
  await testCharsDelta();
  await testMultipleProviders();
  await testMalformedRecord();
  await testNegativeTokenHandled();
  await testNegativeLatencyHandled();
  await testMissingCreatedAt();
  await testTimeFilter();
  await testStrictJson();
  await testDeterministic();
  await testMissingCreatedAtNoWindow();
  await testMissingCreatedAtWithWindow();

  console.log(`\n=== ${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`} ===`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => { console.error('Verifier crashed:', error); process.exit(1); });
