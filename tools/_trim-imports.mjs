// One-off: remove unused named imports from the split bot modules.
// Run with: node tools/_trim-imports.mjs  (then delete this file)
import fs from 'node:fs';

const files = [
  'server/bot/queue.ts',
  'server/bot/gate.ts',
  'server/bot/ownerCommands.ts',
];

for (const rel of files) {
  const p = 'REDACTED_REPO_ROOT/' + rel;
  const src = fs.readFileSync(p, 'utf8');
  const out = [];
  for (const line of src.split('\n')) {
    const m = line.match(/^import \{([^}]+)\} from '([^']+)';/);
    if (!m) { out.push(line); continue; }
    const names = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    const kept = names.filter((n) => {
      const re = new RegExp('\\b' + n.replace(/[$]/g, '\\$&') + '\\b', 'g');
      return (src.match(re) || []).length > 1;
    });
    if (kept.length === 0) continue; // drop the whole import line
    if (kept.length === names.length) { out.push(line); continue; }
    out.push(`import { ${kept.join(', ')} } from '${m[2]}';`);
  }
  fs.writeFileSync(p, out.join('\n'), 'utf8');
  console.log('trimmed', rel);
}
