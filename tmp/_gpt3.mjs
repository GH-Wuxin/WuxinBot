import fs from 'node:fs';
import path from 'node:path';
import { resolveCodexExecutable } from '../server/codexExecutable.ts';
const arch = path.join(process.env.APPDATA, 'Wuxin-dev-archive');
const bak = JSON.parse(fs.readFileSync(path.join(arch, 'db.json.bak-before-deepseek-2026-10-09T11-04-14-983Z'), 'utf8')).settings;
console.log('=== 动之前（权威原值）===');
console.log('  llmProvider     = ' + JSON.stringify(bak.llmProvider));
console.log('  codexExecutable = ' + JSON.stringify(bak.codexExecutable));
console.log('');
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
console.log('  那个原值路径现在存在吗: ' + exists(bak.codexExecutable));
console.log('');
console.log('=== 用该原值跑守卫，看它会解析成什么 ===');
const resolved = resolveCodexExecutable(bak.codexExecutable);
console.log('  解析结果 = ' + resolved);
console.log('  该路径存在 = ' + exists(resolved));
console.log('  是否被自动重新发现到别的版本 = ' + (resolved !== bak.codexExecutable));
console.log('');
const root = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
console.log('=== 托管目录现状 ===');
if (fs.existsSync(root)) {
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const exe = path.join(root, d.name, 'codex.exe');
    console.log('  ' + d.name + '  ' + (exists(exe) ? '存在  ' + (fs.statSync(exe).size/1048576).toFixed(1) + ' MB  改于 ' + fs.statSync(exe).mtime.toISOString().slice(0,19) : '缺失'));
  }
} else console.log('  目录不存在');