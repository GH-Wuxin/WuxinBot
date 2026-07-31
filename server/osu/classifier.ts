// Beatmap classifier — calls osu_oracle ONNX GPU predictor via Python subprocess.
// First run downloads .osu files (~5 min for 100 maps).
// Cached runs take ~3 seconds for 100 maps.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'My pack', 'osu_oracle', 'predict_onnx.py');

export interface ClassifierResult {
  distribution: Record<string, number>;   // { stream: 87, aim: 9, tech: 3, alt: 1 }
  details: Record<string, Record<string, number>>; // { beatmapId: { aim: 0.1, stream: 0.8, ... } }
  totalClassified: number;
  errors: string[];
}

export async function classifyBeatmaps(beatmapIds: (string | number)[]): Promise<ClassifierResult> {
  const ids = beatmapIds.map(String);
  if (ids.length === 0) {
    return { distribution: {}, details: {}, totalClassified: 0, errors: [] };
  }
  if (process.env.OSU_ORACLE_DISABLED === '1') {
    return { distribution: {}, details: {}, totalClassified: 0, errors: ['osu_oracle 已禁用（测试环境）'] };
  }

  return new Promise((resolve) => {
    const python = spawn('python', [SCRIPT, '--json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: path.dirname(SCRIPT)
    });

    let stdout = '';
    let stderr = '';

    python.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    python.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    python.on('close', (code) => {
      if (code !== 0) {
        resolve({
          distribution: {},
          details: {},
          totalClassified: 0,
          errors: [`Classifier exited with code ${code}: ${stderr.slice(0, 200)}`]
        });
        return;
      }

      try {
        // Parse the last JSON line (skip TF/sklearn warnings)
        const lines = stdout.trim().split('\n');
        const jsonLine = lines[lines.length - 1];
        const raw: Record<string, Record<string, number>> = JSON.parse(jsonLine);

        const distribution: Record<string, number> = {};
        const details: Record<string, Record<string, number>> = {};
        let totalClassified = 0;

        for (const [bid, probs] of Object.entries(raw)) {
          const top = Object.entries(probs).sort((a, b) => b[1] - a[1])[0];
          if (top) {
            distribution[top[0]] = (distribution[top[0]] || 0) + 1;
          }
          details[bid] = probs;
          totalClassified++;
        }

        resolve({ distribution, details, totalClassified, errors: [] });
      } catch (e) {
        resolve({
          distribution: {},
          details: {},
          totalClassified: 0,
          errors: [`Failed to parse classifier output: ${(e as Error).message}`]
        });
      }
    });

    python.on('error', (e) => {
      resolve({
        distribution: {},
        details: {},
        totalClassified: 0,
        errors: [`Failed to start classifier: ${e.message}`]
      });
    });

    // Send beatmap IDs as JSON array via stdin
    python.stdin.write(JSON.stringify(ids));
    python.stdin.end();
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
