import fs from 'node:fs';
import path from 'node:path';

/** Rediscover only the current user's managed desktop installation. Never
 * replace an explicit custom executable, or persist versioned paths to settings. */
export function resolveCodexExecutable(configured = 'codex', env = process.env, platform = process.platform): string {
  const command = String(configured || 'codex').trim() || 'codex';
  if (platform !== 'win32' || !env.LOCALAPPDATA) return command;
  const root = path.resolve(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  const isFile = (file: string) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
  const relative = path.relative(root, path.resolve(command));
  const managedPath = /^[a-f0-9]+[\\/]codex\.exe$/i.test(relative);
  if (command !== 'codex' && command !== 'codex.exe' && (!managedPath || isFile(command))) return command;
  try {
    const realRoot = fs.realpathSync(root);
    const candidates = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^[a-f0-9]+$/i.test(entry.name))
      .flatMap(entry => {
        const file = path.join(root, entry.name, 'codex.exe');
        try {
          const stat = fs.statSync(file);
          const realRelative = path.relative(realRoot, fs.realpathSync(file));
          if (!stat.isFile() || !/^[a-f0-9]+[\\/]codex\.exe$/i.test(realRelative)) return [];
          return [{ file, modified: stat.mtimeMs }];
        } catch { return []; }
      })
      .sort((a, b) => b.modified - a.modified || a.file.localeCompare(b.file));
    return candidates[0]?.file || command;
  } catch { return command; }
}
