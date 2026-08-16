// quick-router-p11-alias-verifier.mjs
// EVIDENCE-CORRECTION / AUDIT verifier for P1_1.
// It makes NO production change and does NOT implement any executability
// priority rule. It proves the current registry has ZERO NONEXEC_EXECUTABLE
// collisions, records !search / !badge / !get bg / !todaybp as
// NONEXEC_NONEXEC, and fuzzes 10,000 normalization cases to confirm the
// runtime matcher stays consistent with the pure resolver under the existing
// registry-order precedence.
import { pathToFileURL } from 'node:url';

const REPO = 'G:/QQ-AI-ChatBot';
const { EXCLAMATION_DEFS, SLASH_DEFS, HYDRANT_DEFS, finalizeQuickDef, resolveQuickCommand } = await import(pathToFileURL(`${REPO}/server/bot/commands/quick.meta.ts`));
const { matchQuickCommand } = await import(pathToFileURL(`${REPO}/server/bot/quickRouter.ts`));
const { normalizeAlias } = await import(pathToFileURL(`${REPO}/server/bot/commands/alias.ts`));

let passed = 0;
let failed = 0;
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`PASS [${name}]${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.error(`FAIL [${name}]${detail ? ' — ' + detail : ''}`); }
}

const isExec = (def) => finalizeQuickDef(def).execution.kind !== 'documentation_only';

function collectCollisions(domain, defs) {
  const byKey = new Map();
  for (const def of defs) {
    for (const alias of def.aliases) {
      const key = normalizeAlias(alias);
      if (!key) continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ def, alias, key });
    }
  }
  const out = [];
  for (const [key, entries] of byKey) {
    if (entries.length < 2) continue;
    const winner = entries.slice().sort((a, b) => b.key.length - a.key.length || entries.indexOf(a) - entries.indexOf(b))[0];
    out.push({ domain, key, entries, winner });
  }
  return out;
}

const domains = {
  '!': EXCLAMATION_DEFS,
  '/': SLASH_DEFS,
  none: HYDRANT_DEFS.filter((d) => d.handler !== 'self_profile' && d.handler !== 'at_profile'),
};
const collisions = [];
for (const [domain, defs] of Object.entries(domains)) collisions.push(...collectCollisions(domain, defs));

ok('p11-collision:total', collisions.length === 11, `count=${collisions.length}`);

const classifications = {
  EXECUTABLE_EXECUTABLE: 0,
  NONEXEC_EXECUTABLE: 0,
  NONEXEC_NONEXEC: 0,
  INTRA_DEFINITION_NORMALIZATION_DUPLICATE: 0,
};
const expectedWinners = {
  '!|re': 'kanon:recent', '!|recent': 'kanon:recent', '!|pr': 'kanon:recent',
  '!|bp': 'kanon:bp', '!|score': 'kanon:score', '!|info': 'kanon:info',
  '!|todaybp': 'kanon:todaybp', '!|search': 'kanon:search',
  '!|get bg': 'kanon:getbg', '!|badge': 'kanon:badge',
  'none|我的年度osu!': 'hydrant:annual',
};

for (const c of collisions) {
  const kinds = c.entries.map((e) => (isExec(e.def) ? 'EXEC' : 'NONEXEC'));
  const sameDef = new Set(c.entries.map((e) => `${e.def.source}:${e.def.id}`)).size === 1;
  if (sameDef) classifications.INTRA_DEFINITION_NORMALIZATION_DUPLICATE++;
  else if (kinds.every((k) => k === 'EXEC')) classifications.EXECUTABLE_EXECUTABLE++;
  else if (kinds.some((k) => k === 'EXEC') && kinds.some((k) => k === 'NONEXEC')) classifications.NONEXEC_EXECUTABLE++;
  else classifications.NONEXEC_NONEXEC++;

  const winnerKey = `${c.winner.def.source}:${c.winner.def.id}`;
  const expectedWinner = expectedWinners[`${c.domain}|${c.key}`];
  ok(`p11-collision:winner:${c.domain}:${c.key}`, winnerKey === expectedWinner, `${winnerKey} expected ${expectedWinner}`);
  // Runtime matcher agrees with the registry-order derivation.
  const input = c.domain === '!' ? `!${c.key}` : c.domain === '/' ? `/${c.key}` : c.key;
  const runtime = matchQuickCommand({ text: input, atTargets: [] });
  const runtimeKey = runtime ? `${runtime.def.source}:${runtime.def.id}` : null;
  ok(`p11-collision:runtime:${c.domain}:${c.key}`, runtimeKey === expectedWinner, `${runtimeKey} expected ${expectedWinner}`);
}

ok('p11-class:exec-exec', classifications.EXECUTABLE_EXECUTABLE === 6, JSON.stringify(classifications));
ok('p11-class:nonexec-exec', classifications.NONEXEC_EXECUTABLE === 0, JSON.stringify(classifications));
ok('p11-class:nonexec-nonexec', classifications.NONEXEC_NONEXEC === 4, JSON.stringify(classifications));
ok('p11-class:intra-def', classifications.INTRA_DEFINITION_NORMALIZATION_DUPLICATE === 1, JSON.stringify(classifications));

// The four task-named aliases: BOTH candidates are documentation-only.
for (const [alias, kanonId, yumuId] of [
  ['search', 'kanon:search', 'yumu:explore'],
  ['badge', 'kanon:badge', 'yumu:badge'],
  ['get bg', 'kanon:getbg', 'yumu:getbg'],
  ['todaybp', 'kanon:todaybp', 'yumu:todaybp'],
]) {
  const c = collisions.find((x) => x.domain === '!' && x.key === alias);
  ok(`p11-premise:${alias}:two-candidates`, c && c.entries.length === 2, JSON.stringify(c && c.entries.map((e) => `${e.def.source}:${e.def.id}`)));
  ok(`p11-premise:${alias}:both-nonexec`, c && c.entries.every((e) => !isExec(e.def)), JSON.stringify(c && c.entries.map((e) => [e.def.source, e.def.id, isExec(e.def), finalizeQuickDef(e.def).execution.kind])));
  ok(`p11-premise:${alias}:winner-unchanged`, c && `${c.winner.def.source}:${c.winner.def.id}` === kanonId, `${c && c.winner.def.source}:${c && c.winner.def.id}`);
}

// 10,000 deterministic normalization cases: runtime matcher vs pure resolver
// under the EXISTING registry-order precedence (no proposed-rule simulation).
let state = 0x6a09e667;
function rand() { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; }
function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }
function mutate(text) {
  let out = text;
  for (let i = 0; i < 2; i++) {
    const pos = Math.floor(rand() * (out.length + 1));
    out = out.slice(0, pos) + pick(['', ' ', '  ', '\t']) + out.slice(pos);
  }
  if (rand() < 0.3) out = out.split('').map((ch) => (rand() < 0.5 ? ch.toUpperCase() : ch.toLowerCase())).join('');
  if (rand() < 0.3) out = out.split('').map((ch) => ({ '!': '！', '~': '～', ',': '，' }[ch] || ch)).join('');
  return out;
}
const corpus = collisions.flatMap((c) => c.entries.map((e) => e.alias))
  .concat(['p', 'r', 's', 'help', '~', '查', 'where', 'plus', 'bp 1-10', 're #2', '我的年度osu！']);
let diffs = 0;
const diffExamples = [];
for (let i = 0; i < 10000; i++) {
  const base = pick(corpus);
  const prefix = pick(['!', '！', '/', '', '~']);
  const text = prefix + mutate(base);
  const runtime = matchQuickCommand({ text, atTargets: [] });
  const pure = resolveQuickCommand(text);
  const rk = runtime ? `${runtime.def.source}:${runtime.def.id}` : null;
  const pk = pure ? `${pure.def.source}:${pure.def.id}` : null;
  if (rk !== pk) {
    diffs++;
    if (diffExamples.length < 10) diffExamples.push({ text, runtime: rk, pure: pk });
  }
}
ok('p11-fuzz:10000', true, 'ran 10000 cases');
ok('p11-fuzz:zero-winner-changes', diffs === 0, JSON.stringify({ diffs, diffExamples }));

console.log(`\nquick-router-p11-alias-verifier: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
