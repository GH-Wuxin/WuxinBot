// boundary-correctness-verify.mjs — boundary contracts from the audit's
// package E: OneBot echo validation (F12), osu clear action authorization
// (F13), and prompt snapshot truncation honesty (F14). Fully offline.
import { createTestDataDir, cleanupTestDir, assertNotProduction } from './test-isolation.mjs';

const dataDir = createTestDataDir('wuxin-boundary-e');
assertNotProduction(dataDir);

let failed = 0;
function assert(condition, label, detail = '') {
  if (condition) console.log(`PASS [${label}]`);
  else {
    console.error(`FAIL [${label}] ${detail}`);
    failed++;
  }
}

try {
  // ── F12: OneBot echo envelopes ──
  const onebot = await import('../server/onebot.ts');
  const echo = (payload) => onebot.parseOneBotEcho(payload).kind;
  assert(echo(null) === 'failed', 'f12:null-payload-failed');
  assert(echo({}) === 'failed', 'f12:empty-object-failed', echo({}));
  assert(echo('HTML page') === 'failed', 'f12:html-failed');
  assert(echo([]) === 'failed', 'f12:array-failed');
  assert(echo({ status: 'ok', retcode: 0 }) === 'ok', 'f12:ok-echo');
  assert(echo({ retcode: 0 }) === 'ok', 'f12:retcode-only-ok');
  assert(echo({ status: 'async', retcode: 1 }) === 'async', 'f12:async-echo-unknown');
  assert(echo({ retcode: 1 }) === 'async', 'f12:retcode-1-unknown');
  assert(echo({ status: 'failed', retcode: 1200, message: 'no such group' }) === 'failed', 'f12:failed-echo');
  assert(echo({ retcode: 1200 }) === 'failed', 'f12:nonzero-retcode-failed');
  // A long timeout reply that finally arrives with a failure code must not be
  // misread as success either.
  assert(echo({ status: 'failed', retcode: 100, message: 'send timeout' }) === 'failed', 'f12:late-failure-echo');

  // ── F13: every osu clear action maps to its own permission key ──
  const router = await import('../server/bot/owner/router.ts');
  const route = (text) => {
    const parts = String(text).trim().split(/\s+/);
    return router.resolveOwnerRoute({
      command: `/${parts[1]}`,
      isWuxinCommand: true,
      subCommand: parts[2] || '',
      parts,
      commandArgs: parts.slice(2).join(' '),
      permissions: { isOwner: true, isAdmin: false, level: 100 },
      commandUserPolicy: { policy: 'owner' },
      target: null,
      sendMessage: null,
    });
  };
  const expected = {
    bind: 'osuClearBind',
    history: 'osuClearHistory',
    cooldown: 'osuClearCooldown',
    recommend: 'osuClearRecommend',
    cache: 'osuClearCache',
  };
  for (const [action, permissionKey] of Object.entries(expected)) {
    const resolution = route(`/w osu clear ${action}`);
    assert(resolution.permissionKey === permissionKey,
      `f13:clear-${action}-permission`, `${resolution.permissionKey} (${resolution.handlerKey})`);
  }
  assert(route('/w osu clear bogus').permissionKey === 'osuHelp', 'f13:unknown-action-falls-to-help');
  assert(route('/w osu bind').permissionKey === 'osuBind', 'f13:bind-route-intact');
  assert(route('/w osu analyze').permissionKey === 'osuAnalyze', 'f13:analyze-route-intact');

  // ── F14: prompt snapshots disclose count truncation ──
  const studio = await import('../server/promptStudio.ts');
  const short = Array.from({ length: 10 }, (_, index) => ({ role: 'user', content: `m${index}` }));
  studio.beginPromptCall({ id: 'snap-short', messages: short });
  const shortSnap = JSON.parse(JSON.stringify(studio.listPromptCalls(5).find((call) => call.id === 'snap-short')));
  assert(shortSnap.originalMessageCount === 10 && shortSnap.droppedMessageCount === 0 && shortSnap.truncated === false,
    'f14:short-call-not-truncated', JSON.stringify({ original: shortSnap.originalMessageCount, truncated: shortSnap.truncated }));

  const long = [{ role: 'system', content: 'SYSTEM PROMPT' }, ...Array.from({ length: 32 }, (_, index) => ({ role: 'user', content: `m${index}` }))];
  studio.beginPromptCall({ id: 'snap-long', messages: long });
  const longSnap = JSON.parse(JSON.stringify(studio.listPromptCalls(5).find((call) => call.id === 'snap-long')));
  assert(longSnap.messages[0]?.content === 'SYSTEM PROMPT', 'f14:leading-system-kept', longSnap.messages[0]?.content);
  assert(longSnap.originalMessageCount === 33 && longSnap.droppedMessageCount === 1 && longSnap.truncated === true,
    'f14:count-clip-marked-truncated', JSON.stringify({ original: longSnap.originalMessageCount, dropped: longSnap.droppedMessageCount, truncated: longSnap.truncated }));
  assert(Array.isArray(longSnap.truncationReasons) && longSnap.truncationReasons.some((reason) => /消息数量截断/.test(reason)),
    'f14:truncation-reason-recorded', JSON.stringify(longSnap.truncationReasons));

  const manySystem = Array.from({ length: 40 }, (_, index) => ({ role: 'system', content: `s${index}` }));
  studio.beginPromptCall({ id: 'snap-head', messages: manySystem });
  const headSnap = JSON.parse(JSON.stringify(studio.listPromptCalls(5).find((call) => call.id === 'snap-head')));
  assert(headSnap.retainedMessageCount === 32 && headSnap.droppedMessageCount === 8 && headSnap.truncated === true,
    'f14:oversized-head-clipped-and-disclosed', JSON.stringify({ retained: headSnap.retainedMessageCount, dropped: headSnap.droppedMessageCount }));
} finally {
  cleanupTestDir(dataDir);
}

if (failed > 0) {
  console.error(`BOUNDARY-CORRECTNESS-VERIFY FAILED (${failed})`);
  process.exit(1);
}
console.log('boundary correctness checks passed');
