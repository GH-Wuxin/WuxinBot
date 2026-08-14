// query-osu-policy-verify.mjs — security whitelist regression for query_osu.
// Verifies validateOperation allows query_osu as a readonly op while keeping
// query_external_bot closed. Exit 0 on all pass, non-zero on any failure.

import {
  validateOperation,
  looksLikeToolCallMarkup,
  stripToolCallMarkup,
  parseToolCallMarkup,
} from '../server/bots/guard.ts';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function pass(label) {
  console.log(`PASS [${label}]`);
  passed++;
}

function fail(label, msg) {
  console.error(`FAIL [${label}]: ${msg}`);
  failed++;
}

function expectOk(label, op) {
  const r = validateOperation(op);
  if (r.ok) pass(label);
  else fail(label, `expected allowed, got: ${r.reason}`);
}

function expectRejected(label, op, reasonPart) {
  const r = validateOperation(op);
  if (!r.ok) {
    if (reasonPart && !r.reason.includes(reasonPart)) {
      fail(label, `rejected but reason "${r.reason}" lacks "${reasonPart}"`);
    } else {
      pass(label);
    }
  } else {
    fail(label, 'expected rejected but was allowed');
  }
}

// ═══════════════════════════════════════════════════════
console.log('=== query_osu must be allowed (readonly) ===');

expectOk('query_osu-recent', { type: 'query_osu', params: { capability: 'recent' } });
expectOk('query_osu-bp-rank', { type: 'query_osu', params: { capability: 'bp', bp_rank: 1 } });
expectOk('query_osu-bp_type', { type: 'query_osu', params: { capability: 'bp_type', username: '[SHK]Wuxin' } });
expectOk('query_osu-bp-range', { type: 'query_osu', params: { capability: 'bp', bp_start: 1, bp_end: 10 } });
expectOk('query_osu-bp-range-20', { type: 'query_osu', params: { capability: 'bp', bp_start: 1, bp_end: 20 } });
expectOk('query_osu-bp-range-100', { type: 'query_osu', params: { capability: 'bp', bp_start: 1, bp_end: 100 } });
expectOk('query_osu-bp-compact', { type: 'query_osu', params: { capability: 'bp', bp_start: 1, bp_end: 100, compact: true } });
expectOk('query_osu-info', { type: 'query_osu', params: { capability: 'info' } });
expectOk('query_osu-username', { type: 'query_osu', params: { capability: 'recent', username: '[SHK]Wuxin' } });

console.log('\n=== query_osu invalid params still rejected ===');

expectRejected('query_osu-bp-range-inverted', { type: 'query_osu', params: { capability: 'bp', bp_start: 5, bp_end: 2 } }, '不能大于');
expectRejected('query_osu-bp-range-over-100', { type: 'query_osu', params: { capability: 'bp', bp_start: 1, bp_end: 101 } }, '1 到 100');
expectRejected('query_osu-bp-compact-not-bool', { type: 'query_osu', params: { capability: 'bp', bp_rank: 1, compact: 'yes' } }, '布尔');
expectRejected('query_osu-unknown-capability-param', { type: 'query_osu', params: { capability: 'evil' } }, '无效');
expectRejected('query_osu-unknown-param', { type: 'query_osu', params: { capability: 'bp', evil: 'x' } }, '不允许的参数');
expectRejected('query_osu-unknown-type', { type: 'query_osu', params: { capability: 'delete', command: 'rm' } }, '不允许的参数');

console.log('\n=== beatmap-centric capabilities (Phase B) ===');

expectOk('query_osu-beatmap-lookup', { type: 'query_osu', params: { capability: 'beatmap_lookup', beatmap_id: 5518740 } });
expectOk('query_osu-beatmap-lookup-mods', { type: 'query_osu', params: { capability: 'beatmap_lookup', beatmap_id: 5518740, mods: 'HDHR' } });
expectOk('query_osu-pp-calc-min', { type: 'query_osu', params: { capability: 'pp_calc', beatmap_id: 5518740 } });
expectOk('query_osu-pp-calc-full', { type: 'query_osu', params: { capability: 'pp_calc', beatmap_id: 5518740, mods: 'HD', accuracy: 99, combo: 1200, misses: 1 } });
expectOk('query_osu-leaderboard', { type: 'query_osu', params: { capability: 'leaderboard', beatmap_id: 5518740, limit: 5 } });
expectOk('query_osu-leaderboard-mods', { type: 'query_osu', params: { capability: 'leaderboard', beatmap_id: 5518740, mods: 'HDHR' } });

expectRejected('query_osu-beatmap-no-bid', { type: 'query_osu', params: { capability: 'beatmap_lookup' } }, 'beatmap_id');
expectRejected('query_osu-pp-calc-no-bid', { type: 'query_osu', params: { capability: 'pp_calc' } }, 'beatmap_id');
expectRejected('query_osu-leaderboard-no-bid', { type: 'query_osu', params: { capability: 'leaderboard' } }, 'beatmap_id');
expectRejected('query_osu-beatmap-with-username', { type: 'query_osu', params: { capability: 'beatmap_lookup', beatmap_id: 5518740, username: 'x' } }, 'username');
expectRejected('query_osu-beatmap-with-bp-rank', { type: 'query_osu', params: { capability: 'beatmap_lookup', beatmap_id: 5518740, bp_rank: 1 } }, 'bp_rank');
expectRejected('query_osu-pp-calc-bad-acc', { type: 'query_osu', params: { capability: 'pp_calc', beatmap_id: 5518740, accuracy: 101 } }, 'accuracy');
expectRejected('query_osu-pp-calc-bad-acc-zero', { type: 'query_osu', params: { capability: 'pp_calc', beatmap_id: 5518740, accuracy: 0 } }, 'accuracy');
expectRejected('query_osu-pp-calc-neg-combo', { type: 'query_osu', params: { capability: 'pp_calc', beatmap_id: 5518740, combo: -1 } }, 'combo');
expectRejected('query_osu-pp-calc-many-miss', { type: 'query_osu', params: { capability: 'pp_calc', beatmap_id: 5518740, misses: 1000 } }, 'misses');
expectRejected('query_osu-pp-calc-legacy-acc-param', { type: 'query_osu', params: { capability: 'pp_calc', beatmap_id: 5518740, acc: '99' } }, '不允许的参数');
expectRejected('query_osu-leaderboard-bad-limit', { type: 'query_osu', params: { capability: 'leaderboard', beatmap_id: 5518740, limit: 60 } }, 'limit');
expectRejected('query_osu-leaderboard-with-misses', { type: 'query_osu', params: { capability: 'leaderboard', beatmap_id: 5518740, misses: 1 } }, 'leaderboard');
expectRejected('query_osu-bp-with-bid', { type: 'query_osu', params: { capability: 'bp', beatmap_id: 5518740 } }, 'beatmap_id');
expectRejected('query_osu-profile-with-accuracy', { type: 'query_osu', params: { capability: 'profile', accuracy: 99 } }, 'accuracy');

console.log('\n=== literal tool-call markup guard ===');

const asciiMarkup = '<tool_calls>\n<invoke name="query_osu">\n<parameter name="capability">bp</parameter>\n</invoke>\n</tool_calls>';
const dsmlMarkup = '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="query_osu">\n<｜｜DSML｜｜parameter name="capability">pp_calc<｜｜DSML｜｜/parameter>\n<｜｜DSML｜｜/invoke>\n<｜｜DSML｜｜/tool_calls>';
const dsmlFullwidth = '＜｜｜tool_calls＞\n＜｜｜invoke name="query_osu"＞\n＜｜｜parameter name="capability"＞pp_calc＜｜｜/parameter＞\n＜｜｜/invoke＞\n＜｜｜/tool_calls＞';
const normalText = '这图打99acc fc大概有多少pp，mod是hd';

if (!looksLikeToolCallMarkup(asciiMarkup)) fail('markup-detect-ascii', 'ASCII tool-call markup not detected');
else pass('markup-detect-ascii');
if (!looksLikeToolCallMarkup(dsmlMarkup)) fail('markup-detect-dsml', 'DSML tool-call markup not detected');
else pass('markup-detect-dsml');
if (!looksLikeToolCallMarkup(dsmlFullwidth)) fail('markup-detect-dsml-fullwidth', 'full-width DSML markup not detected');
else pass('markup-detect-dsml-fullwidth');
if (looksLikeToolCallMarkup(normalText)) fail('markup-detect-normal', 'normal chat text flagged as markup');
else pass('markup-detect-normal');

const strippedAscii = stripToolCallMarkup(asciiMarkup);
if (looksLikeToolCallMarkup(strippedAscii) || strippedAscii.length > 0) {
  fail('markup-strip-ascii', `expected empty after strip, got: ${JSON.stringify(strippedAscii)}`);
} else {
  pass('markup-strip-ascii');
}
const strippedDsml = stripToolCallMarkup(dsmlMarkup);
if (looksLikeToolCallMarkup(strippedDsml) || strippedDsml.length > 0) {
  fail('markup-strip-dsml', `expected empty after strip, got: ${JSON.stringify(strippedDsml)}`);
} else {
  pass('markup-strip-dsml');
}
const strippedDsmlFull = stripToolCallMarkup(dsmlFullwidth);
if (looksLikeToolCallMarkup(strippedDsmlFull) || strippedDsmlFull.length > 0) {
  fail('markup-strip-dsml-fullwidth', `expected empty after strip, got: ${JSON.stringify(strippedDsmlFull)}`);
} else {
  pass('markup-strip-dsml-fullwidth');
}

const parsed = parseToolCallMarkup(dsmlMarkup);
if (parsed.length !== 1 || parsed[0].name !== 'query_osu') {
  fail('markup-parse-dsml', `expected one query_osu call, got: ${JSON.stringify(parsed)}`);
} else if (parsed[0].args.capability !== 'pp_calc') {
  fail('markup-parse-dsml-args', `expected capability=pp_calc, got: ${JSON.stringify(parsed[0].args)}`);
} else {
  pass('markup-parse-dsml');
}

if (parseToolCallMarkup(normalText).length !== 0) {
  fail('markup-parse-normal', 'normal text parsed as tool calls');
} else {
  pass('markup-parse-normal');
}

// ASCII-pipe DSML (no full-width decorations at all).
const asciiPipeMarkup = '<|DSML|tool_calls>\n<|DSML|invoke name="query_osu">\n<|DSML|parameter name="capability">bp<|DSML|/parameter>\n<|DSML|/invoke>\n<|DSML|/tool_calls>';
if (!looksLikeToolCallMarkup(asciiPipeMarkup)) fail('markup-detect-ascii-pipe', 'ASCII-pipe DSML not detected');
else pass('markup-detect-ascii-pipe');
const strippedAsciiPipe = stripToolCallMarkup(asciiPipeMarkup);
if (looksLikeToolCallMarkup(strippedAsciiPipe) || strippedAsciiPipe.length > 0) {
  fail('markup-strip-ascii-pipe', `expected empty after strip, got: ${JSON.stringify(strippedAsciiPipe)}`);
} else {
  pass('markup-strip-ascii-pipe');
}
const parsedAsciiPipe = parseToolCallMarkup(asciiPipeMarkup);
if (parsedAsciiPipe.length !== 1 || parsedAsciiPipe[0].name !== 'query_osu' || parsedAsciiPipe[0].args.capability !== 'bp') {
  fail('markup-parse-ascii-pipe', `expected one query_osu/bp call, got: ${JSON.stringify(parsedAsciiPipe)}`);
} else {
  pass('markup-parse-ascii-pipe');
}

// Single-pipe full-width DSML (`<｜DSML｜…>` — the 08-12 production shape).
const dsmlSingleFullwidth = '＜｜DSML｜tool_calls＞\n＜｜DSML｜invoke name="query_osu"＞\n＜｜DSML｜parameter name="capability"＞bp＜｜DSML｜/parameter＞\n＜｜DSML｜/invoke＞\n＜｜DSML｜/tool_calls＞';
if (!looksLikeToolCallMarkup(dsmlSingleFullwidth)) fail('markup-detect-dsml-single-fullwidth', 'single-pipe DSML not detected');
else pass('markup-detect-dsml-single-fullwidth');
const strippedSingleFullwidth = stripToolCallMarkup(dsmlSingleFullwidth);
if (looksLikeToolCallMarkup(strippedSingleFullwidth) || strippedSingleFullwidth.length > 0) {
  fail('markup-strip-dsml-single-fullwidth', `expected empty after strip, got: ${JSON.stringify(strippedSingleFullwidth)}`);
} else {
  pass('markup-strip-dsml-single-fullwidth');
}
const parsedSingleFullwidth = parseToolCallMarkup(dsmlSingleFullwidth);
if (parsedSingleFullwidth.length !== 1 || parsedSingleFullwidth[0].name !== 'query_osu') {
  fail('markup-parse-dsml-single-fullwidth', `expected one query_osu call, got: ${JSON.stringify(parsedSingleFullwidth)}`);
} else {
  pass('markup-parse-dsml-single-fullwidth');
}

// Truncated / unbalanced markup must fail closed: never leave parameter
// values (pp_calc) behind when the closing tags are missing.
const truncatedFullwidth = '＜｜DSML｜tool_calls＞\n＜｜DSML｜invoke name="query_osu"＞\n＜｜DSML｜parameter name="capability"＞pp_calc';
const truncatedAscii = '<|DSML|parameter name="capability">pp_calc';
if (stripToolCallMarkup(truncatedFullwidth).length !== 0) {
  fail('markup-strip-truncated-fullwidth', `truncated DSML must strip to empty, got: ${JSON.stringify(stripToolCallMarkup(truncatedFullwidth))}`);
} else {
  pass('markup-strip-truncated-fullwidth');
}
if (stripToolCallMarkup(truncatedAscii).length !== 0) {
  fail('markup-strip-truncated-ascii', `truncated ASCII DSML must strip to empty, got: ${JSON.stringify(stripToolCallMarkup(truncatedAscii))}`);
} else {
  pass('markup-strip-truncated-ascii');
}

// Mismatched tags must fail closed twice: strip to empty AND parse to [].
// Equal open/close counts are not enough — names and nesting order must match.
const mismatchedClose = '<parameter name="capability">pp_calc</invoke>';
const mismatchedOpen = '<tool_calls></invoke>pp_calc';
const lifoViolation = '<tool_calls><invoke name="query_osu"><parameter name="capability">bp</parameter></tool_calls></invoke>';
if (stripToolCallMarkup(mismatchedClose).length !== 0) {
  fail('markup-strip-mismatched-close', `mismatched close must strip to empty, got: ${JSON.stringify(stripToolCallMarkup(mismatchedClose))}`);
} else {
  pass('markup-strip-mismatched-close');
}
if (parseToolCallMarkup(mismatchedClose).length !== 0) {
  fail('markup-parse-mismatched-close', `mismatched close must parse to [], got: ${JSON.stringify(parseToolCallMarkup(mismatchedClose))}`);
} else {
  pass('markup-parse-mismatched-close');
}
if (stripToolCallMarkup(mismatchedOpen).length !== 0) {
  fail('markup-strip-mismatched-open', `mismatched open must strip to empty, got: ${JSON.stringify(stripToolCallMarkup(mismatchedOpen))}`);
} else {
  pass('markup-strip-mismatched-open');
}
if (parseToolCallMarkup(mismatchedOpen).length !== 0) {
  fail('markup-parse-mismatched-open', `mismatched open must parse to [], got: ${JSON.stringify(parseToolCallMarkup(mismatchedOpen))}`);
} else {
  pass('markup-parse-mismatched-open');
}
if (stripToolCallMarkup(lifoViolation).length !== 0) {
  fail('markup-strip-lifo', `LIFO violation must strip to empty, got: ${JSON.stringify(stripToolCallMarkup(lifoViolation))}`);
} else {
  pass('markup-strip-lifo');
}
if (parseToolCallMarkup(lifoViolation).length !== 0) {
  fail('markup-parse-lifo', `LIFO violation must parse to [], got: ${JSON.stringify(parseToolCallMarkup(lifoViolation))}`);
} else {
  pass('markup-parse-lifo');
}

console.log('\n=== query_external_bot must stay closed ===');

expectRejected('query_external_bot-kanon', { type: 'query_external_bot', params: { bot: 'kanon', command: '/r' } }, '不允许的操作类型');
expectRejected('query_external_bot-lazybot', { type: 'query_external_bot', params: { bot: 'lazybot', command: '/bp' } }, '不允许的操作类型');

console.log('\n=== legacy operations still gated correctly ===');

expectRejected('unknown-op', { type: 'rm_rf', params: {} }, '不允许的操作类型');
expectOk('get_player_skill', { type: 'get_player_skill', params: { player: '[SHK]Wuxin' } });
expectOk('list_bots', { type: 'list_bots', params: {} });

console.log(`\n${'='.repeat(40)}`);
console.log(`Passed: ${passed}, Failed: ${failed}`);

if (failed > 0) {
  console.error('QUERY-OSU-POLICY-VERIFY FAILED');
  process.exit(1);
}
console.log('QUERY-OSU-POLICY-VERIFY PASSED');
process.exit(0);
