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
): string {
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
