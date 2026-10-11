/**
 * Small pure seams for the final sticker branch. Keeping these decisions
 * separate makes the two "image-only must not go silent" cases testable
 * without starting the bot or contacting OneBot.
 */
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
