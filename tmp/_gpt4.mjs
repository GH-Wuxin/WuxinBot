const API = 'http://127.0.0.1:8787';
const ORIG = {
  llmProvider: 'codex-app-server',
  codexExecutable: 'C:\\Users\\asus\\AppData\\Local\\OpenAI\\Codex\\bin\\1e3e57cdf0634c02\\codex.exe',
};
const state = async () => (await (await fetch(API + '/api/state')).json()).db.settings;
const before = await state();
console.log('=== 改动前 ===');
console.log('  llmProvider     = ' + JSON.stringify(before.llmProvider));
console.log('  codexExecutable = ' + JSON.stringify(before.codexExecutable));
console.log('  设置项总数       = ' + Object.keys(before).length);
console.log('');
const r = await fetch(API + '/api/settings', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(ORIG),
});
console.log('  POST /api/settings -> ' + r.status);
console.log('');
const after = await state();
console.log('=== 改动后 ===');
console.log('  llmProvider     = ' + JSON.stringify(after.llmProvider));
console.log('  codexExecutable = ' + JSON.stringify(after.codexExecutable));
console.log('  设置项总数       = ' + Object.keys(after).length);
console.log('');
console.log('=== 逐字段 diff（应只有两个字段变化）===');
const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
const changed = [];
for (const k of [...keys].sort()) {
  const a = JSON.stringify(before[k]), b = JSON.stringify(after[k]);
  if (a !== b) { changed.push(k); console.log('  ' + k.padEnd(26) + String(a).slice(0,40) + '  ->  ' + String(b).slice(0,40)); }
}
console.log('');
console.log('  实际变化字段数 = ' + changed.length + (changed.length === 2 ? '   ✓ 只有目标两个' : '   ← 注意，有额外变化'));
console.log('  与动之前原值一致 = ' + (after.llmProvider === ORIG.llmProvider && after.codexExecutable === ORIG.codexExecutable));