// Reply output: sanitization, segmentation, merged-forward, rewrite guard.
// Extracted from bot.ts.
import { completeChat } from './llm.js';

export function sanitizeReply(text, settings) {
  let cleaned = String(text || '').trim();
  const names = [
    '机器人',
    'bot',
    'Bot',
    'AI',
    ...String(settings.botNames || '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
  ];

  for (let i = 0; i < 3; i += 1) {
    const before = cleaned;
    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      cleaned = cleaned.replace(new RegExp(`^\\s*${escaped}\\s*[:：,，]\\s*`, 'i'), '');
    }
    cleaned = cleaned.replace(/^\s*(助手|群友|AI群友)\s*[:：,，]\s*/i, '');
    if (cleaned === before) break;
  }

  return cleaned.trim();
}

export function splitReplySegments(text) {
  const cleaned = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');

  if (!cleaned) return [];
  if (cleaned.length <= 34 && !cleaned.includes('\n')) return [cleaned];

  const rawParts = cleaned
    .split(/\n+|(?<=[。！？!?])\s+|(?<=[。！？!?])/)
    .map((part) => part.trim())
    .filter(Boolean);

  const parts = rawParts.length > 1 ? rawParts : cleaned
    .split(/(?<=[，,；;])\s*/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length <= 1) return [cleaned];

  const segments = [];
  for (const part of parts) {
    const last = segments[segments.length - 1] || '';
    if (!last || last.length + part.length > 42 || segments.length >= 3) {
      segments.push(part);
    } else {
      segments[segments.length - 1] = `${last}${part}`;
    }
  }

  if (segments.length <= 3) return segments;
  return [
    segments[0],
    segments[1],
    segments.slice(2).join('')
  ].filter(Boolean);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendReplySegments(sendMessage, event, replyText) {
  const segments = splitReplySegments(replyText).slice(0, 3);
  if (!sendMessage) return segments;
  for (let index = 0; index < segments.length; index += 1) {
    await sendMessage(event, segments[index]);
    if (index < segments.length - 1) await wait(700 + Math.floor(Math.random() * 600));
  }
  return segments;
}

export function isWeirdReply(text) {
  const value = String(text || '');
  const patterns = [
    /（[^）]{0,30}(伸手|要钱|阴暗|爬行|哭|怒|摊手|狗头|心虚|无奈|委屈|浮出|画圈|歪头)[^）]{0,30}）/,
    /\([^)]{0,30}(伸手|要钱|阴暗|爬行|哭|怒|摊手|狗头|心虚|无奈|委屈|浮出|画圈|歪头)[^)]{0,30}\)/i,
    /群主|大人|主人|老板|小的|遵命|鄙人|您老|大驾光临/,
    /系统\s*owner|\bowner\b|后台|写死|配置|规则里写|源代码|内部推理逻辑|训练细节|参数规模/,
    /收费|收钱|打钱|给钱|我要钱|伸手要钱/,
    /被淹没|爬出来|阴暗地|浮出水面|急了|破防/,
    /别骂|别在群里|不满意|我改|启动语气|没事爱唠嗑|主要工作是接梗/,
    /又自我介绍|行吧|哎哟|啧|咳[，,]/,
    // Identity self-negation: bot denying it was @mentioned
    /(没有|没)回应.*(at|@).*(不是|不).*(自己|我)/,
    /(at|@).*(不是|不).*(自己|我|本)/,
    /刚才.*(at|@).*(不是|错)/,
    /你.*(at|@).*(别人|其他)/,
    /我.*(不该|不应该|不能).*(回复|回应|说话|插话)/,
  ];
  const manyParentheses = (value.match(/[（(]/g) || []).length >= 2;
  const tooLong = value.length > 180;
  return tooLong || manyParentheses || patterns.some((pattern) => pattern.test(value));
}

export async function rewriteNormalReply(db, originalText, event) {
  const response = await completeChat(db, {
    model: db.settings.model || 'deepseek-v4-flash',
    messages: [
      {
        role: 'system',
        content: `把下面这句 QQ 群聊回复改写成正常、克制、自然的群友语气。
要求：
- 只输出改写后的回复
- 1 到 2 句
- 不要括号表演、颜文字、要钱、装委屈、阴阳怪气
- 不要喊群主、大人、主人、老板
- 不要提"系统、后台、写死、配置、规则里写着、owner"等实现细节；问到源代码或内部推理逻辑时，改成"这个需要后台操作者自己决定是否分享"
- 如果对方是 owner，也只是更稳重一点，不要谄媚
- 保留大意即可`
      },
      {
        role: 'user',
        content: `当前发言者：${event.nickname || event.userId}（QQ:${event.userId}）
原回复：${originalText}`
      }
    ],
    temperature: 0.25,
    maxTokens: 180,
    label: '回复改写'
  });
  return {
    text: response.text || originalText,
    usage: response.usage || {}
  };
}

export function visualLimitationReply(event) {
  if (event.text.includes('[表情') || event.text.includes('[图片]')) {
    return '我现在只能读文字，看不到图片或表情包的具体内容。你可以简单描述一下，我再接着聊。';
  }
  return '我现在看不了这类内容，只能处理文字消息。你描述一下内容，我可以继续接。';
}

export async function sendForwardText(sendMessage, event, title, text) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if (line.length > 260) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let index = 0; index < line.length; index += 260) {
        chunks.push(line.slice(index, index + 260));
      }
      continue;
    }

    const next = current ? `${current}\n${line}` : line;
    if (next.length > 260 && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);

  const nodes = chunks.map((content, index) => ({
    type: 'node',
    data: {
      name: index === 0 ? title : `${title} ${index + 1}`,
      uin: event.raw?.self_id || '',
      content
    }
  }));

  if (!sendMessage) return false;
  await sendMessage(event, title, { forwardNodes: nodes });
  return true;
}
