/**
 * 随机发图的选取规则回归测试。直接调用 randomImages.ts 的 pickWeighted。
 *
 * 这里覆盖三个先后被发现的缺陷，它们叠加起来的结果就是「好些图发了好多遍」：
 *
 *   1. 降权指数方向反了。recent 是时间顺序，而代码写成 decay^(recent.length - index)，
 *      于是最近一次发送拿到最小的指数（抑制最弱），窗口内最远那次反而近乎不可能出现。
 *      抑制总量没变，所以肉眼看不出异常，只表现为重复率和均匀随机差不多。
 *
 *   2. everSent 只记录、不参与选图。没发过的图和很久以前发过的图权重都是 1，
 *      选图没有任何「先把池子铺一遍」的动力。实测 73 次发送只用到 77 张里的 39 张，
 *      而均匀随机的期望是 47 张 —— 比随机还差。
 *
 *   3. 先改成 4 倍权重，仍不够：73 次发送还有 12 次重复。池子比发送次数还多的时候，
 *      「别重复」应当是保证而不是倾向，所以第一期改成了硬规则。
 */
import { pickWeighted } from '../server/bot/randomImages.ts';

const POOL = 77;
const WINDOW = 8;
const DECAY = 0.35;
const files = Array.from({ length: POOL }, (_, i) => '/pool/pippi-' + String(i + 1).padStart(2, '0') + '.png');

let failed = 0;
const check = (ok, label, detail) => {
  if (!ok) failed += 1;
  console.log((ok ? '  ok    ' : '  失败  ') + label + (detail ? '   ' + detail : ''));
};

// ── 1. 池子没铺满时：只从没发过的图里选，零重复 ──
{
  const HITS = 73;
  const ROUNDS = 200;
  let totalDistinct = 0, totalRepeats = 0, worstRepeats = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    let state = { recent: [], everSent: [] };
    const sent = [];
    for (let i = 0; i < HITS; i += 1) {
      const picked = pickWeighted(files, state, WINDOW, DECAY);
      state = {
        recent: [...state.recent.slice(-(WINDOW - 1)), { at: String(i), file: picked }],
        everSent: state.everSent.includes(picked) ? state.everSent : [...state.everSent, picked],
      };
      sent.push(picked);
    }
    const distinct = new Set(sent).size;
    totalDistinct += distinct;
    totalRepeats += HITS - distinct;
    worstRepeats = Math.max(worstRepeats, HITS - distinct);
  }
  console.log('  池子没铺满（连发 ' + HITS + ' 次，池 ' + POOL + ' 张，' + ROUNDS + ' 轮）');
  console.log('    平均覆盖 ' + (totalDistinct / ROUNDS).toFixed(1) + ' 张 · 平均重复 ' + (totalRepeats / ROUNDS).toFixed(2) + ' 次 · 最差一轮 ' + worstRepeats + ' 次');
  check(totalRepeats === 0, '73 次发送零重复（池子比发送次数多）');
  console.log('');
}

// ── 2. 池子铺满之后：回落到窗口降权，最近一次应被压到极低 ──
{
  const DRAWS = 60000;
  const recent = Array.from({ length: WINDOW }, (_, i) => ({ at: String(i), file: files[i] }));
  const previous = { recent, lastFile: files[WINDOW - 1], everSent: files };
  const counts = new Map();
  for (let i = 0; i < DRAWS; i += 1) {
    const picked = pickWeighted(files, previous, WINDOW, DECAY);
    counts.set(picked, (counts.get(picked) || 0) + 1);
  }
  const newest = counts.get(files[WINDOW - 1]) || 0;
  const oldest = counts.get(files[0]) || 0;
  console.log('  池子铺满后（' + DRAWS + ' 次抽取，均匀期望 ' + Math.round(DRAWS / POOL) + ' 次）');
  console.log('    最近一次 ' + newest + ' 次 · 窗口内最远一次 ' + oldest + ' 次');
  check(newest < oldest, '最近一次的抽中次数少于最远一次（抑制方向正确）');
  check(newest <= DRAWS / POOL / 20, '最近一次远低于均匀期望');
  console.log('');
}

// ── 3. 池子铺满后仍然允许重复，不是硬排除 ──
{
  const recent = Array.from({ length: WINDOW }, (_, i) => ({ at: String(i), file: files[i] }));
  const previous = { recent, lastFile: files[WINDOW - 1], everSent: files };
  const DRAWS = 200000;
  let inWindow = 0;
  for (let i = 0; i < DRAWS; i += 1) {
    const picked = pickWeighted(files, previous, WINDOW, DECAY);
    if (recent.some((e) => e.file === picked)) inWindow += 1;
  }
  console.log('  窗口内的图仍会被抽中: ' + inWindow + ' / ' + DRAWS);
  check(inWindow > 0, '窗口内的图没有被硬排除（真人偶尔也会连发同一张）');
  console.log('');
}

if (failed) { console.log('失败 ' + failed + ' 项'); process.exit(1); }
console.log('全部通过');
