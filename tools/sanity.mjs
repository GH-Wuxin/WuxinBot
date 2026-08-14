import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sanityDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-sanity-'));
process.env.DATA_DIR = sanityDataDir;
const dbPath = path.join(sanityDataDir, 'db.json');
const sanityOwnerQq = '10000001';
const sanityBotQq = '10000002';
const sanityNormalUserQq = '10000003';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function event(overrides) {
  return {
    source: 'sanity',
    type: 'group',
    messageId: `sanity-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    groupId: '990001',
    userId: sanityOwnerQq,
    nickname: 'SanityOwner',
    text: '',
    atTargets: [],
    raw: {},
    ...overrides
  };
}

async function main() {
  const { ensureStore, publicDb } = await import('../server/store.ts');
  const { decideReply, processIncoming } = await import('../server/bot.ts');
  const { mentionsBot, normalizeMessage } = await import('../server/bot/cleaning.ts');
  ensureStore();

  const originalRaw = fs.readFileSync(dbPath, 'utf8').replace(/^﻿/, '');
  const original = JSON.parse(originalRaw);
  const sent = [];
  const sendMessage = async (_event, text) => {
    sent.push(String(text || ''));
  };

  try {
    const db = structuredClone(original);
    db.settings.ownerQq = sanityOwnerQq;
    db.settings.selfQq = sanityBotQq;
    db.settings.botNames = db.settings.botNames || 'Wuxin,小深,机器人,bot';
    db.settings.globalPaused = false;
    db.settings.onlyMentionMode = false;
    db.settings.llmProvider = 'deepseek';
    db.settings.apiBaseUrl = 'https://api.deepseek.com';
    db.settings.model = 'deepseek-v4-flash';
    db.settings.apiKey = 'sanity-secret';
    db.settings.visionMode = 'auto';
    db.groups = [
      ...(db.groups || []).filter((group) => !['990001', '990002', '990003'].includes(String(group.groupId))),
      {
        groupId: '990001',
        name: 'Sanity Group',
        enabled: true,
        mode: 'mention',
        maxPerHour: 20,
        cooldownSec: 30,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ];
    db.commandLogs = [];
    db.configSnapshots = [{
      at: new Date().toISOString(),
      settings: { apiKey: 'sanity-secret', oneBotAccessToken: 'sanity-token', adminPassword: 'sanity-password' }
    }];
    writeJson(dbPath, db);

    const browserState = publicDb(readJson(dbPath));
    assert(!('configSnapshots' in browserState), 'public state must not expose config snapshots');
    assert(browserState.settings.apiKey === '已填写', 'public state should mask the API key');

    assert(!mentionsBot('这bot疯了', db.settings), 'generic bot alias should not match inside a sentence');
    assert(mentionsBot('bot 在吗', db.settings), 'generic bot alias should still match at word boundary');
    assert(
      normalizeMessage('/w osu analyze &#91;SHK&#93;Wuxin') === '/w osu analyze [TST]Alpha',
      'raw_message should decode CQ-escaped brackets in osu! usernames'
    );
    assert(
      normalizeMessage([{ type: 'text', data: { text: '&#91;SHK&#93;Wuxin' } }]) === '[TST]Alpha',
      'array text segments should decode CQ-escaped brackets'
    );

    sent.length = 0;
    const ping = await processIncoming(event({ text: '/w ping' }), sendMessage);
    assert(ping.replied === true, '/w ping should reply for owner');
    assert(sent.some((text) => text.includes('pong')), '/w ping should send pong');

    sent.length = 0;
    const status = await processIncoming(event({ text: '/w status' }), sendMessage);
    assert(status.replied === true, '/w status should reply for owner');
    assert(sent.some((text) => text.includes('本群参数')), '/w status should include group settings');

    sent.length = 0;
    const pureAt = await processIncoming(event({
      text: `[CQ:at,qq=${sanityBotQq}]`,
      atTargets: [sanityBotQq]
    }), sendMessage);
    assert(pureAt.replied === false, 'pure @ should not reply');
    assert(String(pureAt.reason || '').includes('@/媒体/卡片'), 'pure @ reason should explain placeholder-only message');

    sent.length = 0;
    const image = await processIncoming(event({ text: '[图片]' }), sendMessage);
    assert(image.replied === false, 'pure image should not reply');

    sent.length = 0;
    const visualAsk = await processIncoming(event({
      text: `[CQ:at,qq=${sanityBotQq}] 看看这张图 [图片]`,
      atTargets: [sanityBotQq]
    }), sendMessage);
    assert(visualAsk.replied === true, 'explicit visual inspection request should get deterministic reply');
    assert(sent.some((text) => text.includes('看不了') || text.includes('看不到图片') || text.includes('只能读文字') || text.includes('没有拿到可读')), 'visual limitation reply should explain limitation');

    sent.length = 0;
    const externalBot = await processIncoming(event({
      userId: '10000009',
      nickname: '串串bot',
      senderRole: 'admin',
      text: 'fetch failed？这bot是不是疯了'
    }), sendMessage);
    const afterExternalBot = readJson(dbPath);
    const loggedExternalBot = afterExternalBot.messages.at(-1);
    assert(externalBot.replied === false, 'external bot-like sender should be ignored');
    assert(String(externalBot.reason || '').includes('其他机器人'), 'external bot ignore reason should be explicit');
    assert(loggedExternalBot?.inContext === false, 'external bot-like sender should not enter context');

    sent.length = 0;
    const humanWithAiName = await processIncoming(event({
      userId: '10000010',
      nickname: 'AI绘画爱好者',
      text: '普通聊天消息'
    }), sendMessage);
    const loggedHumanWithAiName = readJson(dbPath).messages.at(-1);
    assert(!String(humanWithAiName.reason || '').includes('其他机器人'), 'human nickname containing AI should not be treated as a bot');
    assert(loggedHumanWithAiName?.inContext !== false, 'human nickname containing AI should remain in context');

    sent.length = 0;
    const nakedSlash = await processIncoming(event({
      userId: sanityNormalUserQq,
      nickname: 'GroupAdmin',
      senderRole: 'admin',
      text: '/reset'
    }), sendMessage);
    assert(nakedSlash.replied === false, 'naked slash command should be ignored in group even for QQ admins');
    assert(sent.length === 0, 'naked slash command should not send Wuxin help');

    sent.length = 0;
    const typoCommand = await processIncoming(event({ text: '/w usgae' }), sendMessage);
    assert(typoCommand.replied === true, 'unknown /w command should reply briefly');
    assert(sent.length === 1 && sent[0].includes('未知 Wuxin 指令'), 'unknown /w command should not send full help');

    const mimoDecision = await decideReply({
      db: {
        ...db,
        settings: {
          ...db.settings,
          llmProvider: 'openai-compatible',
          apiBaseUrl: 'https://api.mimo-v2.com/v1',
          model: 'mimo-v2-omni',
          visionMode: 'auto'
        },
        messages: []
      },
      group: db.groups.find((group) => group.groupId === '990001'),
      userPolicy: { policy: 'normal', attentionLevel: 3, allowCommands: false },
      text: `[CQ:at,qq=${sanityBotQq}] 看看这张图 [图片]`,
      mentioned: true,
      userId: sanityNormalUserQq,
      images: [{ type: 'image', url: 'https://example.com/a.jpg' }]
    });
    assert(mimoDecision.shouldReply === true && !mimoDecision.visualLimitation, 'mimo visual request should enter vision path');

    sent.length = 0;
    const deniedGroupAdd = await processIncoming(event({
      groupId: '990002',
      userId: sanityNormalUserQq,
      nickname: 'NormalUser',
      text: '/w group add 普通人测试群'
    }), sendMessage);
    const deniedLog = readJson(dbPath).commandLogs.at(-1);
    assert(deniedGroupAdd.replied === true, 'non-owner /w group add should reply with denial');
    assert(String(deniedGroupAdd.reason || '').includes('只有所有者'), 'non-owner /w group add should be denied');
    assert(deniedLog?.status === 'denied', 'non-owner /w group add should be logged as denied');
    assert(!readJson(dbPath).groups.some((group) => String(group.groupId) === '990002'), 'non-owner /w group add must not create group');

    sent.length = 0;
    const ownerGroupAdd = await processIncoming(event({
      groupId: '990003',
      text: '/w group add SanityAddedGroup'
    }), sendMessage);
    const afterOwnerGroupAdd = readJson(dbPath);
    const addedGroup = afterOwnerGroupAdd.groups.find((group) => String(group.groupId) === '990003');
    assert(ownerGroupAdd.replied === true, 'owner /w group add should reply');
    assert(addedGroup?.enabled === true, 'owner /w group add should create enabled group');
    assert(addedGroup?.mode === 'mention', 'new group should default to mention mode');

    sent.length = 0;
    await processIncoming(event({
      groupId: '990003',
      text: '/w group add SanityRenamedGroup'
    }), sendMessage);
    const renamedGroup = readJson(dbPath).groups.find((group) => String(group.groupId) === '990003');
    assert(renamedGroup?.name === 'SanityRenamedGroup', 'owner /w group add should update existing group name');

    sent.length = 0;
    const invalidRate = await processIncoming(event({ text: '/w rate 2200' }), sendMessage);
    const lastCommand = readJson(dbPath).commandLogs.at(-1);
    assert(invalidRate.replied === true, 'invalid /w rate should reply');
    assert(lastCommand?.status === 'invalid', 'invalid /w rate should be logged as invalid');

    console.log('sanity ok');
  } finally {
    fs.rmSync(sanityDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
