import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ISOLATION_MARK = Symbol.for('wuxin.agentReplay.isolated');

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function productionDataDir(): string {
  return path.resolve(
    process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:', 'AppData', 'Roaming'),
    'Wuxin',
  );
}

async function productionDbFingerprint(): Promise<string> {
  try {
    const bytes = await fs.readFile(path.join(productionDataDir(), 'db.json'));
    return `present:${createHash('sha256').update(bytes).digest('hex')}`;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return 'missing';
    throw new Error('HARNESS_ISOLATED: unable to fingerprint the production DB');
  }
}

export function assertReplayIsolation(): {
  dataDir: string;
  tempDataDir: true;
  fetchBlocked: true;
  networkBlockScope: 'globalThis.fetch';
  productionDbBaselineCaptured: true;
} {
  const rawDataDir = String(process.env.DATA_DIR || '');
  const dataDir = rawDataDir ? path.resolve(rawDataDir) : '';
  const tempRoot = path.resolve(os.tmpdir());
  const tripwire = (globalThis as any)[ISOLATION_MARK];
  const isReplayTemp = Boolean(dataDir) && dataDir.startsWith(tempRoot + path.sep) &&
    path.basename(dataDir).startsWith('wuxin-agent-replay-');
  if (process.env.NODE_ENV !== 'test' || !isReplayTemp || samePath(dataDir, productionDataDir()) ||
      typeof tripwire !== 'function' || globalThis.fetch !== tripwire) {
    throw new Error('HARNESS_ISOLATED: replay requires NODE_ENV=test, a replay temp DATA_DIR, and the fetch tripwire');
  }
  return {
    dataDir,
    tempDataDir: true,
    fetchBlocked: true,
    networkBlockScope: 'globalThis.fetch',
    productionDbBaselineCaptured: true,
  };
}

export async function installReplayIsolation(): Promise<{
  dataDir: string;
  assertProductionDbUnchanged(): Promise<true>;
  restore(): Promise<void>;
}> {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldDataDir = process.env.DATA_DIR;
  const oldFetch = globalThis.fetch;
  const productionDbBefore = await productionDbFingerprint();
  const tempRoot = path.resolve(os.tmpdir());
  const dataDir = await fs.mkdtemp(path.join(tempRoot, 'wuxin-agent-replay-'));
  const resolved = path.resolve(dataDir);
  if (samePath(resolved, productionDataDir()) || !resolved.startsWith(tempRoot + path.sep)) {
    throw new Error(`refusing unsafe replay DATA_DIR: ${resolved}`);
  }

  process.env.NODE_ENV = 'test';
  process.env.DATA_DIR = resolved;
  const fetchTripwire = (async () => {
    throw new Error('HARNESS_ISOLATED: outbound network access blocked');
  }) as typeof fetch;
  globalThis.fetch = fetchTripwire;
  (globalThis as any)[ISOLATION_MARK] = fetchTripwire;
  assertReplayIsolation();

  const assertProductionDbUnchanged = async (): Promise<true> => {
    const productionDbAfter = await productionDbFingerprint();
    if (productionDbAfter !== productionDbBefore) {
      throw new Error('HARNESS_ISOLATED: production DB changed during replay');
    }
    return true;
  };

  return {
    dataDir: resolved,
    assertProductionDbUnchanged,
    async restore() {
      let invariantError: unknown;
      try {
        await assertProductionDbUnchanged();
      } catch (error) {
        invariantError = error;
      }
      globalThis.fetch = oldFetch;
      delete (globalThis as any)[ISOLATION_MARK];
      if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = oldNodeEnv;
      if (oldDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = oldDataDir;
      const target = path.resolve(resolved);
      if (target.startsWith(tempRoot + path.sep) && path.basename(target).startsWith('wuxin-agent-replay-')) {
        await fs.rm(target, { recursive: true, force: true });
      }
      if (invariantError) throw invariantError;
    },
  };
}
