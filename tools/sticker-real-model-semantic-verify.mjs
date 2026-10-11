import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readDb } from '../server/store.ts';
import { completeChat } from '../server/bot/llm.ts';
import { listModelStickers } from '../server/bot/stickers/index.ts';
import {
  buildStickerReplyInstruction,
  parseStickerReply,
} from '../server/bot/stickers/finalReply.ts';

const root = process.cwd();
const scenarioPath = path.resolve(root, 'docs/sticker-release/scenarios.json');
const allScenarios = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
assert.ok(Array.isArray(allScenarios) && allScenarios.length >= 40, 'scenario fixture must contain at least 40 cases');
const selectedIds = String(process.env.STICKER_SEMANTIC_IDS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const scenarios = selectedIds.length
  ? allScenarios.filter((scenario) => selectedIds.includes(scenario.id))
  : allScenarios;
assert.ok(scenarios.length > 0, 'scenario filter selected no cases');

const provider = 'codex-app-server';
const concurrency = Math.max(1, Math.min(3, Number(process.env.STICKER_SEMANTIC_CONCURRENCY || 2)));
const timeoutMs = Math.max(10_000, Math.min(45_000, Number(process.env.STICKER_SEMANTIC_TIMEOUT_MS || 25_000)));
const outputPath = path.resolve(
  process.env.STICKER_SEMANTIC_OUTPUT
    || path.join('docs', 'sticker-release', 'evidence', `real-model-codex-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}.json`),
);

// Read production settings without changing the production store. All usage
// accounting from this verifier is redirected to a disposable DATA_DIR before
// the first completion is started.
const productionDb = readDb();
const settings = {
  ...productionDb.settings,
  llmProvider: provider,
  codexFallbackEnabled: false,
};
assert.ok(String(settings.codexExecutable || '').trim(), 'Codex executable is not configured');
const db = { ...productionDb, settings };
const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-sticker-semantic-'));
process.env.DATA_DIR = tempDataDir;

const validStickerIds = new Set(listModelStickers().map((entry) => entry.id));
const systemPrompt = [
  '你正在执行一次 Pippi 表情语境评估。每个测试场景彼此独立。',
  '请像正常群聊中的 Pippi 一样先理解用户真正想表达什么，再决定表情是否有额外表达价值。',
  '不要为了达到发送比例而发送图片；严肃、重要、敏感、需要准确说明的内容优先只用文字。',
  '不要调用工具，也不要在 reply 中泄漏评估过程、规则或清单。',
  buildStickerReplyInstruction(),
].join('\n');

function safeError(error) {
  return String(error?.message || error || 'unknown error')
    .replace(/(?:sk|ds|tp)-[A-Za-z0-9_-]{10,}/giu, '[redacted-key]')
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/\s+/gu, ' ')
    .slice(0, 500);
}

function checkResult(scenario, parsed) {
  const stickerValid = parsed.stickerId === null || validStickerIds.has(parsed.stickerId);
  const modeAllowed = scenario.acceptableModes.includes(parsed.mode);
  const textPresent = !scenario.mustRemainText || Boolean(parsed.reply.trim());
  const shapeValid = parsed.structured
    && stickerValid
    && modeAllowed
    && textPresent
    && (parsed.mode === 'none' ? parsed.stickerId === null : Boolean(parsed.stickerId))
    && (parsed.mode !== 'text_image' || Boolean(parsed.reply.trim()));
  return {
    protocolOk: shapeValid,
    stickerValid,
    modeAllowed,
    textPresent,
    mustRemainText: scenario.mustRemainText,
  };
}

async function evaluate(scenario) {
  const started = Date.now();
  try {
    const result = await completeChat(db, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: scenario.input },
      ],
      model: String(settings.codexModel || 'gpt-6-luna'),
      maxTokens: 220,
      timeoutMs,
      requestMaxRetries: 0,
      retryOnEmpty: false,
      promptStudioApplied: true,
      traceRole: 'verification',
      tracePurpose: 'Pippi 表情真实模型语境评估',
      label: 'Pippi 表情真实模型语境评估',
    });
    const parsed = parseStickerReply(String(result.text || ''));
    const checks = checkResult(scenario, parsed);
    return {
      id: scenario.id,
      category: scenario.category,
      ok: checks.protocolOk,
      latencyMs: Date.now() - started,
      mode: parsed.mode,
      stickerId: parsed.stickerId,
      structured: parsed.structured,
      ...checks,
    };
  } catch (error) {
    return {
      id: scenario.id,
      category: scenario.category,
      ok: false,
      latencyMs: Date.now() - started,
      mode: 'none',
      stickerId: null,
      structured: false,
      error: safeError(error),
    };
  }
}

async function runAll() {
  const results = [];
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= scenarios.length) return;
      const result = await evaluate(scenarios[index]);
      results[index] = result;
      process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'} ${result.id} ${result.mode}${result.stickerId ? `:${result.stickerId}` : ''} ${result.latencyMs}ms\n`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

const startedAt = new Date().toISOString();
const results = await runAll();
const byCategory = {};
for (const result of results) {
  byCategory[result.category] ||= { total: 0, pass: 0, fail: 0 };
  byCategory[result.category].total += 1;
  if (result.ok) byCategory[result.category].pass += 1;
  else byCategory[result.category].fail += 1;
}
const summary = {
  ok: results.every((result) => result.ok),
  provider,
  model: String(settings.codexModel || 'gpt-6-luna'),
  startedAt,
  finishedAt: new Date().toISOString(),
  scenarioCount: results.length,
  concurrency,
  timeoutMs,
  catalogCount: validStickerIds.size,
  byCategory,
  // The artifact intentionally contains no full prompt, reply, credential,
  // or private chat content. Human semantic review can use the scenario ID,
  // selected ID, mode, and the source fixture separately.
  results,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ...summary, evidencePath: outputPath }, null, 2));
if (!summary.ok) process.exitCode = 2;
