// Command cooldown policies — single source of truth (v4 plan).
//
// Runtime cooldown gates and KB/help rendering must read the same object so
// numbers, scopes and reset permissions can never drift. This module is pure.
import type { CooldownPolicy } from './types.js';

/** One-line review: 30min per requester/target/mode, owner can reset. */
export const ANALYSIS_COOLDOWN = {
  kind: 'fixed',
  ms: 30 * 60 * 1000,
  scope: 'user_in_group',
  resettableBy: 'owner',
} as const satisfies CooldownPolicy;

/** Recent-score short review: 10min per user/mode, owner can reset. */
export const RECENT_COOLDOWN = {
  kind: 'fixed',
  ms: 10 * 60 * 1000,
  scope: 'user',
  resettableBy: 'owner',
} as const satisfies CooldownPolicy;

/** Recommend maps: 10min per osu! player, owner can reset. */
export const RECOMMEND_COOLDOWN = {
  kind: 'fixed',
  ms: 10 * 60_000,
  scope: 'user',
  resettableBy: 'owner',
} as const satisfies CooldownPolicy;
