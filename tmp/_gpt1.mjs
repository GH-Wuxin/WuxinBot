import fs from 'node:fs';
import path from 'node:path';
const p = path.join(process.env.APPDATA, 'Wuxin', 'db.json');
const db = JSON.parse(fs.readFileSync(p, 'utf8'));
const s = db.settings;
console.log('=== 生产库当前设置（GPT 相关）===');
const keys = Object.keys(s).filter((k) => /llm|codex|openai|provider|model|vision|mimo|deepseek/i.test(k));
for (const k of keys.sort()) {
  const v = s[k];
  const shown = /key|apiKey/i.test(k) && v ? '(已设置, ' + String(v).length + ' 字符)' : JSON.stringify(v);
  console.log('  ' + k.padEnd(30) + shown);
}
console.log('');
console.log('=== 判读 ===');
console.log('  当前 provider        ' + JSON.stringify(s.llmProvider));
console.log('  会走 Codex/GPT 吗    ' + (String(s.llmProvider) === 'codex-app-server' ? '会 ★★★' : '不会 ✓'));
console.log('  codexExecutable      ' + JSON.stringify(s.codexExecutable));
console.log('  codexFallbackEnabled ' + JSON.stringify(s.codexFallbackEnabled));
console.log('  codexFallbackProvider' + ' ' + JSON.stringify(s.codexFallbackProvider));