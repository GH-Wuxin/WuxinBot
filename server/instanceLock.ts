import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDataDir } from './store.js';

export const INSTANCE_LOCK_FILENAME = 'server-instance.lock';

type InstanceLockRecord = {
  pid: number;
  token: string;
  startedAt: string;
  port: number;
};

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM means the process exists but this account cannot signal it.
    return error?.code === 'EPERM';
  }
}

function readLock(lockPath: string): InstanceLockRecord | null {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return {
      pid: Number(value?.pid || 0),
      token: String(value?.token || ''),
      startedAt: String(value?.startedAt || ''),
      port: Number(value?.port || 0),
    };
  } catch {
    return null;
  }
}

/**
 * Claim one Wuxin server process per DATA_DIR. The OS port alone is not a
 * sufficient singleton guard on Windows: two Node HTTP servers can overlap
 * during a failed restart while both OneBot clients continue consuming events.
 */
export function acquireInstanceLock(port: number): () => void {
  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, INSTANCE_LOCK_FILENAME);
  const record: InstanceLockRecord = {
    pid: process.pid,
    token: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    port,
  };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    let handle: number | undefined;
    try {
      handle = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(handle, JSON.stringify(record), 'utf8');
      fs.closeSync(handle);
      handle = undefined;

      let released = false;
      return () => {
        if (released) return;
        released = true;
        const current = readLock(lockPath);
        if (current?.pid === record.pid && current.token === record.token) {
          try { fs.unlinkSync(lockPath); } catch { /* best-effort shutdown cleanup */ }
        }
      };
    } catch (error: any) {
      if (handle !== undefined) {
        try { fs.closeSync(handle); } catch { /* ignore close failure */ }
      }
      if (error?.code !== 'EEXIST') throw error;

      const owner = readLock(lockPath);
      if (owner && processIsAlive(owner.pid)) {
        const instanceError: any = new Error(
          `WuxinBot 已有实例运行（PID ${owner.pid}，端口 ${owner.port || '未知'}，数据目录 ${dataDir}）`,
        );
        instanceError.code = 'WUXIN_INSTANCE_ALREADY_RUNNING';
        throw instanceError;
      }

      // Missing/malformed/dead owner: remove only this exact stale file, then
      // race through O_EXCL again. Another starter may win, which is fine.
      try { fs.unlinkSync(lockPath); } catch (unlinkError: any) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      }
    }
  }

  throw new Error(`无法获取 WuxinBot 单实例锁：${lockPath}`);
}
