import { runBackgroundTask } from '../backgroundTasks.js';
import { finishRecalc, getRecalcProgress, startRecalc, tickRecalc } from '../health.js';
import { readDb } from '../store.js';
import { updateGroupProfile } from './groupProfile.js';
import { maybeUpdateMemoryProfile } from './memory.js';
import { updateRelationshipProfile } from './relationshipProfile.js';

/** Claim the singleton synchronously, before either entry point replies. */
export function startProfileRecalculation(event?: any) {
  if (getRecalcProgress().running) return null;
  const db = readDb();
  const memories = db.memories.filter(m => m.enabled && (m.samples || []).filter(s => s.usedForProfile).length >= 3);
  const groups = db.groups.filter(g => g.enabled);
  const relationships = db.relationshipProfiles.filter(r => r.enabled !== false);
  const total = memories.length + groups.length + relationships.length;
  const prefix = event ? 'QQ端' : '';
  startRecalc(total, event ? 'QQ端重算' : '正在重算全部画像');
  void runBackgroundTask(event ? 'recalc.qq' : 'recalc.api', async () => {
    let failed = 0;
    let succeeded = 0;
    let label = '';
    async function processItems<T>(items: T[], run: (item: T) => Promise<{ ok?: boolean; skipped?: boolean; error?: string }>) {
      for (const item of items) {
        if (getRecalcProgress().stopped) break;
        try {
          const result = await run(item);
          if (result?.ok === false && !result.skipped) throw new Error(result.error || '画像更新失败');
          if (!result?.skipped) succeeded++;
        } catch (error) {
          failed++;
          console.error('[recalc]', String(error?.message || error).slice(0, 200));
        } finally {
          tickRecalc();
        }
      }
    }
    try {
      await processItems(memories, (mem: any) => maybeUpdateMemoryProfile({
        ...(event || { type: 'private', groupId: '' }), userId: String(mem.userId), nickname: mem.nickname || String(mem.userId),
        messageId: event ? `${event.messageId || 'memory-recalc'}:${mem.userId}` : `memory-recalc:${mem.userId}:${Date.now()}`,
      }, { force: true, kind: 'memory-recalc' }));
      await processItems(groups, (group: any) => updateGroupProfile(readDb(), group.groupId));
      await processItems(relationships, (pair: any) => updateRelationshipProfile(readDb(), pair.groupId, pair.userA, pair.userB));
      label = failed ? `重算完成：成功 ${succeeded}/${total}，失败 ${failed}` : '全部重算完成';
    } catch (error) {
      label = '重算失败：' + String(error?.message || error).slice(0, 300);
    } finally {
      finishRecalc(prefix + (getRecalcProgress().stopped ? '已停止' : label));
    }
  });
  return { memories: memories.length, groups: groups.length, relationships: relationships.length };
}
