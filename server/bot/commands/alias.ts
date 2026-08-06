// Pure alias normalization + collision keys for quick-command parsing.
//
// This is the single normalization fact shared by the pure metadata modules,
// the runtime matcher (quickRouter) and kb-verify. No runtime imports.
import type { CommandNamespace } from './types.js';

export function normalizeAlias(value: string): string {
  return String(value || '').trim().toLowerCase()
    .replace(/[！]/g, '!')
    .replace(/[～∼]/g, '~')
    .replace(/[，]/g, ',')
    .replace(/[ \t]+/g, ' ');
}

/**
 * Real parser domains for quick commands:
 * - `!` domain: COMMON + KANON + YUMU share one matcher
 * - `/` domain: LAZYBOT only
 * - `none` domain: HYDRANT prefix-free triggers
 * Uniqueness is enforced inside each domain, never globally.
 */
export type QuickParseDomain = '!' | '/' | 'none';

export function quickDomainOfPrefix(prefix: string): QuickParseDomain {
  if (prefix === '!') return '!';
  if (prefix === '/') return '/';
  return 'none';
}

export function commandCollisionKey(namespace: CommandNamespace, tokens: readonly string[]): string {
  return `${namespace}:${tokens.map(normalizeAlias).join(' ')}`;
}

export function quickCollisionKey(domain: QuickParseDomain, alias: string): string {
  return `${domain}:${normalizeAlias(alias)}`;
}

export function isQuickPrefix(text: string): '!' | '/' | 'none' | null {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (raw.startsWith('!') || raw.startsWith('！')) return '!';
  if (raw.startsWith('/')) return '/';
  return 'none';
}
