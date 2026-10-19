import fs from 'node:fs';
import path from 'node:path';
// 把 console/ 拷进 dist/：打包后的 Desktop 直接从 dist/index.html 加载新控制台。
const root = path.resolve(process.cwd());
const source = path.join(root, 'console');
const target = path.join(root, 'dist');
if (!fs.existsSync(source)) { console.log('[copy-console] console/ 不存在，跳过'); process.exit(0); }
fs.mkdirSync(target, { recursive: true });
for (const file of fs.readdirSync(source)) {
  const from = path.join(source, file);
  if (!fs.statSync(from).isFile()) continue;
  fs.copyFileSync(from, path.join(target, file));
}
console.log('[copy-console] 已复制 console/ → dist/');
