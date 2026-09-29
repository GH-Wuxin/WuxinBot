import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createPackage, extractFile } from '@electron/asar';
import { activatePreparedFix, patchDesktopArchive } from './apply-desktop-runtime-fix.mjs';
import { ProcessManager, buildDefaultDefinitions } from '../desktop/process-manager.mjs';
import {
  collectOwnedProcesses, loopbackListeners, matchesDefinition, parseHttpServiceState, parseWindowsListeners,
  probePort, waitForPort,
} from '../desktop/process-inspection.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(projectRoot, 'tools', 'fixtures', 'desktop-runtime-service.mjs');
const emptyRuntime = { listProcesses: async () => [], listListeners: async () => [], probePort: async () => false };

function baseDefinition(patch = {}) {
  return {
    id: 'sandbox', label: 'Desktop test', group: 'Test', command: process.execPath, cwd: projectRoot,
    args: [], env: { INHERITED: 'old', REMOVED: 'default' }, matcher: { includes: ['desktop-test'] },
    enabled: true, autoStart: false, stopOnClose: true, port: null, ...patch,
  };
}

async function setup(t, definitions = [baseDefinition()], options = {}) {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wuxin-desktop-test-'));
  t.after(async () => {
    assert.ok(path.resolve(configDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(configDir, { recursive: true, force: true });
  });
  const create = (nextDefinitions = definitions, extra = {}) => new ProcessManager({
    projectRoot, configDir, buildDefinitions: () => structuredClone(nextDefinitions), runtime: emptyRuntime, ...options, ...extra,
  });
  const manager = create();
  return { manager, create, configDir, configFile: manager.configFile };
}

async function readConfig(manager) {
  return JSON.parse(await fs.readFile(manager.configFile, 'utf8'));
}

test('first run persists overrides, not a frozen copy of defaults', async (t) => {
  const { manager } = await setup(t);
  await manager.initialize();
  assert.deepEqual(await readConfig(manager), { version: 2, settings: {}, processOverrides: {} });
  assert.equal(manager.getDefinition('sandbox').env.INHERITED, 'old');
});

test('new defaults propagate while user command/args/env/toggles survive restart', async (t) => {
  const { manager, create } = await setup(t);
  await manager.initialize();
  await manager.updateProcess('sandbox', { command: 'custom-node', args: ['custom'], enabled: false, env: { INHERITED: 'mine', REMOVED: 'default' } });
  await manager.updateSettings({ stopOnClose: false });
  const next = create([baseDefinition({ label: 'New label', cwd: '/new-default', port: 12345, env: { INHERITED: 'new', REMOVED: 'default', ADDED: 'new' } })]);
  await next.initialize();
  const actual = next.getDefinition('sandbox');
  assert.equal(actual.command, 'custom-node');
  assert.deepEqual(actual.args, ['custom']);
  assert.equal(actual.enabled, false);
  assert.equal(actual.label, 'New label');
  assert.equal(actual.cwd, '/new-default');
  assert.equal(actual.port, 12345);
  assert.deepEqual(actual.env, { INHERITED: 'mine', REMOVED: 'default', ADDED: 'new' });
  assert.equal(next.settings.stopOnClose, false);
  assert.equal((await readConfig(next)).processOverrides.sandbox.cwd, undefined);
});

test('restoring a field to its default removes the override', async (t) => {
  const { manager, create } = await setup(t);
  await manager.initialize();
  await manager.updateProcess('sandbox', { command: 'custom-node' });
  await manager.updateProcess('sandbox', { command: process.execPath });
  assert.deepEqual((await readConfig(manager)).processOverrides, {});
  const next = create([baseDefinition({ command: 'new-default-node' })]);
  await next.initialize();
  assert.equal(next.getDefinition('sandbox').command, 'new-default-node');
});

test('env deletions remain deleted and newly added defaults remain inherited', async (t) => {
  const { manager, create } = await setup(t);
  await manager.initialize();
  await manager.updateProcess('sandbox', { env: { INHERITED: 'old' } });
  assert.deepEqual((await readConfig(manager)).processOverrides.sandbox.env, { REMOVED: null });
  const next = create([baseDefinition({ env: { INHERITED: 'new', REMOVED: 'changed', ADDED: 'yes' } })]);
  await next.initialize();
  assert.deepEqual(next.getDefinition('sandbox').env, { INHERITED: 'new', ADDED: 'yes' });
});

test('v1 is backed up byte-for-byte and meaningful custom settings are retained', async (t) => {
  const { manager, create } = await setup(t);
  const raw = JSON.stringify({ version: 1, settings: { stopOnClose: false }, processes: [baseDefinition({ command: 'custom', args: ['mine'], enabled: false })] }, null, 2);
  await fs.writeFile(manager.configFile, raw);
  await manager.initialize();
  assert.equal(await fs.readFile(`${manager.configFile}.v1.backup`, 'utf8'), raw);
  assert.deepEqual((await readConfig(manager)).processOverrides.sandbox, { command: 'custom', enabled: false, args: ['mine'] });
  const next = create([baseDefinition({ label: 'Updated', env: { INHERITED: 'latest', REMOVED: 'default' } })]);
  await next.initialize();
  assert.equal(next.getDefinition('sandbox').command, 'custom');
  assert.equal(next.getDefinition('sandbox').label, 'Updated');
  assert.equal(next.getDefinition('sandbox').env.INHERITED, 'latest');
});

test('v1 generated Wuxin absolute args are normalized without freezing other fields', async (t) => {
  const definitions = buildDefaultDefinitions(projectRoot).filter((definition) => definition.id === 'wuxin');
  const { manager } = await setup(t, definitions);
  const saved = structuredClone(definitions[0]);
  saved.args = saved.args.map((arg) => path.resolve(saved.cwd, arg));
  saved.matcher = { includes: [path.join(saved.cwd, 'server', 'index.ts')] };
  await fs.writeFile(manager.configFile, JSON.stringify({ version: 1, processes: [saved] }));
  await manager.initialize();
  assert.deepEqual((await readConfig(manager)).processOverrides, {});
});

test('Wuxin launch normalizes legacy relative tsx loaders to absolute CLI paths', async (t) => {
  const root = path.join(projectRoot, 'wuxin-checkout');
  const definitions = buildDefaultDefinitions(root).filter((definition) => definition.id === 'wuxin');
  definitions[0].args = ['--loader', 'node_modules\\tsx\\dist\\loader.mjs', 'server\\index.ts'];
  definitions[0].env.NODE_OPTIONS = '--import=node_modules\\tsx\\dist\\loader.mjs --enable-source-maps';
  const { manager } = await setup(t, definitions);
  await manager.initialize();
  const actual = manager.getDefinition('wuxin');
  assert.deepEqual(actual.args, [
    path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(root, 'server', 'index.ts'),
  ]);
  assert.equal(actual.env.NODE_OPTIONS, '--enable-source-maps');
});

test('Wuxin launch strips an inherited legacy tsx loader from NODE_OPTIONS', async (t) => {
  const definitions = buildDefaultDefinitions(projectRoot).filter((definition) => definition.id === 'wuxin');
  definitions[0].command = process.execPath;
  definitions[0].port = null;
  let spawnedEnv;
  let closeChild;
  const { manager } = await setup(t, definitions, { runtime: {
    ...emptyRuntime,
    spawn(_command, _args, options) {
      spawnedEnv = options.env;
      const child = new EventEmitter();
      Object.assign(child, {
        pid: 94001, exitCode: null, signalCode: null,
        stdout: new PassThrough(), stderr: new PassThrough(),
      });
      closeChild = new Promise((resolve) => setTimeout(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
        resolve();
      }, 25));
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  } });
  const originalNodeOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--import=node_modules\\tsx\\dist\\loader.mjs --enable-source-maps';
  try {
    await manager.initialize();
    await manager.start('wuxin');
    assert.equal(spawnedEnv.NODE_OPTIONS, '--enable-source-maps');
    await closeChild;
  } finally {
    if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = originalNodeOptions;
    await closeChild;
  }
});

test('known legacy PP+ launch is migrated; explicit v2/custom launches are respected', async (t) => {
  const definitions = buildDefaultDefinitions(projectRoot).filter((definition) => definition.id === 'ppplus');
  const { manager, create } = await setup(t, definitions);
  const saved = { ...definitions[0], command: path.join(definitions[0].cwd, 'Difficalcy.PerformancePlus.exe'), args: [] };
  await fs.writeFile(manager.configFile, JSON.stringify({ version: 1, processes: [saved] }));
  await manager.initialize();
  assert.deepEqual((await readConfig(manager)).processOverrides, {});
  await manager.updateProcess('ppplus', { command: saved.command, args: [] });
  const next = create();
  await next.initialize();
  assert.equal(next.getDefinition('ppplus').command, saved.command);
  assert.deepEqual(next.getDefinition('ppplus').args, []);
});

test('custom legacy profiler roots and valid algorithm choices are not reset', async (t) => {
  const definitions = buildDefaultDefinitions(projectRoot).filter((definition) => definition.id === 'skillProfiler');
  const { manager } = await setup(t, definitions);
  const saved = { ...definitions[0], cwd: path.join(projectRoot, 'my-profiler'), args: ['custom.py', '--algorithm', 'v100'] };
  await fs.writeFile(manager.configFile, JSON.stringify({ version: 1, processes: [saved] }));
  await manager.initialize();
  assert.equal(manager.getDefinition('skillProfiler').cwd, saved.cwd);
  assert.deepEqual(manager.getDefinition('skillProfiler').args, saved.args);
});

test('old yumuImage port is migrated once; explicit v2 port is retained', async (t) => {
  const defaults = baseDefinition({ id: 'yumuImage' });
  const { manager, create } = await setup(t, [defaults]);
  await fs.writeFile(manager.configFile, JSON.stringify({ version: 1, processes: [{ ...defaults, port: 8388 }] }));
  await manager.initialize();
  assert.equal(manager.getDefinition('yumuImage').port, null);
  await manager.updateProcess('yumuImage', { port: 34567 });
  const next = create();
  await next.initialize();
  assert.equal(next.getDefinition('yumuImage').port, 34567);
  await next.updateProcess('yumuImage', { port: null });
  assert.deepEqual((await readConfig(next)).processOverrides, {});
});

test('unreadable and future config files are preserved', async (t) => {
  const { manager, create } = await setup(t);
  await fs.writeFile(manager.configFile, '{broken');
  await assert.rejects(manager.initialize(), /原文件已保留/);
  assert.equal(await fs.readFile(manager.configFile, 'utf8'), '{broken');
  const raw = JSON.stringify({ version: 99, settings: {} });
  await fs.writeFile(manager.configFile, raw);
  await assert.rejects(create().initialize(), /高于当前支持/);
  assert.equal(await fs.readFile(manager.configFile, 'utf8'), raw);
});

test('readiness polling retries connection errors and waits until ownership is verified', async () => {
  let attempts = 0;
  let ownershipChecks = 0;
  const ready = await waitForPort(12345, {
    timeoutMs: 1000, intervalMs: 10,
    probe: async () => ++attempts >= 3,
    verify: async () => ++ownershipChecks >= 2,
  });
  assert.equal(ready, true);
  assert.equal(attempts, 4);
  assert.equal(ownershipChecks, 2);
});

test('polling reaches its deadline instead of failing on the first error', async () => {
  let attempts = 0;
  const before = Date.now();
  assert.equal(await waitForPort(12345, { timeoutMs: 120, intervalMs: 20, probe: async () => { attempts++; return false; } }), false);
  assert.ok(attempts >= 3);
  assert.ok(Date.now() - before >= 110);
});

test('overlapping state reads coalesce into a single snapshot computation', async (t) => {
  let processCalls = 0;
  const { manager } = await setup(t, [baseDefinition()], { runtime: {
    ...emptyRuntime,
    listProcesses: async () => {
      processCalls += 1;
      await pause(30);
      return [{ pid: 4242, ppid: 1, name: 'node.exe', executablePath: process.execPath, commandLine: 'desktop-test' }];
    },
  } });
  await manager.initialize();
  const [first, second, third] = await Promise.all([manager.state(), manager.state(), manager.state()]);
  assert.equal(processCalls, 1);
  assert.equal(first.processes[0].pids[0], 4242);
  assert.equal(first.updatedAt, second.updatedAt);
  assert.equal(second.updatedAt, third.updatedAt);
  const later = await manager.state();
  assert.notEqual(later.updatedAt, first.updatedAt);
  assert.equal(processCalls, 2);
});

test('listeners are parsed independently of localized state names and IPv4 ownership wins', () => {
  const listeners = parseWindowsListeners('TCP 127.0.0.1:12345 0.0.0.0:0 LISTENING 101\nTCP [::]:12345 [::]:0 侦听 102\nTCP 127.0.0.1:12345 127.0.0.1:5678 ESTABLISHED 103');
  assert.deepEqual(listeners.map((item) => item.pid), [101, 102]);
  assert.deepEqual(loopbackListeners(listeners, 12345).map((item) => item.pid), [101]);
});

test('command identity and normalized slashes are both checked when detecting external services', () => {
  const definition = baseDefinition({ command: 'C:\\runtime\\node.exe', matcher: { includes: ['server\\index.ts'] } });
  assert.equal(matchesDefinition({ pid: 101, executablePath: 'C:/runtime/node.exe', commandLine: 'node server/index.ts' }, definition), true);
  assert.equal(matchesDefinition({ pid: 101, executablePath: 'D:/other/node.exe', commandLine: 'node server/index.ts' }, definition), false);
});

test('matcher survives malformed rows, quoting shapes, and multi-needle definitions', () => {
  const definition = baseDefinition({ command: 'C:\\runtime\\my node.exe', matcher: { includes: ['server\\index.ts'] } });
  // Rows without identity data and the manager's own pid never match.
  assert.equal(matchesDefinition({ pid: 1 }, definition), false);
  assert.equal(matchesDefinition({ pid: process.pid, executablePath: 'C:/runtime/my node.exe', commandLine: '"C:\\runtime\\my node.exe" server/index.ts' }, definition), false);
  // A quoted executable with spaces is recovered from the command line when the path column is empty.
  assert.equal(matchesDefinition({ pid: 101, executablePath: '', commandLine: '"C:\\runtime\\my node.exe" server/index.ts --flag' }, definition), true);
  // Every include must be present; sharing one needle is not enough.
  const multiNeedle = baseDefinition({ command: 'C:\\runtime\\my node.exe', matcher: { includes: ['server\\index.ts', '--mode=service'] } });
  assert.equal(matchesDefinition({ pid: 102, executablePath: 'C:/runtime/my node.exe', commandLine: '"C:\\runtime\\my node.exe" server/index.ts --mode=service' }, multiNeedle), true);
  assert.equal(matchesDefinition({ pid: 103, executablePath: 'C:/runtime/my node.exe', commandLine: '"C:\\runtime\\my node.exe" server/index.ts' }, multiNeedle), false);
  // A .cmd launcher cannot be pinned to one executable, so identity falls back to include matching.
  const cmd = baseDefinition({ command: 'C:\\runtime\\launch.cmd', matcher: { includes: ['server\\index.ts'] } });
  assert.equal(matchesDefinition({ pid: 104, executablePath: '', commandLine: 'cmd.exe /d /c C:\\runtime\\launch.cmd server/index.ts' }, cmd), true);
  assert.equal(matchesDefinition({ pid: 105, executablePath: 'C:/runtime/other.cmd', commandLine: 'C:\\runtime\\other.cmd server/index.ts' }, cmd), true);
  // A relative command is still pinned: basename equality is required when it carries no slash.
  const relative = baseDefinition({ command: 'node.exe', matcher: { includes: ['server\\index.ts'] } });
  assert.equal(matchesDefinition({ pid: 106, executablePath: 'C:/runtime/node.exe', commandLine: 'node.exe server/index.ts' }, relative), true);
  assert.equal(matchesDefinition({ pid: 107, executablePath: 'C:/runtime/nodejs.exe', commandLine: 'nodejs.exe server/index.ts' }, relative), false);
});

test('PostgreSQL and NapCat daemons are identified by their configured instance paths', () => {
  const definitions = buildDefaultDefinitions(projectRoot);
  const postgres = definitions.find((item) => item.id === 'postgres');
  const napcat = definitions.find((item) => item.id === 'napcat');
  assert.equal(matchesDefinition({ pid: 101, executablePath: postgres.matcher.executablePaths[0], commandLine: `postgres -D "${postgres.args[2]}"` }, postgres), true);
  assert.equal(matchesDefinition({ pid: 101, executablePath: postgres.matcher.executablePaths[0], commandLine: 'postgres -D "D:/other-cluster"' }, postgres), false);
  assert.equal(matchesDefinition({ pid: 102, executablePath: napcat.matcher.executablePaths[0], commandLine: 'QQ --type=utility' }, napcat), true);
  assert.equal(matchesDefinition({ pid: 102, executablePath: 'C:/other-QQ/QQ.exe', commandLine: 'QQ --type=utility' }, napcat), false);
});

test('HTTP.sys queue owners are kept separate for each registered listener', () => {
  const output = `Request queue name: unnamed
    Processes:
        ID: 90101, image: kanon.exe
    URL groups:
        Request queue name: unnamed
                HTTP://127.0.0.1:7700:127.0.0.1/
Request queue name: unnamed
    Processes:
        ID: 90102, image: dotnet.exe
                HTTP://+:8800/
Request queue name: unnamed
    Number of active processes attached: 0
                HTTP://127.0.0.1:9900/`;
  assert.deepEqual(parseHttpServiceState(output), [
    { address: '127.0.0.1', port: 7700, pid: 90101, httpSys: true },
    { address: '0.0.0.0', port: 8800, pid: 90102, httpSys: true },
  ]);
});

test('HTTP.sys-backed services require the real worker PID to match the target', async (t) => {
  const { manager } = await setup(t, [baseDefinition({ port: 7700 })], { runtime: {
    ...emptyRuntime, probePort: async () => true,
    listListeners: async () => parseHttpServiceState('Request queue name: unnamed\n    ID: 90101, image: test.exe\n        HTTP://127.0.0.1:7700:127.0.0.1/'),
    listProcesses: async () => [{ pid: 90101, executablePath: process.execPath, commandLine: 'desktop-test', createdAt: 1000 }],
  } });
  await manager.initialize();
  assert.equal((await manager.state()).processes[0].status, 'running');
  assert.equal((await manager.start('sandbox')).managed, false);
  assert.equal((await manager.stop('sandbox')).notManaged, true);
});

function fakeLaunch(definition, pid = 90101, createdAt = Date.now() - 5000) {
  const child = { pid, exitCode: null, signalCode: null, killed: false, lastError: '' };
  return { pid, child, definition, evidence: new Map([[pid, { pid, createdAt, spawnedAt: createdAt, exitedAt: null }]]) };
}

test('launcher descendants remain owned after exit; reused launcher PID and unrelated matches do not', () => {
  const definition = baseDefinition();
  const launch = fakeLaunch(definition, 90101, 1000);
  launch.child.exitCode = 0;
  launch.evidence.get(90101).exitedAt = 2000;
  launch.evidence.get(90101).exitConfirmed = true;
  const processes = [
    { pid: 90101, ppid: 1, createdAt: 4000 },
    { pid: 90102, ppid: 90101, createdAt: 1500 },
    { pid: 90103, ppid: 90102, createdAt: 2500 },
    { pid: 90104, ppid: 90101, createdAt: 4500 },
    { pid: 90105, ppid: 1, createdAt: 1600 },
  ];
  assert.deepEqual(collectOwnedProcesses(launch, processes).map((row) => row.pid), [90102, 90103]);
  assert.deepEqual(collectOwnedProcesses(launch, [{ pid: 90102, ppid: 1, createdAt: 6000 }]), []);
});

test('unconfirmed exit of a descendant cannot confer ownership through its reused PID', () => {
  const launch = fakeLaunch(baseDefinition(), 90101, 1000);
  launch.evidence.set(90102, { pid: 90102, ppid: 90101, createdAt: 1500, spawnedAt: 1500, exitedAt: null });
  const rows = [{ pid: 90101, ppid: 1, createdAt: 1000 }, { pid: 90102, ppid: 1, createdAt: 4000 }, { pid: 90103, ppid: 90102, createdAt: 4500 }];
  assert.deepEqual(collectOwnedProcesses(launch, rows).map((row) => row.pid), [90101]);
});

test('an owned stop command uses the launch configuration, not later edits', async (t) => {
  const launched = baseDefinition({ port: 12345, stopCommand: 'owned-stop', stopArgs: ['original-cluster'] });
  const { manager } = await setup(t, [launched]);
  await manager.initialize();
  const launch = fakeLaunch(launched, 90101, 1000);
  manager.launches.set('sandbox', launch);
  let rows = [{ pid: 90101, ppid: 1, createdAt: 1000 }];
  const commands = [];
  Object.assign(manager.runtime, {
    listProcesses: async () => rows,
    listListeners: async () => [{ address: '127.0.0.1', port: 12345, pid: 90101 }],
    probePort: async () => true,
    runFile: async (command, args) => { commands.push([command, args]); launch.child.exitCode = 0; rows = []; },
  });
  manager.getDefinition('sandbox').stopArgs = ['external-cluster'];
  await manager.stop('sandbox');
  assert.deepEqual(commands, [['owned-stop', ['original-cluster']]]);
});

test('Desktop package patch preserves all unrelated archive metadata and payload', async (t) => {
  const { configDir } = await setup(t);
  const input = path.join(configDir, 'input');
  await fs.mkdir(path.join(input, 'desktop'), { recursive: true });
  await fs.mkdir(path.join(input, 'server'));
  await fs.writeFile(path.join(input, 'package.json'), JSON.stringify({ main: 'desktop/main.mjs' }));
  await fs.writeFile(path.join(input, 'desktop', 'main.mjs'), 'old main');
  await fs.writeFile(path.join(input, 'server', 'keep.txt'), 'unrelated server contents');
  const original = path.join(configDir, 'original.asar');
  const patched = path.join(configDir, 'patched.asar');
  await createPackage(input, original);
  const report = await patchDesktopArchive({ sourceArchive: original, targetArchive: patched });
  assert.equal(report.files.length, 3);
  assert.equal(extractFile(patched, path.join('server', 'keep.txt')).toString(), 'unrelated server contents');
  assert.equal(extractFile(patched, path.join('desktop', 'main.mjs')).toString(), await fs.readFile(path.join(projectRoot, 'desktop', 'main.mjs'), 'utf8'));
});

test('a prepared package can be activated later with the previous renderer retained in its backup', async (t) => {
  const { configDir } = await setup(t);
  const resources = path.join(configDir, 'resources');
  const input = path.join(configDir, 'input');
  const installedRenderer = path.join(resources, 'app.asar.unpacked', 'dist');
  const backup = path.join(resources, 'backup');
  const stagedRenderer = path.join(resources, 'new-renderer');
  await fs.mkdir(path.join(input, 'desktop'), { recursive: true });
  await fs.writeFile(path.join(input, 'package.json'), '{}');
  await fs.writeFile(path.join(input, 'desktop', 'main.mjs'), 'old main');
  await fs.mkdir(installedRenderer, { recursive: true });
  await fs.writeFile(path.join(installedRenderer, 'index.html'), 'old renderer');
  await fs.mkdir(stagedRenderer);
  await fs.writeFile(path.join(stagedRenderer, 'index.html'), 'new renderer');
  await fs.mkdir(backup);
  const original = path.join(resources, 'app.asar');
  const stagedArchive = path.join(resources, 'new.asar');
  await createPackage(input, original);
  await fs.copyFile(original, path.join(backup, 'app.asar'));
  const report = await patchDesktopArchive({ sourceArchive: original, targetArchive: stagedArchive });
  const prepared = { resources, backup, stagedArchive, stagedRenderer, ...report };
  await activatePreparedFix(prepared);
  assert.equal(prepared.applied, true);
  assert.equal(await fs.readFile(path.join(installedRenderer, 'index.html'), 'utf8'), 'new renderer');
  assert.equal(await fs.readFile(path.join(backup, 'dist', 'index.html'), 'utf8'), 'old renderer');
  assert.equal(extractFile(path.join(backup, 'app.asar'), path.join('desktop', 'main.mjs')).toString(), 'old main');
});

test('stop/shutdown/restart cannot kill or run stopCommand against external matching processes', async (t) => {
  const definition = baseDefinition({ stopCommand: 'external-stop-command' });
  const calls = [];
  const { manager } = await setup(t, [definition], { runtime: {
    ...emptyRuntime, listProcesses: async () => [{ pid: 90101, ppid: 1, createdAt: 1000, executablePath: process.execPath, commandLine: 'desktop-test' }],
    runFile: async (...args) => { calls.push(args); },
  } });
  manager.killPid = async (...args) => { calls.push(args); };
  await manager.initialize();
  assert.equal((await manager.state()).processes[0].source, 'external');
  assert.equal((await manager.stop('sandbox')).notManaged, true);
  await assert.rejects(manager.restart('sandbox'), /由外部启动/);
  assert.deepEqual(await manager.restartAll(), []);
  await manager.shutdown();
  assert.deepEqual(calls, []);
});

test('stopping a managed tree excludes other instances even when their matcher is identical', async (t) => {
  const definition = baseDefinition();
  const rows = [
    { pid: 90101, ppid: 1, createdAt: 1000, executablePath: process.execPath, commandLine: 'desktop-test' },
    { pid: 90102, ppid: 90101, createdAt: 1500, executablePath: process.execPath, commandLine: 'desktop-test' },
    { pid: 90103, ppid: 1, createdAt: 1600, executablePath: process.execPath, commandLine: 'desktop-test' },
  ];
  const { manager } = await setup(t, [definition], { runtime: { ...emptyRuntime, listProcesses: async () => rows } });
  await manager.initialize();
  manager.launches.set('sandbox', fakeLaunch(definition, 90101, 1000));
  const targets = [];
  manager.killPid = async (pid) => targets.push(pid);
  const result = await manager.stop('sandbox');
  assert.deepEqual(result.pids, [90101, 90102]);
  assert.ok(targets.includes(90101));
  assert.ok(!targets.includes(90103));
});

test('killPid rejects a retained PID whose process creation time has changed', async (t) => {
  const calls = [];
  const { manager } = await setup(t, undefined, { runtime: {
    ...emptyRuntime, listProcesses: async () => [{ pid: 90101, ppid: 1, createdAt: 2000 }],
    runFile: async (...args) => { calls.push(args); },
  } });
  assert.equal(await manager.killPid(90101, { pid: 90101, createdAt: 1000 }), false);
  assert.deepEqual(calls, []);
});

test('open ports with foreign or unidentified owners are conflicts, not running services', async (t) => {
  for (const listeners of [[{ address: '127.0.0.1', port: 12345, pid: 90109 }], []]) {
    const { manager } = await setup(t, [baseDefinition({ port: 12345 })], { runtime: { ...emptyRuntime, probePort: async () => true, listListeners: async () => listeners } });
    await manager.initialize();
    const state = (await manager.state()).processes[0];
    assert.equal(state.status, 'conflict');
    assert.equal(state.ready, false);
    assert.deepEqual(state.pids, []);
    await assert.rejects(manager.start('sandbox'), /被其他进程占用|无法确认进程归属/);
    assert.equal(manager.launches.size, 0);
  }
});

test('close settings preserve opted-out managed components', async (t) => {
  const definitions = [baseDefinition(), baseDefinition({ id: 'keep', stopOnClose: false })];
  const { manager } = await setup(t, definitions);
  await manager.initialize();
  const calls = [];
  manager.stop = async (id) => { calls.push(id); return { stopped: true }; };
  await manager.shutdown();
  assert.deepEqual(calls, ['sandbox']);
  const { manager: keepAll } = await setup(t, definitions);
  await keepAll.initialize();
  await keepAll.updateSettings({ stopOnClose: false });
  keepAll.stop = async (id) => { calls.push(id); };
  await keepAll.shutdown();
  assert.deepEqual(calls, ['sandbox']);
});

test('closing during startup prevents spawning after asynchronous preflight completes', async (t) => {
  let release;
  let spawns = 0;
  const { manager } = await setup(t, undefined, { runtime: {
    ...emptyRuntime, listProcesses: () => new Promise((resolve) => { release = resolve; }),
    spawn: () => { spawns++; throw new Error('must not spawn'); },
  } });
  await manager.initialize();
  const starting = manager.start('sandbox');
  const rejected = assert.rejects(starting, /启动已取消/);
  await pause(10);
  await manager.shutdown();
  release([]);
  await rejected;
  assert.equal(spawns, 0);
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitClosed(port) {
  for (let index = 0; index < 40; index++) {
    if (!await probePort(port)) return;
    await pause(50);
  }
  assert.fail(`test port ${port} was not closed`);
}

async function liveManager(t, { mode = 'serve', delay = '0', timeoutMs = 6000, cwd = projectRoot } = {}) {
  const port = await freePort();
  const tag = `desktop-test-${process.pid}-${port}`;
  const definition = baseDefinition({ port, cwd, args: [fixture, mode, String(port), String(delay), tag], env: {}, matcher: { includes: [fixture, tag] } });
  const result = await setup(t, [definition], { runtime: {}, readinessTimeoutMs: timeoutMs });
  await result.manager.initialize();
  t.after(async () => {
    await result.manager.stop('sandbox').catch(() => {});
    for (const launch of result.manager.launches.values()) {
      if (launch.child.exitCode === null && !launch.child.killed) launch.child.kill();
    }
  });
  return { ...result, port, definition };
}

test('real delayed listener waits through connection refusals and simultaneous starts spawn once', async (t) => {
  const { manager, port } = await liveManager(t, { delay: 700 });
  const before = Date.now();
  const [left, right] = await Promise.all([manager.start('sandbox'), manager.start('sandbox')]);
  assert.equal(left.pid, right.pid);
  assert.equal(left.ready, true);
  assert.ok(Date.now() - before >= 700);
  const state = (await manager.state()).processes[0];
  assert.equal(state.status, 'running');
  assert.equal(state.source, 'managed');
  assert.ok(state.ownedPids.includes(left.pid));
  await manager.stop('sandbox');
  await waitClosed(port);
});

test('real external matching listener stays alive after stop and shutdown', async (t) => {
  const { manager, port, definition } = await liveManager(t);
  const external = spawn(definition.command, definition.args, { cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (external.exitCode === null) {
      external.kill();
      await new Promise((resolve) => external.once('close', resolve));
    }
  });
  await new Promise((resolve, reject) => {
    external.once('error', reject);
    external.stdout.once('data', resolve);
  });
  const start = await manager.start('sandbox');
  assert.equal(start.alreadyRunning, true);
  assert.equal(start.managed, false);
  assert.ok(start.pids.includes(external.pid));
  assert.equal((await manager.state()).processes[0].source, 'external');
  assert.equal((await manager.stop('sandbox')).notManaged, true);
  await manager.shutdown();
  assert.equal(await probePort(port), true);
  assert.equal(external.exitCode, null);
});

test('real foreign listener blocks launch without being labelled as the target service', async (t) => {
  const { manager, port } = await liveManager(t);
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal((await manager.state()).processes[0].status, 'conflict');
  await assert.rejects(manager.start('sandbox'), /被其他进程占用/);
  assert.equal(manager.children.size, 0);
  await manager.stop('sandbox');
  assert.equal(await probePort(port), true);
});

test('real startup timeout reports failure and keeps the owned process available to stop', async (t) => {
  const { manager } = await liveManager(t, { delay: 'never', timeoutMs: 500 });
  await assert.rejects(manager.start('sandbox'), /启动未就绪.*超时/);
  const state = (await manager.state()).processes[0];
  assert.equal(state.status, 'unready');
  assert.equal(state.managed, true);
  assert.equal(state.ready, false);
  assert.ok((await manager.stop('sandbox')).pids.length > 0);
});

test('real spawn errors and early nonzero exits are rejected', async (t) => {
  const { manager } = await liveManager(t, { cwd: path.join(os.tmpdir(), `desktop-nonexistent-${process.pid}-${Date.now()}`) });
  await assert.rejects(manager.start('sandbox'), /ENOENT/);
  const { manager: exits } = await liveManager(t, { mode: 'fail', delay: 100 });
  await assert.rejects(exits.start('sandbox'), /启动后退出或失败/);
  assert.equal((await exits.state()).processes[0].ready, false);
});

test('real launcher can exit while its later-ready child remains managed and stoppable', async (t) => {
  const { manager, port } = await liveManager(t, { mode: 'launch', delay: 800 });
  const start = await manager.start('sandbox');
  assert.equal(start.ready, true);
  assert.equal(manager.launches.get('sandbox').child.exitCode, 0);
  const state = (await manager.state()).processes[0];
  assert.equal(state.source, 'managed');
  assert.equal(state.status, 'running');
  assert.ok(state.ownedPids.length > 0);
  assert.ok(!state.ownedPids.includes(start.pid));
  await manager.shutdown();
  await waitClosed(port);
});

test('desktop IPC guard allowlists only the app origins', async () => {
  const { desktopAllowedOrigins, isAllowedDesktopUrl } = await import('../desktop/ipc-guard.mjs');
  const dev = desktopAllowedOrigins({ devUrl: 'http://127.0.0.1:5173', apiBase: 'http://127.0.0.1:8787' });
  assert.equal(isAllowedDesktopUrl('http://127.0.0.1:5173/console', dev), true, 'dev origin allowed');
  assert.equal(isAllowedDesktopUrl('file:///G:/app/dist/index.html', dev), true, 'file renderer allowed');
  assert.equal(isAllowedDesktopUrl('http://127.0.0.1:8787/index.html', dev), true, 'loopback api page allowed');
  assert.equal(isAllowedDesktopUrl('http://127.0.0.1:9999/index.html', dev), false, 'foreign loopback port refused');
  assert.equal(isAllowedDesktopUrl('https://127.0.0.1:8787', dev), false, 'https is a different origin');
  assert.equal(isAllowedDesktopUrl('http://evil.example/attack', dev), false, 'remote origin refused');
  assert.equal(isAllowedDesktopUrl('not a url', dev), false, 'malformed url refused');
  const packaged = desktopAllowedOrigins({ apiBase: 'http://127.0.0.1:8787' });
  assert.equal(isAllowedDesktopUrl('http://127.0.0.1:5173', packaged), false, 'dev origin not allowlisted when packaged');
  assert.equal(isAllowedDesktopUrl('file:///G:/app/dist/index.html', packaged), true, 'packaged file renderer allowed');
});

test('api bridge pins targets to the loopback /api surface', async () => {
  const { resolveApiRequest } = await import('../desktop/api-bridge.mjs');
  const request = resolveApiRequest({
    apiBase: 'http://127.0.0.1:8787',
    url: 'http://127.0.0.1:8787/api/state',
    method: 'post',
    headers: { 'Content-Type': 'application/json', 'X-Wuxin-Admin-Password': 'pw', Cookie: 'session=1' },
  });
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['X-Wuxin-Admin-Password'], 'pw');
  assert.equal(request.headers.Cookie, undefined, 'non-allowlisted headers are dropped');
  assert.throws(() => resolveApiRequest({ apiBase: 'http://127.0.0.1:8787', url: 'http://127.0.0.1:9999/api/state' }), /origin/, 'foreign port refused');
  assert.throws(() => resolveApiRequest({ apiBase: 'http://127.0.0.1:8787', url: 'https://evil.example/api/state' }), /origin/, 'remote origin refused');
  assert.throws(() => resolveApiRequest({ apiBase: 'http://127.0.0.1:8787', url: 'http://127.0.0.1:8787/settings' }), /\/api\//, 'non-api path refused');
  assert.throws(() => resolveApiRequest({ apiBase: 'http://127.0.0.1:8787', url: 'http://127.0.0.1:8787/api/state', method: 'TRACE' }), /method/i, 'unsafe method refused');
  assert.throws(() => resolveApiRequest({ apiBase: 'https://api.example.com', url: 'https://api.example.com/api/x' }), /loopback/, 'non-loopback base refused');
});
