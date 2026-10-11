import { pathToFileURL } from 'node:url';
import { readDb } from '../server/store.ts';
import { sendOneBotMessage } from '../server/onebot.ts';
import {
  completeStickerDelivery,
  reserveStickerDelivery,
} from '../server/bot/stickers/delivery.ts';

if (process.env.WUXIN_STICKER_LIVE_AUTHORIZED !== '1') {
  console.error('拒绝执行真实贴纸发送：请显式设置 WUXIN_STICKER_LIVE_AUTHORIZED=1');
  process.exitCode = 2;
} else {
process.env.WUXIN_STICKER_DELIVERY_MODE = 'live';
process.env.WUXIN_STICKER_LIVE_GROUP_IDS = '1083681153';

const reservation = reserveStickerDelivery({
  eventType: 'group',
  groupId: '1083681153',
  userId: 'sticker-live-smoke-test',
  messageId: `sticker-live-smoke-${Date.now()}`,
  stickerId: 'hello',
});
if (!reservation.ok || !reservation.path) {
  console.log(JSON.stringify({ ok: false, stage: 'delivery_gate', reason: reservation.reason }));
  process.exitCode = 1;
} else {
  const event = {
    source: 'onebot',
    type: 'group',
    groupId: '1083681153',
    userId: '0',
    nickname: 'sticker-live-smoke-test',
    messageId: `sticker-live-smoke-${Date.now()}`,
    text: '',
    atTargets: [],
  };
  const cq = `[CQ:image,file=${pathToFileURL(reservation.path).href}]`;
  try {
    const result = await sendOneBotMessage(event, cq, { mentionSender: false });
    const outcome = ['confirmed_success', 'accepted_unknown', 'confirmed_failure', 'unknown']
      .includes(result?.outcome) ? result.outcome : 'unknown';
    completeStickerDelivery(reservation.reservationId, outcome);
    console.log(JSON.stringify({
      ok: true,
      stage: 'onebot_send',
      groupId: event.groupId,
      stickerId: reservation.stickerId,
      outcome,
      accountingFinalized: true,
    }));
  } catch (error) {
    const outcome = ['confirmed_failure', 'unknown'].includes(error?.deliveryOutcome)
      ? error.deliveryOutcome
      : 'unknown';
    completeStickerDelivery(reservation.reservationId, outcome);
    console.log(JSON.stringify({
      ok: false,
      stage: 'onebot_send',
      stickerId: reservation.stickerId,
      outcome,
      accountingFinalized: true,
      error: String(error?.message || error).slice(0, 500),
    }));
    process.exitCode = 1;
  }
}
}

