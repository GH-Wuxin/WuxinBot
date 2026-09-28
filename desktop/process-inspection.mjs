import { execFile } from 'node:child_process';
import net from 'node:net';

const WINDOWS = process.platform === 'win32';

export function runFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 10_000, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

export async function listSystemProcesses() {
  if (WINDOWS) {
    const script = 'Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,@{Name="CreatedAt";Expression={$_.CreationDate.ToUniversalTime().ToString("o")}} | ConvertTo-Json -Compress';
    const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (!stdout.trim()) return [];
    const parsed = JSON.parse(stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
      pid: Number(row.ProcessId), ppid: Number(row.ParentProcessId),
      name: String(row.Name || ''), executablePath: String(row.ExecutablePath || ''),
      commandLine: String(row.CommandLine || ''), createdAt: Date.parse(row.CreatedAt),
    })).filter((row) => Number.isInteger(row.pid) && row.pid > 0);
  }
  const { stdout } = await runFile('ps', ['-axo', 'pid=,ppid=,lstart=,comm=,args=']);
  return stdout.split(/\r?\n/).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(\S+)\s*(.*)$/);
    if (!match) return null;
    return { pid: Number(match[1]), ppid: Number(match[2]), createdAt: Date.parse(match[3]), name: match[4], executablePath: match[4], commandLine: match[5] };
  }).filter(Boolean);
}

function endpoint(value) {
  const match = value.match(/^(?:\[([^\]]+)\]|(.+)):(\d+)$/);
  return match ? { address: match[1] || match[2], port: Number(match[3]) } : null;
}

export function parseWindowsListeners(output) {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*TCP\s+(\S+)\s+(\S+)\s+\S+\s+(\d+)\s*$/i);
    if (!match) return [];
    const local = endpoint(match[1]);
    const remote = endpoint(match[2]);
    // A listener has remote port 0. This also works with localized netstat states.
    return local && remote?.port === 0 ? [{ ...local, pid: Number(match[3]) }] : [];
  });
}

export function parseHttpServiceState(output) {
  const queues = [];
  let queue = { pids: [], urls: [] };
  for (const line of output.split(/\r?\n/)) {
    if (/^(?:Request queue name|请求队列名称|请求队列名)\s*[:：]/i.test(line)) {
      queues.push(queue);
      queue = { pids: [], urls: [] };
    }
    const processId = line.match(/^\s+(?:ID|进程\s*ID|标识符)\s*[:：]\s*(\d+)\s*[,，]/i);
    if (processId) queue.pids.push(Number(processId[1]));
    // netsh prints URL prefixes as HTTP://host:port:host/path, not standard URLs.
    const url = line.match(/^\s+https?:\/\/(\[[^\]]+\]|[^:/]+):(\d+)(?::[^/]+)?\//i);
    if (url) {
      const host = url[1].replace(/^\[|\]$/g, '').toLowerCase();
      queue.urls.push({ address: ['+', '*'].includes(host) ? '0.0.0.0' : host === 'localhost' ? '127.0.0.1' : host, port: Number(url[2]) });
    }
  }
  queues.push(queue);
  return queues.flatMap(({ pids, urls }) => urls.flatMap((url) => pids.map((pid) => ({ ...url, pid, httpSys: true }))));
}

export async function listPortListeners() {
  if (WINDOWS) {
    const { stdout } = await runFile('netstat.exe', ['-ano', '-p', 'tcp']);
    const listeners = parseWindowsListeners(stdout);
    if (!listeners.some((row) => row.pid === 4)) return listeners;
    try {
      const serviceState = await runFile('netsh.exe', ['http', 'show', 'servicestate', 'view=requestq', 'verbose=yes']);
      const httpOwners = parseHttpServiceState(serviceState.stdout);
      return listeners.flatMap((row) => {
        if (row.pid !== 4) return [row];
        const owners = httpOwners.filter((owner) => owner.port === row.port);
        // PID 4 alone never proves ownership. Use active request queues, not URL ACLs.
        return owners.length ? owners : [row];
      });
    } catch {
      return listeners;
    }
  }
  const { stdout } = await runFile('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']);
  let pid = null;
  const result = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (line.startsWith('n') && pid) {
      const local = endpoint(line.slice(1));
      if (local) result.push({ ...local, pid });
    }
  }
  return result;
}

export function loopbackListeners(listeners, port) {
  const rows = listeners.filter((item) => item.port === Number(port));
  const ipv4 = rows.filter((item) => ['127.0.0.1', '0.0.0.0', '*'].includes(item.address));
  // probePort connects via IPv4. Prefer its listener over a separate IPv6-only one.
  return ipv4.length ? ipv4 : rows.filter((item) => item.address === '::');
}

export function matchesDefinition(processInfo, definition) {
  if (!processInfo || processInfo.pid === process.pid) return false;
  const normalize = (value) => String(value || '').replaceAll('\\', '/').toLowerCase();
  const haystack = normalize(`${processInfo.executablePath}\n${processInfo.commandLine}`);
  const includes = Array.isArray(definition.matcher?.includes) ? definition.matcher.includes : [];
  if (!includes.length || !includes.every((needle) => needle && haystack.includes(normalize(needle)))) return false;
  // A relative entry such as server/index.ts alone is not enough to identify a bot.
  const command = normalize(definition.command);
  const commandLineExecutable = String(processInfo.commandLine || '').match(/^(?:"([^"]+)"|(\S+))/);
  const executable = normalize(processInfo.executablePath || commandLineExecutable?.[1] || commandLineExecutable?.[2]);
  const executablePaths = Array.isArray(definition.matcher?.executablePaths) ? definition.matcher.executablePaths : [];
  const commands = [command, ...executablePaths.map(normalize)];
  return Boolean(executable) && (/\.(cmd|bat)$/i.test(command)
    || commands.some((candidate) => candidate.includes('/') ? executable === candidate : executable.split('/').at(-1) === candidate));
}

export function isLiveChild(child) {
  return Boolean(child?.pid && child.exitCode === null && child.signalCode == null && !child.killed && !child.lastError);
}

export function sameProcess(actual, evidence) {
  return Boolean(actual && evidence && actual.pid === evidence.pid
    && Number.isFinite(actual.createdAt) && actual.createdAt === evidence.createdAt);
}

export function collectOwnedProcesses(launch, processes) {
  if (!launch?.pid) return [];
  const rows = new Map(processes.map((row) => [row.pid, row]));
  const live = new Map();
  const root = launch.evidence.get(launch.pid);
  const rootRow = rows.get(launch.pid);
  if (isLiveChild(launch.child)) {
    if (rootRow) Object.assign(root, rootRow);
    live.set(launch.pid, rootRow || { ...root });
  }
  for (const [pid, evidence] of launch.evidence) {
    const row = rows.get(pid);
    if (sameProcess(row, evidence)) live.set(pid, row);
    else if (!evidence.exitedAt && !live.has(pid)) evidence.exitedAt = Date.now();
  }
  // pg_ctl and similar launchers may already be gone when their child binds.
  // Parent PID + a bounded creation time prove ancestry even after that exit.
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of processes) {
      if (live.has(row.pid) || row.pid === process.pid || row.pid === launch.pid) continue;
      const parent = launch.evidence.get(row.ppid);
      if (!parent) continue;
      const parentStart = Number.isFinite(parent.createdAt) ? parent.createdAt : parent.spawnedAt;
      const timeKnown = Number.isFinite(row.createdAt);
      if (!timeKnown || row.createdAt < parentStart) continue;
      // A missing process in a snapshot is not a known exit time: its PID may
      // already belong to another parent. Only a child exit event supplies the
      // historical bound needed to adopt previously unseen descendants.
      if (!live.has(row.ppid) && (!parent.exitConfirmed || !parent.exitedAt || row.createdAt > parent.exitedAt)) continue;
      const known = launch.evidence.get(row.pid);
      if (known && !sameProcess(row, known)) continue;
      launch.evidence.set(row.pid, known || { ...row, spawnedAt: row.createdAt, exitedAt: null });
      live.set(row.pid, row);
      changed = true;
    }
  }
  return [...live.values()];
}

export function probePort(port, timeoutMs = 350) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort <= 0 || numericPort > 65535) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: numericPort });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

export async function waitForPort(port, {
  timeoutMs = 20_000, intervalMs = 250, probe = probePort,
  verify = async () => true, cancelled = () => false,
} = {}) {
  if (!port) return true;
  const deadline = Date.now() + timeoutMs;
  while (!cancelled() && Date.now() < deadline) {
    // Each failed socket is just one attempt, not the outcome of the whole wait.
    const open = await probe(port, Math.max(1, Math.min(500, deadline - Date.now())));
    if (cancelled()) return false;
    if (open && Date.now() < deadline && await verify() && Date.now() <= deadline) return !cancelled();
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
  return false;
}
