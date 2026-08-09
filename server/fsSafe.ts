// fsSafe.ts — shared safety guards for filesystem mutations.
//
// These helpers exist so a typo, a forgotten DATA_DIR, or a broad `rm` can
// never erase or overwrite the production database, a drive root, or a
// directory that was not explicitly scoped by the caller.
import path from 'node:path';

export interface SafeDeleteOptions {
  /** Required containment root. The target must resolve strictly inside it. */
  base?: string;
  /** Allow deleting the base directory itself (default false). */
  allowBase?: boolean;
  /** Human-readable label for error messages. */
  label?: string;
}

export function assertSafeDeleteTarget(target: string, options: SafeDeleteOptions = {}): string {
  const value = String(target || '').trim();
  if (!value) throw new Error(`安全防护：拒绝空路径删除操作${options.label ? `（${options.label}）` : ''}`);
  const resolved = path.resolve(value);
  const parsed = path.parse(resolved);
  if (parsed.root === resolved) {
    throw new Error(`安全防护：拒绝删除文件系统根目录 ${resolved}`);
  }
  if (options.base) {
    const base = path.resolve(String(options.base));
    if (resolved === base) {
      if (options.allowBase !== true) {
        throw new Error(`安全防护：拒绝删除基准目录本身 ${resolved}${options.label ? `（${options.label}）` : ''}`);
      }
    } else if (!resolved.startsWith(base + path.sep)) {
      throw new Error(`安全防护：删除目标 ${resolved} 不在允许范围 ${base} 内${options.label ? `（${options.label}）` : ''}`);
    }
  }
  return resolved;
}

/**
 * Validate a directory that will be used as a write/creation root (e.g. a
 * KB build target). Refuses drive roots and common user-home roots.
 */
export function assertSafeBaseDir(target: string, label = '目标目录'): string {
  const value = String(target || '').trim();
  if (!value) throw new Error(`安全防护：${label}为空`);
  const resolved = path.resolve(value);
  const parsed = path.parse(resolved);
  if (parsed.root === resolved) {
    throw new Error(`安全防护：${label}不能是文件系统根目录 ${resolved}`);
  }
  const userProfile = process.env.USERPROFILE || process.env.HOME;
  if (userProfile) {
    const home = path.resolve(userProfile);
    if (resolved === home) {
      throw new Error(`安全防护：${label}不能是用户主目录 ${resolved}`);
    }
  }
  return resolved;
}
