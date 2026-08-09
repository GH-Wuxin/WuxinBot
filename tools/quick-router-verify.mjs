// quick-router-verify.mjs — M1 quick-command router regression tests.
//
// Covers:
//   1. Registry matching for every prefix class (`!`, `/`, `~`, `查@`, keywords)
//   2. Cut-command aliases must NOT match
//   3. BP rank/range argument parsing (`!bs 1-100`, `!bp 玩家名 5`, `#5`)
//   4. Local handlers (help/ping/dice/unbind), permission gates, group gates
//   5. processIncoming integration: quick commands reply without the LLM
// Exit 0 on all pass, non-zero on any failure.

import { createTestDataDir, assertNotProduction, productionDbSnapshot, verifyProductionDbUnchanged, cleanupTestDir } from './test-isolation.mjs';

const testDataDir = createTestDataDir('wuxin-quickrouter');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);
const prodBefore = productionDbSnapshot();
console.log('[isolation] production db snapshot: ' + (prodBefore ? prodBefore.sha256.slice(0, 12) + '...' : 'N/A'));

const { ensureStore, readDb, updateDb } = await import('../server/store.ts');
const { matchQuickCommand, handleQuickCommand, parseOsuArgs, quickPayload } = await import('../server/bot/quickRouter.ts');
const { processIncoming } = await import('../server/bot.ts');

ensureStore();

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

function ok(label, cond, msg) {
  cond ? pass(label) : fail(label, msg || 'assertion failed');
}

// ── Fixture ──

updateDb((db) => {
  db.settings.ownerQq = '1000000001';
  db.settings.selfQq = '900000029';
  db.settings.llmProvider = 'fixture';
  db.settings.apiKey = 'fixture-key';
  db.settings.thinkingNoticeMode = 'off';
  db.settings.memoryEnabled = false;
  db.groups = [
    { groupId: '900000007', name: 'ExpTest', enabled: true, mode: 'normal', maxPerHour: 100, cooldownSec: 0 },
    { groupId: '770099', name: 'DisabledGroup', enabled: false, mode: 'normal', maxPerHour: 100, cooldownSec: 0 },
  ];
  // Quick router is per-group opt-in in M1 (original bots still run elsewhere).
  db.groupBotConfig = db.groupBotConfig || {};
  db.groupBotConfig['900000007'] = { quick: true };
  db.osuBindings = db.osuBindings || {};
  db.osuBindings['1000000001'] = { id: 1234567, username: '[TST]Alpha' };
});

const groupEvent = (text, extra = {}) => ({
  source: 'onebot',
  type: 'group',
  messageId: 'qr-' + Math.random().toString(36).slice(2, 10),
  groupId: '900000007',
  userId: '10001',
  nickname: 'Tester',
  text,
  atTargets: [],
  images: [],
  raw: {},
  ...extra,
});

// ── 1. Registry matching ──

console.log('=== Unit: matchQuickCommand ===');

{
  const cases = [
    // [text, expected id or null, expected args, extraEvent]
    ['!bs 1-100', 'bs', '1-100', {}],
    ['!bp 5', 'bp', '5', {}],
    ['!bp #5', 'bp', '#5', {}],
    ['!bp 玩家名 5', 'bp', '玩家名 5', {}],
    ['!r', 'recent', '', {}],
    ['!p', 'recent', '', {}],
    ['!re', 'recent', '', {}],
    ['!pr 玩家', 'recent', '玩家', {}],
    ['!pp', 'pplus', '', {}],
    ['!pl', 'pm', '', {}],
    ['!etx', 'etx', '', {}],
    ['!i 玩家', 'info', '玩家', {}],
    ['!帮助', 'help', '', {}],
    ['！dice 6', 'dice', '6', {}],
    ['!ml 123', 'match', '123', {}],
    ['!s 4270382', 'score', '4270382', {}],
    ['!score 4270382', 'score', '4270382', {}],
    ['/s 4270382', 'score', '4270382', {}],
    ['/score 4270382', 'score', '4270382', {}],
    ['/plus 名字', 'pplus', '名字', {}],
    ['/bp 10', 'bp', '10', {}],
    ['/recent', 'recent', '', {}],
    ['/profile 名字', 'profile', '名字', {}],
    ['/help', 'help', '', {}],
    ['~', 'self_profile', '', {}],
    ['~,mania', 'self_profile', '', {}],
    ['查', 'at_profile', '', { atTargets: ['123'] }],
    ['where qq=123', 'where', 'qq=123', {}],
    ['where Cookiezi', 'where', 'Cookiezi', {}],
    ['+ LimaPlayer', 'pplus', 'LimaPlayer', {}],
    ['今日高光', 'highlight', '', {}],
    ['我的年度osu!', 'annual', '', {}],
    // Cut / removed / non-command messages must not match:
    ['!mm 123', null, null, {}],
    ['!or 6', null, null, {}],
    ['!bu 123', null, null, {}],
    ['!g 123', null, null, {}],
    ['!w 123', null, null, {}],
    ['!pu', null, null, {}],
    ['!leeway', null, null, {}],
    ['!gd 1', null, null, {}],
    ['/check', null, null, {}],
    ['/年度总结', null, null, {}],
    ['/badge', null, null, {}],
    ['++', null, null, {}],
    ['+abc', null, null, {}],
    ['今天天气不错', null, null, {}],
    ['@pippi 帮我看看 bp1', null, null, {}],
  ];

  for (const [text, expectedId, expectedArgs, extra] of cases) {
    const match = matchQuickCommand({ text, atTargets: extra.atTargets || [] });
    if (expectedId === null) {
      ok(`match-null:${text}`, match === null, `expected no match, got ${JSON.stringify(match?.def?.id)}`);
    } else {
      ok(`match:${text}`, match !== null && match.def.id === expectedId, `expected ${expectedId}, got ${JSON.stringify(match?.def?.id)}`);
      if (match && expectedArgs !== null) {
        ok(`match-args:${text}`, match.args === expectedArgs, `expected args "${expectedArgs}", got "${match.args}"`);
      }
    }
  }
}

// ── 2. BP argument parsing ──

console.log('\n=== Unit: BP rank/range parsing ===');

{
  const bpDef = { id: 'bp', bpArgs: true, capability: 'bp' };
  const bsDef = { id: 'bs', bpArgs: true, capability: 'bp' };

  const range = parseOsuArgs(bpDef, '1-100');
  ok('bp-range', range.bpSelection?.startRank === 1 && range.bpSelection?.endRank === 100, JSON.stringify(range.bpSelection));
  ok('bp-range-not-compact', range.bpSelection?.compact === false, JSON.stringify(range.bpSelection));

  const bsRange = parseOsuArgs(bsDef, '1-100');
  ok('bs-range-compact', bsRange.bpSelection?.startRank === 1 && bsRange.bpSelection?.endRank === 100 && bsRange.bpSelection?.compact === true, JSON.stringify(bsRange.bpSelection));

  const single = parseOsuArgs(bpDef, '#5');
  ok('bp-single', single.bpSelection?.startRank === 5 && single.bpSelection?.endRank === 5 && single.bpSelection?.single === true, JSON.stringify(single.bpSelection));

  const withUser = parseOsuArgs(bpDef, '玩家名 5');
  ok('bp-user-rank', withUser.username === '玩家名' && withUser.bpSelection?.startRank === 5, JSON.stringify(withUser));

  const withUserRange = parseOsuArgs(bpDef, 'Cookiezi 1-10');
  ok('bp-user-range', withUserRange.username === 'Cookiezi' && withUserRange.bpSelection?.endRank === 10, JSON.stringify(withUserRange));

  const bare = parseOsuArgs(bpDef, '');
  ok('bp-default', bare.bpSelection?.startRank === 1 && bare.bpSelection?.endRank === 10, JSON.stringify(bare.bpSelection));

  const bad = parseOsuArgs(bpDef, '0-5');
  ok('bp-bad-range', Boolean(bad.error), JSON.stringify(bad));

  const usernameOnly = parseOsuArgs(bpDef, '玩家名');
  ok('bp-username', usernameOnly.username === '玩家名' && !usernameOnly.bpSelection, JSON.stringify(usernameOnly));
}

// ── 2a. Score argument parsing (`!s <bid> [玩家名]`) ──

console.log('\n=== Unit: score args ===');

{
  const scoreDef = { id: 'score', capability: 'score' };
  const bidOnly = parseOsuArgs(scoreDef, '4270382');
  ok('score-bid-only', bidOnly.scoreBeatmapId === 4270382 && bidOnly.username === '', JSON.stringify(bidOnly));

  const bidWithUser = parseOsuArgs(scoreDef, '4270382 windpipeey');
  ok('score-bid-user', bidWithUser.scoreBeatmapId === 4270382 && bidWithUser.username === 'windpipeey', JSON.stringify(bidWithUser));

  const badBid = parseOsuArgs(scoreDef, 'abc');
  ok('score-bad-bid', Boolean(badBid.error), JSON.stringify(badBid));

  const empty = parseOsuArgs(scoreDef, '');
  ok('score-empty', Boolean(empty.error), JSON.stringify(empty));
}

// ── 2b. Image-first delivery ──

console.log('\n=== Unit: quickPayload (image-only delivery) ===');

{
  const withImages = quickPayload({
    content: '玩家 的 BP1-100：\n#1 ...\n#2 ...',
    images: ['[CQ:image,file=file:///x.png]'],
  });
  ok('payload-images-only', withImages === '[CQ:image,file=file:///x.png]', withImages);

  const textOnly = quickPayload('纯文字结果');
  ok('payload-text', textOnly === '纯文字结果', textOnly);

  const plainString = quickPayload('直接字符串');
  ok('payload-string', plainString === '直接字符串', plainString);
}

// ── 3. Local handlers ──

console.log('\n=== Unit: local handlers ===');

{
  const sent = [];
  const send = async (_event, text) => { sent.push(text); };

  const helpMatch = matchQuickCommand({ text: '!帮助', atTargets: [] });
  const helpResult = await handleQuickCommand(groupEvent('!帮助'), send, readDb(), helpMatch, { isOwner: false, isAdmin: false });
  ok('handler-help', helpResult.handled && helpResult.replied && sent.some((t) => t.includes('快捷指令')), JSON.stringify(helpResult));
  sent.length = 0;

  const pingMatch = matchQuickCommand({ text: '!ping', atTargets: [] });
  const pingResult = await handleQuickCommand(groupEvent('!ping'), send, readDb(), pingMatch, { isOwner: false, isAdmin: false });
  ok('handler-ping', pingResult.handled && pingResult.replied && sent.some((t) => t.includes('在的')), JSON.stringify(pingResult));
  sent.length = 0;

  const diceMatch = matchQuickCommand({ text: '!dice 6', atTargets: [] });
  const diceResult = await handleQuickCommand(groupEvent('!dice 6'), send, readDb(), diceMatch, { isOwner: false, isAdmin: false });
  ok('handler-dice', diceResult.handled && diceResult.replied && sent.some((t) => /^🎲 \d+（1~6）$/.test(t)), JSON.stringify(diceResult) + ' ' + JSON.stringify(sent));
  sent.length = 0;

  // Bind/unbind are hints to /w osu bind (single binding entry).
  updateDb((db) => { db.osuBindings['10001'] = { id: 1, username: 'x' }; });
  const bindHintMatch = matchQuickCommand({ text: '!bind Cookiezi', atTargets: [] });
  const bindHintResult = await handleQuickCommand(groupEvent('!bind Cookiezi'), send, readDb(), bindHintMatch, { isOwner: false, isAdmin: false });
  ok('handler-bind-hint', bindHintResult.handled && bindHintResult.replied && sent.some((t) => t.includes('/w osu bind')), JSON.stringify(bindHintResult) + ' ' + JSON.stringify(sent));
  sent.length = 0;

  const unbindMatch = matchQuickCommand({ text: '!unbind', atTargets: [] });
  const unbindResult = await handleQuickCommand(groupEvent('!unbind'), send, readDb(), unbindMatch, { isOwner: false, isAdmin: false });
  ok('handler-unbind-hint', unbindResult.handled && readDb().osuBindings?.['10001'], JSON.stringify(unbindResult));
  updateDb((db) => { delete db.osuBindings['10001']; });
  sent.length = 0;

  // Unbound user gets Wuxin's own prompt, never the original bot's message.
  const unboundMatch = matchQuickCommand({ text: '!r', atTargets: [] });
  const unboundResult = await handleQuickCommand(groupEvent('!r'), send, readDb(), unboundMatch, { isOwner: false, isAdmin: false });
  ok('handler-unbound-self', unboundResult.handled && unboundResult.replied && sent.some((t) => t.includes('/w osu bind')), JSON.stringify(unboundResult) + ' ' + JSON.stringify(sent));
  sent.length = 0;

  // !ml (match watch) is implemented: a bare/unknown id gets a usage reply.
  const unimplementedMatch = matchQuickCommand({ text: '!ml 123', atTargets: [] });
  const unimplementedResult = await handleQuickCommand(groupEvent('!ml 123'), send, readDb(), unimplementedMatch, { isOwner: false, isAdmin: false });
  ok('handler-unimplemented-fallback', unimplementedResult.handled && unimplementedResult.replied && sent.some((t) => t.includes('!ml')), JSON.stringify(unimplementedResult) + ' ' + JSON.stringify(sent));
  sent.length = 0;

  // Admin command denied for a normal member.
  const adminMatch = matchQuickCommand({ text: '/addscores x', atTargets: [] });
  const adminResult = await handleQuickCommand(groupEvent('/addscores x'), send, readDb(), adminMatch, { isOwner: false, isAdmin: false });
  ok('handler-admin-denied', adminResult.handled && adminResult.replied && sent.some((t) => t.includes('权限')), JSON.stringify(adminResult) + ' ' + JSON.stringify(sent));
  sent.length = 0;

  // Disabled group → quick command silently ignored.
  const disabledMatch = matchQuickCommand({ text: '!ping', atTargets: [] });
  const disabledResult = await handleQuickCommand({ ...groupEvent('!ping'), groupId: '770099' }, send, readDb(), disabledMatch, { isOwner: false, isAdmin: false });
  ok('handler-disabled-group', disabledResult.handled === true && disabledResult.replied === false, JSON.stringify(disabledResult));

  // Private non-owner → falls through.
  const privateMatch = matchQuickCommand({ text: '!ping', atTargets: [] });
  const privateResult = await handleQuickCommand({ ...groupEvent('!ping'), type: 'private', groupId: 'private' }, send, readDb(), privateMatch, { isOwner: false, isAdmin: false });
  ok('handler-private-nonowner', privateResult.handled === false, JSON.stringify(privateResult));

  // Hydrant std-only mode guard (no network needed).
  const maniaMatch = matchQuickCommand({ text: '~,mania', atTargets: [] });
  const maniaResult = await handleQuickCommand(groupEvent('~,mania'), send, readDb(), maniaMatch, { isOwner: false, isAdmin: false });
  ok('handler-std-only', maniaResult.handled && sent.some((t) => t.includes('osu!std')), JSON.stringify(maniaResult) + ' ' + JSON.stringify(sent));
  sent.length = 0;
}

// ── 4. processIncoming integration (no LLM, no network) ──

console.log('\n=== E2E: processIncoming quick-command path ===');

{
  const sent = [];
  const send = async (_event, text) => { sent.push(text); };

  const dice = await processIncoming(groupEvent('!dice 6'), send);
  ok('e2e-dice', dice.replied === true && sent.some((t) => /^🎲 /.test(t)), JSON.stringify(dice) + ' ' + JSON.stringify(sent));
  sent.length = 0;

  const help = await processIncoming(groupEvent('!帮助'), send);
  ok('e2e-help', help.replied === true && sent.some((t) => t.includes('快捷指令')), JSON.stringify(help) + ' ' + JSON.stringify(sent));
  sent.length = 0;

  const slashHelp = await processIncoming(groupEvent('/help'), send);
  ok('e2e-slash-help', slashHelp.replied === true && sent.some((t) => t.includes('快捷指令')), JSON.stringify(slashHelp) + ' ' + JSON.stringify(sent));
  sent.length = 0;

  const stdOnly = await processIncoming(groupEvent('~,mania'), send);
  ok('e2e-std-only', stdOnly.replied === true && sent.some((t) => t.includes('osu!std')), JSON.stringify(stdOnly) + ' ' + JSON.stringify(sent));
  sent.length = 0;

  // Unbound quick command replies with the Wuxin prompt (no LLM, no bridge).
  const unbound = await processIncoming(groupEvent('!r'), send);
  ok('e2e-unbound-prompt', unbound.replied === true && sent.some((t) => t.includes('/w osu bind')), JSON.stringify(unbound) + ' ' + JSON.stringify(sent));
  sent.length = 0;

  // !bind routes to the /w osu bind hint.
  const bindHint = await processIncoming(groupEvent('!bind Cookiezi'), send);
  ok('e2e-bind-hint', bindHint.replied === true && sent.some((t) => t.includes('/w osu bind')), JSON.stringify(bindHint) + ' ' + JSON.stringify(sent));
  sent.length = 0;

  // A `查` without @ is not a quick command and (unmentioned) gets no reply.
  const bareCha = await processIncoming(groupEvent('查'), send);
  ok('e2e-查-no-at', bareCha.replied === false, JSON.stringify(bareCha));
  sent.length = 0;

  // Cut command `!mm` must not trigger the router (falls into normal gate → no reply).
  const cut = await processIncoming(groupEvent('!mm 123'), send);
  ok('e2e-cut-no-router', cut.replied === false, JSON.stringify(cut));
  sent.length = 0;

  // A group without the quick flag keeps the router dormant (no double replies
  // while the original bots are still running).
  const dormant = await processIncoming({ ...groupEvent('!dice 6'), groupId: '770098' }, send);
  ok('e2e-dormant-group', dormant.replied === false && sent.length === 0, JSON.stringify(dormant) + ' ' + JSON.stringify(sent));
  sent.length = 0;
}

console.log(`\n${'='.repeat(40)}`);
console.log(`Passed: ${passed}, Failed: ${failed}`);

cleanupTestDir(testDataDir);

const prodOk = verifyProductionDbUnchanged(prodBefore);
if (!prodOk) {
  console.error('PRODUCTION DB WAS MODIFIED — refusing success.');
  process.exit(1);
}

process.exit(failed === 0 ? 0 : 1);
