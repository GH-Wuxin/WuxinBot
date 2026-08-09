// safety-guard-verify.mjs — verifies the accidental-write/delete protection.
//
//   npx tsx tools/safety-guard-verify.mjs
//
// Checks:
//   1. fsSafe: delete targets must never be empty, drive roots, bases, or
//      outside an explicit base; base dirs must never be drive/user roots.
//   2. store: NODE_ENV=test must refuse writes that resolve to the production
//      data dir, while reads of an existing db and explicit DATA_DIR test
//      dirs keep working.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSafeBaseDir, assertSafeDeleteTarget } from '../server/fsSafe.ts';

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

function expectThrows(name, fn, pattern) {
  try {
    fn();
    record(name, false, 'expected an exception but none was thrown');
  } catch (error) {
    const message = String(error?.message || error);
    if (pattern && !pattern.test(message)) record(name, false, `wrong error: ${message}`);
    else record(name, true);
  }
}

function expectOk(name, fn) {
  try {
    fn();
    record(name, true);
  } catch (error) {
    record(name, false, String(error?.message || error));
  }
}

function testFsSafe() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-fssafe-'));
  try {
    const base = path.join(tmpRoot, 'builds');
    const inside = path.join(base, 'abc');
    const outside = path.join(tmpRoot, 'other');

    expectThrows('fsSafe: 拒绝空路径删除', () => assertSafeDeleteTarget(''));
    expectThrows('fsSafe: 拒绝文件系统根目录删除', () => assertSafeDeleteTarget('C:\\'));
    expectThrows('fsSafe: 拒绝删除 base 本身', () => assertSafeDeleteTarget(base, { base }));
    expectThrows('fsSafe: 拒绝 base 之外的目标', () => assertSafeDeleteTarget(outside, { base }));
    expectOk('fsSafe: 允许 base 内删除', () => {
      const resolved = assertSafeDeleteTarget(inside, { base });
      if (resolved !== path.resolve(inside)) throw new Error(`unexpected resolve: ${resolved}`);
    });
    expectThrows('fsSafe: 拒绝驱动器根作为构建根', () => assertSafeBaseDir('C:\\'));
    expectThrows('fsSafe: 拒绝用户主目录作为构建根', () => assertSafeBaseDir(os.homedir()));
    expectOk('fsSafe: 允许普通目录作为构建根', () => {
      const resolved = assertSafeBaseDir(tmpRoot);
      if (resolved !== path.resolve(tmpRoot)) throw new Error(`unexpected resolve: ${resolved}`);
    });
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function testStoreGuards() {
  const original = {
    APPDATA: process.env.APPDATA,
    DATA_DIR: process.env.DATA_DIR,
    NODE_ENV: process.env.NODE_ENV,
    ALLOW_PRODUCTION_WRITE: process.env.ALLOW_PRODUCTION_WRITE,
  };
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-store-safe-'));
  try {
    const prodPath = path.join(tmpRoot, 'Wuxin');
    process.env.APPDATA = tmpRoot;
    process.env.DATA_DIR = prodPath;
    process.env.NODE_ENV = 'test';
    delete process.env.ALLOW_PRODUCTION_WRITE;

    const store = await import('../server/store.ts');
    expectOk('store: isProductionDb 识别生产路径', () => {
      if (!store.isProductionDb()) throw new Error('expected isProductionDb() === true');
    });
    expectOk('store: getDataDir 实时跟随 DATA_DIR', () => {
      const resolved = path.resolve(prodPath);
      if (store.getDataDir() !== resolved) throw new Error(`unexpected data dir: ${store.getDataDir()}`);
    });

    expectThrows('store: NODE_ENV=test 拒绝 updateDb 写生产库', () => store.updateDb((db) => db), /安全防护/);
    expectThrows('store: NODE_ENV=test 拒绝 writeDb 写生产库', () => store.writeDb({ settings: {}, users: [] }), /安全防护/);
    expectThrows('store: NODE_ENV=test 拒绝 ensureStore 创建生产库', () => store.ensureStore(), /安全防护/);
    expectOk('store: 拒绝后未产生生产 db.json', () => {
      if (fs.existsSync(path.join(prodPath, 'db.json'))) throw new Error('db.json was created');
    });

    process.env.NODE_ENV = '';
    expectThrows('store: 工具入口默认拒绝写生产库（无 DATA_DIR）', () => store.ensureStore(), /安全防护/);
    expectOk('store: 工具入口拒绝后仍未产生生产 db.json', () => {
      if (fs.existsSync(path.join(prodPath, 'db.json'))) throw new Error('db.json was created');
    });

    process.env.ALLOW_PRODUCTION_WRITE = '1';
    store.ensureStore();
    expectOk('store: ALLOW_PRODUCTION_WRITE=1 允许有意写生产等价库（临时目录）', () => {
      if (!fs.existsSync(path.join(prodPath, 'db.json'))) throw new Error('db.json missing');
    });

    process.env.NODE_ENV = 'test';
    expectThrows('store: NODE_ENV=test 优先于 ALLOW_PRODUCTION_WRITE 拒绝写入', () => store.updateDb((db) => db), /安全防护/);
    expectOk('store: NODE_ENV=test 可读已存在生产库', () => {
      const db = store.readDb();
      if (!db?.settings) throw new Error('read failed');
    });
    expectThrows('store: NODE_ENV=test 仍拒绝写已存在生产库', () => store.updateDb((db) => db), /安全防护/);

    const testDir = path.join(tmpRoot, 'other');
    process.env.DATA_DIR = testDir;
    process.env.NODE_ENV = 'test';
    delete process.env.ALLOW_PRODUCTION_WRITE;
    expectOk('store: 显式 DATA_DIR 测试目录允许写入', () => {
      store.updateDb((db) => db);
      if (!fs.existsSync(path.join(testDir, 'db.json'))) throw new Error('db.json not created');
    });
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function main() {
  testFsSafe();
  await testStoreGuards();

  const failed = results.filter((item) => !item.ok);
  console.log(`\nsafety-guard-verify: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    for (const item of failed) console.error(`- ${item.name}: ${item.detail || 'unknown'}`);
    process.exitCode = 1;
  }
}

await main();
