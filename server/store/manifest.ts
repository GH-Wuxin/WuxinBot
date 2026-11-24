import { randomUUID } from 'node:crypto';
import { MAX_MESSAGES, MAX_DECISIONS } from './limits.js';

export const HISTORY_LIMITS = { messages: MAX_MESSAGES, decisions: MAX_DECISIONS };
export type HistoryName = keyof typeof HISTORY_LIMITS;
export const HISTORY_NAMES = Object.keys(HISTORY_LIMITS) as HistoryName[];
export const MAX_HISTORY_DELTAS = 64;

export type Manifest = {
  format: 'wuxin-sharded-v2';
  version: 2;
  revision: string;
  shards: Record<string, string>;
  history: Record<HistoryName, string[]>;
};

export function newManifest(previous?: Manifest): Manifest {
  return {
    format: 'wuxin-sharded-v2', version: 2, revision: randomUUID(),
    shards: { ...previous?.shards },
    history: { messages: [...(previous?.history.messages || [])], decisions: [...(previous?.history.decisions || [])] },
  };
}

export function generationFile(name: string, revision: string) {
  return `db-${name}.${revision}.json`;
}

const revisionPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
export function isGenerationFile(file: string, name: string) {
  const parts = file.split('.');
  return parts.length === 3 && parts[0] === 'db-' + name && parts[2] === 'json' && revisionPattern.test(parts[1]);
}

export function manifestFiles(marker: Manifest): Set<string> {
  return new Set([...Object.values(marker.shards), ...marker.history.messages, ...marker.history.decisions]);
}

export function validateManifest(marker: Manifest, specs: { name: string }[]) {
  if (!revisionPattern.test(marker.revision) || !marker.shards || !marker.history
    || Object.keys(marker.shards).length !== specs.length
    || specs.some(({ name }) => typeof marker.shards[name] !== 'string' || !isGenerationFile(marker.shards[name], name))) {
    throw new Error('数据库分片清单损坏');
  }
  for (const name of HISTORY_NAMES) {
    const files = marker.history[name];
    if (!Array.isArray(files) || files.length > MAX_HISTORY_DELTAS || new Set(files).size !== files.length
      || files.some(file => typeof file !== 'string' || !isGenerationFile(file, name) || file === marker.shards[name])) {
      throw new Error('数据库历史分片清单损坏: ' + name);
    }
  }
}
