import fs from 'node:fs';
import path from 'node:path';
const arch = path.join(process.env.APPDATA, 'Wuxin-dev-archive');
const live = path.join(process.env.APPDATA, 'Wuxin', 'db.json');
const read = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')).settings; } catch (e) { return null; } };
console.log('=== 归档目录里的备份 ===');
for (const f of fs.readdirSync(arch)) {
  const st = fs.statSync(path.join(arch, f));
  console.log('  ' + f.padEnd(58) + (st.isDirectory() ? '[D]' : (st.size/1024).toFixed(0) + ' KB'));
}
console.log('');
const FIELDS = ['llmProvider', 'codexExecutable', 'codexModel', 'codexFallbackEnabled', 'codexFallbackProvider', 'model', 'codexReasoningEffort', 'codexTimeoutMs'];
const b1 = read(path.join(arch, 'db.json.bak-before-deepseek-2026-10-09T11-04-14-983Z'));
const b2 = read(path.join(arch, 'db.json.bak-before-codex-guard-2026-10-09T11-13-50-758Z'));
const now = read(live);
console.log('=== 三个时点的关键字段 ===');
console.log('  字段'.padEnd(24) + '切deepseek前'.padEnd(30) + '加挡板前'.padEnd(30) + '当前');
for (const f of FIELDS) {
  const g = (s) => s ? JSON.stringify(s[f]) : '(读不到)';
  console.log('  ' + f.padEnd(22) + String(g(b1)).slice(0,28).padEnd(30) + String(g(b2)).slice(0,28).padEnd(30) + String(g(now)).slice(0,30));
}