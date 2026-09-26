import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-runtime-safety-'));
process.env.DATA_DIR = dataDir;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const { acquireInstanceLock, INSTANCE_LOCK_FILENAME } = await import('../server/instanceLock.ts');
  const { persistedInboundDuplicate } = await import('../server/bot/queue.ts');

  const releaseFirst = acquireInstanceLock(18787);
  let duplicateRejected = false;
  try {
    acquireInstanceLock(18788);
  } catch (error) {
    duplicateRejected = error?.code === 'WUXIN_INSTANCE_ALREADY_RUNNING';
  }
  assert(duplicateRejected, 'a second server for the same DATA_DIR must be rejected');
  releaseFirst();
  assert(!fs.existsSync(path.join(dataDir, INSTANCE_LOCK_FILENAME)), 'owned instance lock must be removed on release');

  const releaseRestart = acquireInstanceLock(18789);
  releaseRestart();

  const event = {
    source: 'onebot',
    type: 'group',
    groupId: 'fixture-group',
    messageId: 'fixture-message',
  };
  const draft = {
    messages: [{
      sourceMessageId: 'fixture-message',
      type: 'group',
      groupId: 'fixture-group',
    }],
  };
  assert(persistedInboundDuplicate(draft, event), 'persisted OneBot message id must be rejected across processes');
  assert(!persistedInboundDuplicate(draft, { ...event, messageId: 'new-message' }), 'new message id must remain accepted');
  assert(!persistedInboundDuplicate(draft, { ...event, source: 'gui' }), 'GUI fixtures must bypass OneBot persistence dedupe');

  const indexSource = fs.readFileSync(path.resolve('server/index.ts'), 'utf8');
  assert(indexSource.includes('const expected = cachedAdminPassword'), 'API auth must use the lightweight password cache');
  assert(!indexSource.includes("const expected = String(readDb().settings.adminPassword"), 'API auth must not parse the full DB per request');

  console.log('PASS runtime safety: singleton lock, persisted inbound dedupe and lightweight API auth');
}

main()
  .finally(() => {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
