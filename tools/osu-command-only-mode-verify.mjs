import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-osu-only-'));
process.env.DATA_DIR = dataDir;

function check(condition, label, detail = '') {
  if (!condition) throw new Error(`FAIL [${label}]${detail ? ` ${detail}` : ''}`);
  console.log(`PASS [${label}]`);
}

const GROUP_ID = '991337';
const OWNER_ID = '10000001';

function event(text, messageId) {
  return {
    source: 'gui',
    type: 'group',
    messageId,
    groupId: GROUP_ID,
    userId: OWNER_ID,
    nickname: 'ModeOwner',
    text,
    atTargets: [],
    raw: {},
  };
}

try {
  const { ensureStore, readDb, writeDb } = await import('../server/store.ts');
  const { processIncoming, allowedByOsuCommandOnlyMode } = await import('../server/bot.ts');
  const { matchQuickCommand } = await import('../server/bot/quickRouter.ts');
  ensureStore();
  const db = structuredClone(readDb());
  db.settings.ownerQq = OWNER_ID;
  db.settings.selfQq = '10000002';
  db.settings.globalPaused = false;
  db.settings.quickRouterEnabled = true;
  db.settings.apiKey = 'must-not-be-used';
  db.groups = [{
    groupId: GROUP_ID,
    name: 'OsuOnlyFixture',
    enabled: true,
    mode: 'osu',
    maxPerHour: 100,
    cooldownSec: 0,
  }];
  db.messages = [];
  db.decisions = [];
  db.memories = [];
  db.groupProfiles = [{ groupId: GROUP_ID, enabled: true, pendingCount: 7, atmosphere: 'existing' }];
  db.pendingPairCounts = { [`${GROUP_ID}:a:b`]: 3 };
  db.experience = {};
  db.groupExperience = {};
  db.commandLogs = [];
  db.adminActions = [];
  writeDb(db);

  const sent = [];
  const send = async (_event, text) => sent.push(String(text || ''));
  const protectedBefore = JSON.stringify({
    messages: readDb().messages,
    decisions: readDb().decisions,
    memories: readDb().memories,
    groupProfiles: readDb().groupProfiles,
    pendingPairCounts: readDb().pendingPairCounts,
    experience: readDb().experience,
    groupExperience: readDb().groupExperience,
  });

  const chat = await processIncoming(event('小深，评价一下这张图', 'osu-only-chat'), send);
  check(chat.replied === false && String(chat.reason).includes('仅 osu! 指令'), 'ordinary-chat-hard-blocked');
  check(sent.length === 0, 'ordinary-chat-silent');
  const protectedAfter = JSON.stringify({
    messages: readDb().messages,
    decisions: readDb().decisions,
    memories: readDb().memories,
    groupProfiles: readDb().groupProfiles,
    pendingPairCounts: readDb().pendingPairCounts,
    experience: readDb().experience,
    groupExperience: readDb().groupExperience,
  });
  check(protectedAfter === protectedBefore, 'ordinary-chat-no-context-or-profile-side-effects');

  const ping = await processIncoming(event('/w ping', 'osu-only-ping'), send);
  check(ping.replied === false && sent.length === 0, 'non-osu-command-blocked');
  check(!(readDb().commandLogs || []).some((entry) => entry.messageId === 'osu-only-ping'), 'blocked-command-not-dispatched');

  check(
    allowedByOsuCommandOnlyMode(event('!r', 'quick-osu'), matchQuickCommand(event('!r', 'quick-osu'))) === true,
    'metadata-osu-quick-allowed',
  );
  check(
    allowedByOsuCommandOnlyMode(event('!ping', 'quick-system'), matchQuickCommand(event('!ping', 'quick-system'))) === false,
    'non-osu-quick-blocked',
  );

  sent.length = 0;
  const quickOsu = await processIncoming(event('!r', 'osu-only-quick'), send);
  check(
    quickOsu.replied === true && sent.some((text) => text.includes('绑定')),
    'osu-quick-command-allowed',
    JSON.stringify({ quickOsu, sent }),
  );
  check(readDb().messages.length === 0, 'osu-quick-command-not-added-to-chat-context');

  sent.length = 0;
  const help = await processIncoming(event('/w osu help', 'osu-only-help'), send);
  check(help.replied === true && sent.length === 1 && /osu/i.test(sent[0]), 'wuxin-osu-command-allowed');
  check(readDb().messages.length === 0, 'osu-command-not-added-to-chat-context');

  sent.length = 0;
  await processIncoming(event('/w mode natural', 'osu-only-exit'), send);
  check(readDb().groups[0].mode === 'natural', 'mode-escape-hatch');
  await processIncoming(event('/w mode osu', 'osu-only-enter'), send);
  check(readDb().groups[0].mode === 'osu', 'mode-can-be-enabled');
  check(sent.some((text) => text.includes('普通消息不会进入 LLM')), 'mode-enable-explains-hard-boundary');

  console.log('osu command-only group mode checks passed');
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
