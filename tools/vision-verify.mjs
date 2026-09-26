/**
 * 图片查看功能验证测试
 *
 * 测试场景:
 * 1. 引用消息图片 — 引用含图消息时图片被提取
 * 2. "看上文图片" — 用户要求看上下文图片时触发回复
 * 3. 上下文图片搜索 — 无附图时从近期消息找图
 * 4. 视觉限制 — 不支持视觉时正确提示
 */

import { createTestDataDir, cleanupTestDir } from './test-isolation.mjs';
const testDataDir = createTestDataDir('wuxin-vision');
process.on('exit', () => cleanupTestDir(testDataDir));
const { extractReplyMessageId, asksToInspectVisual, extractImageInputs } = await import('../server/bot/cleaning.ts');
const { collectEventVisionImages, decideReply } = await import('../server/bot.ts');
const { completeChat } = await import('../server/bot/llm.ts');
const { buildPrompt, modelSupportsVision, responseOptionsFor } = await import('../server/bot/prompt.ts');

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

async function main() {
  const textOnlyHistoryDb = {
    settings: {
      llmProvider: 'deepseek', apiBaseUrl: 'https://api.deepseek.com', model: 'deepseek-chat',
      visionMode: 'auto', ownerQq: 'owner1', selfQq: 'bot1', contextLimit: 30,
      personalityPrompt: '测试', botNames: '小深', ignoreSystemFacts: true
    },
    messages: [{ role: 'user', type: 'group', groupId: 'g1', userId: 'u1', nickname: '用户', content: '[图片]', createdAt: new Date().toISOString() }],
    users: [], memories: [], groupProfiles: [], relationshipProfiles: []
  };
  const textOnlyPrompt = buildPrompt(textOnlyHistoryDb, { groupId: 'g1', name: '测试群' }, {
    type: 'group', groupId: 'g1', userId: 'u2', nickname: '当前用户', text: '继续聊', atTargets: []
  }, { policy: 'normal' });
  const historyText = textOnlyPrompt.slice(1, -1).map((message) => String(message.content || '')).join('\n');
  assert(!historyText.includes('[图片]'), 'text-only model history must not retain pure image placeholders');

  // ============================================================
  // Test 1: extractReplyMessageId
  // ============================================================
  console.log('Test 1: extractReplyMessageId');

  // String format: [CQ:reply,id=12345]
  assert(extractReplyMessageId('[CQ:reply,id=12345] text here') === '12345', 'should extract from string CQ');
  assert(extractReplyMessageId('[CQ:reply,id=abc-123]') === 'abc-123', 'should extract with dash id');
  assert(extractReplyMessageId('[CQ:at,qq=123] no reply') === null, 'should return null when no reply');
  assert(extractReplyMessageId('plain text') === null, 'should return null for plain text');
  assert(extractReplyMessageId('') === null, 'should return null for empty');

  // Array format (OneBot segment)
  assert(extractReplyMessageId([{ type: 'reply', data: { id: '999' } }]) === '999', 'should extract from array segment');
  assert(extractReplyMessageId([{ type: 'at', data: { qq: '123' } }]) === null, 'should return null for array without reply');
  assert(extractReplyMessageId([]) === null, 'should return null for empty array');

  console.log('PASS: Test 1 — extractReplyMessageId');

  // ============================================================
  // Test 2: asksToInspectVisual — extended patterns
  // ============================================================
  console.log('Test 2: asksToInspectVisual — extended patterns');

  // Original patterns (with [图片] placeholder)
  assert(asksToInspectVisual('看看这张[图片]') === true, 'should match 看看+图片');
  assert(asksToInspectVisual('帮我识别[图片]') === true, 'should match 识别+图片');
  assert(asksToInspectVisual('[图片]') === false, 'pure placeholder should not match');

  // New patterns: "看上文图片" without [图片] placeholder
  assert(asksToInspectVisual('看上文图片') === true, 'should match 看上文图片');
  assert(asksToInspectVisual('看看上面的图') === true, 'should match 看看上面的图');
  assert(asksToInspectVisual('帮我看看之前的图片') === true, 'should match 看看之前的图片');
  assert(asksToInspectVisual('看看上面那个图') === true, 'should match 看看上面那个图');
  assert(asksToInspectVisual('看一下前面发的图') === true, 'should match 看一下前面发的图');

  // Should NOT match
  assert(asksToInspectVisual('你好啊') === false, 'should not match normal text');
  assert(asksToInspectVisual('看看这个消息') === false, 'should not match without 图/照片/图片 keyword');

  console.log('PASS: Test 2 — asksToInspectVisual extended patterns');

  // ============================================================
  // Test 3: decideReply — vision capable + ask to inspect
  // ============================================================
  console.log('Test 3: decideReply — vision capable + ask to inspect');

  const visionDb = {
    settings: {
      globalPaused: false,
      onlyMentionMode: false,
      selfQq: '999',
      botNames: '小深,bot',
      model: 'mimo-v2-omni',
      llmProvider: 'openai-compatible',
      apiBaseUrl: 'https://api.mimo-v2.com/v1',
    },
    messages: [],
  };
  const group = { groupId: 'g1', enabled: true, mode: 'natural', maxPerHour: 20, cooldownSec: 30 };
  const ownerPolicy = { policy: 'owner', attentionLevel: 5, allowCommands: true };
  const deepseekFlashVisionDb = {
    settings: {
      globalPaused: false, onlyMentionMode: false, selfQq: '999', botNames: '小深,bot',
      model: 'deepseek-v4-flash', llmProvider: 'deepseek', apiBaseUrl: 'https://api.deepseek.com',
      visionMode: 'auto', maxTokens: 300, enableAutoModel: true,
    },
    messages: [],
  };
  assert(modelSupportsVision(deepseekFlashVisionDb) === true, 'DeepSeek V4 Flash alias should support vision');
  const flashVisualOptions = responseOptionsFor(
    { text: '小深 看看这张[图片]', images: [{ type: 'image', url: 'http://example.com/a.jpg' }] },
    deepseekFlashVisionDb,
    ownerPolicy,
  );
  assert(flashVisualOptions.overrideModel === 'deepseek-v4-flash', 'visual owner turn must not auto-upgrade to text-only Pro');
  const pureFlashImage = await decideReply({
    db: deepseekFlashVisionDb, group, userPolicy: { policy: 'normal', attentionLevel: 3, allowCommands: false },
    text: '[图片]', mentioned: false, userId: 'u1',
    images: [{ type: 'image', url: 'http://example.com/pure.jpg' }],
  });
  assert(pureFlashImage.shouldReply === false, 'a real pure image must not trigger an unsolicited reply without mention');
  assert(pureFlashImage.inContext !== false, 'a real pure image should enter conversation context');
  const mentionedFlashImage = await decideReply({
    db: deepseekFlashVisionDb, group, userPolicy: { policy: 'normal', attentionLevel: 3, allowCommands: false },
    text: '[CQ:at,qq=999][图片]', mentioned: true, userId: 'u1',
    images: [{ type: 'image', url: 'http://example.com/mentioned.jpg' }],
  });
  assert(mentionedFlashImage.shouldReply === true, 'a real image explicitly mentioning Pippi should trigger Vision');
  const placeholderOnly = await decideReply({
    db: deepseekFlashVisionDb, group, userPolicy: { policy: 'normal', attentionLevel: 3, allowCommands: false },
    text: '[图片]', mentioned: false, userId: 'u1', images: [],
  });
  assert(placeholderOnly.shouldReply === false, 'an image placeholder without payload must stay silent');
  assert(placeholderOnly.inContext === false, 'an image placeholder without payload must not enter context');
  const quotedVisionEvent = {
    type: 'group', groupId: 'g1', userId: 'u1', nickname: '提问者',
    text: '@Pippi 这个图是什么', atTargets: [], images: [],
    replyMessageId: 'quoted-1',
    quotedMessage: {
      messageId: 'quoted-1', text: '被引用的原图', nickname: '原发送者',
      images: [{ type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' }],
    },
  };
  const quotedVisionImages = collectEventVisionImages(quotedVisionEvent);
  assert(quotedVisionImages.length === 1, 'quoted image must join the current Vision input');
  const quotedPrompt = buildPrompt({
    ...deepseekFlashVisionDb,
    users: [], memories: [], groupProfiles: [], relationshipProfiles: [],
  }, { groupId: 'g1', name: '测试群' }, quotedVisionEvent, { policy: 'normal' });
  assert(String(quotedPrompt.at(-1)?.content).includes('【所回复的 QQ 消息｜原发送者】被引用的原图'), 'quoted text must be explicit in the current user prompt');

  // Case A: vision capable + ask to inspect + no images → should reply
  const d3a = await decideReply({
    db: visionDb, group, userPolicy: ownerPolicy,
    text: '小深 看上文图片', mentioned: true, userId: 'owner1', images: []
  });
  assert(d3a.shouldReply === true, 'vision capable + ask to inspect should reply');
  assert(d3a.visualLimitation !== true, 'should NOT be visual limitation');

  // Case B: vision capable + ask to inspect + has images → should reply
  const d3b = await decideReply({
    db: visionDb, group, userPolicy: ownerPolicy,
    text: '小深 看看这张[图片]', mentioned: true, userId: 'owner1',
    images: [{ type: 'image', url: 'http://example.com/a.jpg' }]
  });
  assert(d3b.shouldReply === true, 'vision capable + images should reply');

  // Case C: NOT vision capable + ask to inspect → should reply with visualLimitation
  const noVisionDb = {
    settings: {
      globalPaused: false, onlyMentionMode: false, selfQq: '999', botNames: '小深,bot',
      model: 'deepseek-chat', llmProvider: 'deepseek', apiBaseUrl: 'https://api.deepseek.com',
    },
    messages: [],
  };
  const d3c = await decideReply({
    db: noVisionDb, group, userPolicy: ownerPolicy,
    text: '小深 看上文图片', mentioned: true, userId: 'owner1', images: []
  });
  assert(d3c.shouldReply === true, 'not vision capable + ask should still reply');
  assert(d3c.visualLimitation === true, 'should be visual limitation');

  console.log('PASS: Test 3 — decideReply vision scenarios');

  // ============================================================
  // Test 4: extractImageInputs
  // ============================================================
  console.log('Test 4: extractImageInputs');

  // From CQ string
  const imgs4a = extractImageInputs('[CQ:image,file=abc,url=http://example.com/a.jpg]');
  assert(imgs4a.length === 1, 'should extract 1 image from CQ string');
  assert(imgs4a[0].url === 'http://example.com/a.jpg', 'should have correct url');

  // From array segment
  const imgs4b = extractImageInputs([{ type: 'image', data: { url: 'http://x.com/b.png', file: 'b' } }]);
  assert(imgs4b.length === 1, 'should extract 1 image from array');
  assert(imgs4b[0].url === 'http://x.com/b.png', 'should have correct url from array');

  // No images
  assert(extractImageInputs('plain text').length === 0, 'should return empty for plain text');
  assert(extractImageInputs('').length === 0, 'should return empty for empty string');

  console.log('PASS: Test 4 — extractImageInputs');

  // ============================================================
  // Test 5: Flash alias wire mapping + DeepSeek image transport
  // ============================================================
  console.log('Test 5: DeepSeek Flash Vision wire request');

  const originalFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (input, init) => {
    const rawBody = init?.body ?? (typeof input?.clone === 'function' ? await input.clone().text() : '');
    capturedBody = JSON.parse(String(rawBody || '{}'));
    return new Response(JSON.stringify({
      id: 'vision-test',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-v4-flash-vision-exp',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '看到了' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await completeChat({
      settings: {
        ...deepseekFlashVisionDb.settings,
        apiKey: 'sk-offline-test',
        deepseekApiKey: 'sk-offline-test',
        deepseekApiBaseUrl: 'https://api.deepseek.com',
        visionImageTransport: 'auto',
      },
    }, {
      messages: quotedPrompt,
      visionImages: quotedVisionImages,
      requestMaxRetries: 0,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert(capturedBody?.model === 'deepseek-v4-flash-vision-exp', 'wire model must be DeepSeek Flash Vision');
  const wireParts = capturedBody?.messages?.at(-1)?.content;
  assert(Array.isArray(wireParts), 'DeepSeek Vision user content must be multipart');
  assert(wireParts.some((part) => part?.type === 'image_url'), 'DeepSeek Vision request must include image_url');

  console.log('PASS: Test 5 — DeepSeek Flash alias sends image to Vision endpoint');

  // ============================================================
  console.log('\nAll vision verification tests PASSED.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
