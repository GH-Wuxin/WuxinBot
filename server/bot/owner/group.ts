// Owner-command handlers for /preset, /group, and /rate|/cooldown|/mode|/status.
// Behavior-preserving decomposition of server/bot/ownerCommands.ts.
import { readDb, updateDb, nowIso } from '../../store.js';
import { getGroup } from '../gate.js';
import { setBotPaused } from '../../health.js';
import { getGroupProfile, updateGroupProfile, clearGroupProfile, hasGroupProfileContent } from '../groupProfile.js';
import { sendForwardText } from '../reply.js';
import type { OwnerHandlerContext, OwnerCommandResult } from './types.js';

export async function ownerPresetHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const { event, sendMessage, parts, subCommand } = ctx;
  const presetName = subCommand || (parts[2] || '').toLowerCase();
  const presets = {
    class: { mode: 'silent', maxPerHour: 0, cooldownSec: 300, onlyMentionMode: true, groupProfileAutoUpdate: false, globalPaused: false, label: '上课/会议：完全静默，不回复' },
    away: { mode: 'silent', maxPerHour: 3, cooldownSec: 120, onlyMentionMode: true, groupProfileAutoUpdate: false, globalPaused: false, label: '出门/忙：极少回复，只在@时可能回' },
    sleep: { mode: 'silent', maxPerHour: 0, cooldownSec: 600, onlyMentionMode: true, groupProfileAutoUpdate: false, globalPaused: true, label: '睡觉：全局暂停' },
    active: { mode: 'natural', maxPerHour: 30, cooldownSec: 15, onlyMentionMode: false, groupProfileAutoUpdate: true, globalPaused: false, label: '活跃聊天：自然参与，自动画像' },
    silent: { mode: 'light', maxPerHour: 10, cooldownSec: 60, onlyMentionMode: false, groupProfileAutoUpdate: true, globalPaused: false, label: '安静挂机：轻度参与，保持画像更新' },
    debug: { mode: 'mention', maxPerHour: 60, cooldownSec: 5, onlyMentionMode: false, groupProfileAutoUpdate: true, globalPaused: false, label: '调试：高频回复，只在@模式' },
  };
  const preset = presets[presetName];
  if (!preset) {
    const list = Object.entries(presets).map(([k, v]) => `/w preset ${k} — ${v.label}`).join('\n');
    const reply = `可用预设：\n${list}`;
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), reason: reply };
  }
  const db = readDb();
  const group = getGroup(db, event.groupId);
  const oldMode = group?.mode || 'mention';
  const oldRate = group?.maxPerHour || 20;
  const oldCooldown = group?.cooldownSec || 30;
  updateDb((draft) => {
    const g = draft.groups.find((entry) => String(entry.groupId) === String(event.groupId));
    if (g) {
      g.mode = preset.mode;
      g.maxPerHour = preset.maxPerHour;
      g.cooldownSec = preset.cooldownSec;
      g.updatedAt = nowIso();
    }
    draft.settings.onlyMentionMode = preset.onlyMentionMode;
    draft.settings.groupProfileAutoUpdate = preset.groupProfileAutoUpdate !== false;
    draft.settings.globalPaused = preset.globalPaused;
    setBotPaused(preset.globalPaused);
  });
  const reply = `已切换为「${preset.label}」\n回复模式：${oldMode} → ${preset.mode}\n每小时上限：${oldRate} → ${preset.maxPerHour}\n冷却：${oldCooldown} → ${preset.cooldownSec} 秒`;
  if (sendMessage) await sendMessage(event, reply);
  return { replied: Boolean(sendMessage), reason: `预设：${presetName}` };
}

export async function ownerGroupHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const { event, sendMessage, parts, subCommand } = ctx;
  // /w group profile show/update/clear/on/off
  if (subCommand === 'profile') {
    const profileAction = (parts[3] || '').toLowerCase();
    const db = readDb();
    if (profileAction === 'show') {
      const gp = getGroupProfile(db, event.groupId);
      if (!gp) { const reply = '这个群还没有群聊画像。用 /w group profile update 生成。'; if (sendMessage) await sendMessage(event, reply); return { replied: Boolean(sendMessage), reason: reply }; }
      if (!hasGroupProfileContent(gp)) {
        const pending = Number(gp.pendingMessageCount || 0);
        const failed = gp.lastUpdateStatus === 'failed' && gp.lastUpdateError ? `\n上次自动更新失败：${gp.lastUpdateError}` : '';
        const reply = `这个群还没有有效群聊画像。已累计 ${pending} 条候选消息，可以用 /w group profile update 手动生成。${failed}`;
        if (sendMessage) await sendMessage(event, reply);
        return { replied: Boolean(sendMessage), reason: reply };
      }
      const text = `启用：${gp.enabled ? '是' : '否'}\n氛围：${gp.atmosphere || '无'}\n话题：${gp.topics || '无'}\n玩笑：${gp.humorStyle || '无'}\n节奏：${gp.pace || '无'}\n边界：${gp.boundaries || '无'}\n策略：${gp.botStrategy || '无'}\n置信：${Math.round(gp.confidence * 100)}% · ${gp.evidenceCount}条依据\n更新：${gp.updatedAt ? new Date(gp.updatedAt).toLocaleString('zh-CN') : '未知'}`;
      if (sendMessage) await sendForwardText(sendMessage, event, '群聊画像', text);
      return { replied: Boolean(sendMessage), reason: '显示群聊画像' };
    }
    if (profileAction === 'update') {
      if (sendMessage) await sendMessage(event, '正在生成群聊画像…');
      try {
        const result = await updateGroupProfile(db, event.groupId);
        if (!result.ok) { const reply = `群聊画像生成失败：${result.error}`; if (sendMessage) await sendMessage(event, reply); return { replied: Boolean(sendMessage), error: result.error, reason: reply }; }
        if (sendMessage) await sendMessage(event, `群聊画像已更新（${result.sampleCount}条消息）。用 /w group profile show 查看。`);
        return { replied: Boolean(sendMessage), reason: '群聊画像已更新' };
      } catch (error) {
        const reply = `群聊画像更新失败：${error.message}`;
        if (sendMessage) await sendMessage(event, reply);
        return { replied: Boolean(sendMessage), error: error.message, reason: reply };
      }
    }
    if (profileAction === 'clear') {
      clearGroupProfile(event.groupId);
      const reply = '已清除本群的群聊画像。';
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }
    if (profileAction === 'on' || profileAction === 'off') {
      updateDb((draft) => {
        if (!draft.groupProfiles) draft.groupProfiles = [];
        const gp = draft.groupProfiles.find((p) => String(p.groupId) === String(event.groupId));
        if (gp) gp.enabled = profileAction === 'on';
      });
      const reply = profileAction === 'on' ? '已启用群聊画像注入。' : '已停用群聊画像注入。';
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }
    const reply = '用法：/w group profile show|update|clear|on|off';
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), reason: reply };
  }

  if (subCommand !== 'add') {
    const reply = '用法：/w group add [群名] 或 /w group profile show|update|clear|on|off';
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), reason: reply };
  }

  if (event.type !== 'group' || !event.groupId || event.groupId === 'private') {
    const reply = '这个指令只能在目标群聊里使用：/wuxin group add [群名]。';
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), reason: reply };
  }

  const groupName = parts.slice(3).join(' ').trim() || event.raw?.group_name || event.groupName || `群聊 ${event.groupId}`;
  updateDb((draft) => {
    const existing = draft.groups.find((entry) => String(entry.groupId) === String(event.groupId));
    if (existing) {
      existing.name = groupName || existing.name || event.groupId;
      existing.enabled = true;
      existing.updatedAt = nowIso();
    } else {
      draft.groups.push({
        groupId: String(event.groupId),
        name: groupName,
        enabled: true,
        mode: 'mention',
        maxPerHour: 20,
        cooldownSec: 30,
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
    }
    draft.adminActions.push({
      id: crypto.randomUUID(),
      operatorUserId: event.userId,
      action: '/wuxin group add',
      targetUserId: 'group',
      groupId: event.groupId,
      detail: `添加/启用活跃群聊：${groupName}`,
      createdAt: nowIso()
    });
  });

  const reply = `已将本群加入活跃群聊：${groupName}（${event.groupId}）。默认只在 @ 时回复，可用 /w mode natural 调整。`;
  if (sendMessage) await sendMessage(event, reply);
  return { replied: Boolean(sendMessage), reason: reply };
}

export async function ownerGroupSettingsHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const { event, sendMessage, parts, command } = ctx;

  const db = readDb();
  const currentGroup = getGroup(db, event.groupId);
  if (!currentGroup) {
    const reply = '这个群还没有添加到白名单配置里。';
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), reason: reply };
  }

  if (command === '/status') {
    const modeName = {
      silent: '静默',
      mention: '只在 @ 时回复',
      light: '轻度参与',
      natural: '自然群友'
    }[currentGroup.mode] || currentGroup.mode;
    const reply = `本群参数：
模式：${modeName}
每小时最多回复：${currentGroup.maxPerHour}
发言冷却：${currentGroup.cooldownSec} 秒`;
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), reason: '显示群运行参数' };
  }

  let reply = '';
  updateDb((draft) => {
    const group = draft.groups.find((entry) => String(entry.groupId) === String(event.groupId));
    if (!group) return;

    if (command === '/rate') {
      const value = Number(parts[2]);
      if (!Number.isFinite(value) || value < 1 || value > 200) {
        reply = '用法：/wuxin rate 20。范围 1 到 200。';
        return;
      }
      group.maxPerHour = Math.round(value);
      reply = `已设置本群每小时最多回复 ${group.maxPerHour} 次。`;
    }

    if (command === '/cooldown') {
      const value = Number(parts[2]);
      if (!Number.isFinite(value) || value < 0 || value > 600) {
        reply = '用法：/wuxin cooldown 30。范围 0 到 600 秒。';
        return;
      }
      group.cooldownSec = Math.round(value);
      reply = `已设置本群发言冷却 ${group.cooldownSec} 秒。`;
    }

    if (command === '/mode') {
      const value = String(parts[2] || '').toLowerCase();
      const allowed = ['silent', 'mention', 'light', 'natural'];
      if (!allowed.includes(value)) {
        reply = '用法：/wuxin mode silent|mention|light|natural。';
        return;
      }
      group.mode = value;
      reply = `已设置本群回复模式为 ${value}。`;
    }

    group.updatedAt = nowIso();
    draft.adminActions.push({
      id: crypto.randomUUID(),
      operatorUserId: event.userId,
      action: `/wuxin ${command.slice(1)}`,
      targetUserId: 'group',
      groupId: event.groupId,
      detail: reply,
      createdAt: nowIso()
    });
  });

  if (sendMessage) await sendMessage(event, reply || '设置失败，请检查指令格式。');
  return { replied: Boolean(sendMessage), reason: reply || '群运行参数设置失败' };
}
