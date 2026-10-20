export interface ParsedScoreArgs {
  username: string;
  scoreBeatmapId?: number;
  /** Undefined means unrestricted; NM is an explicit no-mod filter. */
  scoreMods?: string[];
  error?: string;
}

const USAGE = '用法：!score <谱面BID> [玩家名] [+Mods]，例如 !score 3648544 +HDDA；玩家名也可放在 BID 前。';

/** Parse the score forms shared by !score, !s and /score before resolving a player. */
export function parseScoreArgs(args: string): ParsedScoreArgs {
  let value = String(args || '').trim().replace(/＋/g, '+').replace(/＃/g, '#');
  const result: ParsedScoreArgs = { username: '' };
  if (!value) return { ...result, error: USAGE };

  const plus = value.indexOf('+');
  if (plus >= 0) {
    const rawMods = value.slice(plus + 1).trim().toUpperCase();
    // Accept concatenated acronyms, including lazer mods and mania key mods.
    // Keep unknown two-character acronyms for the upstream API to validate.
    if (!/^(?:[A-Z0-9]{2})+$/.test(rawMods)) {
      return { ...result, error: 'Mod 格式无效，请在指令末尾使用 +HDDA、+DC 或 +NM 这样的写法。' };
    }
    result.scoreMods = [...new Set(rawMods.match(/.{2}/g)!)];
    if (result.scoreMods.includes('NM') && result.scoreMods.length > 1) {
      return { ...result, error: 'NM 表示无 Mod，不能与其他 Mod 一起筛选。' };
    }
    value = value.slice(0, plus).trim();
  }

  // A quoted numeric name remains a name. Otherwise preserve BID-first
  // precedence while also accepting the original bot's username-first form.
  const tokens = value.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const explicit = tokens.map((token, index) => token.startsWith('#') ? index : -1).filter((index) => index >= 0);
  let bidIndex = -1;
  if (explicit.length === 1) bidIndex = explicit[0];
  else if (explicit.length === 0 && /^\d+$/.test(tokens[0] || '')) bidIndex = 0;
  else if (explicit.length === 0 && /^\d+$/.test(tokens.at(-1) || '')) bidIndex = tokens.length - 1;
  if (bidIndex < 0) return { ...result, error: `请提供有效的谱面 BID。${USAGE}` };

  const rawBid = tokens.splice(bidIndex, 1)[0].replace(/^#/, '');
  const bid = Number(rawBid);
  if (!/^\d+$/.test(rawBid) || !Number.isSafeInteger(bid) || bid <= 0 || bid > 2_147_483_647) {
    return { ...result, error: `谱面 BID 无效：${rawBid}。${USAGE}` };
  }
  let username = tokens.join(' ').trim();
  if (/^"[^"]*"$|^'[^']*'$/.test(username)) username = username.slice(1, -1).trim();
  // Do not silently treat unsupported selectors or incomplete quotes as names.
  if (/["':#&]/.test(username)) return { ...result, error: `玩家名或参数格式无效。${USAGE}` };
  return { ...result, username, scoreBeatmapId: bid };
}

/** #BID prevents a numeric/trailing-number username from becoming the beatmap ID. */
export function buildKanonScoreCommand(parsed: ParsedScoreArgs, username: string): string {
  return `!score ${username} #${parsed.scoreBeatmapId}${parsed.scoreMods ? ` +${parsed.scoreMods.join('')}` : ''}`;
}
