/**
 * QQ → 名字的目录。
 *
 * 消息里 @ 段只带 QQ 号，光看号码分不出谁是谁，更分不出哪个是她自己。AstrBot 的
 * 做法是遇到 @ 就查一次接口把名字补上（astrbot/core/platform/sources/aiocqhttp/
 * aiocqhttp_platform_adapter.py），这里照搬，包括它的两级回退：
 *
 *   1. get_group_member_info → card（群名片）
 *   2. 群名片为空时再查 get_stranger_info → nick / nickname（QQ 昵称）
 *
 * 两个细节也照搬：
 *
 *   - 用 OneBot 自己的缓存（不额外传 no_cache），它比我们这边的缓存更准；
 *   - 查不到不抛错，退回空名字，渲染时保持原来的样子。
 *
 * 另外这里额外保留了 QQ 昵称：群名片为空才回退，但两个都存下来，调用方想同时
 * 显示两种称呼时有得用。这一步 AstrBot 没做，是我们多要的。
 */
import { callOneBotAction } from '../onebot.js';

export interface MemberNames {
  qq: string;
  /** 群名片。可能为空。 */
  card: string;
  /** QQ 昵称。可能为空。 */
  nickname: string;
}

/** 渲染用：优先群名片，其次 QQ 昵称，都没有就退回号码。 */
export function displayName(names: MemberNames | undefined, qq: string): string {
  const card = String(names?.card || '').trim();
  if (card) return card;
  const nickname = String(names?.nickname || '').trim();
  if (nickname) return nickname;
  return String(qq || '').trim();
}

/**
 * 解析一批 QQ 的名字。
 *
 * 逐个查询而不是拉全群列表：全群列表在大群里是几百条，而一条消息里的 @ 通常
 * 只有一两个。拿不到的条目直接不出现在结果里，调用方按 undefined 处理。
 */
export async function resolveMemberNames(
  db: any,
  groupId: string,
  qqs: readonly string[],
): Promise<Map<string, MemberNames>> {
  const result = new Map<string, MemberNames>();
  const group = String(groupId || '').trim();
  const wanted = [...new Set((qqs || []).map((qq) => String(qq || '').trim()).filter(Boolean))];
  if (!group || !wanted.length) return result;
  const selfQq = String(db?.settings?.selfQq || '').trim();

  for (const qq of wanted) {
    // 她自己的名字不用查。
    if (selfQq && qq === selfQq) continue;
    let member = await callOneBotAction(db, 'get_group_member_info', {
      group_id: Number(group),
      user_id: Number(qq),
    });
    let card = String(member?.card || '').trim();
    let nickname = String(member?.nickname || '').trim();
    if (!card) {
      // 群名片为空：可能是没设群名片，也可能根本不是群成员。再查一次陌生人资料。
      const stranger = await callOneBotAction(db, 'get_stranger_info', { user_id: Number(qq) });
      nickname = String(stranger?.nick || stranger?.nickname || nickname || '').trim();
    }
    if (card || nickname) result.set(qq, { qq, card, nickname });
  }
  return result;
}

/** 从文本里挑出所有 @ 的 QQ 号，用于决定要解析谁。 */
export function collectMentionedQqs(texts: readonly (string | undefined)[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    const raw = String(text || '');
    let index = 0;
    while (index >= 0) {
      const start = raw.indexOf('[CQ:at,qq=', index);
      if (start < 0) break;
      const from = start + '[CQ:at,qq='.length;
      const end = raw.indexOf(']', from);
      if (end < 0) break;
      const qq = raw.slice(from, end).split(',')[0].trim();
      if (qq && qq !== 'all') found.add(qq);
      index = end;
    }
  }
  return [...found];
}
