// Command cooldown policies — single source of truth (v4 plan).
//
// Runtime cooldown gates and KB/help rendering must read the same object so
// numbers, scopes and reset permissions can never drift. This module is pure.
import type { CooldownPolicy } from './types.js';

/** Recommend maps: 10min per osu! player, owner can reset. */
export const RECOMMEND_COOLDOWN = {
  kind: 'fixed',
  ms: 10 * 60_000,
  scope: 'user',
  resettableBy: 'owner',
} as const satisfies CooldownPolicy;
