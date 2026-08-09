import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-model-switch-'));
process.env.DATA_DIR = dataDir;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const {
  activateModelProfile,
  ensureProviderProfiles,
  recoverProviderProfiles,
  updateProviderSettings,
  DEEPSEEK_BASE_URL,
  MIMO_BASE_URL
} = await import('../server/modelConfig.ts');
const { ensureStore, publicDb, readDb, writeDb } = await import('../server/store.ts');
const { createLLMClient } = await import('../server/bot/llm.ts');
const { processIncoming } = await import('../server/bot.ts');

try {
  const profiles = {
    llmProvider: 'deepseek',
    apiBaseUrl: DEEPSEEK_BASE_URL,
    apiKey: 'ds-secret',
    deepseekApiKey: 'ds-secret',
    deepseekApiBaseUrl: DEEPSEEK_BASE_URL,
    mimoApiKey: 'mimo-secret',
    mimoApiBaseUrl: MIMO_BASE_URL,
    model: 'deepseek-chat'
  };
  const mimo = activateModelProfile(profiles, 'mimo-v2.5');
  assert(mimo.llmProvider === 'openai-compatible', 'Mimo model must select OpenAI-compatible provider');
  assert(mimo.apiBaseUrl === MIMO_BASE_URL && mimo.apiKey === 'mimo-secret', 'Mimo model must select Mimo endpoint and key');

  const deepseek = activateModelProfile(mimo, 'deepseek-reasoner');
  assert(deepseek.llmProvider === 'deepseek', 'DeepSeek model must select DeepSeek provider');
  assert(deepseek.apiBaseUrl === DEEPSEEK_BASE_URL && deepseek.apiKey === 'ds-secret', 'DeepSeek model must restore DeepSeek endpoint and key');

  const placeholderCleaned = ensureProviderProfiles({
    llmProvider: 'deepseek', apiBaseUrl: DEEPSEEK_BASE_URL,
    apiKey: '已填写', deepseekApiKey: '已填写', model: 'deepseek-chat'
  });
  assert(!placeholderCleaned.apiKey && !placeholderCleaned.deepseekApiKey, 'secret placeholders must never be migrated back into provider profiles');

  const recovered = recoverProviderProfiles({
    llmProvider: 'openai-compatible', apiBaseUrl: MIMO_BASE_URL, apiKey: 'mimo-live', model: 'mimo-v2.5'
  }, [{ settings: { llmProvider: 'deepseek', apiBaseUrl: DEEPSEEK_BASE_URL, apiKey: 'old-ds-key', model: 'deepseek-chat' } }]);
  assert(recovered.mimoApiKey === 'mimo-live' && recovered.deepseekApiKey === 'old-ds-key', 'legacy snapshots should recover separate provider keys safely');

  const guiSwitch = updateProviderSettings(profiles, {
    ...publicDb({ settings: profiles, messages: [], decisions: [], commandLogs: [], memories: [] }).settings,
    model: 'mimo-v2.5',
    llmProvider: 'openai-compatible',
    apiBaseUrl: MIMO_BASE_URL,
    apiKey: '已填写'
  });
  assert(guiSwitch.apiKey === 'mimo-secret', 'GUI placeholder must activate the target saved key, not copy the old active key');

  const generic = updateProviderSettings(profiles, {
    llmProvider: 'openai-compatible', apiBaseUrl: 'https://example-llm.invalid/v1',
    apiKey: 'generic-secret', model: 'example-chat'
  });
  assert(generic.apiKey === 'generic-secret' && generic.mimoApiKey === 'mimo-secret', 'unknown OpenAI-compatible providers must not overwrite the Mimo profile');

  const resolvedClient = createLLMClient({ settings: profiles }, 'mimo-v2.5');
  assert(resolvedClient.provider === 'openai-compatible' && resolvedClient.baseURL === MIMO_BASE_URL, 'request layer must resolve provider from requested model');

  ensureStore();
  const db = readDb();
  db.settings = { ...db.settings, ...profiles, ownerQq: '10001', selfQq: '10002' };
  db.groups = [{ groupId: '990001', name: 'Switch Test', enabled: true, mode: 'mention', maxPerHour: 20, cooldownSec: 0 }];
  writeDb(db);
  const sent = [];
  const event = (text) => ({
    source: 'gui', type: 'group', messageId: `switch-${Date.now()}-${Math.random()}`,
    groupId: '990001', userId: '10001', nickname: 'Owner', text, atTargets: [], raw: {}
  });
  await processIncoming(event('/w model mimo-v2.5'), async (_event, text) => sent.push(String(text)));
  let after = readDb();
  assert(after.settings.model === 'mimo-v2.5' && after.settings.apiKey === 'mimo-secret', '/w model must atomically activate Mimo profile');
  await processIncoming(event('/w model deepseek-chat'), async (_event, text) => sent.push(String(text)));
  after = readDb();
  assert(after.settings.model === 'deepseek-chat' && after.settings.apiKey === 'ds-secret', '/w model must atomically restore DeepSeek profile');
  assert(sent.some((text) => text.includes('Mimo / OpenAI 兼容接口')), 'command reply must report the selected provider');

  const masked = publicDb(after).settings;
  assert(masked.apiKey === '已填写' && masked.deepseekApiKey === '已填写' && masked.mimoApiKey === '已填写', 'all provider keys must be masked');
  console.log('PASS model/provider switching: migration, GUI, QQ command, request routing, secret masking');
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
