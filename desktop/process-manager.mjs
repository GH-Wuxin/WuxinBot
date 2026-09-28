import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  collectOwnedProcesses, isLiveChild, listPortListeners, listSystemProcesses,
  loopbackListeners, matchesDefinition, probePort, runFile, sameProcess, waitForPort,
} from './process-inspection.mjs';

const WINDOWS = process.platform === 'win32';
const CONFIG_VERSION = 2;
const DEFAULT_SETTINGS = { autoLaunch: false, startOnOpen: false, stopOnClose: true };
const CONFIG_FIELDS = ['label', 'group', 'command', 'cwd', 'port', 'enabled', 'autoStart', 'stopOnClose', 'args', 'env', 'matcher', 'stopCommand', 'stopArgs'];

function text(value) {
  return String(value ?? '').trim();
}

function firstExisting(...candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || candidates.find(Boolean) || '';
}

function envOr(name, fallback) {
  return text(process.env[name]) || fallback;
}

function normalizeArgs(args) {
  return Array.isArray(args) ? args.map((arg) => String(arg)) : [];
}

function normalizeEnv(env) {
  if (!env || typeof env !== 'object') return {};
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [String(key), String(value)]));
}

// These are the selectors exposed by the current profiler CLI. The v0.40
// release worktree has its own formal selector; v100 is the older stable line.
// Keep both explicit so a saved old Desktop config cannot silently start the
// wrong algorithm.
const PROFILER_ALGORITHMS = new Set([
  'v040-formal', 'v100', 'v101-experimental',
  'v010-beta9.2', 'v010-beta9.1', 'v010-beta9', 'v010-beta8',
  'v010-beta7', 'v010-beta6', 'v010-beta5', 'v010-beta4',
  'v010-beta3', 'v010-beta2', 'v010-beta1', 'v096',
]);

function normalizeProfilerArgs(args, fallback = 'v040-formal') {
  const normalized = normalizeArgs(args);
  for (let index = 0; index < normalized.length; index += 1) {
    const arg = normalized[index];
    if (arg === '--algorithm') {
      if (!PROFILER_ALGORITHMS.has(normalized[index + 1])) normalized[index + 1] = fallback;
      continue;
    }
    if (arg.startsWith('--algorithm=')) {
      const value = arg.slice('--algorithm='.length);
      if (!PROFILER_ALGORITHMS.has(value)) normalized[index] = `--algorithm=${fallback}`;
    }
  }
  return normalized;
}

function normalizeWuxinArgs(args, cwd = '') {
  const normalized = normalizeArgs(args);
  const base = isAbsoluteCommand(cwd) ? path.resolve(cwd) : '';
  for (let index = 0; index < Math.min(normalized.length, 2); index += 1) {
    let value = normalized[index] || '';
    if (value.startsWith('file://')) {
      try { value = fileURLToPath(value); } catch { /* leave malformed values for the normal error path */ }
    }
    if (base && isAbsoluteCommand(value)) {
      const relative = path.relative(base, path.resolve(value));
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) normalized[index] = relative;
    }
  }
  return normalized;
}

function compactError(value) {
  return String(value || '')
    .replace(/(password|passwd|token|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

function missingRequirements(definition) {
  const missing = [];
  for (const requiredPath of definition.requiredPaths || []) {
    if (!fs.existsSync(requiredPath)) missing.push(`缺少文件：${requiredPath}`);
  }
  for (const requiredFile of definition.requiredFiles || []) {
    let size = 0;
    try { size = fs.statSync(requiredFile.path).size; } catch { /* reported below */ }
    if (!fs.existsSync(requiredFile.path) || size < Number(requiredFile.minBytes || 1)) {
      missing.push(`文件为空或不存在：${requiredFile.path}`);
    }
  }
  return missing;
}

function isAbsoluteCommand(command) {
  return path.isAbsolute(command) || /^[A-Za-z]:[\\/]/.test(command);
}

function safeId(value) {
  const result = text(value);
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(result) ? result : null;
}

function commandExists(command) {
  if (!command) return false;
  return isAbsoluteCommand(command) ? fs.existsSync(command) : true;
}

function localRuntimeRoot() {
  return envOr('WUXIN_LOCAL_BOTS_ROOT', 'G:\\My pack\\Agent Work\\codex_work\\napcat-local-bots');
}

function buildDefaultDefinitions(projectRoot) {
  const localRoot = localRuntimeRoot();
  const runtime = path.join(localRoot, 'runtime');
  const java = firstExisting(
    envOr('WUXIN_JAVA', ''),
    path.join(runtime, 'jdk21-stage', 'jdk-21.0.11+10', 'bin', 'java.exe'),
    'java.exe',
  );
  const node = firstExisting(
    envOr('WUXIN_NODE', ''),
    path.join(projectRoot, 'portable-node', 'node.exe'),
    'node.exe',
  );
  const dotnet = firstExisting(
    envOr('WUXIN_DOTNET', ''),
    path.join(runtime, 'dotnet', 'dotnet.exe'),
    'dotnet.exe',
  );
  const python = firstExisting(
    envOr('WUXIN_PYTHON', ''),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe'),
    'python.exe',
  );
  const javaOpts = ['--enable-preview', '--enable-native-access=ALL-UNNAMED'];
  const shellDir = envOr('NAPCAT_SHELL_DIR', 'G:\\My pack\\NapCat.Shell.Windows.OneKey\\NapCat.44498.Shell');
  const napcat = firstExisting(
    envOr('NAPCAT_LAUNCHER_PATH', ''),
    path.join(shellDir, 'NapCatWinBootMain-patched.exe'),
    path.join(shellDir, 'NapCatWinBootMain.exe'),
  );
  const napcatUserData = envOr('NAPCAT_USER_DATA_DIR', 'D:\\PippiQQProfile');
  const profilerRoot = envOr('SKILL_PROFILER_ROOT', 'G:\\My pack\\Agent Work\\codex_work\\osu-skill-profiler-v040-release');
  const profilerCli = path.join(profilerRoot, 'tools', 'map_demand_v01', 'cli.py');
  // The formal release worktree contains the v0.40 runtime. Keep the large
  // local manifest in the main checkout instead of the release worktree's
  // placeholder manifest.
  const profilerManifest = envOr('SKILL_PROFILER_MANIFEST', 'G:\\My pack\\Agent Work\\osu-skill-profiler\\training\\datasets\\std_manifest.json');
  const profilerAlgorithm = envOr('SKILL_PROFILER_ALGORITHM', 'v040-formal');
  const yumuNode = firstExisting(envOr('YUMU_NODE', ''), path.join(runtime, 'node-v22.23.1-win-x64', 'node-v22.23.1-win-x64', 'node.exe'), node);
  const yumuDir = envOr('YUMU_DIR', path.join(localRoot, 'sources', 'yumu-image'));
  const yumuImageEnv = {
    PORT: '8388',
    WUXIN_PORT: '8389',
    EXPORT_FILE: path.join(localRoot, 'data', 'yumu', 'img', 'ExportFileV3'),
    BUFFER_PATH: path.join(localRoot, 'data', 'yumu', 'imgbuffer'),
    OSU_BUFFER_PATH: path.join(localRoot, 'data', 'yumu', 'osufile'),
    IMAGE_FORMAT: 'jpg',
  };

  const postgresDir = path.join(runtime, 'postgresql-16.10', 'pgsql');
  const postgresCluster = path.join(localRoot, 'data', 'postgresql', 'cluster');
  const pgCtl = firstExisting(envOr('WUXIN_PG_CTL', ''), path.join(postgresDir, 'bin', 'pg_ctl.exe'), 'pg_ctl.exe');
  const mariaDir = path.join(runtime, 'mariadb-11.4.12-winx64');
  const maria = firstExisting(envOr('WUXIN_MARIADB', ''), path.join(mariaDir, 'bin', 'mariadbd.exe'), 'mariadbd.exe');
  const mariaConfig = path.join(localRoot, 'data', 'mariadb', 'my.ini');
  const dotnetEnv = {
    DOTNET_ROOT: path.join(runtime, 'dotnet'),
    DOTNET_ROOT_X64: path.join(runtime, 'dotnet'),
    DOTNET_ROLL_FORWARD: 'Major',
  };

  const ppplusJar = path.join(localRoot, 'artifacts', 'ppplus-aggregate', 'lazybot-ppplus-0.1.15.jar');
  const ppplusExe = path.join(localRoot, 'artifacts', 'ppplus', 'Difficalcy.PerformancePlus.exe');
  const ppplusDll = path.join(path.dirname(ppplusExe), 'Difficalcy.PerformancePlus.dll');
  const ppplusConfig = path.join(localRoot, 'configs', 'private', 'ppplus-aggregate', 'application.yaml');
  const yumuJar = path.join(localRoot, 'artifacts', 'yumu', 'nowbot-windows-v0.8.3-source-build.jar');
  const yumuConfig = path.join(localRoot, 'configs', 'private', 'yumu', 'application.yaml');
  const kanonExe = path.join(localRoot, 'artifacts', 'kanon', 'KanonBot.exe');
  const hydrantDll = path.join(localRoot, 'artifacts', 'hydrant', 'Bleatingsheep.NewHydrant.Bot.dll');
  const hydrantDir = path.join(localRoot, 'data', 'hydrant');
  const lazybotJar = path.join(localRoot, 'artifacts', 'lazybot', 'lazybot-1.2.0.jar');
  const lazybotConfig = path.join(localRoot, 'configs', 'private', 'lazybot', 'application.yaml');
  const wuxinEntry = path.join(projectRoot, 'server', 'index.ts');
  const wuxinTsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

  const definition = (value) => ({
    stopOnClose: true,
    enabled: true,
    autoStart: false,
    env: {},
    args: [],
    ...value,
    args: normalizeArgs(value.args),
    env: normalizeEnv(value.env),
  });

  return [
    definition({
      id: 'postgres', label: 'PostgreSQL', group: '基础依赖', port: 5432,
      command: pgCtl, cwd: postgresDir, args: ['start', '-D', postgresCluster, '-l', path.join(localRoot, 'logs', 'postgresql.log'), '-w'],
      stopCommand: pgCtl, stopArgs: ['stop', '-D', postgresCluster, '-m', 'fast'],
      matcher: { includes: [postgresCluster], executablePaths: [path.join(postgresDir, 'bin', 'postgres.exe')] },
    }),
    definition({
      id: 'mariadb', label: 'MariaDB', group: '基础依赖', port: 3306,
      command: maria, cwd: mariaDir, args: [`--defaults-file=${mariaConfig}`],
      matcher: { includes: ['mariadbd', localRoot] },
    }),
    definition({
      id: 'ppplus', label: 'PP+ PerformancePlus', group: 'PP+ / 外部 Bot', port: 5000,
      // Launch through the bundled host explicitly. Starting the apphost exe
      // can fall back to the system .NET installation on Windows.
      // The shipped runtime currently carries ASP.NET Core 10 while the
      // calculator targets net8.  Make the roll-forward part of the command
      // line as well as the environment so it survives Electron/Windows
      // launchers that sanitize DOTNET_* variables.
      command: dotnet, cwd: path.dirname(ppplusDll), args: ['--roll-forward', 'Major', path.basename(ppplusDll)], env: dotnetEnv,
      requiredPaths: [ppplusDll],
      matcher: { includes: [path.basename(ppplusDll)] },
    }),
    definition({
      id: 'ppplusAggregate', label: 'PP+ Aggregate', group: 'PP+ / 外部 Bot', port: 9001,
      command: java, cwd: localRoot, args: [...javaOpts, '-jar', ppplusJar, `--spring.config.additional-location=${ppplusConfig}`],
      matcher: { includes: [path.basename(ppplusJar), 'ppplus-aggregate'] },
    }),
    definition({
      // yumu-image is a renderer client. It connects to Yumu's 8388
      // render-ws and to Wuxin's 8389 render-ws; it does not listen on a
      // port itself. Giving it port=8388 made Desktop wait for a listener
      // that can only be provided by the separate Yumu process.
      id: 'yumuImage', label: 'yumu-image 渲染器', group: '外部 Bot', port: null,
      command: yumuNode, cwd: yumuDir, args: [path.join(yumuDir, 'main.js')], env: yumuImageEnv,
      matcher: { includes: [path.join(yumuDir, 'main.js')] },
    }),
    definition({
      id: 'yumu', label: '雨沐 YumuBot', group: '外部 Bot', port: 8388,
      command: java, cwd: localRoot, args: [...javaOpts, `-Djava.io.tmpdir=${path.join(localRoot, 'data', 'yumu', 'tmp')}`, '-jar', yumuJar, `--spring.config.additional-location=${yumuConfig}`],
      matcher: { includes: [path.basename(yumuJar)] },
    }),
    definition({
      id: 'kanon', label: '猫猫 KanonBot', group: '外部 Bot', port: 7700, enabled: false,
      command: kanonExe, cwd: path.dirname(kanonExe), args: [],
      requiredFiles: [{ path: path.join(path.dirname(kanonExe), 'config.toml'), minBytes: 1 }],
      matcher: { includes: [path.basename(kanonExe)] },
    }),
    definition({
      id: 'hydrant', label: '消防栓 Hydrant', group: '外部 Bot', port: 8800,
      command: dotnet, cwd: hydrantDir, args: ['--roll-forward', 'Major', hydrantDll], env: dotnetEnv,
      matcher: { includes: [path.basename(hydrantDll)] },
    }),
    definition({
      id: 'lazybot', label: 'LazyBot', group: '外部 Bot', port: 1145, enabled: false,
      command: java, cwd: localRoot, args: [...javaOpts, '-Dlazybot.ppplus.base-url=http://127.0.0.1:9001', '-Dlazybot.ppplus.api-prefix=', '-jar', lazybotJar, `--spring.config.additional-location=${lazybotConfig}`],
      matcher: { includes: [path.basename(lazybotJar)] },
    }),
    definition({
      id: 'napcat', label: 'NapCat / QQ', group: '消息入口', port: 3001,
      command: napcat, cwd: shellDir, args: [`--user-data-dir=${napcatUserData}`],
      matcher: { includes: [shellDir], executablePaths: [path.join(shellDir, 'QQ.exe')] },
    }),
    definition({
      id: 'skillProfiler', label: 'Skill Profiler', group: '分析服务', port: 8767, enabled: false,
      command: python, cwd: profilerRoot, args: ['-u', profilerCli, 'bid-review-ui', '--manifest', profilerManifest, '--no-open', '--algorithm', profilerAlgorithm],
      requiredPaths: [profilerManifest],
      matcher: { includes: [profilerCli] },
    }),
    definition({
      id: 'wuxin', label: 'WuxinBot', group: '核心服务', port: 8787, enabled: true, autoStart: true,
      command: node, cwd: projectRoot,
      args: [path.relative(projectRoot, wuxinTsxCli), path.relative(projectRoot, wuxinEntry)],
      // The bridge reads Hydrant's token and LazyBot's config through the
      // deployment root.  Desktop knows this root; pass it explicitly instead
      // of relying on the process cwd (which is the Wuxin checkout).
      env: {
        PORT: '8787',
        BOTS_ROOT: localRoot,
        LAZYBOT_CONFIG_PATH: lazybotConfig,
        HYDRANT_CONFIG_PATH: path.join(localRoot, 'configs', 'private', 'hydrant', 'appsettings.json'),
      },
      // Match both an absolute entry path from an older config and the
      // relative path used by the Windows Node CLI after migration.
      matcher: { includes: [path.join('server', 'index.ts')] },
    }),
  ];
}

function mergeDefinition(defaultDefinition, savedDefinition) {
  const result = { ...defaultDefinition, args: [...defaultDefinition.args], env: { ...defaultDefinition.env } };
  if (savedDefinition && typeof savedDefinition === 'object') {
    for (const key of ['label', 'group', 'command', 'cwd', 'port', 'enabled', 'autoStart', 'stopOnClose']) {
      if (savedDefinition[key] !== undefined) result[key] = savedDefinition[key];
    }
    if (Array.isArray(savedDefinition.args)) result.args = normalizeArgs(savedDefinition.args);
    if (savedDefinition.env && typeof savedDefinition.env === 'object') {
      result.env = { ...normalizeEnv(defaultDefinition.env) };
      for (const [key, value] of Object.entries(savedDefinition.env)) {
        if (value === null) delete result.env[key];
        else result.env[key] = String(value);
      }
    }
    if (savedDefinition.matcher && typeof savedDefinition.matcher === 'object') result.matcher = { ...defaultDefinition.matcher, ...savedDefinition.matcher };
    if (savedDefinition.stopCommand !== undefined) result.stopCommand = text(savedDefinition.stopCommand);
    if (Array.isArray(savedDefinition.stopArgs)) result.stopArgs = normalizeArgs(savedDefinition.stopArgs);
  }
  if (result.id === 'wuxin') {
    result.args = normalizeWuxinRuntimeArgs(result.args, result.cwd);
    if (Object.hasOwn(result.env, 'NODE_OPTIONS')) {
      result.env.NODE_OPTIONS = stripLegacyTsxLoaderOption(result.env.NODE_OPTIONS);
    }
  }
  return result;
}

function normalizeWuxinRuntimeArgs(args, cwd) {
  const normalized = normalizeArgs(args);
  const root = path.resolve(cwd || process.cwd());
  const usesTsxLoader = normalized.some((arg) => /(?:^|[\\/])tsx[\\/]dist[\\/]loader\.mjs$/i.test(arg));
  const cliIndex = normalized.findIndex((arg) => /(?:^|[\\/])tsx[\\/]dist[\\/]cli\.mjs$/i.test(arg));
  const entryIndex = normalized.findIndex((arg) => /(?:^|[\\/])server[\\/]index\.ts$/i.test(arg));

  // Older Desktop configs used a Windows-relative loader URL. Node treats it
  // as a package name, so it fails before server/index.ts can run. Launch the
  // current tsx CLI and entrypoint by absolute path, rooted at the selected
  // Wuxin checkout, including when a v2 override still carries that old form.
  if (usesTsxLoader || cliIndex >= 0 && entryIndex > cliIndex) {
    const trailingArgs = entryIndex >= 0 ? normalized.slice(entryIndex + 1) : [];
    return [
      path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      path.join(root, 'server', 'index.ts'),
      ...trailingArgs,
    ];
  }
  return normalized;
}

function stripLegacyTsxLoaderOption(value) {
  return String(value || '')
    .replace(/(?:^|\s)(?:--loader|--import|--require|-r)(?:=|\s+)(?:"[^"]*tsx[\\/]dist[\\/]loader\.mjs"|'[^']*tsx[\\/]dist[\\/]loader\.mjs'|[^\s]+tsx[\\/]dist[\\/]loader\.mjs)(?=\s|$)/gi, ' ')
    .trim();
}

function definitionOverrides(definition, defaults) {
  const overrides = {};
  for (const key of CONFIG_FIELDS) {
    if (key === 'env') continue;
    if (definition[key] !== undefined && !isDeepStrictEqual(definition[key], defaults[key])) overrides[key] = definition[key];
  }
  const env = {};
  for (const key of new Set([...Object.keys(defaults.env || {}), ...Object.keys(definition.env || {})])) {
    if (definition.env?.[key] !== defaults.env?.[key]) env[key] = definition.env?.[key] ?? null;
  }
  if (Object.keys(env).length) overrides.env = env;
  return overrides;
}

function migrateLegacyDefinition(defaultDefinition, savedDefinition) {
  const result = mergeDefinition(defaultDefinition, savedDefinition);
  if (!savedDefinition || typeof savedDefinition !== 'object') return result;
  // v1 saved whole defaults, with no indication of user edits. Only recognize
  // known generated shapes here; all other differences become user overrides.
  if (result.id === 'postgres' && isDeepStrictEqual(savedDefinition.matcher?.includes, ['postgres'])) {
    result.matcher = defaultDefinition.matcher;
  } else if (result.id === 'wuxin') {
    result.args = normalizeWuxinArgs(result.args, result.cwd);
    const oldMatcher = savedDefinition.matcher?.includes;
    if (Array.isArray(oldMatcher) && oldMatcher.length === 1
      && [path.join(result.cwd, 'server', 'index.ts'), path.join('server', 'index.ts')].includes(oldMatcher[0])) {
      result.matcher = defaultDefinition.matcher;
    }
  } else if (result.id === 'skillProfiler') {
    const savedRoot = text(savedDefinition.cwd);
    const knownRoots = [defaultDefinition.cwd, 'G:\\My pack\\Agent Work\\osu-skill-profiler'];
    const knownManifest = [defaultDefinition.args[4], path.join(savedRoot, 'training', 'datasets', 'std_manifest.json')].includes(result.args[4]);
    const generatedArgs = ['-u', path.join(savedRoot, 'tools', 'map_demand_v01', 'cli.py'), 'bid-review-ui', '--manifest', result.args[4], '--no-open', '--algorithm', result.args[7]];
    if (knownRoots.includes(savedRoot) && knownManifest && isDeepStrictEqual(result.args, generatedArgs)
      && ['v100', 'v040', 'v040-formal'].includes(result.args[7])) {
      result.cwd = defaultDefinition.cwd;
      result.args = [...defaultDefinition.args];
      result.matcher = defaultDefinition.matcher;
    } else {
      // Keep a deliberate alternate profiler/algorithm, including its root.
      result.args = normalizeProfilerArgs(result.args);
    }
  } else if (result.id === 'ppplus') {
    const savedCommand = text(savedDefinition.command);
    const savedArgs = normalizeArgs(savedDefinition.args);
    const oldAppHost = savedCommand === path.join(defaultDefinition.cwd, 'Difficalcy.PerformancePlus.exe') && savedArgs.length === 0;
    const systemDotnet = /^dotnet(?:\.exe)?$/i.test(savedCommand)
      || /[\\/]Program Files[\\/]dotnet[\\/]dotnet\.exe$/i.test(savedCommand);
    const oldDllArgs = [path.basename(defaultDefinition.args[2]), path.join(defaultDefinition.cwd, defaultDefinition.args[2])];
    const knownDotnet = systemDotnet || savedCommand === defaultDefinition.command;
    const oldDllShape = savedArgs.length === 1 && oldDllArgs.includes(savedArgs[0]);
    const currentDllShape = savedArgs.length === 3 && savedArgs[0] === '--roll-forward' && savedArgs[1] === 'Major' && oldDllArgs.includes(savedArgs[2]);
    if (oldAppHost || knownDotnet && (oldDllShape || systemDotnet && currentDllShape)) {
      result.command = defaultDefinition.command;
      result.cwd = defaultDefinition.cwd;
      result.args = [...defaultDefinition.args];
    }
  } else if (result.id === 'hydrant') {
    if (isDeepStrictEqual(result.args, defaultDefinition.args.slice(2))) result.args = [...defaultDefinition.args];
  } else if (result.id === 'yumuImage') {
    // Migrate the old saved `port: 8388` value. 8388 belongs to YumuBot;
    // this process is only a renderer client.
    if (result.port === 8388) result.port = defaultDefinition.port;
  }
  return result;
}

function commandForSpawn(command) {
  return /\.(cmd|bat)$/i.test(command) ? { command: 'cmd.exe', argsPrefix: ['/d', '/c', command] } : { command, argsPrefix: [] };
}

export class ProcessManager {
  constructor({ projectRoot, configDir, onLog = () => {}, buildDefinitions = buildDefaultDefinitions, runtime = {}, readinessTimeoutMs = 20_000 }) {
    this.projectRoot = projectRoot;
    this.configDir = configDir;
    this.configFile = path.join(configDir, 'desktop-runtime.json');
    this.logDir = path.join(configDir, 'logs');
    this.onLog = onLog;
    this.buildDefinitions = buildDefinitions;
    this.runtime = { listProcesses: listSystemProcesses, listListeners: listPortListeners, probePort, runFile, spawn, ...runtime };
    this.readinessTimeoutMs = readinessTimeoutMs;
    this.children = new Map();
    this.launches = new Map();
    this.starting = new Map();
    this.closing = false;
    this.startGeneration = 0;
    this.lastErrors = new Map();
    this.defaults = new Map();
    this.processOverrides = new Map();
    this.config = null;
    this.writePromise = Promise.resolve();
    this.initialization = null;
    this.statePromise = null;
  }

  initialize() {
    if (this.config) return Promise.resolve(this.config);
    if (!this.initialization) this.initialization = this.loadConfig().catch((error) => {
      this.config = null;
      this.initialization = null;
      throw error;
    });
    return this.initialization;
  }

  async loadConfig() {
    await fsp.mkdir(this.configDir, { recursive: true });
    await fsp.mkdir(this.logDir, { recursive: true });
    let saved = null;
    try { saved = JSON.parse(await fsp.readFile(this.configFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`无法读取 Desktop 配置，原文件已保留：${error.message}`); }
    if (saved?.version > CONFIG_VERSION) throw new Error(`Desktop 配置版本 ${saved.version} 高于当前支持的版本 ${CONFIG_VERSION}`);
    const defaults = this.buildDefinitions(this.projectRoot);
    this.defaults = new Map(defaults.map((definition) => [definition.id, definition]));
    if (saved && saved.version !== CONFIG_VERSION) {
      await fsp.copyFile(this.configFile, `${this.configFile}.v1.backup`, fs.constants.COPYFILE_EXCL).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
      for (const previous of Array.isArray(saved.processes) ? saved.processes : []) {
        const baseline = this.defaults.get(previous?.id);
        if (!baseline) continue;
        const overrides = definitionOverrides(migrateLegacyDefinition(baseline, previous), baseline);
        if (Object.keys(overrides).length) this.processOverrides.set(previous.id, overrides);
      }
      this.onLog({ level: 'info', message: 'Desktop 配置已迁移，原始 v1 文件已备份' });
    } else if (saved?.processOverrides && typeof saved.processOverrides === 'object' && !Array.isArray(saved.processOverrides)) {
      for (const [id, overrides] of Object.entries(saved.processOverrides)) {
        if (!safeId(id) || !overrides || typeof overrides !== 'object' || Array.isArray(overrides)) continue;
        this.processOverrides.set(id, Object.fromEntries(CONFIG_FIELDS.filter((key) => overrides[key] !== undefined).map((key) => [key, overrides[key]])));
      }
    }
    this.config = {
      version: CONFIG_VERSION,
      settings: Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([key, fallback]) => [key, saved?.settings?.[key] === undefined ? fallback : Boolean(saved.settings[key])])),
      processes: defaults.map((definition) => mergeDefinition(definition, this.processOverrides.get(definition.id))),
    };
    await this.persist();
    return this.config;
  }

  get settings() {
    return { ...(this.config?.settings || {}) };
  }

  get definitions() {
    return this.config?.processes || [];
  }

  getDefinition(id) {
    return this.definitions.find((definition) => definition.id === id) || null;
  }

  async persist() {
    if (!this.config) return;
    const serialized = JSON.stringify({
      version: CONFIG_VERSION,
      settings: Object.fromEntries(Object.entries(this.config.settings).filter(([key, value]) => value !== DEFAULT_SETTINGS[key])),
      processOverrides: Object.fromEntries(this.processOverrides),
    }, null, 2);
    this.writePromise = this.writePromise.catch(() => {}).then(async () => {
      const temp = `${this.configFile}.${process.pid}.tmp`;
      await fsp.writeFile(temp, serialized, 'utf8');
      await fsp.rename(temp, this.configFile);
    });
    return this.writePromise;
  }

  async updateSettings(patch = {}) {
    if (!this.config) await this.initialize();
    for (const key of ['autoLaunch', 'startOnOpen', 'stopOnClose']) {
      if (patch[key] !== undefined) this.config.settings[key] = Boolean(patch[key]);
    }
    await this.persist();
    return this.settings;
  }

  async updateProcess(id, patch = {}) {
    if (!this.config) await this.initialize();
    const definition = this.getDefinition(id);
    if (!definition) throw new Error(`未知进程：${id}`);
    for (const key of ['command', 'cwd', 'label', 'group']) {
      if (patch[key] !== undefined) definition[key] = text(patch[key]);
    }
    for (const key of ['enabled', 'autoStart', 'stopOnClose']) {
      if (patch[key] !== undefined) definition[key] = Boolean(patch[key]);
    }
    if (patch.port !== undefined) {
      const port = patch.port === null ? null : Number(patch.port);
      if (port === null) definition.port = null;
      if (Number.isInteger(port) && port >= 0 && port <= 65535) definition.port = port;
    }
    if (Array.isArray(patch.args)) definition.args = normalizeArgs(patch.args);
    if (patch.env && typeof patch.env === 'object') definition.env = normalizeEnv(patch.env);
    const overrides = definitionOverrides(definition, this.defaults.get(id));
    if (Object.keys(overrides).length) this.processOverrides.set(id, overrides);
    else this.processOverrides.delete(id);
    await this.persist();
    return definition;
  }

  async matchingProcesses(definition, allProcesses = null) {
    const processes = allProcesses || await this.runtime.listProcesses();
    return processes.filter((processInfo) => matchesDefinition(processInfo, definition));
  }

  async inspect() {
    const [processes, listeners] = await Promise.allSettled([this.runtime.listProcesses(), this.runtime.listListeners()]);
    return {
      processes: processes.status === 'fulfilled' ? processes.value : [],
      listeners: listeners.status === 'fulfilled' ? listeners.value : [],
    };
  }

  ownedProcesses(id, processes) {
    return collectOwnedProcesses(this.launches.get(id), processes);
  }

  async portStatus(definition, snapshot, owned, { managedOnly = false } = {}) {
    if (!definition.port) return { open: false, ready: true, conflict: false, pids: [] };
    const open = await this.runtime.probePort(definition.port);
    if (!open) return { open: false, ready: false, conflict: false, pids: [] };
    const pids = [...new Set(loopbackListeners(snapshot.listeners, definition.port).map((item) => item.pid))];
    const ownedPids = new Set(owned.map((item) => item.pid));
    const verified = pids.filter((pid) => ownedPids.has(pid) || !managedOnly
      && matchesDefinition(snapshot.processes.find((item) => item.pid === pid), definition));
    const ready = pids.length > 0 && verified.length === pids.length;
    return { open, ready, conflict: !ready, pids };
  }

  portError(definition, port) {
    return port.pids.length
      ? `端口 ${definition.port} 被其他进程占用（PID ${port.pids.join(', ')}）`
      : `端口 ${definition.port} 已监听，但无法确认进程归属`;
  }

  state() {
    // The console polls this every 2.5s and each snapshot spawns PowerShell.
    // Coalesce overlapping reads so a slow snapshot cannot stack concurrent
    // IPC calls into parallel process enumerations.
    if (this.statePromise) return this.statePromise;
    const promise = this.computeState().finally(() => {
      if (this.statePromise === promise) this.statePromise = null;
    });
    this.statePromise = promise;
    return promise;
  }

  async computeState() {
    if (!this.config) await this.initialize();
    const snapshot = await this.inspect();
    const processes = await Promise.all(this.definitions.map(async (definition) => {
      const matches = await this.matchingProcesses(definition, snapshot.processes);
      const owned = this.ownedProcesses(definition.id, snapshot.processes);
      const launch = this.launches.get(definition.id);
      const managed = owned.length > 0;
      const port = await this.portStatus(definition, snapshot, owned);
      const running = managed || matches.length > 0;
      const requirementErrors = missingRequirements(definition);
      const available = commandExists(definition.command) && requirementErrors.length === 0;
      if (running && port.ready) this.lastErrors.delete(definition.id);
      const status = port.conflict ? 'conflict'
        : running && !port.ready ? (launch?.timedOut ? 'unready' : 'starting')
          : running ? 'running' : available ? 'stopped' : 'missing';
      return {
        id: definition.id,
        label: definition.label,
        group: definition.group,
        command: definition.command,
        cwd: definition.cwd,
        args: [...definition.args],
        enabled: Boolean(definition.enabled),
        autoStart: Boolean(definition.autoStart),
        stopOnClose: definition.stopOnClose !== false,
        port: definition.port || null,
        available,
        status,
        managed,
        source: managed ? 'managed' : running ? 'external' : null,
        ready: running && port.ready,
        ownedPids: owned.map((item) => item.pid),
        pids: [...new Set([...matches.map((item) => item.pid), ...owned.map((item) => item.pid)])],
        lastError: port.conflict ? this.portError(definition, port)
          : launch?.child?.lastError || this.lastErrors.get(definition.id) || requirementErrors.join('；'),
      };
    }));
    return {
      settings: this.settings,
      processes,
      updatedAt: new Date().toISOString(),
    };
  }

  start(id) {
    if (this.closing) return Promise.reject(new Error('Desktop 正在退出，启动已取消'));
    const pending = this.starting.get(id);
    if (pending) return pending.promise;
    const entry = { controller: new AbortController() };
    entry.promise = Promise.resolve().then(() => this.startProcess(id, entry.controller.signal)).finally(() => {
      if (this.starting.get(id) === entry) this.starting.delete(id);
    });
    this.starting.set(id, entry);
    return entry.promise;
  }

  async startProcess(id, signal) {
    if (!this.config) await this.initialize();
    const configured = this.getDefinition(id);
    const definition = configured ? mergeDefinition(configured) : null;
    if (!definition) throw new Error(`未知进程：${id}`);
    if (!definition.enabled) throw new Error(`${definition.label} 已被关闭，请先打开进程开关`);
    const ensureActive = () => {
      if (this.closing || signal.aborted) throw new Error(`${definition.label} 的启动已取消`);
    };
    ensureActive();
    const snapshot = await this.inspect();
    ensureActive();
    const existing = await this.matchingProcesses(definition, snapshot.processes);
    const owned = this.ownedProcesses(id, snapshot.processes);
    const port = await this.portStatus(definition, snapshot, owned);
    ensureActive();
    if (port.conflict) {
      const error = this.portError(definition, port);
      this.lastErrors.set(id, error);
      throw new Error(`${definition.label} 无法启动：${error}`);
    }
    if (existing.length || owned.length) {
      if (!port.ready) throw new Error(`${definition.label} 已有进程，但端口 ${definition.port} 尚未就绪，请查看日志`);
      this.lastErrors.delete(id);
      return { alreadyRunning: true, ready: true, managed: owned.length > 0, pids: [...new Set([...existing, ...owned].map((item) => item.pid))] };
    }
    if (!commandExists(definition.command)) throw new Error(`${definition.label} 的启动文件不存在：${definition.command}`);
    const missing = missingRequirements(definition);
    if (missing.length) throw new Error(`${definition.label} 尚未就绪：${missing.join('；')}`);

    // Kanon writes downloaded .osu files relative to its working directory.
    // The packaged artifact does not ship the cache directory, and without it
    // a recent-score request crashes during PP calculation before it can send
    // the panel reply. Create it at the same boundary used for every launch so
    // manual starts and restarts behave identically.
    if (definition.id === 'kanon') {
      const kanonRoot = definition.cwd || this.projectRoot;
      const kanonWork = path.join(kanonRoot, 'work');
      await fsp.mkdir(path.join(kanonWork, 'beatmap'), { recursive: true });
      // The packaged executable expects its Takumi font bundle under the same
      // relative work directory. Keep the artifact self-contained while using
      // the checked-in deployment bundle as the source of truth.
      const fontSource = path.resolve(kanonRoot, '..', '..', 'data', 'kanon', 'work', 'fonts');
      const fontTarget = path.join(kanonWork, 'fonts');
      if (fs.existsSync(fontSource)) {
        await fsp.cp(fontSource, fontTarget, { recursive: true, force: false });
      }
      const workSource = path.resolve(kanonRoot, '..', '..', 'data', 'kanon', 'work');
      const workSentinel = path.join(kanonWork, 'templates', 'ScorePanelV2', 'index.jinja');
      if (!fs.existsSync(workSentinel) && fs.existsSync(workSource)) {
        await fsp.cp(workSource, kanonWork, { recursive: true, force: false });
      }
      const resourceSource = path.resolve(kanonRoot, '..', '..', 'sources', 'kanon-bot', 'resources');
      const resourceTarget = path.join(kanonRoot, 'resources');
      const resourceSentinel = path.join(resourceTarget, 'templates', 'ScorePanelV2', 'index.jinja');
      if (!fs.existsSync(resourceSentinel) && fs.existsSync(resourceSource)) {
        await fsp.cp(resourceSource, resourceTarget, { recursive: true, force: false });
      }
    }

    ensureActive();
    const logBase = path.join(this.logDir, definition.id);
    const stdout = fs.createWriteStream(`${logBase}.stdout.log`, { flags: 'a' });
    const stderr = fs.createWriteStream(`${logBase}.stderr.log`, { flags: 'a' });
    const spawnCommand = commandForSpawn(definition.command);
    const args = [...spawnCommand.argsPrefix, ...definition.args];
    const childEnv = { ...process.env, ...definition.env };
    if (definition.id === 'wuxin' && childEnv.NODE_OPTIONS) {
      const safeNodeOptions = stripLegacyTsxLoaderOption(childEnv.NODE_OPTIONS);
      if (safeNodeOptions) childEnv.NODE_OPTIONS = safeNodeOptions;
      else delete childEnv.NODE_OPTIONS;
    }
    const spawnedAt = Date.now();
    const child = this.runtime.spawn(spawnCommand.command, args, {
      cwd: definition.cwd || this.projectRoot,
      env: childEnv,
      windowsHide: true,
      detached: false,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderrTail = '';
    child.stderr?.on('data', (chunk) => {
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-2400);
    });
    child.stdout?.pipe(stdout);
    child.stderr?.pipe(stderr);
    child.lastError = '';
    const launch = {
      pid: child.pid, child, definition, timedOut: false,
      evidence: new Map(child.pid ? [[child.pid, { pid: child.pid, spawnedAt, createdAt: null, exitedAt: null }]] : []),
    };
    this.lastErrors.delete(definition.id);
    this.children.set(definition.id, child);
    this.launches.set(definition.id, launch);
    this.onLog({ level: 'info', message: `${definition.label} 已发起启动`, id: definition.id });
    child.once('error', (error) => {
      child.lastError = error?.message || String(error);
      this.lastErrors.set(definition.id, compactError(child.lastError));
      this.onLog({ level: 'error', message: `${definition.label} 启动失败：${child.lastError}`, id: definition.id });
    });
    child.once('exit', (code, signal) => {
      const root = launch.evidence.get(child.pid);
      if (root) {
        root.exitedAt = Date.now();
        root.exitConfirmed = true;
      }
      if (this.children.get(definition.id) === child) this.children.delete(definition.id);
      const detail = compactError(stderrTail);
      if (child.intentionalStop || code === 0 || !detail && !code && !signal) this.lastErrors.delete(definition.id);
      else if (code !== 0 || signal) this.lastErrors.set(definition.id, detail || `退出码 ${code ?? signal ?? 'unknown'}`);
      const suffix = child.intentionalStop ? '' : (detail ? `：${detail}` : '');
      this.onLog({ level: child.intentionalStop || code === 0 ? 'info' : 'warn', message: `${definition.label} 已退出 (${code ?? signal ?? 'unknown'})${suffix}`, id: definition.id });
    });
    child.once('close', () => {
      stdout.end();
      stderr.end();
      if (this.children.get(definition.id) === child) this.children.delete(definition.id);
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    ensureActive();
    if (definition.port) {
      const failed = () => Boolean(child.lastError || child.intentionalStop || child.signalCode || child.exitCode !== null && child.exitCode !== 0);
      const ready = await waitForPort(definition.port, {
        timeoutMs: this.readinessTimeoutMs,
        probe: this.runtime.probePort,
        cancelled: () => this.closing || signal.aborted || failed(),
        verify: async () => {
          const current = await this.inspect();
          const ownedNow = this.ownedProcesses(id, current.processes);
          const status = await this.portStatus(definition, current, ownedNow, { managedOnly: true });
          if (status.conflict && status.pids.length) throw new Error(`${definition.label} 启动失败：${this.portError(definition, status)}`);
          return status.ready;
        },
      });
      ensureActive();
      if (!ready) {
        launch.timedOut = !failed();
        const error = failed()
          ? `${definition.label} 启动后退出或失败，请查看桌面日志${child.lastError ? `：${compactError(child.lastError)}` : ''}`
          : `${definition.label} 启动未就绪：等待端口 ${definition.port} 超时（${this.readinessTimeoutMs / 1000} 秒）`;
        this.lastErrors.set(id, error);
        throw new Error(error);
      }
    }
    return { started: true, ready: true, pid: child.pid };
  }

  async killPid(pid, evidence, launch) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
    const liveRoot = launch?.pid === pid && isLiveChild(launch.child);
    if (!liveRoot) {
      // A retained launcher PID can be reused. Recheck identity before killing.
      const processes = await this.runtime.listProcesses();
      if (!sameProcess(processes.find((item) => item.pid === pid), evidence)) return false;
    }
    if (WINDOWS) {
      try { await this.runtime.runFile('taskkill.exe', ['/PID', String(pid), '/T', '/F']); }
      catch (error) {
        const remaining = await this.runtime.listProcesses();
        if (sameProcess(remaining.find((item) => item.pid === pid), evidence) || liveRoot && isLiveChild(launch.child)) throw error;
        return false;
      }
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; return false; }
    }
    return true;
  }

  async stop(id) {
    const definition = this.getDefinition(id);
    if (!definition) throw new Error(`未知进程：${id}`);
    this.starting.get(id)?.controller.abort();
    const launch = this.launches.get(id);
    if (!launch) return { stopped: false, notManaged: true, pids: [] };
    const child = launch.child;
    child.intentionalStop = true;
    let snapshot = await this.inspect();
    let owned = this.ownedProcesses(id, snapshot.processes);
    if (!owned.length) return { stopped: false, notManaged: true, pids: [] };
    const originalPids = owned.map((item) => item.pid);
    const launchedDefinition = launch.definition;
    const port = await this.portStatus(launchedDefinition, snapshot, owned, { managedOnly: true });
    if (port.ready && launchedDefinition.stopCommand && commandExists(launchedDefinition.stopCommand)) {
      try { await this.runtime.runFile(launchedDefinition.stopCommand, normalizeArgs(launchedDefinition.stopArgs)); } catch (error) {
        this.onLog({ level: 'warn', message: `${definition.label} 停止命令返回错误：${error?.message || error}`, id });
      }
      snapshot = await this.inspect();
      owned = this.ownedProcesses(id, snapshot.processes);
    }
    const ownedPids = new Set(owned.map((item) => item.pid));
    // Windows taskkill /T handles the descendants of each surviving owned root.
    const targets = WINDOWS ? owned.filter((item) => !ownedPids.has(item.ppid)) : [...owned].reverse();
    await Promise.all(targets.map((item) => this.killPid(item.pid, launch.evidence.get(item.pid), launch)));
    this.lastErrors.delete(id);
    this.onLog({ level: 'info', message: `${definition.label} 已请求停止本窗口启动的进程`, id });
    return { stopped: true, pids: originalPids };
  }

  async restart(id) {
    const result = await this.stop(id);
    if (result.notManaged) {
      const definition = this.getDefinition(id);
      const existing = await this.matchingProcesses(definition);
      if (existing.length || definition.port && await this.runtime.probePort(definition.port)) {
        throw new Error(`${definition.label} 由外部启动，不能在此窗口重启`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    return this.start(id);
  }

  async startAll({ onlyAutoStart = false } = {}) {
    const results = [];
    const generation = this.startGeneration;
    for (const definition of this.definitions) {
      if (this.closing || generation !== this.startGeneration) break;
      if (!definition.enabled || (onlyAutoStart && !definition.autoStart)) continue;
      try { results.push({ id: definition.id, ok: true, result: await this.start(definition.id) }); }
      catch (error) { results.push({ id: definition.id, ok: false, error: error?.message || String(error) }); }
    }
    return results;
  }

  async stopAll({ respectStopOnClose = false } = {}) {
    this.startGeneration += 1;
    const results = [];
    for (const definition of [...this.definitions].reverse()) {
      if (respectStopOnClose && definition.stopOnClose === false) continue;
      try { results.push({ id: definition.id, ok: true, result: await this.stop(definition.id) }); }
      catch (error) { results.push({ id: definition.id, ok: false, error: error?.message || String(error) }); }
    }
    return results;
  }

  async restartAll() {
    const snapshot = await this.inspect();
    const ids = this.definitions.filter((definition) => definition.enabled
      && this.ownedProcesses(definition.id, snapshot.processes).length).map((definition) => definition.id);
    const results = [];
    for (const id of ids) {
      if (this.closing) break;
      try { results.push({ id, ok: true, result: await this.restart(id) }); }
      catch (error) { results.push({ id, ok: false, error: error.message || String(error) }); }
    }
    return results;
  }

  async shutdown() {
    this.closing = true;
    for (const entry of this.starting.values()) entry.controller.abort();
    if (this.settings.stopOnClose !== false) await this.stopAll({ respectStopOnClose: true });
  }
}

export { buildDefaultDefinitions };
