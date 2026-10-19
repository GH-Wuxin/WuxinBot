/**
 * Small pure seams for the final sticker branch. Keeping these decisions
 * separate makes the two "image-only must not go silent" cases testable
 * without starting the bot or contacting OneBot.
 */
/**
 * 图片没能交付时要补发给用户的话。
 *
 * 只有在模型自报「用户明确要图」（sticker_use=requested）时才补 —— 她自己想加
 * 一张反应图失败，不该反过来打扰用户。旧格式信封没有这个字段，按 reaction 处理，
 * 因此不会被补通知，也不会被算进「失败不复用完成话术」的保障范围。
 */
export const STICKER_FAILURE_NOTICE = {
  /** 明确要图，但没有可交付的图片 */
  missing: '这张没发出去',
  /** 正文已经单独发过了，只有配图失败 */
  captionOnly: '表情那张没发出去',
} as const;

/** 把闸门拒绝原因翻译成模型能读懂的一句话。 */
export function stickerFailureReasonText(reason: string): string {
  switch (String(reason || '')) {
    case 'cooldown': return '群里刚刚发过表情包，还在冷却时间里';
    case 'user_cooldown': return '刚刚给这个用户发过表情包';
    case 'duplicate': return '这张表情包最近已经发过一次了';
    case 'hourly_limit': return '这个群这一小时的表情包次数用完了';
    case 'daily_limit': return '这个群今天的表情包次数用完了';
    case 'user_daily_limit': return '这个用户今天收到的表情包已经够多了';
    case 'duplicate_turn': return '这一轮已经给过图了';
    case 'unknown_sticker': return '想发的那张表情包不在图库里';
    case 'group': return '这个群没有开启表情包发送';
    case 'private': return '私聊里不能发表情包';
    case 'mode': return '当前状态不允许发表情包';
    default: return '表情包这一刻没能发出去';
  }
}

/**
 * 表情包没发出去时，让模型自己重写这句话，而不是由投递层补一句生硬的系统提示。
 * 返回 null 表示原文可以直接复用（正文里没有依赖图片的承诺）。
 */
export function stickerFailureInstruction(originalReply: string, reason: string): { system: string; user: string } {
  const reasonText = stickerFailureReasonText(reason);
  const original = String(originalReply || '').trim();
  const system = [
    '你在 QQ 群里扮演「Pippi」，说话短、口语、不像客服。',
    '刚才你打算附带一张表情包，但它没有发出去。用户可能点名要过图。',
    '现在请用你自己的语气重写要发出去的那句话：不要提「系统」「接口」「投递」「限制」这些词，',
    '不要生硬道歉，不要编造图片内容，也不要假装已经发出去了。',
    '如果只是自己顺手配图失败，可以完全不提，把原话顺一下就行。',
    '只输出要发给用户的那句话，不要 JSON、不要解释，20 字以内优先。',
  ].join('');
  const user = [
    `失败原因：${reasonText}`,
    original ? `原话：${original}` : '原话：（空，你本来只打算发图）',
  ].join('\n');
  return { system, user };
}

export function stickerFailureNotice(input: {
  /** 模型自报：用户是否明确要求发图 */
  explicitRequest: boolean;
  /** 正文是否已经作为独立消息发出 */
  bodyDelivered: boolean;
}): string {
  if (!input.explicitRequest) return '';
  return input.bodyDelivered ? STICKER_FAILURE_NOTICE.captionOnly : STICKER_FAILURE_NOTICE.missing;
}

export function ensureStickerReplyFallback(
  replyText: string,
  stickerCqCode: string,
  options: { deferToNotice?: boolean } = {},
): string {
  // 明确要图时，空正文留给收尾去说 —— 只有那里知道图片到底送没送到，
  // 说的也是「这张没发出去」而不是一句「收到。」。在这里先占位的话，
  // 图失败时会出现「收到。」和「这张没发出去」两句叠在一起。
  // 调用方必须保证 defer 之后仍有内容可发（见 bot.ts 里没选到图的那一支）。
  if (options.deferToNotice) return replyText;
  return !String(replyText || '').trim() && !String(stickerCqCode || '').trim()
    ? '收到。'
    : replyText;
}

export function stickerFailureFallback(input: {
  deliveredText: string;
  confirmedFailure: boolean;
  isLongReply: boolean;
}): string | null {
  if (!input.confirmedFailure || input.isLongReply) return null;
  return String(input.deliveredText || '').trim() || '收到。';
}
