// Shared types for the owner-command dispatch decomposition (R2).
// Pure types only; no runtime imports from store/commands/bot modules.

export interface OwnerHandlerContext {
  event: any;
  sendMessage: any;
  permissions: { isOwner: boolean; isAdmin: boolean };
  /** Original whitespace-split tokens, exactly as runOwnerCommand parsed them. */
  parts: string[];
  prefix: string;
  isWuxinCommand: boolean;
  command: string;
  subCommand: string;
  commandArgs: string;
  target: string | undefined;
  groupId: string;
  commandDb: any;
  commandUserPolicy: any;
  policyMap: Record<string, string>;
}

export interface OwnerCommandResult {
  replied: boolean;
  reason: string;
  [key: string]: any;
}

export type OwnerHandler = (context: OwnerHandlerContext) => Promise<OwnerCommandResult>;

/**
 * One registry key per current descriptor execution.handlerKey, plus the two
 * hidden relation descriptors added by R2. Kept explicit so a missing registry
 * entry is a compile error rather than a runtime fallback.
 */
export type OwnerHandlerKey =
  | 'lv'
  | 'exp'
  | 'top'
  | 'nick'
  | 'style'
  | 'me'
  | 'memberPolicy'
  | 'note'
  | 'profile'
  | 'promptShow'
  | 'promptEdit'
  | 'promptSavebase'
  | 'groupAdd'
  | 'groupProfileShow'
  | 'groupProfileEdit'
  | 'rate'
  | 'cooldown'
  | 'mode'
  | 'status'
  | 'modelShow'
  | 'modelSet'
  | 'search'
  | 'thinking'
  | 'sysfacts'
  | 'summarize'
  | 'preset'
  | 'usage'
  | 'pause'
  | 'resume'
  | 'why'
  | 'help'
  | 'ping'
  | 'my'
  | 'recalc'
  | 'refresh'
  | 'osu.help'
  | 'osu.bind'
  | 'osu.analyze'
  | 'osu.recent'
  | 'osu.clear.bind'
  | 'osu.clear.history'
  | 'osu.clear.cooldown'
  | 'osu.clear.recommend'
  | 'osu.clear.cache'
  | 'relationShow'
  | 'relationEdit';
