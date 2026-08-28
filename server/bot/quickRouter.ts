// Quick-command router — M1 of the four-bot merge.
//
// Deterministic, no-LLM handling of the legacy quick commands (`!p`/`!bs`/`/plus`/
// `~`/`查@` …). Every kept alias from the confirmed feature inventory lives in
// the registry below; implemented commands execute directly against the shared
// internal engine, while not-yet-migrated commands fall through to the normal
// LLM pipeline so the group experience never regresses.
import { readDb, updateDb, nowIso } from '../store.js';
import { getGroup, getUserPolicy } from './gate.js';
import { hasCommandPermission, commandDeniedReply, writeCommandLog } from './commands.js';
import {
  executeInternalBotCommand,
  parseEmbeddedBpCommand,
  type BpQuerySelection,
} from '../bots/executor.js';
import { callLocalBot, hasLocalEndpoint } from '../bots/localBridge.js';
import {
  recordQuickContext,
  recordQuickContextPending,
  hydrateQuickContextPending,
  buildQuickShadowSummary,
} from './quickMemory.js';
import { registerPendingQuickObservation } from './quickContext.js';
import {
  EXCLAMATION_DEFS,
  SLASH_DEFS,
  HYDRANT_DEFS,
  finalizeQuickDef,
  type QuickCommandDef,
  type RawQuickCommandDef,
} from './commands/quick.meta.js';
import { normalizeAlias } from './commands/alias.js';
import {
  beginLatencyTrace,
  finishLatencyTrace,
  markLatencySpan,
} from '../perf/latencyTrace.js';

export type { QuickCommandDef, RawQuickCommandDef } from './commands/quick.meta.js';
export { EXCLAMATION_DEFS, SLASH_DEFS, HYDRANT_DEFS, ALL_QUICK_DEFS, QUICK_DEFS } from './commands/quick.meta.js';

interface QuickMatch {
  def: RawQuickCommandDef;
  /** The full normalized command text without the prefix. */
  cmdText: string;
  /** The matched alias (normalized), used to rebuild injected commands. */
  alias: string;
  /** Raw arguments after the matched alias. */
  args: string;
  prefix: '!' | '/' | 'none';
  atTargets: string[];
  /** Hydrant mode suffix (e.g. `,mania` after `~` / `查`). */
  extraMode?: string;
}

function matchAlias(defs: RawQuickCommandDef[], rest: string): { def: RawQuickCommandDef; alias: string } | null {
  const normalized = normalizeAlias(rest);
  let best: { def: RawQuickCommandDef; alias: string; length: number } | null = null;
  for (const def of defs) {
    for (const alias of def.aliases) {
      const key = normalizeAlias(alias);
      if (normalized === key || normalized.startsWith(key + ' ')) {
        if (!best || key.length > best.length) {
          best = { def, alias: key, length: key.length };
        }
      }
    }
  }
  return best ? { def: best.def, alias: best.alias } : null;
}

/** Rebuild raw args after a matched alias, preserving original casing. */
function argsAfterAlias(rawRest: string, alias: string): string {
  const aliasTokens = alias.split(' ').filter(Boolean).length;
  const tokens = String(rawRest || '').trim().split(/\s+/).filter(Boolean);
  return tokens.slice(aliasTokens).join(' ');
}

function modeSuffix(value: string): { mode: string; rest: string } {
  const match = /^(.*?)\s*[,，]\s*(\S*)\s*$/.exec(value);
  if (match) return { mode: match[2], rest: match[1] };
  return { mode: '', rest: value };
}

/**
 * Match a message against the quick-command registry.
 * Returns null when the message is not a quick command (LLM pipeline owns it).
 */
export function matchQuickCommand(event: { text: string; atTargets?: string[] }): QuickMatch | null {
  const raw = String(event.text || '').trim();
  if (!raw) return null;
  const atTargets = Array.isArray(event.atTargets) ? event.atTargets.map(String) : [];

  if (raw.startsWith('!') || raw.startsWith('！')) {
    const rest = raw.slice(1).trim();
    const normalizedRest = normalizeAlias(rest);
    const matched = matchAlias(EXCLAMATION_DEFS, normalizedRest);
    if (!matched) return null;
    return {
      def: matched.def,
      cmdText: rest,
      alias: matched.alias,
      args: argsAfterAlias(rest, matched.alias),
      prefix: '!',
      atTargets,
    };
  }

  if (raw.startsWith('/') && !/^\/w(?:uxin)?(?:\s|$)/i.test(raw)) {
    const rest = raw.slice(1).trim();
    const normalizedRest = normalizeAlias(rest);
    const matched = matchAlias(SLASH_DEFS, normalizedRest);
    if (!matched) return null;
    return {
      def: matched.def,
      cmdText: rest,
      alias: matched.alias,
      args: argsAfterAlias(rest, matched.alias),
      prefix: '/',
      atTargets,
    };
  }

  // Hydrant: prefix-free triggers.
  const hydrant = normalizeAlias(raw);
  if (/^~/.test(hydrant)) {
    const { mode, rest } = modeSuffix(hydrant.slice(1).trim());
    const def = HYDRANT_DEFS.find((d) => d.handler === 'self_profile')!;
    return { def, cmdText: hydrant, alias: '~', args: rest, prefix: 'none', atTargets, extraMode: mode };
  }
  if (/^查/.test(raw)) {
    const { mode, rest } = modeSuffix(raw.slice(1).trim());
    if (atTargets.length > 0) {
      const def = HYDRANT_DEFS.find((d) => d.handler === 'at_profile')!;
      return { def, cmdText: raw, alias: '查', args: rest, prefix: 'none', atTargets, extraMode: mode };
    }
    return null;
  }
  const normalizedRaw = normalizeAlias(raw);
  const prefixFree = matchAlias(HYDRANT_DEFS.filter((d) => d.handler !== 'self_profile' && d.handler !== 'at_profile'), normalizedRaw);
  if (prefixFree) {
    const def = prefixFree.def;
    return {
      def,
      cmdText: raw,
      alias: prefixFree.alias,
      args: argsAfterAlias(raw, prefixFree.alias),
      prefix: 'none',
      atTargets,
      extraMode: '',
    };
  }
  return null;
}

// ── BP argument parsing ──

interface ParsedOsuArgs {
  username: string;
  bpSelection?: BpQuerySelection;
  scoreBeatmapId?: number;
  error?: string;
}

export function parseBpArgs(args: string, compactDefault: boolean): ParsedOsuArgs {
  const value = String(args || '').trim();
  if (!value) {
    return {
      username: '',
      bpSelection: {
        startRank: 1,
        endRank: 10,
        explicit: false,
        single: false,
        compact: compactDefault,
      },
    };
  }

  // "1-100", "#5", "5", "1到10"
  const bareRange = /^#?(\d{1,3})(?:\s*(?:-|~|到|至)\s*#?(\d{1,3}))?$/.exec(value);
  if (bareRange) {
    const startRank = Number(bareRange[1]);
    const endRank = bareRange[2] ? Number(bareRange[2]) : startRank;
    if (startRank < 1 || endRank > 100 || startRank > endRank) {
      return { username: '', error: 'BP 名次必须是 1 到 100，且范围起点不能大于终点' };
    }
    return {
      username: '',
      bpSelection: { startRank, endRank, explicit: true, single: startRank === endRank, compact: compactDefault },
    };
  }

  // "<用户名> 1-100" / "<用户名> 5"
  const trailingRange = /^(.+?)\s+#?(\d{1,3})(?:\s*(?:-|~|到|至)\s*#?(\d{1,3}))?$/.exec(value);
  if (trailingRange) {
    const startRank = Number(trailingRange[2]);
    const endRank = trailingRange[3] ? Number(trailingRange[3]) : startRank;
    if (startRank >= 1 && endRank <= 100 && startRank <= endRank) {
      return {
        username: trailingRange[1].trim(),
        bpSelection: { startRank, endRank, explicit: true, single: startRank === endRank, compact: compactDefault },
      };
    }
  }

  return { username: value };
}

export function parseOsuArgs(def: RawQuickCommandDef, args: string): ParsedOsuArgs {
  if (def.capability === 'score') {
    // `!s <bid> [玩家名]` / `/score <bid> [玩家名]` — BID comes first, an
    // optional trailing username overrides the sender's binding.
    const tokens = String(args || '').trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      return { username: '', error: '用法：!s <谱面BID> [玩家名]，例如 !s 4270382' };
    }
    const bid = Number(tokens[0]);
    if (!Number.isInteger(bid) || bid <= 0) {
      return { username: '', error: `谱面 BID 无效：${tokens[0]}（示例：!s 4270382）` };
    }
    return {
      username: tokens.slice(1).join(' '),
      scoreBeatmapId: bid,
    };
  }
  if (def.bpArgs || def.capability === 'bp' || def.capability === 'bplist') {
    // Reuse the executor parser for canonical "bp 1-100" / "bs 10" forms.
    const embedded = parseEmbeddedBpCommand(`${def.id === 'bs' ? 'bs' : 'bp'} ${args}`.trim());
    if (embedded.selection && !embedded.error) {
      return {
        username: '',
        bpSelection: {
          ...embedded.selection,
          compact: embedded.selection.compact || def.id === 'bs',
        },
      };
    }
    return parseBpArgs(args, def.id === 'bs');
  }
  if (def.capability === 'recent') {
    // `!pr #2` / `!re #2`：裸 `#N` 是成绩序号，不是用户名。保留原始 args，
    // 桥接时会重建成 `!pr <绑定的用户名> #2`，避免把命令丢给 Kanon 后触发
    // 它自己的 desu.life 绑定检查。
    const value = String(args || '').trim();
    if (!value) return { username: '' };
    if (/^[#＃]\s*\d{1,3}$/.test(value)) return { username: '' };
    const trailingIndex = /^(.+?)\s+[#＃]\s*\d{1,3}$/.exec(value);
    if (trailingIndex) return { username: trailingIndex[1].trim() };
    return { username: value };
  }
  return { username: String(args || '').trim() };
}

/** Rebuild the original bot command text for bridge invocation. */
function buildBridgeCommand(match: QuickMatch): string {
  const { def, cmdText, args, prefix } = match;
  if (def.handler === 'self_profile') return '~';
  if (def.handler === 'at_profile') {
    const qq = match.atTargets?.[0] || '';
    return qq ? `查[CQ:at,qq=${qq}]` : '查';
  }
  if (def.handler === 'where') return `where ${args}`.trim();
  if (prefix === '!') return `!${cmdText}`;
  if (prefix === '/') return `/${cmdText}`;
  return cmdText;
}

// ── Execution ──

const HELP_TEXT = [
  '快捷指令（迁移中，陆续接入）：',
  '成绩：!p / !r / !pr / !re（最近）、!bp / !b / !bs（BP）、!i / !info（玩家信息）、!pp / !plus（PP+）、!pl（旧版 PP−）、!etx（ETX）、!k（技能）',
  'LazyBot 风格：/plus /ppp（PP+）、/bp /bplist、/pr /recent、/profile /info',
  '消防栓风格：~（自己信息卡）、查+@（查他人）、where 名字、+ 玩家名（PP+）',
  '绑定（唯一入口）：/w osu bind <osu用户名>；解绑：/w osu clear bind',
].join('\n');

const UNBOUND_SELF_PROMPT = '你还没绑定 osu! 账号。先发送 /w osu bind <osu用户名> 绑定一次，之后 !p/!r/!pr/!bp/!bs/!i/~ 这些指令都能直接用。';
const UNBOUND_TARGET_PROMPT = '对方还没绑定 osu! 账号。';
const UNBOUND_QQ_PROMPT = '该 QQ 还没绑定 osu! 账号。';
const BIND_HINT = '绑定请使用 /w osu bind <osu用户名>；解绑请使用 /w osu clear bind。';

/**
 * Resolve a QQ to its Wuxin binding as an injectable user token (username or
 * osu id). Returns '' when the QQ has no binding.
 */
function bindingUser(db: any, qq: string | undefined): string {
  const binding = db?.osuBindings?.[String(qq ?? '')];
  if (!binding) return '';
  return bindingParts(binding).username || String(bindingParts(binding).id || '');
}

function bindingParts(binding: any): { id: number; username: string } {
  if (typeof binding === 'number' && Number.isFinite(binding) && binding > 0) {
    return { id: binding, username: '' };
  }
  if (typeof binding === 'string' && binding.trim()) {
    const value = binding.trim();
    return /^\d+$/.test(value)
      ? { id: Number(value), username: '' }
      : { id: 0, username: value };
  }
  if (binding && typeof binding === 'object') {
    const id = Number(binding.osuUserId ?? binding.userId ?? binding.id ?? 0);
    return {
      id: Number.isFinite(id) && id > 0 ? id : 0,
      username: String(binding.osuUsername ?? binding.username ?? '').trim(),
    };
  }
  return { id: 0, username: '' };
}

/**
 * Resolve a QQ to an injectable osu! USERNAME. Original bots resolve numeric
 * inputs inconsistently (雨沐 treats them as QQ, 消防栓 `where` only accepts
 * names), so numeric bindings are resolved via the osu API and the username
 * is persisted back into the binding for future calls.
 */
async function resolveInjectionUser(db: any, qq: string | undefined): Promise<string> {
  const binding = db?.osuBindings?.[String(qq ?? '')];
  if (!binding) return '';
  const { id, username } = bindingParts(binding);
  if (username) return username;
  if (id > 0) {
    try {
      const { getUserById } = await import('../osu/api.js');
      const user = await getUserById(id);
      const resolved = String(user?.username || '').trim();
      if (resolved) {
        try {
          updateDb((draft) => {
            const target = draft.osuBindings?.[String(qq)];
            if (target && typeof target === 'object') {
              target.username = resolved;
            } else {
              draft.osuBindings[String(qq)] = { id, username: resolved };
            }
          });
        } catch { /* caching is non-fatal */ }
        return resolved;
      }
    } catch { /* fall back to the id below */ }
    return String(id);
  }
  return '';
}

/**
 * Quick commands mirror the original bots: when a panel image exists, the
 * image IS the answer. The full text payload is only for the LLM fallback
 * path; quick delivery drops it so `!bs 1-100` never dumps 100 text lines
 * alongside the panel.
 */
export function quickPayload(result: string | { content: string; images?: string[] }): string {
  if (typeof result === 'string') return result;
  const images = Array.isArray(result.images) ? result.images : [];
  if (images.length > 0) return images.join('\n');
  return String(result.content || '');
}

function stdOnlyNote(mode: string): string | null {
  if (!mode) return null;
  const normalized = mode.toLowerCase();
  if (['taiko', 'catch', 'mania', 'ctb', 'osu!taiko', 'osu!catch', 'osu!mania'].includes(normalized)) {
    return '目前只支持 osu!std 查询。';
  }
  return null;
}

function resolveAtBinding(db: any, atTargets: string[]): string {
  if (!atTargets?.length) return '';
  const binding = db?.osuBindings?.[atTargets[0]];
  if (!binding) return '';
  return String(binding.osuUsername ?? binding.username ?? binding.id ?? '');
}

export interface QuickRoutePermissions {
  isOwner: boolean;
  isAdmin: boolean;
}

/**
 * Execute a matched quick command. Returns `{ handled: true }` when the quick
 * path owns the message (reply sent or intentionally ignored); `{ handled: false }`
 * when the message should continue into the normal LLM pipeline.
 */
export async function handleQuickCommand(
  event: any,
  sendMessage: any,
  db: any,
  match: QuickMatch,
  permissions: QuickRoutePermissions,
): Promise<{ handled: boolean; replied?: boolean; reason?: string }> {
  const traceId = beginLatencyTrace('quick_command', {
    command: match.def.id,
    source: match.def.source,
    prefix: match.prefix,
    capability: match.def.capability || '',
    handler: match.def.handler || '',
    bridge: Boolean(match.def.bridge),
  });
  if (traceId) markLatencySpan(traceId, 'route_start', { parseAlreadyCompleted: true });
  try {
    const result = await handleQuickCommandInner(event, sendMessage, db, match, permissions, traceId);
    if (traceId) {
      markLatencySpan(traceId, 'route_done', {
        handled: Boolean(result?.handled),
        replied: Boolean(result?.replied),
      });
    }
    return result;
  } finally {
    finishLatencyTrace(traceId, {
      command: match.def.id,
      source: match.def.source,
      prefix: match.prefix,
    });
  }
}

async function handleQuickCommandInner(
  event: any,
  sendMessage: any,
  db: any,
  match: QuickMatch,
  permissions: QuickRoutePermissions,
  traceId?: string | null,
): Promise<{ handled: boolean; replied?: boolean; reason?: string }> {
  const { def, args, atTargets } = match;

  // Global/group/user gates shared with the main pipeline.
  if (db?.settings?.globalPaused) return { handled: true, replied: false, reason: '全局暂停' };
  const group = getGroup(db, event.groupId);
  const isPrivate = event.type === 'private';
  if (!isPrivate && !group?.enabled) return { handled: true, replied: false, reason: '群未启用' };
  const userPolicy = getUserPolicy(db, event.groupId, event.userId);
  if (userPolicy.policy === 'blocked') return { handled: true, replied: false, reason: '黑名单用户' };
  if (!isPrivate && group?.mode === 'silent') return { handled: true, replied: false, reason: '静默模式' };

  // Private chat: owner only in M1 (original bots answered privately too, but
  // the merged entry keeps private traffic conservative for now).
  if (isPrivate && !permissions.isOwner) {
    return { handled: false, reason: '私聊快捷指令暂仅限 owner' };
  }

  // In the hard osu-only group mode, deterministic commands are allowed but
  // their observations must not become future conversational context. Command
  // telemetry and the command's own functional state (bindings, cooldowns,
  // results) remain available.
  const contextRecordingEnabled = isPrivate || group?.mode !== 'osu';

  // Admin-gated commands.
  const meta = finalizeQuickDef(def);
  if ((meta.permission === 'group_admin' || def.kind === 'admin') && !permissions.isOwner && !permissions.isAdmin) {
    const reply = commandDeniedReply(db, 'admin');
    if (sendMessage) await sendMessage(event, reply);
    return { handled: true, replied: true, reason: '权限不足' };
  }

  const log = (outcome: string, detail = '') => {
    try {
      writeCommandLog(event, {
        prefix: match.prefix,
        command: `quick:${def.id}`,
        subCommand: '',
        isWuxinCommand: false,
        rawText: String(event.text || '').slice(0, 600),
        userRoleId: '',
        userPolicy: userPolicy.policy || 'normal',
      }, { outcome, detail, source: def.source, implemented: meta.execution.kind !== 'documentation_only' });
    } catch { /* logging is non-fatal */ }
  };

  // Context memory: quick replies bypass the LLM pipeline and are normally
  // invisible to pippi. Record the query + a compact factual summary into
  // db.messages (inContext only, never long-term memory), always naming who
  // asked. Recording failures must never affect the reply.
  const requester = String(event.nickname || event.userId || '未知用户');
  const record = (content: string, images: string[] = []) => {
    if (!contextRecordingEnabled) return;
    try {
      if (traceId) markLatencySpan(traceId, 'observation_persist_start');
      recordQuickContext(
        event,
        `【快捷查询】${requester}：${String(content || '').trim()}`,
        images,
        traceId,
      );
      if (traceId) markLatencySpan(traceId, 'observation_persist_done');
    } catch { /* memory is non-fatal */ }
  };
  const recordShadow = (
    capability: string | undefined,
    username: string,
    images: string[],
    bpSelection?: BpQuerySelection,
  ) => {
    if (!contextRecordingEnabled) return;
    // QUICK_CONTEXT_FIX_QB08: write the placeholder context slot NOW (the
    // visible reply was already sent) so later hydration can never reorder
    // two consecutive quick commands. The shadow fetch still runs
    // fire-and-forget and hydrates the SAME record in place; the next
    // conversational turn drains the registered pending promise before
    // building its LLM context.
    const fallback = `快捷指令查询完成（${def.source} 面板，结果见图片）`;
    const placeholder = `【快捷查询】${requester}：${fallback}`;
    const pendingId = recordQuickContextPending(event, placeholder, images, traceId);
    void registerPendingQuickObservation(event, async () => {
      try {
        const summary = await buildQuickShadowSummary(
          capability,
          username,
          bpSelection,
          traceId,
        );
        const content = summary
          ? `【快捷查询】${requester}：${summary}`
          : placeholder;
        hydrateQuickContextPending(event, pendingId, content, images, traceId);
        if (traceId) markLatencySpan(traceId, 'context_ready');
      } catch {
        // Hydration failure keeps the already-persisted placeholder; the
        // pending entry always settles so a later turn can never hang.
        hydrateQuickContextPending(event, pendingId, placeholder, images, traceId);
      }
    });
  };

  // Per-group bot toggle: when a specific bot is disabled for this group, its
  // quick routes are fully silent here. The original bot (if still running)
  // keeps owning the command; Wuxin just stops double-replying.
  const groupBotConfig = db?.groupBotConfig?.[String(event?.groupId || '')];
  if (groupBotConfig && groupBotConfig[def.source] === false) {
    log('disabled', `${def.source}:${def.id}`);
    return { handled: true, replied: false, reason: `group_bot_disabled:${def.source}` };
  }

  // Hydrant std-only guard runs before bridging `~` / `查@`.
  if (def.handler === 'self_profile' || def.handler === 'at_profile') {
    const modeNote = stdOnlyNote((match as any).extraMode || '');
    if (modeNote) {
      if (sendMessage) await sendMessage(event, modeNote);
      return { handled: true, replied: true, reason: '非 std 模式' };
    }
  }

  // ── Local bot bridge: direct invocation of the original bot ──
  // Original rendering (雨沐 E5/A4 面板、消防栓文字卡等) beats the internal
  // engine; on any bridge failure we fall through to the internal handler.
  let bridgeUser = '';
  let parsedArgs: ParsedOsuArgs | undefined;
  // Request-scoped marker for QUICK_BRIDGE_FIX_P0_2: set only when a local
  // bridge call was actually issued for THIS top-level quick command. It is
  // consumed by executeInternalBotCommand so its recent case does not repeat
  // the same-target bridge after the fallback.
  let bridgeAlreadyAttemptedFor = '';
  if (def.bridge && hasLocalEndpoint(def.source)) {
    if (traceId) markLatencySpan(traceId, 'subject_resolution_start');
    let bridgeCommand = buildBridgeCommand(match);
    const bridgeContext = {
      // Bridge traffic always uses the dedicated virtual group 770099, whose
      // shared config keeps all four bots enabled. Using the real group id
      // would make the bots' own group-disable check silence bridge calls.
      groupId: '770099',
      userId: String(event.userId || ''),
      nickname: String(event.nickname || ''),
      atTargets,
    };
    // M2: unified binding — commands that need "me"/"him" resolve the user from
    // Wuxin's osuBindings and inject it into the original bot's command.
    if (def.handler === 'self_profile') {
      const user = await resolveInjectionUser(db, String(event.userId));
      if (!user) {
        log('unbound', 'self');
        try {
          if (sendMessage) await sendMessage(event, UNBOUND_SELF_PROMPT);
        } catch (deliveryError: any) {
          console.error('[quick] 未绑定提示发送失败:', deliveryError?.message || deliveryError);
        }
        record(UNBOUND_SELF_PROMPT);
        return { handled: true, replied: true, reason: 'unbound_self' };
      }
      bridgeUser = user;
      bridgeCommand = `where ${user}`;
    } else if (def.handler === 'at_profile') {
      const target = String(atTargets?.[0] || '');
      const user = await resolveInjectionUser(db, target);
      if (!user) {
        log('unbound', `at:${target}`);
        try {
          if (sendMessage) await sendMessage(event, UNBOUND_TARGET_PROMPT);
        } catch (deliveryError: any) {
          console.error('[quick] 未绑定提示发送失败:', deliveryError?.message || deliveryError);
        }
        record(UNBOUND_TARGET_PROMPT);
        return { handled: true, replied: true, reason: 'unbound_target' };
      }
      bridgeUser = user;
      bridgeCommand = `where ${user}`;
    } else if (def.handler === 'where') {
      const qqMatch = /^qq\s*=\s*(\d+)$/i.exec(String(args || '').trim());
      if (qqMatch) {
        const user = await resolveInjectionUser(db, qqMatch[1]);
        if (!user) {
          log('unbound', `qq:${qqMatch[1]}`);
          try {
            if (sendMessage) await sendMessage(event, UNBOUND_QQ_PROMPT);
          } catch (deliveryError: any) {
            console.error('[quick] 未绑定提示发送失败:', deliveryError?.message || deliveryError);
          }
          record(UNBOUND_QQ_PROMPT);
          return { handled: true, replied: true, reason: 'unbound_qq' };
        }
        bridgeUser = user;
        bridgeCommand = `where ${user}`;
      }
    } else if (def.capability || def.injectBinding) {
      parsedArgs = parseOsuArgs(def, args);
      const parsed = parsedArgs;
      if (!parsed.username) {
        const usesAt = atTargets.length > 0;
        const target = usesAt ? String(atTargets[0]) : String(event.userId);
        const user = await resolveInjectionUser(db, target);
        if (!user) {
          log('unbound', usesAt ? `at:${target}` : 'self');
          try {
            if (sendMessage) await sendMessage(event, usesAt ? UNBOUND_TARGET_PROMPT : UNBOUND_SELF_PROMPT);
          } catch (deliveryError: any) {
            console.error('[quick] 未绑定提示发送失败:', deliveryError?.message || deliveryError);
          }
          record(usesAt ? UNBOUND_TARGET_PROMPT : UNBOUND_SELF_PROMPT);
          return { handled: true, replied: true, reason: usesAt ? 'unbound_target' : 'unbound_self' };
        }
        bridgeUser = user;
        // Rebuild with the injected user before any BP range.
        bridgeCommand = `${match.prefix}${match.alias} ${user}${args ? ' ' + args : ''}`;
      } else {
        bridgeUser = parsed.username;
      }
    }
    if (traceId) markLatencySpan(traceId, 'subject_resolution_done', { resolved: Boolean(bridgeUser) });
    try {
      const bridgeTimeout = def.source === 'lazybot' ? 30_000 : 60_000;
      if (traceId) markLatencySpan(traceId, 'bridge_request_start', { source: def.source });
      bridgeAlreadyAttemptedFor = def.source;
      const reply = await callLocalBot(def.source, bridgeCommand, bridgeContext, bridgeTimeout);
      if (traceId) markLatencySpan(traceId, 'bridge_response', { source: def.source, frames: reply?.frames });
      // Bridge replies are the original bot's own output: keep text and images
      // exactly as produced (the internal engine is the one that needed the
      // image-only rule to avoid duplicating its panel text).
      const payload = [reply.text, ...reply.images].filter(Boolean).join('\n');
      if (payload) {
        // QUICK_CONTEXT_QB08 A1: the conversation record (text) or placeholder
        // + pending registration (image-only shadow) MUST exist BEFORE the
        // visible send can be observed by a follow-up. Never register after
        // await sendMessage.
        const bridgeText = String(reply.text || '').trim();
        if (bridgeText) {
          record(`[${def.source}] ${bridgeText}`, reply.images);
        } else {
          const whereUser = def.handler === 'where' ? String(args || '').trim() : '';
          const shadowUser = bridgeUser || whereUser;
          const shadowCap = def.capability
            ?? (def.handler === 'self_profile' || def.handler === 'at_profile' || def.handler === 'where'
              ? 'profile'
              : undefined);
          if (shadowCap && shadowUser) {
            recordShadow(shadowCap, shadowUser, reply.images, parsedArgs?.bpSelection);
          } else {
            record(`快捷指令查询完成（${def.source} 面板，结果见图片）`, reply.images);
          }
        }
        try {
          if (traceId) markLatencySpan(traceId, 'send_start', { channel: 'bridge' });
          if (sendMessage) await sendMessage(event, payload);
          if (traceId) markLatencySpan(traceId, 'send_resolved', { channel: 'bridge' });
        } catch (deliveryError: any) {
          console.error(`[quick] bridge ${def.source} 发送失败（面板可能已发出）:`, deliveryError?.message || deliveryError);
        }
        log('bridge', `${def.source}:${bridgeCommand}`);
        return { handled: true, replied: true, reason: `bridge:${def.source}` };
      }
      console.error(`[quick] bridge ${def.source} 返回空回复，回退内部引擎`);
    } catch (error: any) {
      if (traceId) markLatencySpan(traceId, 'bridge_failed', { source: def.source });
      console.error(`[quick] bridge ${def.source} 失败，回退内部引擎:`, error?.message || error);
    }
  }

  // ── Local handlers ──
  if (def.handler === 'help') {
    if (sendMessage) await sendMessage(event, HELP_TEXT);
    log('help');
    return { handled: true, replied: true, reason: 'help' };
  }
  if (def.handler === 'ping') {
    const text = `在的（${new Date().toLocaleTimeString('zh-CN', { hour12: false })}）`;
    if (sendMessage) await sendMessage(event, text);
    log('ping');
    return { handled: true, replied: true, reason: 'ping' };
  }
  if (def.handler === 'dice') {
    const raw = args.match(/(\d{1,6})/);
    const sides = raw ? Math.min(Number(raw[1]), 1_000_000) : 100;
    const value = Math.floor(Math.random() * sides) + 1;
    const text = `🎲 ${value}（1~${sides}）`;
    if (sendMessage) await sendMessage(event, text);
    log('dice', String(sides));
    return { handled: true, replied: true, reason: 'dice' };
  }
  if (def.handler === 'bind' || def.handler === 'unbind') {
    log(def.handler);
    try {
      if (sendMessage) await sendMessage(event, BIND_HINT);
    } catch (deliveryError: any) {
      console.error('[quick] 绑定提示发送失败:', deliveryError?.message || deliveryError);
    }
    return { handled: true, replied: true, reason: 'bind_hint' };
  }

  // ── Hydrant profile/PP+ handlers ──
  if (def.handler === 'self_profile' || def.handler === 'at_profile') {
    const modeNote = stdOnlyNote((match as any).extraMode || '');
    if (modeNote) {
      if (sendMessage) await sendMessage(event, modeNote);
      return { handled: true, replied: true, reason: '非 std 模式' };
    }
    const username = def.handler === 'at_profile' ? resolveAtBinding(db, atTargets) : '';
    let result: Awaited<ReturnType<typeof executeInternalBotCommand>>;
    try {
      result = await executeInternalBotCommand('hydrant', 'profile', username, {
        db, userId: String(event.userId), groupId: event.groupId,
      });
    } catch (error: any) {
      if (sendMessage) await sendMessage(event, String(error?.message || error));
      record(`查询失败：${String(error?.message || error)}`);
      return { handled: true, replied: true, reason: 'profile_error' };
    }
    // Delivery failure after a successful command must not trigger a second,
    // confusing error message (panel may already have been sent).
    try {
      if (sendMessage) await sendMessage(event, quickPayload(result));
    } catch (deliveryError: any) {
      console.error(`[quick] ${def.id} 发送失败（面板可能已发出）:`, deliveryError?.message || deliveryError);
    }
    log('profile', username || '(self)');
    const memContent = typeof result === 'string'
      ? result
      : String((result as any).content || '');
    const memImages = typeof result === 'string' ? [] : ((result as any).images || []);
    record(memContent || `查询了 ${username || '绑定玩家'} 的玩家信息`, memImages);
    return { handled: true, replied: true, reason: 'profile' };
  }
  if (def.handler === 'where') {
    const query = String(args || '').trim();
    const qqMatch = /^qq\s*=\s*(\d+)$/i.exec(query);
    if (qqMatch) {
      const binding = db?.osuBindings?.[qqMatch[1]];
      const text = binding
        ? `QQ ${qqMatch[1]} 绑定到 osu! ${String(binding.osuUsername ?? binding.username ?? binding.id)}。`
        : `QQ ${qqMatch[1]} 未绑定 osu! 账号。`;
      if (sendMessage) await sendMessage(event, text);
      log('where_qq', qqMatch[1]);
      record(text);
      return { handled: true, replied: true, reason: 'where_qq' };
    }
    if (!query) {
      if (sendMessage) await sendMessage(event, '用法：where <osu用户名> 或 where qq=<QQ号>');
      return { handled: true, replied: true, reason: 'where 缺参数' };
    }
    let result: Awaited<ReturnType<typeof executeInternalBotCommand>>;
    try {
      result = await executeInternalBotCommand('hydrant', 'profile', query, {
        db, userId: String(event.userId), groupId: event.groupId,
      });
    } catch (error: any) {
      if (sendMessage) await sendMessage(event, String(error?.message || error));
      record(`查询失败：${String(error?.message || error)}`);
      return { handled: true, replied: true, reason: 'where_error' };
    }
    try {
      if (sendMessage) await sendMessage(event, quickPayload(result));
    } catch (deliveryError: any) {
      console.error(`[quick] ${def.id} 发送失败（面板可能已发出）:`, deliveryError?.message || deliveryError);
    }
    log('where', query);
    const memContent = typeof result === 'string'
      ? result
      : String((result as any).content || '');
    const memImages = typeof result === 'string' ? [] : ((result as any).images || []);
    record(memContent || `查询了 ${query} 的玩家信息`, memImages);
    return { handled: true, replied: true, reason: 'where' };
  }
  // ── Internal engine capabilities ──
  if (def.capability) {
    const parsed = parseOsuArgs(def, args);
    if (parsed.error) {
      if (sendMessage) await sendMessage(event, parsed.error);
      record(`参数错误：${parsed.error}`);
      return { handled: true, replied: true, reason: '参数错误' };
    }
    let username = parsed.username;
    if (!username && atTargets.length > 0) {
      const target = String(atTargets[0]);
      username = bindingUser(db, target);
      if (!username) {
        log('unbound', `at:${target}`);
        try {
          if (sendMessage) await sendMessage(event, UNBOUND_TARGET_PROMPT);
        } catch (deliveryError: any) {
          console.error('[quick] 未绑定提示发送失败:', deliveryError?.message || deliveryError);
        }
        record(UNBOUND_TARGET_PROMPT);
        return { handled: true, replied: true, reason: 'unbound_target' };
      }
    }
    if (!username && !bindingUser(db, String(event.userId))) {
      log('unbound', 'self');
      try {
        if (sendMessage) await sendMessage(event, UNBOUND_SELF_PROMPT);
      } catch (deliveryError: any) {
        console.error('[quick] 未绑定提示发送失败:', deliveryError?.message || deliveryError);
      }
      record(UNBOUND_SELF_PROMPT);
      return { handled: true, replied: true, reason: 'unbound_self' };
    }
    const botId = def.source === 'kanon'
      ? 'kanon'
      : def.source === 'lazybot'
        ? 'lazybot'
        : def.source === 'hydrant'
          ? 'hydrant'
          : 'yumu';
    if (def.capability === 'recommend' && sendMessage) {
      try {
        await sendMessage(event, '（正在翻同分段玩家的成绩单…可能要等半分钟）');
      } catch {
        // Hint is non-fatal.
      }
    }
    let result: Awaited<ReturnType<typeof executeInternalBotCommand>>;
    try {
      if (traceId && def.capability === 'recent') {
        markLatencySpan(traceId, 'recent_execution_start', { path: 'internal_engine' });
      }
      result = await executeInternalBotCommand(
        botId,
        def.capability,
        username,
        { db, userId: String(event.userId), groupId: event.groupId, event, isOwner: permissions.isOwner, beatmapId: parsed.scoreBeatmapId },
        parsed.bpSelection,
        bridgeAlreadyAttemptedFor ? { bridgeAlreadyAttemptedFor } : undefined,
        traceId,
      );
      if (traceId && def.capability === 'recent') {
        markLatencySpan(traceId, 'recent_execution_done', { path: 'internal_engine' });
      }
    } catch (error: any) {
      if (traceId && def.capability === 'recent') {
        markLatencySpan(traceId, 'recent_execution_done', { path: 'internal_engine', failed: true });
      }
      if (sendMessage) await sendMessage(event, String(error?.message || error));
      record(`查询失败：${String(error?.message || error)}`);
      return { handled: true, replied: true, reason: `${def.capability}_error` };
    }
    try {
      if (traceId) markLatencySpan(traceId, 'send_start', { channel: 'internal' });
      if (sendMessage) await sendMessage(event, quickPayload(result));
      if (traceId) markLatencySpan(traceId, 'send_resolved', { channel: 'internal' });
    } catch (deliveryError: any) {
      console.error(`[quick] ${def.id} 发送失败（面板可能已发出）:`, deliveryError?.message || deliveryError);
    }
    log(def.capability, username || '(self)');
    const memContent = typeof result === 'string'
      ? result
      : String((result as any).content || '');
    const memImages = typeof result === 'string' ? [] : ((result as any).images || []);
    record(memContent || `${def.capability} 查询完成（结果见图片）`, memImages);
    return { handled: true, replied: true, reason: def.capability };
  }

  // Registered but not yet ported: keep the LLM pipeline as the fallback so
  // the group keeps getting useful answers while migration is in progress.
  log('unimplemented', def.id);
  return { handled: false, reason: `quick_unimplemented:${def.id}` };
}
