import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function readText(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

function importedNames(source) {
  const names = [];
  const importRegex = /import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"];?/g;
  for (const match of source.matchAll(importRegex)) {
    const [, body, from] = match;
    for (const raw of body.split(',')) {
      const item = raw.trim();
      if (!item) continue;
      const local = item.split(/\s+as\s+/).pop().trim();
      names.push({ name: local, from });
    }
  }
  return names;
}

function declaredFunctions(source) {
  return [...source.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)]
    .map((match) => match[1]);
}

function lineOf(source, needle) {
  const index = source.indexOf(needle);
  if (index < 0) return 0;
  return source.slice(0, index).split('\n').length;
}

function main() {
  const botSource = readText('server/bot.ts');
  const imports = importedNames(botSource).filter((entry) => entry.from.startsWith('./bot/'));
  const declarations = declaredFunctions(botSource);
  const duplicateImports = imports
    .filter((entry) => declarations.includes(entry.name))
    .map((entry) => ({
      name: entry.name,
      from: entry.from,
      localLine: lineOf(botSource, `function ${entry.name}(`) || lineOf(botSource, `async function ${entry.name}(`)
    }));

  const submodules = fs.readdirSync(path.join(rootDir, 'server', 'bot'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => {
      const relativePath = `server/bot/${name}`;
      const source = readText(relativePath);
      const importedByMain = botSource.includes(`'./bot/${name.replace(/\.ts$/, '.js')}'`);
      return {
        file: relativePath,
        functions: declaredFunctions(source),
        importedByMain,
        note: name === 'commandHandlers.ts' ? 'currently not imported by server/bot.ts' : ''
      };
    });

  const risks = [
    'server/bot/commandHandlers.ts is not imported by the runtime path.',
    'When changing behavior, verify processIncoming() and run npm run sanity.'
  ];
  if (duplicateImports.length) {
    risks.unshift('server/bot.ts still contains local functions with the same names as imported helper modules.');
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mainEntrypoints: [
      'server/index.ts imports oneBotToInternal/processIncoming from server/bot.ts',
      'OneBot events and /api/simulate both enter processIncoming()',
      'Most command handling still lives in server/bot.ts runOwnerCommand()'
    ],
    risks,
    duplicateImports,
    submodules
  };

  console.log(JSON.stringify(report, null, 2));
}

main();
