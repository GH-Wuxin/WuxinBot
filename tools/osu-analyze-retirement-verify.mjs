import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestDataDir, cleanupTestDir } from './test-isolation.mjs';

const directory = createTestDataDir('wuxin-analyze-retirement');
const originalFetch = globalThis.fetch;
let secondDirectory;
try {
  const { ensureStore, updateDb, readDb, normalizeDb } = await import('../server/store.ts');
  const { OSU_SUBCOMMANDS, OSU_CLEAR_ACTIONS_META, parseOsuCommandText } = await import('../server/bot/commands/osu.meta.ts');
  const { OWNER_COMMANDS } = await import('../server/bot/commands/owner.meta.ts');
  const { getAllCommandHelpEntries } = await import('../server/bot/commands/index.ts');
  const { getPersonaStudioCatalog } = await import('../server/promptStudio.ts');
  ensureStore();
  assert.equal('analyze' in OSU_SUBCOMMANDS, false);
  assert.equal('history' in OSU_CLEAR_ACTIONS_META, false);
  assert.equal(parseOsuCommandText('/w osu analyze mrekk'), null);
  assert.equal(parseOsuCommandText('/w osu clear history'), null);
  assert.equal(OWNER_COMMANDS.some(c => c.id === 'osuAnalyze'), false);
  assert.ok(!getAllCommandHelpEntries().some(c => c.canonicalSyntax.startsWith('/w osu analyze')));
  for (const id of ['info', 'osuUpdate', 'skill']) assert.ok(OWNER_COMMANDS.some(c => c.id === id), id);
  assert.equal(getPersonaStudioCatalog({}).some(m => m.id === 'osu_analyzer'), false);
  assert.ok(getPersonaStudioCatalog({}).some(m => m.id === 'pippi_activity'));

  const legacy = structuredClone(readDb());
  Object.assign(legacy.settings, { pplusReferences: [123], commandPermissions: { ...legacy.settings.commandPermissions, osuAnalyze: 'guest', osuClearHistory: 'guest', info: 'guest' },
    personaModulePrompts: { osu_analyzer: 'retired supplement', pippi_activity: 'keep this' } });
  legacy.osuAnalyses = [{ userId: 'member', fullText: 'existing historical report' }];
  const migrated = normalizeDb(legacy);
  assert.equal('osuAnalyze' in migrated.settings.commandPermissions, false);
  assert.equal('osuClearHistory' in migrated.settings.commandPermissions, false);
  assert.equal('pplusReferences' in migrated.settings, false);
  assert.equal('osu_analyzer' in migrated.settings.personaModulePrompts, false);
  assert.equal(migrated.settings.personaModulePrompts.pippi_activity, 'keep this');
  assert.equal(migrated.osuAnalyses[0].fullText, 'existing historical report');

  updateDb(db => {
    Object.assign(db.settings, { ownerQq: '10001', selfQq: '10002', globalPaused: false, socialV2Enabled: false, memoryEnabled: false,
      thinkingNoticeMode: 'off', levelUpNotifyEnabled: false, osuSearchEnabled: false, stickerDeliveryMode: 'off' });
    db.groups = [{ groupId: '20001', name: 'Fixture', enabled: true, mode: 'osu', cooldownSec: 0, maxPerHour: 100 }];
    db.users = []; db.messages = []; db.osuBindings = {};
  });
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('Retired command must not invoke network or a model'); };
  const { processIncoming } = await import('../server/bot.ts');
  const sends = [];
  for (const text of ['/w osu analyze', '/w osu analyze mrekk --mode=std', '/wuxin osu analyze mrekk', '/w osu help']) {
    const result = await processIncoming({ source: 'onebot', type: 'group', groupId: '20001', userId: '10003', nickname: 'Fixture',
      messageId: crypto.randomUUID(), text, atTargets: [], images: [], raw: {} }, async (_event, reply) => {
      sends.push(String(reply)); return { outcome: 'confirmed_success', messageId: crypto.randomUUID() };
    });
    assert.equal(result.replied, true);
  }
  assert.ok(sends.slice(0, 3).every(text => text.includes('未知 osu 子命令')));
  assert.ok(!sends.at(-1).includes('/w osu analyze')); assert.ok(sends.at(-1).includes('/w update'));
  assert.equal(networkCalls, 0);
  globalThis.fetch = originalFetch;

  // The remaining profile cache still follows DATA_DIR and preserves historical
  // report bytes without restarting a removed worker or dropping player data.
  const file = path.join(directory, 'osu-console-profiles.json');
  const old = { '123': { profile: { fetchedAt: '2026-10-20T00:00:00Z', user: { username: 'old player' } },
    analysis: { status: 'running', at: '2026-10-20T00:00:00Z', text: 'historical result' } } };
  const serialized = JSON.stringify(old); fs.writeFileSync(file, serialized);
  const { getStoredProfile, setStoredProfile } = await import('../server/osu/profileStore.ts');
  assert.equal(getStoredProfile(123).user.username, 'old player');
  assert.equal(fs.readFileSync(file, 'utf8'), serialized, 'reading a retired job must not rewrite data');
  setStoredProfile(123, { username: 'refreshed' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8'))['123'].analysis, old['123'].analysis);
  secondDirectory = createTestDataDir('wuxin-profile-root');
  assert.equal(getStoredProfile(123), null);
  process.env.DATA_DIR = directory;
  assert.equal(getStoredProfile(123).user.username, 'refreshed');
  console.log('PASS retired analyze: no registration, help, network/LLM calls; settings cleanup; existing reports and profile isolation preserved');
} finally { globalThis.fetch = originalFetch; cleanupTestDir(secondDirectory); cleanupTestDir(directory); }
