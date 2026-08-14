// Beatmap classifier — calls osu_oracle ONNX GPU predictor via Python subprocess.
// First run downloads .osu files (~5 min for 100 maps).
// Cached runs take ~3 seconds for 100 maps.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCachedClassifications, saveClassifications } from './oracleCache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'My pack', 'osu_oracle', 'predict_onnx.py');

export interface ClassifierResult {
  distribution: Record<string, number>;   // { stream: 87, aim: 9, tech: 3, alt: 1 }
  details: Record<string, Record<string, number>>; // { beatmapId: { aim: 0.1, stream: 0.8, ... } }
  totalClassified: number;
  errors: string[];
}

export async function classifyBeatmaps(
  beatmapIds: (string | number)[],
  runner?: (ids: string[]) => Promise<Record<string, Record<string, number>>>
): Promise<ClassifierResult> {
  const ids = beatmapIds.map(String);
  if (ids.length === 0) {
    return { distribution: {}, details: {}, totalClassified: 0, errors: [] };
  }
  if (process.env.OSU_ORACLE_DISABLED === '1') {
    return { distribution: {}, details: {}, totalClassified: 0, errors: ['osu_oracle 已禁用（测试环境）'] };
  }

  // Reuse stable per-beatmap classifications so repeated queries never touch
  // Python. Only uncached maps go to the model, then the merge happens here.
  const cached = getCachedClassifications(ids);
  const uncached = ids.filter((id) => !cached.has(id));
  if (uncached.length === 0) {
    return mergeClassificationResults(ids, cached, {});
  }

  const run = runner || runClassifierProcess;
  let fresh: Record<string, Record<string, number>>;
  let errors: string[] = [];
  try {
    fresh = await run(uncached);
  } catch (error) {
    fresh = {};
    errors = [String((error as Error)?.message || error).slice(0, 300)];
  }
  saveClassifications(fresh);
  return mergeClassificationResults(ids, cached, fresh, errors);
}

function mergeClassificationResults(
  ids: string[],
  cached: Map<string, Record<string, number>>,
  fresh: Record<string, Record<string, number>>,
  extraErrors: string[] = []
): ClassifierResult {
  const details: Record<string, Record<string, number>> = {};
  const distribution: Record<string, number> = {};
  let totalClassified = 0;
  for (const id of ids) {
    const probs = cached.get(id) || fresh[id];
    if (!probs) continue;
    details[id] = probs;
    const top = Object.entries(probs).sort((a, b) => b[1] - a[1])[0];
    if (top) distribution[top[0]] = (distribution[top[0]] || 0) + 1;
    totalClassified++;
  }
  return { distribution, details, totalClassified, errors: extraErrors };
}

function runClassifierProcess(ids: string[]): Promise<Record<string, Record<string, number>>> {
  const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'My pack', 'osu_oracle', 'predict_onnx.py');
  return new Promise((resolve) => {
    const python = spawn('python', [SCRIPT, '--json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: path.dirname(SCRIPT)
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    python.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    python.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    python.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        resolve(Promise.reject(new Error(`Classifier exited with code ${code}: ${stderr.slice(-500)}`)));
        return;
      }

      try {
        // Parse the last JSON line (skip TF/sklearn warnings)
        const lines = stdout.trim().split('\n');
        const jsonLine = lines[lines.length - 1];
        const raw: Record<string, Record<string, number>> = JSON.parse(jsonLine);
        resolve(raw);
      } catch (e) {
        resolve(Promise.reject(new Error(`Failed to parse classifier output: ${(e as Error).message}`)));
      }
    });

    python.on('error', (e) => {
      if (settled) return;
      settled = true;
      resolve(Promise.reject(new Error(`Failed to start classifier: ${e.message}`)));
    });

    // Send beatmap IDs as JSON array via stdin
    python.stdin.write(JSON.stringify(ids));
    python.stdin.end();

    // Hard timeout: never let a stuck classifier block a chat reply forever.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      python.kill('SIGKILL');
      resolve(Promise.reject(new Error(`Classifier timed out after 90s (${ids.length} maps)`)));
    }, 90_000);
    python.on('close', () => clearTimeout(timer));
    python.on('error', () => clearTimeout(timer));
  });
}

export function formatClassifierBlock(result: ClassifierResult): string {
  if (result.totalClassified === 0) {
    return result.errors.length > 0
      ? `【谱面类型分布】\n分类器暂时不可用：${result.errors[0]}\n`
      : '';
  }

  const dist = result.distribution;
  const total = result.totalClassified;
  const entries = Object.entries(dist).sort((a, b) => b[1] - a[1]);
  const lines = entries.map(([cls, count]) => {
    const pct = Math.round(count / total * 100);
    return `  ${cls.padEnd(8)} ${pct}%（${count} 张）`;
  });

  const topLabel = entries[0]?.[0] || '未知';
  const topChinese: Record<string, string> = { aim: '跳图', stream: '串图', tech: '技术', alt: '切换' };

  return [
    '【谱面类型分布】',
    `BP${total} 分类统计（osu!oracle）：`,
    ...lines,
    '',
    `整体来看是一个${topChinese[topLabel] || topLabel}倾向明显的号。`,
  ].join('\n');
}
