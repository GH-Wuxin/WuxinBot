// Behavior-preserving decomposition of server/bot/ownerCommands.ts.
// Handlers for /note, /profile, and /relation; command-level permission checks
// are enforced by the owner-command dispatch before these handlers run.
import { readDb, updateDb, nowIso } from '../../store.js';
import {
  getRelationshipProfile,
  updateRelationshipProfile,
  clearRelationshipProfile
} from '../relationshipProfile.js';
import { maybeUpdateMemoryProfile } from '../memory.js';
import { sendForwardText } from '../reply.js';
import type { OwnerHandlerContext, OwnerCommandResult } from './types.js';

export async function ownerNoteHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const event = ctx.event;
  const sendMessage = ctx.sendMessage;
  const permissions = ctx.permissions;
  const parts = ctx.parts;
  const subCommand = ctx.subCommand;
  const commandArgs = ctx.commandArgs;
  const commandDb = ctx.commandDb;

  const action = (parts[2] || '').toLowerCase();
  const noteTarget = (event.atTargets && event.atTargets[0]) || (action === 'show' || action === 'clear' ? parts[3] : parts[2]);
  const noteText = action === 'show' || action === 'clear'
    ? parts.slice(4).join(' ').trim()
    : parts.slice(3).join(' ').trim();

  if (!noteTarget) {
    const reply = '用法：/wuxin note @某人 内容，/wuxin note show @某人，/wuxin note clear @某人';
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), reason: reply };
  }

  if (action === 'show') {
    const db = readDb();
    const user = db.users.find((entry) => String(entry.groupId) === String(event.groupId) && String(entry.userId) === String(noteTarget));
    const reply = user?.note ? `${noteTarget} 的备注：${user.note}` : `${noteTarget} 还没有备注。`;
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), reason: reply };
  }

  const nextNote = action === 'clear' ? '' : noteText;
  if (action !== 'clear' && !nextNote) {
    const reply = '备注内容不能为空。用法：/wuxin note @某人 内容';
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), reason: reply };
  }

  updateDb((draft) => {
    const existingIndex = draft.users.findIndex(
      (user) => String(user.groupId) === String(event.groupId) && String(user.userId) === String(noteTarget)
    );
    if (existingIndex >= 0) {
      draft.users[existingIndex] = { ...draft.users[existingIndex], note: nextNote, updatedAt: nowIso() };
    } else {
      draft.users.push({
        id: crypto.randomUUID(),
        groupId: event.groupId,
        userId: noteTarget,
        nickname: noteTarget,
        policy: 'normal',
        attentionLevel: 3,
        allowCommands: false,
        note: nextNote,
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
    }
    draft.adminActions.push({
      id: crypto.randomUUID(),
      operatorUserId: event.userId,
      action: `/wuxin note ${action || 'set'}`,
      targetUserId: noteTarget,
      groupId: event.groupId,
      detail: nextNote || '清除备注',
      createdAt: nowIso()
    });
  });

  const reply = action === 'clear' ? `已清除 ${noteTarget} 的备注。` : `已给 ${noteTarget} 设置备注。`;
  if (sendMessage) await sendMessage(event, reply);
  return { replied: Boolean(sendMessage), reason: reply };
}

export async function ownerProfileHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const event = ctx.event;
  const sendMessage = ctx.sendMessage;
  const permissions = ctx.permissions;
  const parts = ctx.parts;
  const subCommand = ctx.subCommand;
  const commandArgs = ctx.commandArgs;
  const commandDb = ctx.commandDb;

  const action = subCommand || 'update';
  // /w profile show @某人 — view profile
  if (action === 'show') {
    const showTarget = (event.atTargets && event.atTargets[0]) || parts[3];
    if (!showTarget) {
      const reply = '用法：/w profile show @某人';
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }
    const db = readDb();
    const mem = (db.memories || []).find((m) => String(m.userId) === String(showTarget));
    if (!mem || (!mem.summary && !mem.traits && !mem.speechStyle && !mem.behavior && !mem.preferences)) {
      const reply = `${showTarget} 还没有画像数据。`;
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }
    const recentDynamics = (mem.recentDynamics || []).slice(-5).filter((d) => d.confidence >= 0.2);
    const dynamicsBlock = recentDynamics.length > 0 ? '\n—— 近期动态（可能临时）——\n' + recentDynamics.map((d) => `${d.topic}：${d.summary}（置信${Math.round(d.confidence * 100)}%）`).join('\n') : '';
    const profileText = [
      '—— 长期画像 ——',
      mem.summary && `整体：${mem.summary}`,
      mem.traits && `性格：${mem.traits}`,
      mem.speechStyle && `说话：${mem.speechStyle}`,
      mem.behavior && `行为：${mem.behavior}`,
      mem.preferences && `偏好：${mem.preferences}`,
      mem.manualNotes && `备注：${mem.manualNotes}`,
      dynamicsBlock,
      `\n发言数：${mem.profileMessageCount || 0} | 最近更新：${mem.lastProfiledAt ? new Date(mem.lastProfiledAt).toLocaleString('zh-CN') : '从未'}`
    ].filter(Boolean).join('\n');
    if (sendMessage) await sendForwardText(sendMessage, event, `${mem.nickname || showTarget} 的画像`, profileText);
    return { replied: Boolean(sendMessage), reason: `查看 ${showTarget} 画像` };
  }
  // /w profile samples @某人 — show profile evidence
  if (action === 'samples') {
    const samplesTarget = (event.atTargets && event.atTargets[0]) || parts[3];
    if (!samplesTarget) {
      const reply = '用法：/w profile samples @某人';
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }
    const db = readDb();
    const mem = (db.memories || []).find((m) => String(m.userId) === String(samplesTarget));
    if (!mem || !(mem.samples || []).length) {
      const reply = `${samplesTarget} 还没有发言样本。`;
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }
    const all = mem.samples || [];
    const usedNormal = all.filter((s) => s.usedForProfile && s.riskLevel === 'normal');
    const lowConf = all.filter((s) => s.riskLevel === 'low-confidence');
    const highRisk = all.filter((s) => s.riskLevel === 'high-risk');
    const cards = all.filter((s) => !s.usedForProfile && s.type === 'card');
    const otherExcluded = all.filter((s) => !s.usedForProfile && s.type !== 'card' && s.riskLevel === 'normal');

    const meta = mem.profileMeta || {};
    const metaLine = (field) => {
      const m = meta[field];
      if (!m || !m.confidence) return '';
      return ` ${Math.round(m.confidence * 100)}%`;
    };

    const lines = [
      `${mem.nickname || samplesTarget} 的画像依据`,
      `画像置信：整体${metaLine('traits')}${metaLine('speechStyle')}${metaLine('behavior')}${metaLine('preferences')}`,
      '',
    ];

    if (usedNormal.length > 0) {
      const withCtx = usedNormal.filter((s) => s.context && s.context.nearby && s.context.nearby.length > 0);
      const withoutCtx = usedNormal.filter((s) => !s.context || !s.context.nearby || s.context.nearby.length === 0);
      if (withCtx.length > 0) {
        lines.push(`—— 用于画像（${withCtx.length}条，带上下文）——`);
        for (const s of withCtx.slice(-10)) {
          const ctx = s.context;
          let ctxSummary = '';
          if (ctx.nearby && ctx.nearby.length > 0) {
            const last = ctx.nearby[ctx.nearby.length - 1];
            if (last && String(last.userId) !== String(samplesTarget)) {
              ctxSummary = `  ← 接「${(last.nickname || last.userId)}：${last.content.slice(0, 30)}」`;
            }
          }
          lines.push(`${s.content}${ctxSummary}`);
        }
        lines.push('');
      }
      if (withoutCtx.length > 0) {
        lines.push(`—— 旧版画像依据（${withoutCtx.length}条，无上下文，权重已降低。新数据积累后将覆盖）——`);
        for (const s of withoutCtx.slice(-6)) {
          lines.push(`${s.content}`);
        }
        lines.push('');
      }
    }

    if (lowConf.length > 0) {
      lines.push(`—— 低置信观察（${lowConf.length}条，保留但不写画像）——`);
      for (const s of lowConf.slice(-8)) {
        const ctx = s.context;
        let ctxSummary = s.reason;
        if (ctx && ctx.nearby && ctx.nearby.length > 0) {
          const prev = ctx.nearby[ctx.nearby.length - 1];
          if (prev && String(prev.userId) !== String(samplesTarget)) {
            ctxSummary += `，接「${prev.nickname || prev.userId}：${prev.content.slice(0, 30)}」`;
          }
        }
        lines.push(`${s.content}  [${ctxSummary}]`);
      }
      lines.push('');
    }

    if (highRisk.length > 0) {
      lines.push(`—— 高风险已降级（${highRisk.length}条，仅审计）——`);
      for (const s of highRisk.slice(-5)) {
        lines.push(`${s.content}  [${s.reason}]`);
      }
      lines.push('');
    }

    if (cards.length > 0 || otherExcluded.length > 0) {
      const totalBg = cards.length + otherExcluded.length;
      lines.push(`另有 ${totalBg} 条低权重/被排除样本（分享卡片、指令、过短文本等），不单独下结论。`);
    }

    if (sendMessage) await sendForwardText(sendMessage, event, `${mem.nickname || samplesTarget} 画像依据`, lines.join('\n'));
    return { replied: Boolean(sendMessage), reason: `显示 ${samplesTarget} 画像依据` };
  }
  // /w profile rule @某人 规则 — set profiling constraint
  if (action === 'rule') {
    const ruleTarget = (event.atTargets && event.atTargets[0]) || parts[3];
    const ruleText = parts.slice(4).join(' ').trim();
    if (!ruleTarget) {
      const reply = '用法：/w profile rule @某人 规则内容。例如：/w profile rule @某人 禁止使用负面词汇描述';
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }
    updateDb((draft) => {
      let mem = (draft.memories || []).find((m) => String(m.userId) === String(ruleTarget));
      if (!mem) {
        mem = {
          id: crypto.randomUUID(), userId: ruleTarget, nickname: ruleTarget,
          enabled: true, importanceLevel: 2, importanceLabel: '手动创建',
          messageCount: 0, profileMessageCount: 0, pendingCount: 0, groupsSeen: [],
          samples: [], summary: '', traits: '', speechStyle: '', behavior: '', preferences: '',
          manualNotes: '', profilingRule: '', createdAt: nowIso(), updatedAt: nowIso()
        };
        draft.memories.push(mem);
      }
      mem.profilingRule = ruleText || '';
      mem.updatedAt = nowIso();
    });
    const reply = ruleText
      ? `已设置 ${ruleTarget} 的画像约束：${ruleText}`
      : `已清除 ${ruleTarget} 的画像约束。`;
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), reason: reply };
  }
  // /w profile retry @某人 方向 — recalculate profile with guidance
  if (action === 'retry') {
    const retryTarget = (event.atTargets && event.atTargets[0]) || parts[3];
    const guidance = parts.slice(4).join(' ').trim();
    if (!retryTarget) { const reply = '用法：/w profile retry @某人 画像方向。例如：/w profile retry @某人 重点关注技术和游戏方面的表达'; if (sendMessage) await sendMessage(event, reply); return { replied: Boolean(sendMessage), reason: reply }; }
    const db = readDb();
    const mem = (db.memories || []).find((m) => String(m.userId) === String(retryTarget));
    if (!mem) { const reply = '还没有这个用户的记忆数据。'; if (sendMessage) await sendMessage(event, reply); return { replied: Boolean(sendMessage), reason: reply }; }
    if (sendMessage) await sendMessage(event, `正在按「${guidance || '默认方向'}」重算 ${mem.nickname || retryTarget} 的画像…`);
    try {
      const outcome = await maybeUpdateMemoryProfile({
        ...event,
        userId: String(retryTarget),
        nickname: mem.nickname || String(retryTarget),
        messageId: `${event.messageId || 'profile-retry'}:${retryTarget}`,
      }, {
        force: true,
        kind: 'memory-manual-retry',
        profilingRule: guidance || mem.profilingRule || '',
      });
      if (!outcome.ok) throw new Error(outcome.reason || outcome.error || '画像更新失败');
      if (sendMessage) await sendMessage(event, `${mem.nickname || retryTarget} 画像重算完成：${outcome.reason}`);
      return { replied: Boolean(sendMessage), reason: `定向重算 ${retryTarget} 画像` };
    } catch (error) {
      const reply = `重算失败：${error.message}`; if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), error: error.message, reason: reply };
    }
  }
  // /w profile clear @某人 — clear profile
  if (action === 'clear') {
    const clearTarget = (event.atTargets && event.atTargets[0]) || parts[3];
    if (!clearTarget) {
      const reply = '用法：/w profile clear @某人';
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }
    updateDb((draft) => {
      const mem = (draft.memories || []).find((m) => String(m.userId) === String(clearTarget));
      if (!mem) return;
      mem.summary = '';
      mem.traits = '';
      mem.speechStyle = '';
      mem.behavior = '';
      mem.preferences = '';
      mem.pendingCount = 0;
      mem.lastProfiledAt = '';
      mem.updatedAt = nowIso();
    });
    const reply = `已清除 ${clearTarget} 的画像数据。`;
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), reason: reply };
  }
  // /w profile @某人 — update profile (default)
  const targetUser = (event.atTargets && event.atTargets[0]) || parts[2];
  if (!targetUser) {
    const reply = '用法：/w profile @某人（更新）/ /w profile show @某人（查看）/ /w profile clear @某人（清除）';
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), reason: reply };
  }
  const db = readDb();
  let memory = (db.memories || []).find((m) => String(m.userId) === String(targetUser));
  if (!memory) {
    const reply = '还没有这个用户的记忆数据，等ta多说几句话后再试。';
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), reason: reply };
  }
  if (sendMessage) await sendMessage(event, `正在更新 ${memory.nickname || targetUser} 的画像…`);
  try {
    const outcome = await maybeUpdateMemoryProfile({
      ...event,
      userId: String(targetUser),
      nickname: memory.nickname || String(targetUser),
      messageId: `${event.messageId || 'profile-manual'}:${targetUser}`,
    }, { force: true, kind: 'memory-manual' });
    if (!outcome.ok) throw new Error(outcome.reason || outcome.error || '画像更新失败');
    if (sendMessage) await sendMessage(event, `${memory.nickname || targetUser} 画像更新完成：${outcome.reason}`);
    return { replied: Boolean(sendMessage), reason: `手动更新 ${targetUser} 画像` };
  } catch (error) {
    const reply = `画像更新失败：${error.message}`;
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), error: error.message, reason: reply };
  }
}

export async function ownerRelationHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const event = ctx.event;
  const sendMessage = ctx.sendMessage;
  const permissions = ctx.permissions;
  const parts = ctx.parts;
  const subCommand = ctx.subCommand;
  const commandArgs = ctx.commandArgs;
  const commandDb = ctx.commandDb;

  const relAction = subCommand || 'show';
  const targetA = (event.atTargets && event.atTargets[0]) || parts[3];
  const targetB = (event.atTargets && event.atTargets[1]) || parts[4];
  if (relAction === 'show') {
    const db = readDb();
    const rp = getRelationshipProfile(db, event.groupId, targetA, targetB);
    if (!rp) {
      const reply = '这两人还没有关系画像。用 /w relation update @A @B 生成。';
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }
    const text = `互动风格：${rp.interactionStyle || '无'}\n共同话题：${rp.commonTopics || '无'}\n语气：${rp.tone || '无'}\nbot策略：${rp.botStrategy || '无'}\n边界：${rp.boundaries || '无'}\n置信：${Math.round((rp.confidence || 0) * 100)}% · ${rp.evidenceCount || 0}条互动`;
    if (sendMessage) await sendForwardText(sendMessage, event, '群友关系画像', text);
    return { replied: Boolean(sendMessage), reason: '显示关系画像' };
  }
  if (relAction === 'update') {
    if (sendMessage) await sendMessage(event, '正在生成关系画像…');
    const db = readDb();
    const result = await updateRelationshipProfile(db, event.groupId, targetA, targetB);
    if (!result.ok) { const reply = `生成失败：${result.error}`; if (sendMessage) await sendMessage(event, reply); return { replied: Boolean(sendMessage), error: result.error, reason: reply }; }
    if (result.skipped) {
      const reply = `关系画像未保存：${result.reason || '互动证据不足'}（${result.sampleCount || 0}条有效互动）。`;
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }
    if (sendMessage) await sendMessage(event, `关系画像已更新（${result.sampleCount}条互动）。`);
    return { replied: Boolean(sendMessage), reason: '关系画像已更新' };
  }
  if (relAction === 'clear') {
    clearRelationshipProfile(event.groupId, targetA, targetB);
    if (sendMessage) await sendMessage(event, '已清除关系画像。');
    return { replied: Boolean(sendMessage), reason: '已清除' };
  }
  const reply = '用法：/w relation show|update|clear @某人 @某人';
  if (sendMessage) await sendMessage(event, reply);
  return { replied: Boolean(sendMessage), reason: reply };
}
