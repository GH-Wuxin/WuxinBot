// Security guard: strict operation whitelist for LLM-initiated actions.
// The LLM can ONLY request whitelisted operations. Everything else is rejected.
// NO file system access, NO shell execution, NO config modification.
import type { AllowedOperation, AllowedOperationType } from './types.js';
import { internalCapabilitySupported } from './registry.js';

// ── Whitelist ──

// query_osu is the internal readonly osu! data tool (BP/recent/info/pp+/skill).
// query_external_bot stays OUT of this whitelist until its permission model and
// real channel (QQ adapter) are confirmed — it must not be callable by default.
const ALLOWED_OPERATIONS: ReadonlySet<AllowedOperationType> = new Set([
  'query_osu',
  'query_bot',
  'get_player_skill',
  'list_bots',
  'get_recent_score'
]);

// Operations that the LLM is NEVER allowed to request. These patterns are a
// defence-in-depth check for any future, free-form parameters. The currently
// supported tools use an exact key allowlist and field-specific validation
// below, so data such as an osu! username is never mistaken for an operation
// merely because the JSON key happens to be named "command".
const BLOCKED_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  // Match English operation words as complete tokens. Substring matching here
  // used to reject the legitimate osu! command name "profile" because it ends
  // in "file".
  { pattern: /(?:^|[^a-z0-9])(?:file|read|write|delete|create|remove|unlink|mkdir)(?:$|[^a-z0-9])|文件|写入|删除|修改|创建|读取/i, reason: '禁止文件系统操作' },
  { pattern: /exec|shell|bash|cmd|powershell|command|执行|运行|启动|进程|process/i, reason: '禁止执行系统命令' },
  { pattern: /config|设置|settings|修改配置|change.*setting|update.*config/i, reason: '禁止修改配置' },
  { pattern: /http|fetch|curl|wget|api(?!.*osu)|外部|网络请求|下载|upload|上传/i, reason: '禁止外部网络请求（osu API 除外）' },
  { pattern: /token|password|secret|key|密码|密钥|凭证|api.?key/i, reason: '禁止访问凭据' },
  { pattern: /db|database|数据库|sql|mongo/i, reason: '禁止直接数据库操作' },
  { pattern: /eval|function\s*\(|require|import\s*\(|Function\(|setTimeout|setInterval/i, reason: '禁止代码执行' },
];

// ── Validation ──

const PARAM_KEYS: Readonly<Record<AllowedOperationType, ReadonlySet<string>>> = {
  query_osu: new Set(['capability', 'username', 'bp_rank', 'bp_start', 'bp_end', 'compact', 'bot', 'beatmap_id', 'mods', 'accuracy', 'combo', 'misses', 'limit']),
  query_external_bot: new Set(['bot', 'command']),
  query_bot: new Set(['bot', 'command', 'username', 'bp_rank', 'bp_start', 'bp_end']),
  get_player_skill: new Set(['player']),
  list_bots: new Set(),
  get_recent_score: new Set(['player']),
};

function rejectUnknownParams(op: AllowedOperation): { ok: true } | { ok: false; reason: string } {
  const allowed = PARAM_KEYS[op.type];
  for (const key of Object.keys(op.params || {})) {
    if (!allowed.has(key)) {
      return { ok: false, reason: `不允许的参数: ${key}` };
    }
  }
  return { ok: true };
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function validatePlayerText(value: string, label: string, required: boolean): string | null {
  if (!value) return required ? `无效的${label}` : null;
  if (value.length > 128) return `${label}过长`;
  if (hasControlCharacters(value)) return `${label}包含控制字符`;
  if (/\[CQ:/i.test(value)) return `${label}包含不允许的消息代码`;
  return null;
}

function hasOwnParam(params: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(params, key) &&
    params[key] !== undefined &&
    params[key] !== null &&
    params[key] !== '';
}

function parseBpRankParam(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

function validateBpSelectionParams(op: AllowedOperation): { ok: true } | { ok: false; reason: string } {
  const hasRank = hasOwnParam(op.params, 'bp_rank');
  const hasStart = hasOwnParam(op.params, 'bp_start');
  const hasEnd = hasOwnParam(op.params, 'bp_end');
  for (const [key, label] of [
    ['bp_rank', 'BP 名次'],
    ['bp_start', 'BP 范围起点'],
    ['bp_end', 'BP 范围终点'],
  ] as const) {
    if (!hasOwnParam(op.params, key)) continue;
    const value = parseBpRankParam(op.params[key]);
    if (value === null || value < 1 || value > 100) {
      return { ok: false, reason: `${label}必须是 1 到 100 的整数` };
    }
  }
  if (hasRank && (hasStart || hasEnd)) {
    return { ok: false, reason: 'bp_rank 不能和 BP 范围参数同时使用' };
  }
  if (hasStart !== hasEnd) {
    return { ok: false, reason: 'BP 范围必须同时提供 bp_start 和 bp_end' };
  }
  if (hasStart && parseBpRankParam(op.params.bp_start)! > parseBpRankParam(op.params.bp_end)!) {
    return { ok: false, reason: 'BP 范围起点不能大于终点' };
  }
  if (hasStart && parseBpRankParam(op.params.bp_end)! - parseBpRankParam(op.params.bp_start)! + 1 > 100) {
    return { ok: false, reason: '一次最多查询 100 张 BP' };
  }
  return { ok: true };
}

export function validateOperation(op: AllowedOperation): { ok: true } | { ok: false; reason: string } {
  if (!ALLOWED_OPERATIONS.has(op.type)) {
    return { ok: false, reason: `不允许的操作类型: ${op.type}` };
  }

  const keyValidation = rejectUnknownParams(op);
  if (!keyValidation.ok) return keyValidation;

  // Specific parameter validation
  switch (op.type) {
    case 'query_osu': {
      const capability = String(op.params.capability || '').trim();
      if (!capability || !internalCapabilitySupported(capability)) {
        return { ok: false, reason: `无效的查询类型: ${capability || '(空)'}` };
      }
      if (hasOwnParam(op.params, 'compact') && typeof op.params.compact !== 'boolean') {
        return { ok: false, reason: 'compact 参数必须是布尔值' };
      }
      const username = String(op.params.username || '').trim();
      const usernameError = validatePlayerText(username, '玩家名', false);
      if (usernameError) return { ok: false, reason: usernameError };

      // Beatmap-centric capabilities (Phase B): beatmap-scoped params only.
      const BEATMAP_CAPABILITIES = new Set(['beatmap_lookup', 'pp_calc', 'leaderboard']);
      if (BEATMAP_CAPABILITIES.has(capability)) {
        const beatmapId = parseBpRankParam(op.params.beatmap_id);
        if (beatmapId === null || beatmapId < 1) {
          return { ok: false, reason: `${capability} 需要有效的 beatmap_id` };
        }
        for (const key of ['username', 'bp_rank', 'bp_start', 'bp_end', 'compact']) {
          if (hasOwnParam(op.params, key)) return { ok: false, reason: `${key} 不能与 ${capability} 一起使用` };
        }
        if (hasOwnParam(op.params, 'mods')) {
          const modsValue = String(op.params.mods || '');
          if (modsValue.length > 16 || !/^[A-Za-z]*$/.test(modsValue)) {
            return { ok: false, reason: 'mods 必须是成对双字母组合' };
          }
        }
        if (capability === 'pp_calc') {
          if (hasOwnParam(op.params, 'accuracy')) {
            const acc = Number(op.params.accuracy);
            if (!Number.isFinite(acc) || acc <= 0 || acc > 100) return { ok: false, reason: 'accuracy 必须是 0-100 的数字' };
          }
          if (hasOwnParam(op.params, 'combo')) {
            const combo = Number(op.params.combo);
            if (!Number.isFinite(combo) || combo < 0 || !Number.isInteger(combo)) return { ok: false, reason: 'combo 必须是非负整数' };
          }
          if (hasOwnParam(op.params, 'misses')) {
            const misses = Number(op.params.misses);
            if (!Number.isInteger(misses) || misses < 0 || misses > 999) return { ok: false, reason: 'misses 必须是 0-999 的整数' };
          }
        } else {
          for (const key of ['accuracy', 'combo', 'misses']) {
            if (hasOwnParam(op.params, key)) return { ok: false, reason: `${key} 不能与 ${capability} 一起使用` };
          }
        }
        if (capability !== 'leaderboard' && hasOwnParam(op.params, 'limit')) {
          return { ok: false, reason: `limit 不能与 ${capability} 一起使用` };
        }
        if (capability === 'leaderboard' && hasOwnParam(op.params, 'limit')) {
          const limit = Number(op.params.limit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 50) return { ok: false, reason: 'limit 必须是 1-50 的整数' };
        }
      } else {
        for (const key of ['beatmap_id', 'accuracy', 'combo', 'misses', 'limit']) {
          if (hasOwnParam(op.params, key)) return { ok: false, reason: `${key} 不能与 ${capability} 一起使用` };
        }
      }
      return validateBpSelectionParams(op);
    }
    case 'query_bot': {
      const botId = String(op.params.bot || '').trim();
      if (!botId || botId.length > 64) return { ok: false, reason: '无效的机器人 ID' };
      // Registry IDs/names may be Latin or Chinese, but never contain syntax.
      if (!/^[\p{L}\p{N}_-]+$/u.test(botId)) return { ok: false, reason: '机器人 ID 包含无效字符' };

      const command = String(op.params.command || '').trim();
      if (!command || command.length > 128) return { ok: false, reason: '无效的指令' };
      // Accept either a registry command name or its literal trigger. Exact
      // membership is checked by executor.findCommand; this lexical gate only
      // permits the harmless syntax used by known osu! bot triggers.
      if (!/^[\p{L}\p{N}_!/~+.#-]+(?:[ \t][\p{L}\p{N}_!/~+.#-]+)*$/u.test(command)) {
        return { ok: false, reason: '指令格式无效' };
      }
      for (const { pattern, reason } of BLOCKED_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(command)) {
          return { ok: false, reason };
        }
      }

      const username = String(op.params.username || '').trim();
      const usernameError = validatePlayerText(username, '玩家名', false);
      if (usernameError) return { ok: false, reason: usernameError };

      const bpValid = validateBpSelectionParams(op);
      if (!bpValid.ok) return bpValid;

      break;
    }
    case 'get_player_skill': {
      const player = String(op.params.player || '').trim();
      const playerError = validatePlayerText(player, '玩家标识', true);
      if (playerError) return { ok: false, reason: playerError };
      break;
    }
    case 'get_recent_score': {
      const player = String(op.params.player || '').trim();
      const playerError = validatePlayerText(player, '玩家标识', false);
      if (playerError) return { ok: false, reason: playerError };
      break;
    }
    case 'list_bots': {
      // No params needed
      break;
    }
  }

  return { ok: true };
}

// ── LLM tool result sanitization ──

export function sanitizeToolResult(content: string): string {
  // Strip anything that looks like a file path
  let cleaned = content
    .replace(/[A-Za-z]:[\\/][^\s,，。]*/g, '[路径已隐藏]')
    // Only treat forward-slash tokens as paths when they contain a dot or a
    // file extension; plain word lists like "aim/alt/tech/stream" must survive.
    .replace(/\/[^\s,，。]*\.[^\s,，。]+/g, '[路径已隐藏]')
    .replace(/\\[^\s,，。]+\\[^\s,，。]+/g, '[路径已隐藏]');

  // Truncate if too long
  if (cleaned.length > 4000) {
    cleaned = cleaned.slice(0, 4000) + '\n（结果过长，已截断）';
  }

  return cleaned;
}

// ── Tool result should NOT contain executable instructions ──

export function isSafeToolResult(content: string): boolean {
  // Results must not contain LLM prompt injection patterns
  const dangerPatterns = [
    /忽略.*指令|ignore.*instruction|system.*prompt/i,
    /你是.*不是.*pippi|you are not pippi/i,
    /new.*instruction|新的.*指令/i,
  ];
  return !dangerPatterns.some((p) => p.test(content));
}

// ── Tool-call markup guard ──
// Some providers/models write tool invocations as literal text in `content`
// (XML or DSML with ASCII/full-width brackets and pipe decorations) instead
// of (or in addition to) the structured `tool_calls` field. That text is NOT
// executed by the harness and must NEVER reach the user as a final reply.
// These helpers detect, strip, and parse that markup so the loop can either
// route it through the normal validated executor or drop it safely.

const TOOL_MARKUP_TAG = '(?:tool_calls?|tool_call|invoke|parameter|function_call)';
const TOOL_MARKUP_PIPE = '[｜|]';
const TOOL_MARKUP_OPEN_RE = new RegExp(
  `(?:<|＜)\\s*(?:[\\\\/]\\s*)?(?:${TOOL_MARKUP_PIPE}{1,2}\\s*DSML\\s*${TOOL_MARKUP_PIPE}{1,2}\\s*)?(?:${TOOL_MARKUP_PIPE}{1,2}\\s*)?[\\\\/]?\\s*${TOOL_MARKUP_TAG}\\b`,
  'i'
);
const DSML_PIPE_RE = new RegExp(
  `${TOOL_MARKUP_PIPE}{1,2}\\s*DSML\\s*${TOOL_MARKUP_PIPE}{1,2}|(?:<|＜)\\s*(?:[\\\\/]\\s*)?(?:${TOOL_MARKUP_PIPE}{1,2}\\s*)?DSML\\b`,
  'i'
);

function markupAscii(value: string): string {
  return value.replace(/＜/g, '<').replace(/＞/g, '>').replace(/｜/g, '|');
}

export function looksLikeToolCallMarkup(text: string): boolean {
  const value = String(text || '');
  if (!value) return false;
  // Test both the raw text and its ASCII-normalised form so that ASCII pipes
  // (`<|DSML|tool_calls>`) are detected too, not only full-width decorations.
  const ascii = markupAscii(value);
  if (TOOL_MARKUP_OPEN_RE.test(value) || TOOL_MARKUP_OPEN_RE.test(ascii)) return true;
  // DSML-decorated blocks (＜｜DSML｜＞ ...) that also name a call tag.
  if ((DSML_PIPE_RE.test(value) || DSML_PIPE_RE.test(ascii)) && new RegExp(TOOL_MARKUP_TAG, 'i').test(value)) return true;
  return false;
}

// The real production leak decorates tags in several observed ways:
//   `<｜DSML｜/parameter>`  (DSML keyword + single pipes, before the slash)
//   `<｜｜/tool_calls>`     (bare doubled pipes, full-width brackets)
//   `<|DSML|tool_calls>`   (ASCII pipes)
// After markupAscii these become `<|DSML|/parameter>`, `<||/tool_calls>` and
// `<|DSML|tool_calls>`. Normalise those decorations inside tag brackets so the
// plain-XML pair regexes below match the observed shapes instead of only
// `</parameter>`.
function normalizeDsmlTags(value: string): string {
  return value
    .replace(/<([^>]*?)\|{1,2}\s*DSML\s*\|{1,2}([^>]*?)>/gi, '<$1$2>')
    .replace(/<(\s*)\|{1,2}/g, '<$1')
    .replace(/\|{1,2}\s*>/g, '>');
}

// Structural validator: walk every tool-markup tag in order and verify that
// closing tags match the currently open tag by name (LIFO). Self-closing tags
// (`<parameter …/>`) are accepted. Any mismatch, extra close, or unclosed tag
// means the block is corrupt/truncated and must fail closed. A pure
// open/close COUNT is not enough: `<parameter>pp_calc</invoke>` has equal
// counts but would still leak the parameter value after pair-wise removal.
const TOOL_TAG_SCAN_RE = new RegExp(`<\\s*(\\/?)\\s*(${TOOL_MARKUP_TAG})\\b([^>]*)>`, 'gi');

function validateToolMarkupStructure(ascii: string): boolean {
  TOOL_TAG_SCAN_RE.lastIndex = 0;
  const stack: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = TOOL_TAG_SCAN_RE.exec(ascii)) !== null) {
    const closing = Boolean(match[1]);
    // `tool_calls` and `tool_call` are one family; the pair regexes treat them
    // the same, so the structural check must too.
    const name = String(match[2] || '').replace(/^tool_call$/, 'tool_calls');
    const rest = match[3] || '';
    if (!closing) {
      if (rest.trim().endsWith('/')) continue; // self-closing
      stack.push(name);
      continue;
    }
    const open = stack.pop();
    if (open !== name) return false;
  }
  return stack.length === 0;
}

export function stripToolCallMarkup(text: string): string {
  const original = String(text || '');
  if (!looksLikeToolCallMarkup(original)) return original;
  const ascii = normalizeDsmlTags(markupAscii(original));
  // Fail closed on truncated, unbalanced or mismatched markup: stream
  // interruption or budget exhaustion can cut a block mid-parameter, and
  // mis-nested tags would otherwise leave raw parameter values (e.g.
  // `pp_calc`) behind after pair-wise removal.
  if (!validateToolMarkupStructure(ascii)) return '';
  const keyword = '(?:tool_calls?|invoke|parameter|function_call|DSML)';
  let cleaned = ascii
    // Whole tool_calls blocks (including closing tag).
    .replace(new RegExp(`<\\s*(?!\\/)[^>]*?tool_calls?[^>]*>[\\s\\S]*?<\\s*\\/\\s*[^>]*?tool_calls?[^>]*>`, 'gi'), '')
    // invoke blocks.
    .replace(new RegExp(`<\\s*(?!\\/)[^>]*?invoke[^>]*>[\\s\\S]*?<\\s*\\/\\s*[^>]*?invoke[^>]*>`, 'gi'), '')
    // parameter pairs and leftovers.
    .replace(new RegExp(`<\\s*(?!\\/)[^>]*?parameter[^>]*>[\\s\\S]*?<\\s*\\/\\s*[^>]*?parameter[^>]*>`, 'gi'), '')
    .replace(new RegExp(`<\\s*(?:\\/\\s*)?[^>]*?parameter[^>]*>`, 'gi'), '')
    // Any remaining tool_calls / DSML fragments.
    .replace(new RegExp(`<[^>]*?${keyword}[^>]*>`, 'gi'), '');
  cleaned = cleaned
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned;
}

export interface ParsedToolMarkupCall {
  name: string;
  args: Record<string, unknown>;
}

export function parseToolCallMarkup(text: string): ParsedToolMarkupCall[] {
  const value = String(text || '');
  if (!looksLikeToolCallMarkup(value)) return [];
  const ascii = normalizeDsmlTags(markupAscii(value));
  // Structural gate: mis-nested / mismatched / truncated markup must never be
  // routed to the executor, even though a naive pair scan could still find a
  // plausible <invoke>…</invoke> substring inside the corrupt block.
  if (!validateToolMarkupStructure(ascii)) return [];
  const calls: ParsedToolMarkupCall[] = [];
  const invokeRe = /<[^>]*?invoke\b[^>]*>([\s\S]*?)<\/[^>]*?invoke\b[^>]*>/gi;
  let invokeMatch: RegExpExecArray | null;
  while ((invokeMatch = invokeRe.exec(ascii)) !== null) {
    const body = invokeMatch[1] || '';
    const nameMatch = String(invokeMatch[0] || '').match(/name\s*=\s*["']([^"']+)["']/i);
    if (!nameMatch) continue;
    const name = String(nameMatch[1] || '').trim();
    const args: Record<string, unknown> = {};
    const paramRe = /<[^>]*?parameter\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/[^>]*?parameter\s*>/gi;
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = paramRe.exec(body)) !== null) {
      const key = String(paramMatch[1] || '').trim();
      const raw = String(paramMatch[2] || '').trim();
      let parsedValue: unknown = raw;
      if (raw === 'true') parsedValue = true;
      else if (raw === 'false') parsedValue = false;
      args[key] = parsedValue;
    }
    if (name) calls.push({ name, args });
  }
  return calls;
}
