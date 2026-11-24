import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = fs.readdirSync(path.join(root, 'server'), { recursive: true })
  .filter(name => name.endsWith('.ts')).map(name => 'server/' + name.split(path.sep).join('/')).sort();
const modules = files.map(file => {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const functions = source.statements.filter(ts.isFunctionDeclaration).filter(fn => fn.name)
    .map(fn => ({ name: fn.name.text, line: source.getLineAndCharacterOfPosition(fn.getStart()).line + 1 }));
  const imports = source.statements.filter(ts.isImportDeclaration).map(node => node.moduleSpecifier.text)
    .filter(name => name.startsWith('.')).map(name => path.posix.join(path.posix.dirname(file), name.replace(/\.js$/, '.ts')));
  return { file, functions, imports };
});

// Resolve locations from declarations so moved entry points stay accurate.
const entryNames = ['handleOneBotEvent', 'oneBotToInternal', 'processIncoming', 'handleOwnerCommand',
  'matchQuickCommand', 'generateConversationReply', 'runToolLoop', 'openStore'];
const mainEntrypoints = entryNames.flatMap(name => {
  const matches = modules.flatMap(module => module.functions.filter(fn => fn.name === name)
    .map(fn => ({ file: module.file, ...fn })));
  if (!matches.length) throw new Error(`Missing entry point: ${name}`);
  return matches;
});
console.log(JSON.stringify({ mainEntrypoints, modules }, null, 2));
