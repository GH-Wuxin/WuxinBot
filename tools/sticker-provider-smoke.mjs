import { readDb } from '../server/store.ts';
import { completeChat } from '../server/bot/llm.ts';
import {
  buildStickerReplyInstruction,
  parseStickerReply,
  STICKER_REPLY_RESPONSE_FORMAT,
} from '../server/bot/stickers/finalReply.ts';

const baseDb = readDb();
const commonOptions = {
  messages: [
    {
      role: 'system',
      content: `${buildStickerReplyInstruction()}\n这是供应商兼容性冒烟测试。不要调用工具，直接回复“兼容性测试通过”。`,
    },
    { role: 'user', content: '请完成兼容性测试。' },
  ],
  responseFormat: STICKER_REPLY_RESPONSE_FORMAT,
  maxTokens: 120,
  timeoutMs: 30_000,
  requestMaxRetries: 0,
  retryOnEmpty: false,
  promptStudioApplied: true,
  traceRole: 'verification',
  tracePurpose: '贴纸最终回复格式供应商冒烟测试',
  label: '贴纸供应商冒烟测试',
};

function safeError(error) {
  return String(error?.message || error || 'unknown error')
    .replace(/(?:sk|ds)-[A-Za-z0-9_-]{12,}/gu, '[redacted-key]')
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .slice(0, 500);
}

async function runProvider(name, db, options = {}) {
  const started = Date.now();
  try {
    const result = await completeChat(db, { ...commonOptions, ...options });
    const parsed = parseStickerReply(String(result.text || ''));
    return {
      provider: name,
      ok: Boolean(parsed.structured && parsed.reply),
      model: result.model || db.settings.model || '',
      latencyMs: Date.now() - started,
      structuredReply: parsed.structured,
      stickerId: parsed.stickerId,
      ...(parsed.structured && parsed.reply ? {} : { error: 'response_not_parseable' }),
    };
  } catch (error) {
    return {
      provider: name,
      ok: false,
      model: options.model || options.overrideModel || db.settings.model || '',
      latencyMs: Date.now() - started,
      error: safeError(error),
    };
  }
}

const results = [];
const currentSettings = baseDb.settings || {};

if (String(currentSettings.codexExecutable || '').trim()) {
  results.push(await runProvider('codex-app-server', {
    ...baseDb,
    settings: {
      ...currentSettings,
      llmProvider: 'codex-app-server',
      // This probe must report the native provider result; it must not hide a
      // Codex failure behind a fallback provider.
      codexFallbackEnabled: false,
    },
  }, {
    model: String(currentSettings.codexModel || 'gpt-6-luna').trim(),
  }));
} else {
  results.push({ provider: 'codex-app-server', ok: false, skipped: 'unconfigured' });
}

const deepseekKey = String(currentSettings.deepseekApiKey || '').trim();
if (deepseekKey) {
  const deepseekBaseUrl = String(
    currentSettings.deepseekApiBaseUrl || 'https://api.deepseek.com',
  ).trim();
  const deepseekModel = String(
    currentSettings.codexFallbackModel || 'deepseek-v4-flash',
  ).trim();
  results.push(await runProvider('deepseek', {
    ...baseDb,
    settings: {
      ...currentSettings,
      llmProvider: 'deepseek',
      apiKey: deepseekKey,
      apiBaseUrl: deepseekBaseUrl,
      model: deepseekModel,
      codexFallbackEnabled: false,
    },
  }, { model: deepseekModel }));
} else {
  results.push({ provider: 'deepseek', ok: false, skipped: 'unconfigured' });
}

const openAiKey = String(
  process.env.OPENAI_API_KEY
    || (String(currentSettings.llmProvider || '') === 'openai-compatible'
      ? currentSettings.apiKey
      : ''),
).trim();
const openAiBaseUrl = String(
  process.env.OPENAI_BASE_URL
    || (String(currentSettings.llmProvider || '') === 'openai-compatible'
      ? currentSettings.apiBaseUrl
      : '')
    || 'https://api.openai.com/v1',
).trim();
const openAiModel = String(
  process.env.OPENAI_MODEL
    || (String(currentSettings.llmProvider || '') === 'openai-compatible'
      ? currentSettings.model
      : ''),
).trim();
if (openAiKey && openAiModel) {
  results.push(await runProvider('openai-compatible', {
    ...baseDb,
    settings: {
      ...currentSettings,
      llmProvider: 'openai-compatible',
      apiKey: openAiKey,
      apiBaseUrl: openAiBaseUrl,
      model: openAiModel,
      codexFallbackEnabled: false,
    },
  }, { model: openAiModel }));
} else {
  results.push({ provider: 'openai-compatible', ok: false, skipped: 'unconfigured' });
}

console.log(JSON.stringify({
  ok: results.filter((item) => !item.skipped).every((item) => item.ok),
  note: '仅输出 provider/model/耗时/解析结果；未输出 key 或完整模型回复。',
  results,
}, null, 2));

