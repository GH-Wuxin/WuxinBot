import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideReply, processIncoming } from '../server/bot.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dbPath = process.env.DATA_DIR || path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:', 'AppData', 'Roaming'), 'Wuxin', 'db.json');
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
    writeJson(dbPath, db);

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
    assert(sent.some((text) => text.includes('看不到图片') || text.includes('只能读文字')), 'visual limitation reply should explain limitation');

    const mimoDecision = decideReply({
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
    fs.writeFileSync(dbPath, originalRaw, 'utf8');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
