/**
 * 图片查看功能验证测试
 *
 * 测试场景:
 * 1. 引用消息图片 — 引用含图消息时图片被提取
 * 2. "看上文图片" — 用户要求看上下文图片时触发回复
 * 3. 上下文图片搜索 — 无附图时从近期消息找图
 * 4. 视觉限制 — 不支持视觉时正确提示
 */

import { extractReplyMessageId, asksToInspectVisual, extractImageInputs } from '../server/bot/cleaning.ts';
import { decideReply } from '../server/bot.ts';

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

async function main() {
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

  // Case A: vision capable + ask to inspect + no images → should reply
  const d3a = decideReply({
    db: visionDb, group, userPolicy: ownerPolicy,
    text: '小深 看上文图片', mentioned: true, userId: 'owner1', images: []
  });
  assert(d3a.shouldReply === true, 'vision capable + ask to inspect should reply');
  assert(d3a.visualLimitation !== true, 'should NOT be visual limitation');

  // Case B: vision capable + ask to inspect + has images → should reply
  const d3b = decideReply({
    db: visionDb, group, userPolicy: ownerPolicy,
    text: '小深 看看这张[图片]', mentioned: true, userId: 'owner1',
    images: [{ type: 'image', url: 'http://example.com/a.jpg' }]
  });
  assert(d3b.shouldReply === true, 'vision capable + images should reply');

  // Case C: NOT vision capable + ask to inspect → should reply with visualLimitation
  const noVisionDb = {
    settings: {
      globalPaused: false, onlyMentionMode: false, selfQq: '999', botNames: '小深,bot',
      model: 'deepseek-v4-flash', llmProvider: 'deepseek', apiBaseUrl: 'https://api.deepseek.com',
    },
    messages: [],
  };
  const d3c = decideReply({
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
  console.log('\nAll vision verification tests PASSED.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
