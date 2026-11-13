import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createTestDataDir, cleanupTestDir, assertNotProduction } from './test-isolation.mjs';

const dataDir = createTestDataDir('wuxin-owner-command');
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
assertNotProduction(dataDir);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = '10001';
const SELF = '10002';
const MEMBER = '10003';
const GROUP = '20001';
const OTHER_GROUP = '20002';
const now = new Date().toISOString();

async function main() {
  const store = await import('../server/store.ts');
  const state = await import('../server/bot/social/state.ts');
  const { handleOwnerCommand } = await import('../server/bot/ownerCommands.ts');
  const { parseOwnerCommandText } = await import('../server/bot/commands/owner.meta.ts');
  const { resolveOwnerRoute } = await import('../server/bot/owner/router.ts');
  store.ensureStore();

  const event = (overrides = {}) => ({
    source: 'onebot',
    type: 'group',
    messageId: `owner-command-${Math.random().toString(16).slice(2)}`,
    groupId: GROUP,
    userId: MEMBER,
    nickname: '成员甲',
    text: '',
    atTargets: [],
    images: [],
    raw: {},
    ...overrides,
  });

  const seed = () => store.updateDb((db) => {
    db.settings.ownerQq = OWNER;
    db.settings.selfQq = SELF;
    db.settings.socialV2Enabled = true;
    db.settings.globalPaused = false;
    db.settings.memoryEnabled = false;
    db.settings.osuSearchEnabled = false;
    db.settings.enableAutoModel = false;
    db.settings.thinkingNoticeMode = 'off';
    db.settings.levelUpNotifyEnabled = false;
    db.settings.stickerPolicy = { mode: 'off' };
    db.settings.groupProfileAutoUpdateEnabled = false;
    db.groups = [{ groupId: GROUP, name: '测试群', enabled: true, mode: 'natural', cooldownSec: 0, maxPerHour: 100 }];
    db.users = [];
    db.messages = [];
    db.decisions = [];
    db.usageEvents = [];
    db.ownerDirectives = [];
    db.socialV2 = state.emptySocialState();
    db.socialV2.people[MEMBER] = {
      userId: MEMBER,
      affinity: { kind: 'ordinary', score: 42 },
      familiarity: 30,
      revision: 1,
      updatedAt: now,
    };
    db.socialV2.views[`group:${GROUP}/${MEMBER}`] = {
      summary: '本群关系摘要',
      preferredNames: ['小明'],
      style: '',
      mood: { label: '平静', reason: '测试', updatedAt: now },
      revision: 1,
      updatedAt: now,
    };
  });

  const run = async (text, overrides = {}, permissions = { isOwner: false, isAdmin: false }) => {
    const sent = [];
    const result = await handleOwnerCommand(
      event({ text, ...overrides }),
      async (_event, reply) => { sent.push(String(reply)); },
      permissions,
    );
    return { result, sent, text: sent.join('\n') };
  };

  const routeFor = (text, permissions = { isOwner: true, isAdmin: false }) => {
    const parts = text.trim().split(/\s+/);
    const prefix = parts[0].toLowerCase();
    const isWuxinCommand = prefix === '/w' || prefix === '/wuxin';
    const command = isWuxinCommand ? `/${(parts[1] || '').toLowerCase()}` : prefix;
    const subCommand = isWuxinCommand ? (parts[2] || '').toLowerCase() : '';
    const commandArgs = isWuxinCommand ? parts.slice(2).join(' ') : parts.slice(1).join(' ');
    return resolveOwnerRoute({
      event: event({ text, userId: OWNER }),
      sendMessage: async () => {},
      permissions,
      parts,
      prefix,
      isWuxinCommand,
      command,
      subCommand,
      commandArgs,
      target: parts[2],
      groupId: GROUP,
      commandDb: store.readDb(),
      commandUserPolicy: { policy: 'normal' },
      policyMap: {},
    });
  };

  // ── Parser: explicit Chinese commands, aliases, and exact rejection ──
  const parsedCases = [
    ['/w 好感度', 'affinity', ''],
    ['/w 好感度 10003', 'affinity', '10003'],
    ['/w affinity 10003', 'affinity', '10003'],
    ['/w 好感榜', 'affinityRank', ''],
    ['/w 好感排名', 'affinityRank', ''],
    ['/w affinity-top 全局', 'affinityRank', '全局'],
    ['/w 指令', 'ownerDirective', ''],
    ['/w 指令 list', 'ownerDirective', 'list'],
    ['/w 指令 set 称呼 简洁回答', 'ownerDirective', 'set 称呼 简洁回答'],
    ['/w directive list', 'ownerDirective', 'list'],
    ['/w 拉黑 10003', 'memberPolicy', '10003'],
    ['/w 白名单 10003', 'memberPolicy', '10003'],
    ['/wuxin 好感度', 'affinity', ''],
    ['/wuxin affinity 10003', 'affinity', '10003'],
    ['/wuxin 好感榜', 'affinityRank', ''],
    ['/wuxin 好感排名', 'affinityRank', ''],
    ['/wuxin affinity-top 全局', 'affinityRank', '全局'],
    ['/wuxin 指令 list', 'ownerDirective', 'list'],
    ['/wuxin directive list', 'ownerDirective', 'list'],
    ['/w group add 测试群', 'groupAdd', 'add 测试群'],
    ['/wuxin group add 测试群', 'groupAdd', 'add 测试群'],
    ['/w group profile show', 'groupProfileShow', 'profile show'],
    ['/wuxin group profile show', 'groupProfileShow', 'profile show'],
    ['/w group profile update', 'groupProfileEdit', 'profile update'],
    ['/wuxin group profile clear', 'groupProfileEdit', 'profile clear'],
    ['/w prompt show', 'promptShow', 'show'],
    ['/wuxin prompt show', 'promptShow', 'show'],
    ['/w prompt savebase', 'promptSavebase', 'savebase'],
    ['/wuxin prompt add 内容', 'promptEdit', 'add 内容'],
    ['/w model', 'modelShow', ''],
    ['/wuxin model', 'modelShow', ''],
    ['/w model list', 'modelShow', 'list'],
    ['/wuxin model show', 'modelShow', 'show'],
    ['/w model deepseek-v4-flash', 'modelSet', 'deepseek-v4-flash'],
    ['/wuxin model deepseek-v4-flash', 'modelSet', 'deepseek-v4-flash'],
  ];
  for (const [text, id, args] of parsedCases) {
    assert.deepEqual(parseOwnerCommandText(text), { id, args }, text);
  }
  for (const text of [
    '/w', '/w 未知指令', '/w 好感度x', '/w affinityx', '/w 指令x', '/w 拉黑x',
    '/w group', '/w group unknown', '/w group profile', '/w group profile unknown',
    '/wuxin group', '/wuxin group unknown', '/wuxin group profile unknown',
    '/wuxin 未知指令', '/wuxin 好感度x', '/wuxin affinityx', '/wuxin 指令x',
  ]) {
    assert.equal(parseOwnerCommandText(text), null, text);
  }

  // ── Generated KB examples must be concrete and resolve to the right doc ──
  const build = spawnSync(process.execPath, [
    '--import', 'tsx', 'tools/kb-build.mjs',
    '--data-dir', dataDir,
    '--skip-community',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, DATA_DIR: dataDir },
  });
  assert.equal(build.status, 0, `kb-build failed\n${build.stdout}\n${build.stderr}`);
  const buildReport = JSON.parse(build.stdout.slice(build.stdout.indexOf('{')));
  const knowledgeRoot = buildReport.knowledgeRoot || path.join(dataDir, 'knowledge');
  const docs = JSON.parse(fs.readFileSync(
    path.join(knowledgeRoot, 'builds', buildReport.contentSha, 'wuxin_self.json'),
    'utf8',
  ));
  const expectedExamples = [
    ['cmd:wuxin:affinity', '/w 好感度', 'affinity', ''],
    ['cmd:wuxin:affinityrank', '/w 好感榜', 'affinityRank', ''],
    ['cmd:wuxin:ownerdirective', '/w 指令 list', 'ownerDirective', 'list'],
  ];
  for (const [docId, command, id, args] of expectedExamples) {
    const doc = docs.find((entry) => entry.id === docId);
    assert.ok(doc, `missing generated doc ${docId}`);
    assert.deepEqual(doc.commandExamples, [{ command, verifier: 'wuxin' }], docId);
    assert.deepEqual(parseOwnerCommandText(command), { id, args }, command);
  }

  // ── Actual command behavior: Owner query, target, alias, and scope ──
  seed();
  let result = await run('/w 好感度', { userId: OWNER }, { isOwner: true, isAdmin: false });
  assert.match(result.text, /QQ 10001/);
  assert.match(result.text, /特殊/);

  result = await run('/w 好感度 10003', { userId: OWNER }, { isOwner: true, isAdmin: false });
  assert.match(result.text, /QQ 10003/);
  assert.match(result.text, /42\.0 \/ 100/);
  assert.match(result.text, /本群关系摘要/);

  result = await run('/w 好感度', { userId: OWNER, atTargets: [MEMBER] }, { isOwner: true, isAdmin: false });
  assert.match(result.text, /QQ 10003/);

  result = await run('/w affinity 10003', { userId: OWNER }, { isOwner: true, isAdmin: false });
  assert.match(result.text, /QQ 10003/);
  assert.match(result.text, /42\.0 \/ 100/);

  // Long `/wuxin` prefix must resolve the same Chinese commands and aliases.
  seed();
  result = await run('/wuxin 好感度', { userId: OWNER }, { isOwner: true, isAdmin: false });
  assert.match(result.text, /QQ 10001/);
  assert.match(result.text, /特殊/);
  result = await run('/wuxin affinity 10003', { userId: OWNER }, { isOwner: true, isAdmin: false });
  assert.match(result.text, /QQ 10003/);
  assert.match(result.text, /42\.0 \/ 100/);
  for (const text of ['/wuxin 好感榜', '/wuxin 好感排名', '/wuxin affinity-top']) {
    result = await run(text, { userId: OWNER }, { isOwner: true, isAdmin: false });
    assert.match(result.text, /Pippi 好感榜/, text);
  }
  result = await run('/wuxin 指令 list', { userId: OWNER }, { isOwner: true, isAdmin: false });
  assert.match(result.text, /本会话没有已保存的长期指令/);
  result = await run('/wuxin directive list', { userId: OWNER }, { isOwner: true, isAdmin: false });
  assert.match(result.text, /本会话没有已保存的长期指令/);

  // Shared English paths: parser ids and actual owner/router handler branches.
  const routeCases = [
    ['/w group add 测试群', 'groupAdd'],
    ['/wuxin group add 测试群', 'groupAdd'],
    ['/w group profile show', 'groupProfileShow'],
    ['/wuxin group profile show', 'groupProfileShow'],
    ['/w group profile update', 'groupProfileEdit'],
    ['/wuxin group profile clear', 'groupProfileEdit'],
    ['/w prompt show', 'promptShow'],
    ['/wuxin prompt savebase', 'promptSavebase'],
    ['/w prompt add 内容', 'promptEdit'],
    ['/w model', 'modelShow'],
    ['/w model list', 'modelShow'],
    ['/wuxin model deepseek-v4-flash', 'modelSet'],
  ];
  for (const [text, handlerKey] of routeCases) {
    const route = routeFor(text);
    assert.equal(route.kind, 'handler', text);
    assert.equal(route.handlerKey, handlerKey, text);
  }

  // Read-only shared branches execute through the real handler; mutating
  // group/prompt/model branches are covered by the router assertions above.
  seed();
  for (const text of ['/wuxin prompt show', '/wuxin model', '/wuxin group profile show']) {
    result = await run(text, { userId: OWNER }, { isOwner: true, isAdmin: false });
    assert.ok(result.sent.length > 0, text);
    assert.ok(!result.text.includes('未知 Wuxin 指令'), text);
  }

  // Unknown shared branches and unknown commands stay rejected.
  for (const text of ['/w group', '/w group unknown', '/w group profile', '/w group profile unknown', '/wuxin group profile unknown']) {
    result = await run(text, { userId: OWNER }, { isOwner: true, isAdmin: false });
    assert.match(result.text, /用法/, text);
    const route = routeFor(text);
    assert.equal(route.kind, 'reply', text);
    assert.match(route.reply, /用法/, text);
  }
  for (const text of ['/w groupx', '/w promptx', '/wuxin 未知指令']) {
    result = await run(text, { userId: OWNER }, { isOwner: true, isAdmin: false });
    assert.match(result.text, /未知 Wuxin 指令/, text);
    const route = routeFor(text);
    assert.equal(route.kind, 'reply', text);
    assert.match(route.reply, /未知 Wuxin 指令/, text);
  }

  // Forged permission flags and administrator status cannot grant Owner.
  for (const text of ['/w 好感度 10003', '/w affinity 10003', '/w 好感榜', '/w directive list']) {
    result = await run(text, { userId: MEMBER }, { isOwner: true, isAdmin: true });
    assert.match(result.text, /只有所有者可以使用这个指令/, text);
  }

  // ── Ranking: canonical + aliases, group default, private default, invalid args ──
  seed();
  for (const text of ['/w 好感榜', '/w 好感排名', '/w affinity-top']) {
    result = await run(text, { userId: OWNER }, { isOwner: true, isAdmin: false });
    assert.match(result.text, /Pippi 好感榜/, text);
    assert.match(result.text, /本群/, text);
  }
  result = await run('/w 好感榜 全局', { userId: OWNER }, { isOwner: true, isAdmin: false });
  assert.match(result.text, /Pippi 好感榜/);
  assert.match(result.text, /全局/);
  result = await run('/w 好感榜', { userId: OWNER, type: 'private', groupId: 'private' }, { isOwner: true, isAdmin: false });
  assert.match(result.text, /Pippi 好感榜/);
  assert.match(result.text, /全局/);
  result = await run('/w 好感榜 本群', { userId: OWNER, type: 'private', groupId: 'private' }, { isOwner: true, isAdmin: false });
  assert.match(result.text, /用法/);

  // ── Invalid inputs do not mutate social state ──
  seed();
  const socialBefore = JSON.stringify(store.readDb().socialV2);
  for (const text of [
    '/w 好感度 not-a-qq',
    '/w 好感度 10003 extra',
    '/w affinity 10003 extra',
    '/w 好感榜 全局 extra',
    '/w 好感榜 本群 extra',
  ]) {
    result = await run(text, { userId: OWNER }, { isOwner: true, isAdmin: false });
    assert.match(result.text, /用法/, text);
  }
  assert.equal(JSON.stringify(store.readDb().socialV2), socialBefore);

  // ── Unknown commands stay rejected ──
  for (const text of ['/w 未知指令', '/w 好感度x', '/w affinityx', '/w 指令x']) {
    result = await run(text, { userId: OWNER }, { isOwner: true, isAdmin: false });
    assert.match(result.text, /未知 Wuxin 指令/, text);
  }

  // ── Directive: actual state, list/set/revoke, aliases, invalid input, scope ──
  seed();
  result = await run('/w 指令 set 称呼 简洁回答', { userId: OWNER }, { isOwner: true, isAdmin: false });
  assert.match(result.text, /已保存/);
  let active = state.activeOwnerDirectives(store.readDb(), `group:${GROUP}`);
  assert.equal(active.length, 1);
  assert.equal(active[0].key, '称呼');
  assert.equal(active[0].text, '简洁回答');

  result = await run('/w 指令 list', { userId: OWNER }, { isOwner: true, isAdmin: false });
  assert.match(result.text, /称呼/);
  assert.match(result.text, /简洁回答/);
  result = await run('/w directive list', { userId: OWNER }, { isOwner: true, isAdmin: false });
  assert.match(result.text, /称呼/);
  assert.match(result.text, /简洁回答/);

  result = await run('/w 指令 set 称呼', { userId: OWNER }, { isOwner: true, isAdmin: false });
  assert.match(result.text, /指令执行失败/);
  active = state.activeOwnerDirectives(store.readDb(), `group:${GROUP}`);
  assert.equal(active.length, 1);
  assert.equal(active[0].text, '简洁回答');

  result = await run('/w 指令 unknown 称呼', { userId: OWNER }, { isOwner: true, isAdmin: false });
  assert.match(result.text, /用法/);
  assert.equal(state.activeOwnerDirectives(store.readDb(), `group:${GROUP}`).length, 1);

  // Free-form directive content may contain spaces; this is not an invalid
  // extra-argument case.
  result = await run('/w 指令 set 称呼 简洁回答 补充', { userId: OWNER }, { isOwner: true, isAdmin: false });
  assert.match(result.text, /已保存/);
  assert.equal(state.activeOwnerDirectives(store.readDb(), `group:${GROUP}`)[0].text, '简洁回答 补充');

  result = await run('/w 指令 list', { userId: OWNER, groupId: OTHER_GROUP }, { isOwner: true, isAdmin: false });
  assert.match(result.text, /本会话没有已保存的长期指令/);
  result = await run('/w 指令 list', { userId: OWNER, type: 'private', groupId: 'private' }, { isOwner: true, isAdmin: false });
  assert.match(result.text, /本会话没有已保存的长期指令/);

  result = await run('/w 指令 revoke 称呼', { userId: OWNER }, { isOwner: true, isAdmin: false });
  assert.match(result.text, /已撤销/);
  assert.equal(state.activeOwnerDirectives(store.readDb(), `group:${GROUP}`).length, 0);

  // Directive permission boundary is the configured system Owner, not flags.
  result = await run('/w 指令 list', { userId: MEMBER }, { isOwner: true, isAdmin: true });
  assert.match(result.text, /只有所有者可以使用这个指令/);
  seed();
  result = await run('/w 指令 set 越权 内容', { userId: MEMBER }, { isOwner: true, isAdmin: true });
  assert.match(result.text, /只有所有者可以使用这个指令/);
  assert.equal(store.readDb().ownerDirectives.length, 0);

  console.log('owner command: generated examples, Chinese aliases, argument rejection, scope and Owner permissions PASS');
}

try {
  await main();
} finally {
  cleanupTestDir(dataDir);
}
