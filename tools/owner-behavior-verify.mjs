// owner-behavior-verify.mjs — R2 owner-dispatch behavior-preservation matrix.
//
// Uses an isolated DATA_DIR and captured sendMessage to verify the exact
// pre-R2 user-visible replies/reasons for safe, side-effect-free or
// permission-denied paths. Heavy LLM/profile paths are intentionally not
// exercised here; dispatch-verify covers structural coverage.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-owner-behavior-'));
process.env.DATA_DIR = testDataDir;

let passed = 0;
let failed = 0;

function pass(label) {
  passed += 1;
  console.log(`PASS: ${label}`);
}

function fail(label, detail = '') {
  failed += 1;
  console.error(`FAIL: ${label}${detail ? `\n  ${detail}` : ''}`);
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass(label);
  else fail(label, `got ${JSON.stringify(actual)}\nexpected ${JSON.stringify(expected)}`);
}

function assert(condition, label, detail = '') {
  if (condition) pass(label);
  else fail(label, detail);
}

async function main() {
  const store = await import('../server/store.js');
  const owner = await import('../server/bot/ownerCommands.js');
  store.ensureStore();
  store.updateDb((db) => {
    db.settings.ownerQq = 'OWNER';
    db.settings.selfQq = 'BOT';
    db.groups = [{
      groupId: '10001',
      name: 'G',
      enabled: true,
      mode: 'mention',
      maxPerHour: 20,
      cooldownSec: 30,
      createdAt: '',
      updatedAt: '',
    }];
  });

  async function run(text, isOwner = false, isAdmin = false, groupId = '10001') {
    const sent = [];
    const captured = [];
    const event = {
      source: 'onebot',
      type: 'group',
      groupId,
      userId: isOwner ? 'OWNER' : 'GUEST',
      nickname: isOwner ? 'Owner' : 'Guest',
      text,
      atTargets: [],
      raw: {},
    };
    const send = async (target, value, options) => {
      sent.push(String(value));
      captured.push({ value: String(value), options });
    };
    const result = await owner.handleOwnerCommand(event, send, { isOwner, isAdmin });
    return { result, sent, captured };
  }

  // ── Pre-R2 matrix (captured before decomposition) ──
  const matrix = [
    ['/w prompt', false, false, '未知 prompt 指令', undefined],
    ['/w foo', false, false, '未知 Wuxin 指令：/foo。用 /w help 查看帮助。', undefined],
    ['/w op', false, false, 'op 权限限制', '只有 bot 所有者可以使用 /w op。'],
    ['/w preset', false, false, '这个指令需要 管理员 或更高权限。', '这个指令需要 管理员 或更高权限。'],
    ['/w relation', false, false, '用法：/w relation show|update|clear @某人 @某人', '用法：/w relation show|update|clear @某人 @某人'],
    ['/w group profile show', false, false, '这个指令需要 管理员 或更高权限。', '这个指令需要 管理员 或更高权限。'],
    ['/w group add', false, false, '这个指令只有所有者可以使用。', '这个指令只有所有者可以使用。'],
    ['/w model', false, false, '这个指令需要 管理员 或更高权限。', '这个指令需要 管理员 或更高权限。'],
    ['/w exp', false, false, 'exp 权限限制', '只有 bot 所有者可以使用 /w exp。'],
    ['/w ping', false, false, 'pong，我在。', 'pong，我在。'],
  ];

  for (const [text, isOwner, isAdmin, reason, sent] of matrix) {
    const r = await run(text, isOwner, isAdmin);
    assertEqual(r.result.reason, reason, `reason: ${text}`);
    if (sent !== undefined) {
      assertEqual(r.sent.length ? r.sent[0] : undefined, sent, `sent: ${text}`);
    }
    assertEqual(r.result.replied, Boolean(r.sent.length), `replied: ${text}`);
  }

  // ── /w osu help delegated handler ──
  {
    const r = await run('/w osu help', false, false);
    assertEqual(r.result.reason, 'osu help', 'osu help reason');
    assert(
      r.sent.length === 1
        && r.sent[0].startsWith('osu! 命令：\n/w osu bind')
        && r.sent[0].includes('/w skill profile [玩家名]')
        && r.sent[0].includes('/w skill <BP名次或BID> [+Mods]')
        && r.sent[0].includes('/w cd <BID> [+Mods] <反馈>')
        && !r.sent[0].includes('/w osu recent'),
      'osu help contains Skill family and omits removed recent command',
    );
  }

  // ── Unknown prompt fallback bytes ──
  {
    const r = await run('/w prompt', false, false);
    assertEqual(r.result.reason, '未知 prompt 指令', 'prompt fallback reason');
    assert(
      r.sent.length === 1 && r.sent[0].includes('【成员管理】') && r.sent[0].includes('具体权限以控制台”权限”页为准。'),
      'prompt fallback uses preserved static help',
    );
  }

  // ── /w help body equivalence from hardcoded pre-R2 inventory ──
  {
    // Guest role only sees entries whose runtime default role is guest.
    const guest = await run('/w help', false, false);
    const body = guest.captured[0]?.options?.forwardNodes?.map((node) => node.data.content).join('\n') || '';
    assert(
      body.startsWith('Wuxin 指令 · 都可以简写为 /w · 以下是你有权限的指令\n【等级】\n/w lv (@某人) · 查看等级经验\n/w top · 查看群内等级排行榜'),
      'guest help header and level group unchanged',
    );
    assert(!body.includes('/w nick'), 'guest help hides trusted-only nick');
    assert(!body.includes('/w relation'), 'help inventory still has no relation entry');
    assert(body.endsWith('具体权限以控制台"权限"页为准。'), 'guest help footer unchanged');

    const ownerRun = await run('/w help', true, false);
    const ownerBody = ownerRun.captured[0]?.options?.forwardNodes?.map((node) => node.data.content).join('\n') || '';
    assert(ownerBody.includes('【等级】\n/w lv (@某人) · 查看等级经验\n/w exp'), 'owner help shows owner-only exp');
    assert(ownerBody.includes('/w refresh · 触发全局重算（仅 owner）'), 'owner help shows refresh');
  }

  // ── Summarize range-before-permission quirk ──
  {
    const r = await run('/w summarize 1000', false, false);
    assertEqual(r.result.reason, '总结消息条数范围：5-500。', 'summarize range check precedes permission');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(testDataDir, { recursive: true, force: true });
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  fs.rmSync(testDataDir, { recursive: true, force: true });
  process.exit(1);
});
