import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createTestDataDir, assertNotProduction, productionDbSnapshot, verifyProductionDbUnchanged, cleanupTestDir } from './test-isolation.mjs';

const testDataDir = createTestDataDir('wuxin-onebot');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);

const prodBefore = productionDbSnapshot();
console.log('[isolation] production db snapshot: ' + (prodBefore ? prodBefore.sha256.slice(0, 12) + '...' : 'N/A'));

const port = 19877;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const { ensureStore, readDb, updateDb } = await import('../server/store.ts');
  const { handleOneBotEvent, sendOneBotMessage } = await import('../server/onebot.ts');
  const { compactDirectToolLead, processIncoming } = await import('../server/bot.ts');
  const {
    registerPendingBotCall,
    tryResolveBotResponse
  } = await import('../server/bots/executor.ts');
  const { sendAsReply } = await import('../server/osu/commands.ts');
  ensureStore();
  updateDb((db) => {
    db.settings.oneBotHttpUrl = `http://127.0.0.1:${port}`;
    db.settings.oneBotAccessToken = '';
    db.settings.ownerQq = '1000000001';
    db.settings.selfQq = '900000029';
    // Keep route drain windows short so repeated fixture calls on the same
    // bot route can be exercised without waiting for production defaults.
    db.settings.botResponseImageDrainMs = 30;
    db.settings.botResponseTextDrainMs = 40;
    db.settings.botResponseTimeoutDrainMs = 40;
  });

  let mode = 'failed';
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(mode === 'failed'
      ? { status: 'failed', retcode: 100, message: 'mock failure' }
      : { status: 'ok', retcode: 0, data: { message_id: 1 } }));
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  let llmCalls = 0;
  let llmFixtureMode = 'image';
  const llmServer = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = raw ? JSON.parse(raw) : {};
    llmCalls += 1;
    const alreadyHasToolResult = (request.messages || []).some((message) => message.role === 'tool');
    const message = alreadyHasToolResult
      ? {
          role: 'assistant',
          content: llmFixtureMode === 'bp-list' ? '#2 Sid...' : '查好了。'
        }
      : {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'fixture-tool-call',
            type: 'function',
            function: {
              name: 'query_bot',
              arguments: JSON.stringify({
                bot: 'fixture-private-bot',
                command: llmFixtureMode === 'bp-list' ? 'bp' : 'recent',
                username: '[TST]Alpha'
              })
            }
          }]
        };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: `fixture-completion-${llmCalls}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: request.model || 'deepseek-v4-pro',
      choices: [{
        index: 0,
        message,
        finish_reason: alreadyHasToolResult ? 'stop' : 'tool_calls'
      }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
    }));
  });
  await new Promise((resolve) => llmServer.listen(0, '127.0.0.1', resolve));
  const llmPort = llmServer.address().port;

  try {
    let failed = false;
    try {
      await sendOneBotMessage({ type: 'group', groupId: '1', userId: '2' }, 'test');
    } catch (error) {
      failed = /retcode 100/.test(String(error?.message));
    }
    assert(failed, 'HTTP 200 with failed retcode must reject');

    mode = 'ok';
    await sendOneBotMessage({ type: 'group', groupId: '1', userId: '2' }, 'test');
    console.log('PASS: OneBot HTTP business status verification');

    const sent = [];
    const duplicateEvent = {
      source: 'onebot',
      type: 'group',
      messageId: 'onebot-dedupe-test-1',
      groupId: '10001',
      userId: '1000000001',
      nickname: 'Owner',
      text: '/w ping',
      atTargets: [],
      raw: {}
    };
    const captureSend = async (_event, text) => {
      sent.push(String(text || ''));
    };
    const first = await processIncoming(duplicateEvent, captureSend);
    const duplicate = await processIncoming(duplicateEvent, captureSend);
    const next = await processIncoming(
      { ...duplicateEvent, messageId: 'onebot-dedupe-test-2' },
      captureSend
    );
    assert(first.replied === true, 'first OneBot event must be processed');
    assert(duplicate.replied === false && duplicate.duplicate === true, 'duplicate message_id must be ignored');
    assert(next.replied === true, 'different message_id must still be processed');
    assert(sent.length === 2, `dedupe test expected 2 sends, got ${sent.length}`);
    console.log('PASS: duplicate OneBot message_id suppression');

    const privateCommandSends = [];
    const privateCommand = await processIncoming({
      source: 'onebot',
      type: 'private',
      messageId: 'private-owner-command-reply',
      groupId: 'private',
      userId: '1000000001',
      nickname: 'Owner',
      text: '/w ping',
      atTargets: [],
      raw: {}
    }, async (_event, text) => {
      privateCommandSends.push(String(text || ''));
    });
    assert(privateCommand.replied === true, 'owner private command must execute');
    assert(privateCommandSends.length === 1 && privateCommandSends[0].includes('pong'), 'owner private command must send its reply');
    console.log('PASS: owner private commands preserve the QQ send callback');

    updateDb((db) => {
      db.settings.botRegistry = {
        updatedAt: new Date().toISOString(),
        bots: [
          {
            id: 'fixture-group-bot',
            name: 'Fixture Group Bot',
            description: 'group interception fixture',
            qq: '900000001',
            channel: 'qq_group',
            groupId: '10001',
            enabled: true,
            commands: [{
              name: 'recent',
              trigger: '/r',
              description: 'recent',
              params: [],
              returns: 'both'
            }]
          },
          {
            id: 'fixture-private-bot',
            name: 'Fixture Private Bot',
            description: 'private interception fixture',
            qq: '900000002',
            channel: 'qq_private',
            enabled: true,
            commands: [{
              name: 'recent',
              trigger: '/r',
              description: 'recent',
              params: [],
              returns: 'both'
            }]
          }
        ]
      };
    });

    const groupPending = registerPendingBotCall({
      correlationId: 'onebot-group-route',
      botId: 'fixture-group-bot',
      channel: 'qq_group',
      groupId: '10001'
    }, 2_000);
    let interceptedFallbackSends = 0;
    const groupHandled = await handleOneBotEvent({
      post_type: 'message',
      message_type: 'group',
      group_id: 10001,
      user_id: 900000001,
      message_id: 7001,
      raw_message: '成绩图[CQ:image,file=score.jpg,url=https://example.invalid/score.jpg]',
      message: [
        { type: 'text', data: { text: '成绩图' } },
        { type: 'image', data: { file: 'score.jpg', url: 'https://example.invalid/score.jpg' } }
      ],
      sender: { nickname: 'Fixture Group Bot', role: 'member' }
    }, async () => {
      interceptedFallbackSends += 1;
    });
    const groupResponse = await groupPending;
    assert(groupHandled.botResponse === true, 'group bot reply must be intercepted');
    assert(groupResponse.text.includes('成绩图'), 'intercepted group reply must keep normalized text');
    assert(groupResponse.images[0] === 'https://example.invalid/score.jpg', 'intercepted group reply must keep image URL');
    assert(interceptedFallbackSends === 0, 'intercepted group bot reply must not enter normal chat processing');

    const privatePending = registerPendingBotCall({
      correlationId: 'onebot-private-route',
      botId: 'fixture-private-bot',
      channel: 'qq_private'
    }, 2_000);
    const privateHandled = await handleOneBotEvent({
      post_type: 'message',
      message_type: 'private',
      user_id: 900000002,
      message_id: 7002,
      raw_message: '文字结果',
      message: [{ type: 'text', data: { text: '文字结果' } }],
      sender: { nickname: 'Fixture Private Bot' }
    }, async () => {
      interceptedFallbackSends += 1;
    });
    const privateResponse = await privatePending;
    assert(privateHandled.botResponse === true, 'private bot reply must be intercepted');
    assert(privateResponse.text === '文字结果', 'private bot reply must preserve text');
    assert(interceptedFallbackSends === 0, 'intercepted private bot reply must not enter normal chat processing');
    console.log('PASS: private/group bot response interception with image preservation');
    await sleep(60);

    updateDb((db) => {
      const fixtureBaseUrl = `http://127.0.0.1:${llmPort}/v1`;
      db.settings.model = 'deepseek-v4-flash';
      db.settings.llmProvider = 'deepseek';
      db.settings.apiKey = 'fixture-key';
      db.settings.deepseekApiKey = 'fixture-key';
      db.settings.apiBaseUrl = fixtureBaseUrl;
      db.settings.deepseekApiBaseUrl = fixtureBaseUrl;
      db.settings.enableAutoModel = false;
      db.settings.thinkingNoticeMode = 'simple';
      db.settings.memoryEnabled = false;
      // Include yumu (internal) for deterministic routing and fixture-private-bot
      // for the LLM tool loop fallback test.
      db.settings.botRegistry = {
        updatedAt: new Date().toISOString(),
        bots: [
          {
            id: 'yumu', name: '雨沐', description: 'osu! data',
            qq: '', channel: 'internal', enabled: true,
            commands: [
              { name: 'bp', trigger: '/bp', description: 'best plays', params: [], returns: 'image' },
            ]
          },
          {
            id: 'fixture-private-bot',
            name: 'Fixture Private Bot',
            description: 'private tool-loop fixture',
            qq: '900000002',
            channel: 'qq_private',
            enabled: true,
            commands: [{
              name: 'recent', trigger: '/r', description: 'recent', params: [], returns: 'both'
            }]
          }
        ]
      };
      // QQ → osu! binding for deterministic routing
      db.osuBindings = db.osuBindings || {};
      db.osuBindings['1000000001'] = 1234567;
    });

    const finalSends = [];
    let botCommandsSent = 0;
    const llmCallsBeforeDetRoute = llmCalls;
    const harnessResult = await processIncoming({
      source: 'gui',
      type: 'private',
      messageId: 'tool-det-route-output',
      groupId: 'private',
      userId: '1000000001',
      nickname: 'Owner',
      text: '查一下我的bp1',
      atTargets: [],
      raw: {}
    }, async (targetEvent, text, options) => {
      if (String(targetEvent.userId || '') === '900000002') {
        botCommandsSent += 1;
        return;
      }
      finalSends.push({ text: String(text || ''), options });
    });
    assert(harnessResult.replied === true, 'deterministic route must produce a reply');
    // Deterministic routing uses yumu (internal channel) — no QQ bot command is sent.
    assert(botCommandsSent === 0, `deterministic route must not send QQ bot command, got ${botCommandsSent}`);
    // Only one LLM call: the lead write after requiredTool execution.
    // (llmCalls increased from the baseline by exactly 1 for the lead call.)
    assert(llmCalls === llmCallsBeforeDetRoute + 1,
      `deterministic route must make exactly 1 LLM lead call, got ${llmCalls - llmCallsBeforeDetRoute}`);
    assert(finalSends.length >= 1, `deterministic route must send at least one message, got ${finalSends.length}`);
    console.log('PASS: deterministic osu! routing executes before LLM tool loop');

    // ── LLM tool loop path (non-osu-data message) ──
    updateDb((db) => {
      db.settings.botRegistry = {
        updatedAt: new Date().toISOString(),
        bots: [{
          id: 'fixture-private-bot',
          name: 'Fixture Private Bot',
          description: 'private tool-loop fixture',
          qq: '900000002',
          channel: 'qq_private',
          enabled: true,
          commands: [{
            name: 'recent', trigger: '/r', description: 'recent', params: [], returns: 'both'
          }]
        }]
      };
    });

    const llSends = [];
    let llBotCommandsSent = 0;
    const llCallsBeforeLL = llmCalls;
    const llHarnessResult = await processIncoming({
      source: 'gui',
      type: 'private',
      messageId: 'tool-loop-llm-output',
      groupId: 'private',
      userId: '1000000001',
      nickname: 'Owner',
      text: '帮我调一下osu机器人',
      atTargets: [],
      raw: {}
    }, async (targetEvent, text, options) => {
      if (String(targetEvent.userId || '') === '900000002') {
        llBotCommandsSent += 1;
        assert(String(text).includes('/r [TST]Alpha'), 'tool loop must send the selected bot command');
        const resolved = tryResolveBotResponse(
          readDb(),
          {
            type: 'private',
            userId: '900000002',
            text: '图片已生成',
            images: [{ url: 'https://example.invalid/rendered.jpg' }],
            messageId: 'tool-image-response'
          }
        );
        assert(resolved, 'fixture bot response must resolve the active tool request');
        return;
      }
      llSends.push({ text: String(text || ''), options });
    });
    assert(llHarnessResult.replied === true, 'LLM tool loop must produce a reply');
    assert(llBotCommandsSent === 1, `tool loop must send exactly one bot command, got ${llBotCommandsSent}`);
    assert(llmCalls === llCallsBeforeLL + 2,
      `tool loop must make one tool turn and one final turn, got ${llmCalls - llCallsBeforeLL}`);
    assert(llHarnessResult.images?.[0] === 'https://example.invalid/rendered.jpg',
      'process result must expose tool images structurally');
    assert(llSends.length === 1, `text+image result must be sent once, got ${llSends.length}`);
    assert(
      llSends[0].text === '查好了。\n[CQ:image,file=https://example.invalid/rendered.jpg]',
      `final QQ message must append the image deterministically: ${llSends[0].text}`
    );
    assert(!llSends[0].options?.forwardNodes, 'tool images must not be swallowed by merged-forward output');
    const storedImageReply = readDb().messages
      .filter((message) => message.role === 'assistant')
      .at(-1);
    assert(
      storedImageReply?.media?.images?.[0]?.url === 'https://example.invalid/rendered.jpg',
      'database history must preserve the image that was delivered directly'
    );
    assert(
      compactDirectToolLead('[CQ:at,qq=all][图片]', '', true) === '查好了，结果在图里。',
      'LLM lead cleanup must remove CQ controls and empty media placeholders'
    );
    assert(
      compactDirectToolLead('……', '完整结果', false) === '查好了，完整结果放在下面。',
      'punctuation-only cosmetic leads must use the deterministic fallback'
    );
    console.log('PASS: full LLM tool loop sends one deterministic QQ text+image message');
    await sleep(60);

    llmFixtureMode = 'bp-list';
    const completeBpList = [
      '[TST]Alpha 的前 10 个最佳成绩：',
      ...Array.from({ length: 10 }, (_, index) =>
        `  #${index + 1} ${index === 1 ? 'Sidetracked Day' : `Fixture Song ${index + 1}`} | 7.${String(index).padStart(2, '0')}★ | HD | 99.00% | ${560 - index}.0pp`
      ),
    ].join('\n');
    updateDb((db) => {
      db.settings.botRegistry = {
        updatedAt: new Date().toISOString(),
        bots: [{
          id: 'fixture-private-bot',
          name: 'Fixture Private Bot',
          description: 'private direct-list fixture',
          qq: '900000002',
          channel: 'qq_private',
          enabled: true,
          responsePolicy: { textSettleMs: 10, progressSettleMs: 20 },
          commands: [{
            name: 'bp',
            trigger: '/bp',
            description: 'complete BP list',
            params: [],
            returns: 'text'
          }]
        }]
      };
    });

    const directListSends = [];
    let bpCommandsSent = 0;
    const llmCallsBeforeDirectList = llmCalls;
    const directListHarnessResult = await processIncoming({
      source: 'gui',
      type: 'private',
      messageId: 'tool-direct-list-final-output',
      groupId: 'private',
      userId: '1000000001',
      nickname: 'Owner',
      text: '帮我调一下bp机器人',
      atTargets: [],
      raw: {}
    }, async (targetEvent, text, options) => {
      if (String(targetEvent.userId || '') === '900000002') {
        bpCommandsSent += 1;
        assert(String(text).includes('/bp [TST]Alpha'), 'direct-list query must send the selected BP command');
        const resolved = tryResolveBotResponse(
          readDb(),
          {
            type: 'private',
            userId: '900000002',
            text: completeBpList,
            images: [],
            messageId: 'tool-direct-list-response'
          }
        );
        assert(resolved, 'complete BP fixture response must resolve the active tool request');
        return;
      }
      directListSends.push({ text: String(text || ''), options });
    });
    assert(directListHarnessResult.replied === true, 'direct BP list must produce a reply');
    assert(bpCommandsSent === 1, `direct-list flow must send exactly one bot command, got ${bpCommandsSent}`);
    assert(llmCalls - llmCallsBeforeDirectList === 2, 'direct-list flow must make one tool turn and one short-lead turn');
    assert(directListSends.length === 1, `direct BP result must be sent exactly once, got ${directListSends.length}`);
    assert(
      directListSends[0].text.startsWith('查好了，完整结果放在下面。\n\n[TST]Alpha 的前 10 个最佳成绩：'),
      `data-like LLM fragments must be replaced with a deterministic lead: ${directListSends[0].text}`
    );
    assert(directListSends[0].text.includes('#10 Fixture Song 10'), 'QQ delivery must retain the final BP row');
    assert(!directListSends[0].options?.forwardNodes, 'direct text must bypass merged-forward output');
    assert(directListHarnessResult.text.includes('#10 Fixture Song 10'), 'process result must expose the complete delivered text');
    const storedDirectReply = readDb().messages
      .filter((message) => message.role === 'assistant')
      .at(-1);
    assert(storedDirectReply?.content.includes('#10 Fixture Song 10'), 'database history must store the complete direct result');
    assert(!storedDirectReply?.content.endsWith('#2 Sid...'), 'database history must not store the truncated LLM fragment as the result');
    console.log('PASS: complete text panels bypass LLM restatement, segmentation and merged-forward');

    const reportCalls = [];
    const reportBlocks = ['账号档案', 'Top 100', 'PP+ 六维', 'pippi']
      .map((title) => `【${title}】\n${'x'.repeat(120)}`)
      .join('\n\n');
    await sendAsReply(
      {
        type: 'group',
        groupId: '10001',
        userId: '1000000001',
        nickname: 'Owner',
        raw: { self_id: 900000029 }
      },
      async (event, text, options) => {
        reportCalls.push({ event, text, options });
      },
      reportBlocks
    );
    assert(reportCalls.length === 1, `long report must create one final send, got ${reportCalls.length}`);
    assert(reportCalls[0].options?.forwardNodes?.length === 4, 'each QQ report block must become one forward node');
    console.log('PASS: long osu! report sends one final message');
  } finally {
    await new Promise((resolve) => llmServer.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
}

main().then(() => {
  const prodOk = verifyProductionDbUnchanged(prodBefore);
  if (!prodOk) {
    console.error('FATAL: production database was modified during test!');
    process.exit(1);
  }
  console.log('[isolation] production db unchanged: ' + prodOk);
  cleanupTestDir(testDataDir);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
