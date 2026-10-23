import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-runtime-paths-'));
const saved = { ...process.env };
try {
  const appData = path.join(root, 'appdata');
  const physical = path.join(root, 'production');
  fs.mkdirSync(appData); fs.mkdirSync(physical);
  const legacy = path.join(appData, 'Wuxin');
  fs.symlinkSync(physical, legacy, process.platform === 'win32' ? 'junction' : 'dir');
  process.env.APPDATA = appData;
  process.env.NODE_ENV = 'test';
  process.env.DATA_DIR = physical;
  delete process.env.WUXIN_PRODUCTION_DATA_DIR;
  const store = await import('../server/store.ts');
  assert.equal(store.isProductionDb(), true, 'physical target of legacy alias is production');
  assert.throws(() => store.writeDb({}), /NODE_ENV=test/);
  assert.equal(fs.existsSync(path.join(physical, 'db.json')), false);

  const configured = path.join(root, 'configured-production');
  fs.mkdirSync(configured);
  process.env.WUXIN_PRODUCTION_DATA_DIR = configured;
  delete process.env.DATA_DIR;
  assert.equal(store.getDataDir(), configured);
  assert.equal(store.isProductionDb(), true);
  assert.throws(() => store.writeDb({}), /NODE_ENV=test/);
  process.env.DATA_DIR = physical;
  assert.equal(store.isProductionDb(), true, 'legacy root stays protected during migration');
  process.env.DATA_DIR = configured;
  const { assertNotProduction } = await import('./test-isolation.mjs');
  assert.throws(() => assertNotProduction(configured));
  console.log('PASS production roots, legacy junction aliases, and test isolation');

  const isolated = path.join(root, 'isolated');
  fs.mkdirSync(isolated);
  process.env.DATA_DIR = isolated;
  assert.equal(store.isProductionDb(), false);
  assertNotProduction(isolated);
  const script = path.join(root, 'predictor fixture.mjs');
  fs.writeFileSync(script, `let s='';for await(const c of process.stdin)s+=c;const ids=JSON.parse(s);console.log(JSON.stringify(Object.fromEntries(ids.map(id=>[id,{aim:1,stream:0}]))));`);
  process.env.OSU_ORACLE_SCRIPT = script;
  process.env.OSU_ORACLE_PYTHON = process.execPath;
  process.env.ORACLE_CACHE_FILE = path.join(isolated, 'oracle.json');
  delete process.env.OSU_ORACLE_DISABLED;
  const { classifyBeatmaps } = await import('../server/osu/classifier.ts');
  const result = await classifyBeatmaps(['777']);
  assert.equal(result.totalClassified, 1);
  assert.equal(result.details['777'].aim, 1);
  assert.deepEqual(result.errors, []);
  console.log('PASS configurable Oracle script and executable from a path containing spaces');
} finally {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  const resolved = fs.realpathSync(root);
  const temp = fs.realpathSync(os.tmpdir());
  assert.ok(resolved.startsWith(temp + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
}
