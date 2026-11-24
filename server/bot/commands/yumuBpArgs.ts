// Wuxin supplies the missing subject, not the answers to Yumu's score filters.
// Keep the original provider expression for the wire. This scan only separates
// command arguments from the residual player name; it never filters scores.
const ARG = /(?<!\S)(?:(?<mode>[:：]\s*[a-z0-9_-]+)(?=\s|$)|(?<mod>[+＋]\s*[a-z0-9]+)(?=\s|$)|(?<key>[\p{L}\p{N}_-]+)\s*(?<op>[!！][=＝]|[<>＜＞=＝][=＝]?|[≤≥]|[+＋])\s*(?<value>"[^"]*"|'[^']*'|[^\s]+))/giu;

// Free-text classifier values can include unquoted spaces (title=Blue Zenith).
// Numeric conditions and quoted values end before a following player name.
const TEXT_FIELD = /^(?:title|name|song|t|歌?曲名|歌曲|标题|artist|singer|art|f?a|艺术家|曲师?|source|src|from|f|o|sc|se|来?源|tags?|ta|tg|w|标签?|any(?:thing)?|y|任[何意]?(?:字段|文字)?|[字文]|difficult(?:y|ies)|diff|d|难度名?|creator|host|mapper|guest|gder|作者|谱师|alias(?:es)?|别名|外号|昵称)$/iu;

export function yumuBpSyntax(raw: string) {
  const rest: string[] = [];
  let end = 0, mode = '', modeStart = -1, modeEnd = -1;
  let selector = '', filtered = false, textValue = false;
  for (const match of raw.matchAll(ARG)) {
    const {key, op, value, mod, mode: modeToken} = match.groups!;
    const gap = raw.slice(end, match.index);
    if (!textValue) rest.push(gap);
    end = match.index + match[0].length;
    textValue = false;
    if (modeToken) {
      if (!mode) { mode = modeToken; modeStart = match.index; modeEnd = end; }
    } else if (key && /^(?:u(?:ser)?id|id|qq)$/i.test(key) && /^[=＝]$/.test(op) && /^\d+$/.test(value)) {
      // Bare id= is ambiguous across Yumu versions. Forward it, don't add a
      // second target or synthesize a result on behalf of either interpretation.
      selector ||= match[0];
    } else if (mod || key) {
      filtered = true;
      textValue = Boolean(key && TEXT_FIELD.test(key) && !/^["']/.test(value));
    }
  }
  if (!textValue) rest.push(raw.slice(end));
  const residual = rest.join(' ').trim();
  const argsWithoutMode = mode ? [raw.slice(0, modeStart).trim(), raw.slice(modeEnd).trim()].filter(Boolean).join(' ') : raw;
  return {residual, selector, mode, argsWithoutMode, filtered, panelOnly: Boolean(filtered || mode || selector)};
}
