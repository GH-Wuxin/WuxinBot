// Quick-command context memory.
//
// Quick commands (`!re` / `!p` / `~` / ...) bypass the normal LLM pipeline and
// never reach `db.messages`, so pippi cannot later "see" what was queried and
// by whom. This module records the user message plus a compact factual summary
// into the conversation context (`inContext: true`) ONLY. It never writes to
// the long-term memory/profile store.
import crypto from 'node:crypto';
import { updateDb, nowIso } from '../store.js';
import { textWithoutControlPlaceholders } from './cleaning.js';
import {
  getUser,
  getUserById,
  getUserBestScores,
  getUserRecentScores,
} from '../osu/api.js';
import {
  formatInternalScoreLine,
  formatInternalProfileText,
  type BpQuerySelection,
} from '../bots/executor.js';
import { getPlayerBars } from '../osu/pplus.js';

const SUMMARY_LIMIT = 400;
const ASSISTANT_IMAGES_LIMIT = 4;

/**
 * Write the quick command's user message and assistant result into the group
 * conversation context. Deduplicated by the OneBot message id.
 */
export function recordQuickContext(
  event: any,
  content: string,
  images: string[] = [],
): void {
  try {
    const createdAt = nowIso();
    const messageId = String(event?.messageId || '');
    const cleanContent = textWithoutControlPlaceholders(
      String(content || '').trim(),
    ).slice(0, SUMMARY_LIMIT);
    updateDb((draft) => {
      if (!Array.isArray(draft.messages)) draft.messages = [];
      const alreadyRecorded = Boolean(
        messageId &&
        draft.messages.some(
          (m: any) => m.role === 'user' && m.messageId === messageId,
        ),
      );
      if (alreadyRecorded) return;

      draft.messages.push({
        id: crypto.randomUUID(),
        role: 'user',
        type: event.type,
        groupId: event.groupId,
        userId: String(event.userId || ''),
        nickname: event.nickname || String(event.userId || ''),
        content: String(event.text || '').slice(0, 600),
        messageId,
        inContext: true,
        createdAt,
      });

      if (cleanContent || images.length > 0) {
        draft.messages.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          type: event.type,
          groupId: event.groupId,
          userId: 'bot',
          nickname: '机器人',
          content: cleanContent,
          media:
            images.length > 0
              ? { images: images.slice(0, ASSISTANT_IMAGES_LIMIT) }
              : undefined,
          inContext: true,
          createdAt,
        });
      }
    });
  } catch (error: any) {
    console.error('[quickMemory] 记录快捷指令上下文失败:', error?.message || error);
  }
}

/**
 * Re-fetch a compact factual summary for a bridged command whose original bot
 * only returned a rendered image. Used purely for context memory; the result
 * is never sent to the group and never goes through the LLM at query time.
 */
export async function buildQuickShadowSummary(
  capability: string | undefined,
  username: string,
  bpSelection?: BpQuerySelection,
): Promise<string> {
  const cap = String(capability || '').trim();
  const name = String(username || '').trim();
  if (!cap || !name) return '';
  try {
    const user = /^\d+$/.test(name)
      ? await getUserById(Number(name))
      : await getUser(name);
    if (!user?.id) return '';

    switch (cap) {
      case 'recent': {
        const scores = await getUserRecentScores(user.id, 'osu', 1);
        if (!Array.isArray(scores) || scores.length === 0) {
          return `${user.username} 最近没有 osu! 成绩记录`;
        }
        return `${user.username} 的最近成绩：${formatInternalScoreLine(
          scores[0],
          { includeCombo: true },
        )}`;
      }
      case 'bp':
      case 'bplist': {
        const scores = await getUserBestScores(user.id, 'osu', 100);
        if (!Array.isArray(scores) || scores.length === 0) {
          return `${user.username} 没有 BP 记录`;
        }
        let candidates = scores;
        if (bpSelection?.startRank) {
          candidates = scores.slice(
            bpSelection.startRank - 1,
            bpSelection.endRank || bpSelection.startRank,
          );
        }
        const lines = candidates
          .slice(0, 5)
          .map((score) => formatInternalScoreLine(score, { includeCombo: true }));
        return `${user.username} 的 BP：${lines.join('；')}`;
      }
      case 'info':
      case 'profile':
      case 'card':
        return formatInternalProfileText(user);
      case 'pplus': {
        const bars = await getPlayerBars(user.id);
        if (!bars) return `${user.username} 的 PP+ 数据暂不可用`;
        return `${user.username} 的 PP+（${bars.ppTotal}pp）：Jump ${bars.jump.toFixed(2)}、Flow ${bars.flow.toFixed(2)}、Speed ${bars.speed.toFixed(2)}、Stamina ${bars.stamina.toFixed(2)}、Precision ${bars.precision.toFixed(2)}、Accuracy ${bars.accuracy.toFixed(2)}`;
      }
      default:
        return '';
    }
  } catch (error: any) {
    console.error(
      `[quickMemory] 影子查询失败 (${cap}/${name}):`,
      error?.message || error,
    );
    return '';
  }
}
