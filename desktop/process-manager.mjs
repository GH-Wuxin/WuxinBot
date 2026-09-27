import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const WINDOWS = process.platform === 'win32';
const MAX_PROCESS_OUTPUT = 8 * 1024 * 1024;

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
  const profilerRoot = envOr('SKILL_PROFILER_ROOT', 'G:\\My pack\\Agent Work\\osu-skill-profiler');
  const profilerCli = path.join(profilerRoot, 'tools', 'map_demand_v01', 'cli.py');
  const profilerManifest = envOr('SKILL_PROFILER_MANIFEST', path.join(profilerRoot, 'training', 'datasets', 'std_manifest.json'));
  // The profiler CLI currently exposes v100 as its frozen formal release.
  // Keep the override for local experiments, but do not ship the removed
  // v040-formal selector as the Desktop default.
  const profilerAlgorithm = envOr('SKILL_PROFILER_ALGORITHM', 'v100');
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
      matcher: { includes: ['postgres'] },
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
      command: dotnet, cwd: path.dirname(ppplusDll), args: [path.basename(ppplusDll)], env: dotnetEnv,
      requiredPaths: [ppplusDll],
      matcher: { includes: [path.basename(ppplusDll)] },
    }),
    definition({
      id: 'ppplusAggregate', label: 'PP+ Aggregate', group: 'PP+ / 外部 Bot', port: 9001,
      command: java, cwd: localRoot, args: [...javaOpts, '-jar', ppplusJar, `--spring.config.additional-location=${ppplusConfig}`],
      matcher: { includes: [path.basename(ppplusJar), 'ppplus-aggregate'] },
    }),
    definition({
      id: 'yumuImage', label: 'yumu-image 渲染器', group: '外部 Bot', port: 8388,
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
      command: dotnet, cwd: hydrantDir, args: [hydrantDll],
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
      matcher: { includes: [shellDir] },
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
      args: [wuxinTsxCli, wuxinEntry],
      env: { PORT: '8787' },
      matcher: { includes: [wuxinEntry] },
    }),
  ];
}

function mergeDefinition(defaultDefinition, savedDefinition) {
  if (!savedDefinition || typeof savedDefinition !== 'object') return defaultDefinition;
  const result = { ...defaultDefinition };
  for (const key of ['label', 'group', 'command', 'cwd', 'port', 'enabled', 'autoStart', 'stopOnClose']) {
    if (savedDefinition[key] !== undefined) result[key] = savedDefinition[key];
  }
  if (Array.isArray(savedDefinition.args)) result.args = normalizeArgs(savedDefinition.args);
  if (savedDefinition.env && typeof savedDefinition.env === 'object') result.env = normalizeEnv(savedDefinition.env);
  if (savedDefinition.matcher && typeof savedDefinition.matcher === 'object') result.matcher = savedDefinition.matcher;
  if (savedDefinition.stopCommand !== undefined) result.stopCommand = text(savedDefinition.stopCommand);
  if (Array.isArray(savedDefinition.stopArgs)) result.stopArgs = normalizeArgs(savedDefinition.stopArgs);
  return result;
}

function runFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, maxBuffer: MAX_PROCESS_OUTPUT, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function listSystemProcesses() {
  if (WINDOWS) {
    const script = '$ErrorActionPreference="SilentlyContinue"; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
    try {
      const result = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
      if (!result.stdout.trim()) return [];
      const parsed = JSON.parse(result.stdout);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows.map((row) => ({
        pid: Number(row.ProcessId),
        ppid: Number(row.ParentProcessId),
        name: text(row.Name),
        executablePath: text(row.ExecutablePath),
        commandLine: text(row.CommandLine),
      })).filter((row) => Number.isInteger(row.pid) && row.pid > 0);
    } catch {
      return [];
    }
  }
  try {
    const result = await runFile('ps', ['-axo', 'pid=,ppid=,comm=,args=']);
    return result.stdout.split(/\r?\n/).map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
      if (!match) return null;
      return { pid: Number(match[1]), ppid: Number(match[2]), name: match[3], executablePath: match[3], commandLine: match[4] };
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function matchesDefinition(processInfo, definition) {
  if (!processInfo || processInfo.pid === process.pid) return false;
  const haystack = `${processInfo.executablePath}\n${processInfo.commandLine}`.toLowerCase();
  const includes = Array.isArray(definition.matcher?.includes) ? definition.matcher.includes : [];
  return includes.length > 0 && includes.every((needle) => haystack.includes(String(needle).toLowerCase()));
}

function waitForPort(port, timeoutMs = 20_000) {
  if (!port) return Promise.resolve(true);
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const probe = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(500, () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.once('close', () => {
        if (Date.now() >= deadline) finish(false);
        else if (!settled) setTimeout(probe, 250);
      });
    };
    probe();
  });
}

function commandForSpawn(command) {
  return /\.(cmd|bat)$/i.test(command) ? { command: 'cmd.exe', argsPrefix: ['/d', '/c', command] } : { command, argsPrefix: [] };
}

export class ProcessManager {
  constructor({ projectRoot, configDir, onLog = () => {} }) {
    this.projectRoot = projectRoot;
    this.configDir = configDir;
    this.configFile = path.join(configDir, 'desktop-runtime.json');
    this.logDir = path.join(configDir, 'logs');
    this.onLog = onLog;
    this.children = new Map();
    this.lastErrors = new Map();
    this.config = null;
    this.writePromise = Promise.resolve();
  }

  async initialize() {
    await fsp.mkdir(this.configDir, { recursive: true });
    await fsp.mkdir(this.logDir, { recursive: true });
    let saved = null;
    try { saved = JSON.parse(await fsp.readFile(this.configFile, 'utf8')); } catch { /* first run */ }
    const defaults = buildDefaultDefinitions(this.projectRoot);
    const savedProcesses = new Map((Array.isArray(saved?.processes) ? saved.processes : []).map((item) => [item?.id, item]));
    this.config = {
      version: 1,
      settings: {
        autoLaunch: Boolean(saved?.settings?.autoLaunch),
        startOnOpen: saved?.settings?.startOnOpen === undefined ? false : Boolean(saved.settings.startOnOpen),
        stopOnClose: saved?.settings?.stopOnClose === undefined ? true : Boolean(saved.settings.stopOnClose),
      },
      processes: defaults.map((definition) => mergeDefinition(definition, savedProcesses.get(definition.id))),
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
    const serialized = JSON.stringify(this.config, null, 2);
    this.writePromise = this.writePromise.then(async () => {
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
      const port = Number(patch.port);
      if (Number.isInteger(port) && port >= 0 && port <= 65535) definition.port = port;
    }
    if (Array.isArray(patch.args)) definition.args = normalizeArgs(patch.args);
    if (patch.env && typeof patch.env === 'object') definition.env = normalizeEnv(patch.env);
    await this.persist();
    return definition;
  }

  async matchingProcesses(definition, allProcesses = null) {
    const processes = allProcesses || await listSystemProcesses();
    return processes.filter((processInfo) => matchesDefinition(processInfo, definition));
  }

  async state() {
    if (!this.config) await this.initialize();
    const allProcesses = await listSystemProcesses();
    const processes = await Promise.all(this.definitions.map(async (definition) => {
      const matches = await this.matchingProcesses(definition, allProcesses);
      const child = this.children.get(definition.id);
      const managed = Boolean(child && child.exitCode === null && !child.killed);
      const running = managed || matches.length > 0;
      const requirementErrors = missingRequirements(definition);
      const available = commandExists(definition.command) && requirementErrors.length === 0;
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
        status: running ? 'running' : (available ? 'stopped' : 'missing'),
        pids: [...new Set([...matches.map((item) => item.pid), ...(managed ? [child.pid] : [])])],
        lastError: child?.lastError || this.lastErrors.get(definition.id) || requirementErrors.join('；'),
      };
    }));
    return {
      settings: this.settings,
      processes,
      updatedAt: new Date().toISOString(),
    };
  }

  async start(id) {
    const definition = this.getDefinition(id);
    if (!definition) throw new Error(`未知进程：${id}`);
    if (!definition.enabled) throw new Error(`${definition.label} 已被关闭，请先打开进程开关`);
    const existing = await this.matchingProcesses(definition);
    if (existing.length > 0) return { alreadyRunning: true, pids: existing.map((item) => item.pid) };
    if (!commandExists(definition.command)) throw new Error(`${definition.label} 的启动文件不存在：${definition.command}`);
    const missing = missingRequirements(definition);
    if (missing.length) throw new Error(`${definition.label} 尚未就绪：${missing.join('；')}`);

    const logBase = path.join(this.logDir, definition.id);
    const stdout = fs.createWriteStream(`${logBase}.stdout.log`, { flags: 'a' });
    const stderr = fs.createWriteStream(`${logBase}.stderr.log`, { flags: 'a' });
    const spawnCommand = commandForSpawn(definition.command);
    const args = [...spawnCommand.argsPrefix, ...definition.args];
    const child = spawn(spawnCommand.command, args, {
      cwd: definition.cwd || this.projectRoot,
      env: { ...process.env, ...definition.env },
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
    this.lastErrors.delete(definition.id);
    this.children.set(definition.id, child);
    this.onLog({ level: 'info', message: `${definition.label} 已发起启动`, id: definition.id });
    child.once('error', (error) => {
      child.lastError = error?.message || String(error);
      this.onLog({ level: 'error', message: `${definition.label} 启动失败：${child.lastError}`, id: definition.id });
    });
    child.once('exit', (code, signal) => {
      stdout.end();
      stderr.end();
      if (this.children.get(definition.id) === child) this.children.delete(definition.id);
      const detail = compactError(stderrTail);
      if (child.intentionalStop || code === 0 || !detail && !code && !signal) this.lastErrors.delete(definition.id);
      else if (code !== 0 || signal) this.lastErrors.set(definition.id, detail || `退出码 ${code ?? signal ?? 'unknown'}`);
      const suffix = child.intentionalStop ? '' : (detail ? `：${detail}` : '');
      this.onLog({ level: child.intentionalStop || code === 0 ? 'info' : 'warn', message: `${definition.label} 已退出 (${code ?? signal ?? 'unknown'})${suffix}`, id: definition.id });
    });
    if (definition.port) {
      const ready = await waitForPort(definition.port, 20_000);
      if (!ready && child.exitCode !== null) throw new Error(`${definition.label} 启动后立即退出，请查看桌面日志`);
    }
    return { started: true, pid: child.pid };
  }

  async killPid(pid) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
    if (WINDOWS) {
      try { await runFile('taskkill.exe', ['/PID', String(pid), '/T', '/F']); } catch { /* already exited */ }
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
    }
  }

  async stop(id) {
    const definition = this.getDefinition(id);
    if (!definition) throw new Error(`未知进程：${id}`);
    if (definition.stopCommand && commandExists(definition.stopCommand)) {
      try { await runFile(definition.stopCommand, normalizeArgs(definition.stopArgs)); } catch (error) {
        this.onLog({ level: 'warn', message: `${definition.label} 停止命令返回错误：${error?.message || error}`, id });
      }
    }
    const allProcesses = await listSystemProcesses();
    const matches = await this.matchingProcesses(definition, allProcesses);
    const child = this.children.get(id);
    if (child) child.intentionalStop = true;
    const pids = [...new Set([...matches.map((item) => item.pid), child?.pid].filter(Boolean))];
    await Promise.all(pids.map((pid) => this.killPid(pid)));
    if (child && this.children.get(id) === child) this.children.delete(id);
    this.onLog({ level: 'info', message: `${definition.label} 已请求停止`, id });
    return { stopped: true, pids };
  }

  async restart(id) {
    await this.stop(id);
    await new Promise((resolve) => setTimeout(resolve, 600));
    return this.start(id);
  }

  async startAll({ onlyAutoStart = false } = {}) {
    const results = [];
    for (const definition of this.definitions) {
      if (!definition.enabled || (onlyAutoStart && !definition.autoStart)) continue;
      try { results.push({ id: definition.id, ok: true, result: await this.start(definition.id) }); }
      catch (error) { results.push({ id: definition.id, ok: false, error: error?.message || String(error) }); }
    }
    return results;
  }

  async stopAll({ respectStopOnClose = false } = {}) {
    const results = [];
    for (const definition of [...this.definitions].reverse()) {
      if (respectStopOnClose && definition.stopOnClose === false) continue;
      try { results.push({ id: definition.id, ok: true, result: await this.stop(definition.id) }); }
      catch (error) { results.push({ id: definition.id, ok: false, error: error?.message || String(error) }); }
    }
    return results;
  }
}

export { buildDefaultDefinitions };
