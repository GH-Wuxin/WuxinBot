// query-osu-policy-verify.mjs — security whitelist regression for query_osu.
// Verifies validateOperation allows query_osu as a readonly op while keeping
// query_external_bot closed. Exit 0 on all pass, non-zero on any failure.

import { validateOperation } from '../server/bots/guard.ts';

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
expectOk('query_osu-bp_type', { type: 'query_osu', params: { capability: 'bp_type', username: '[TST]Alpha' } });
expectOk('query_osu-bp-range', { type: 'query_osu', params: { capability: 'bp', bp_start: 1, bp_end: 10 } });
expectOk('query_osu-bp-range-20', { type: 'query_osu', params: { capability: 'bp', bp_start: 1, bp_end: 20 } });
expectOk('query_osu-bp-range-100', { type: 'query_osu', params: { capability: 'bp', bp_start: 1, bp_end: 100 } });
expectOk('query_osu-bp-compact', { type: 'query_osu', params: { capability: 'bp', bp_start: 1, bp_end: 100, compact: true } });
expectOk('query_osu-info', { type: 'query_osu', params: { capability: 'info' } });
expectOk('query_osu-username', { type: 'query_osu', params: { capability: 'recent', username: '[TST]Alpha' } });

console.log('\n=== query_osu invalid params still rejected ===');

expectRejected('query_osu-bp-range-inverted', { type: 'query_osu', params: { capability: 'bp', bp_start: 5, bp_end: 2 } }, '不能大于');
expectRejected('query_osu-bp-range-over-100', { type: 'query_osu', params: { capability: 'bp', bp_start: 1, bp_end: 101 } }, '1 到 100');
expectRejected('query_osu-bp-compact-not-bool', { type: 'query_osu', params: { capability: 'bp', bp_rank: 1, compact: 'yes' } }, '布尔');
expectRejected('query_osu-unknown-capability-param', { type: 'query_osu', params: { capability: 'evil' } }, '无效');
expectRejected('query_osu-unknown-param', { type: 'query_osu', params: { capability: 'bp', evil: 'x' } }, '不允许的参数');
expectRejected('query_osu-unknown-type', { type: 'query_osu', params: { capability: 'delete', command: 'rm' } }, '不允许的参数');

console.log('\n=== query_external_bot must stay closed ===');

expectRejected('query_external_bot-kanon', { type: 'query_external_bot', params: { bot: 'kanon', command: '/r' } }, '不允许的操作类型');
expectRejected('query_external_bot-lazybot', { type: 'query_external_bot', params: { bot: 'lazybot', command: '/bp' } }, '不允许的操作类型');

console.log('\n=== legacy operations still gated correctly ===');

expectRejected('unknown-op', { type: 'rm_rf', params: {} }, '不允许的操作类型');
expectOk('get_player_skill', { type: 'get_player_skill', params: { player: '[TST]Alpha' } });
expectOk('list_bots', { type: 'list_bots', params: {} });

console.log(`\n${'='.repeat(40)}`);
console.log(`Passed: ${passed}, Failed: ${failed}`);

if (failed > 0) {
  console.error('QUERY-OSU-POLICY-VERIFY FAILED');
  process.exit(1);
}
console.log('QUERY-OSU-POLICY-VERIFY PASSED');
process.exit(0);
