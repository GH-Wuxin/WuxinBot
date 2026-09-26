// store-retention-verify.mjs — db.json history arrays must stay bounded.
// Prevents unbounded messages/decisions growth from making every store write
// (full-file rewrite) slower and backup copies bigger over time.
import { createTestDataDir, cleanupTestDir } from './test-isolation.mjs';

let failed = 0;
function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failed++;
  }
}

// ── Unit: applyRetention trims over-cap arrays, keeps the newest tail ──
const { applyRetention, normalizeDb } = await import('../server/store.ts');

const base = { messages: [], decisions: [], commandLogs: [], adminActions: [], toolCallLogs: [] };
for (let i = 0; i < 12_010; i++) base.messages.push({ id: `m${i}`, createdAt: `t${i}` });
for (let i = 0; i < 30_010; i++) base.decisions.push({ id: `d${i}`, createdAt: `t${i}` });
for (let i = 0; i < 2_010; i++) base.commandLogs.push({ id: `c${i}`, createdAt: `t${i}` });
for (let i = 0; i < 1_010; i++) base.adminActions.push({ id: `a${i}`, createdAt: `t${i}` });
for (let i = 0; i < 5_010; i++) base.toolCallLogs.push({ id: `t${i}`, createdAt: `t${i}` });

applyRetention(base);
assert(base.messages.length === 12_000, 'messages must be capped at 12_000');
assert(base.messages[0].id === 'm10', 'messages must keep the newest tail');
assert(base.messages[base.messages.length - 1].id === 'm12009', 'messages tail must end at the latest entry');
assert(base.decisions.length === 30_000, 'decisions must be capped at 30_000');
assert(base.decisions[0].id === 'd10', 'decisions must keep the newest tail');
assert(base.commandLogs.length === 2_000, 'commandLogs must be capped at 2_000');
assert(base.adminActions.length === 1_000, 'adminActions must be capped at 1_000');
assert(base.toolCallLogs.length === 5_000, 'toolCallLogs must be capped at 5_000');
assert(base.toolCallLogs[0].id === 't10', 'toolCallLogs must keep the newest tail');
assert(base.toolCallLogs[base.toolCallLogs.length - 1].id === 't5009', 'toolCallLogs tail must end at the latest entry');

// Under-cap arrays must be untouched.
const small = { messages: [{ id: 'keep' }], decisions: [], commandLogs: [], adminActions: [], toolCallLogs: [] };
applyRetention(small);
assert(small.messages.length === 1 && small.messages[0].id === 'keep', 'under-cap arrays must not be trimmed');

// osu clear cache is owner-only in the handler; the gate must not drift lower.
const drift = normalizeDb({ settings: { commandPermissions: { osuClearCache: 'admin' } } });
assert(drift.settings.commandPermissions.osuClearCache === 'owner', 'osuClearCache must normalize to owner');
assert(drift.settings.commandPermissions.osuClearHistory === 'guest', 'other osu clear permissions must keep their defaults');

// ── Integration: updateDb persists the cap in an isolated DATA_DIR ──
const testDataDir = createTestDataDir('wuxin-retention');
process.env.DATA_DIR = testDataDir;

const { ensureStore, updateDb, readDb } = await import('../server/store.ts');
ensureStore();
updateDb((db) => {
  db.messages = Array.from({ length: 12_005 }, (_, i) => ({ id: `m${i}`, role: 'user', content: 'x', groupId: 'g1', userId: 'u1', createdAt: new Date().toISOString() }));
  db.decisions = Array.from({ length: 30_005 }, (_, i) => ({ id: `d${i}`, groupId: 'g1', shouldReply: false, reason: 'x', createdAt: new Date().toISOString() }));
  db.toolCallLogs = Array.from({ length: 5_005 }, (_, i) => ({ id: `t${i}`, groupId: 'g1', userId: 'u1', toolCallId: `tc${i}`, capability: 'bp_type', args: {}, ok: true, latencyMs: 1, createdAt: new Date().toISOString() }));
});

const persisted = readDb();
assert(persisted.messages.length === 12_000, 'updateDb must persist the messages cap');
assert(persisted.messages[persisted.messages.length - 1].id === 'm12004', 'persisted messages must keep the newest entry');
assert(persisted.decisions.length === 30_000, 'updateDb must persist the decisions cap');
assert(persisted.decisions[persisted.decisions.length - 1].id === 'd30004', 'persisted decisions must keep the newest entry');
assert(persisted.toolCallLogs.length === 5_000, 'updateDb must persist the toolCallLogs cap');
assert(persisted.toolCallLogs[persisted.toolCallLogs.length - 1].id === 't5004', 'persisted toolCallLogs must keep the newest entry');

cleanupTestDir(testDataDir);

if (failed > 0) {
  console.error('STORE-RETENTION-VERIFY FAILED');
  process.exit(1);
}
console.log('store retention caps passed (messages/decisions/commandLogs/adminActions/toolCallLogs)');
process.exit(0);
