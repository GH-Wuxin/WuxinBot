/**
 * 指令作用域回归：全局开关不能按「群管理员」授权。
 *
 * 事故背景：群 1067117635 里一个 QQ 群管理员发了 /w pause，机器人回了「已暂停」，
 * 结果 11 个群加私聊一起停摆。原因是 pause 的权限是 admin，而它写的是
 * settings.globalPaused —— 权限是群内的，效果是全局的。
 *
 * 这里直接调用真实的指令入口，确认：群管理员调不动全局开关，owner 调得动，
 * 而 group.mode 这类真正群内的设置仍然对群管理员开放。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-command-scope-'));
process.env.DATA_DIR = tmpDir;

const { ensureStore, readDb, updateDb, defaultCommandPermissions } = await import('../server/store.ts');
const { hasCommandPermission } = await import('../server/bot/commands.ts');
const { handleOwnerCommand } = await import('../server/bot/ownerCommands.ts');
const { OWNER_PERMISSION_POLICY } = await import('../server/bot/commands/owner.meta.ts');

let failed = 0;
function check(ok, label, detail = '') {
  if (!ok) failed += 1;
  console.log((ok ? '  ok   ' : '  不符 ') + label + (detail ? '   ' + detail : ''));
}

ensureStore();
updateDb((db) => {
  db.settings.ownerQq = 'owner';
  db.settings.selfQq = 'bot';
  db.settings.globalPaused = false;
  db.settings.onlyMentionMode = true;
  db.groups = [
    { groupId: 'g1', name: '群一', enabled: true, mode: 'natural', maxPerHour: 20, cooldownSec: 30 },
    { groupId: 'g2', name: '群二', enabled: true, mode: 'natural', maxPerHour: 20, cooldownSec: 30 },
  ];
});

const event = (text, userId = 'u-admin') => ({
  type: 'group', groupId: 'g1', userId, nickname: '测试', messageId: 'm-' + Math.random().toString(36).slice(2),
  text, atTargets: [], senderRole: 'admin',
});
const admin = { isOwner: false, isAdmin: true };
const owner = { isOwner: true, isAdmin: false };

// 1. 默认权限表：这两条是全局开关，必须是 owner。
check(defaultCommandPermissions.pause === 'owner', '默认权限表里 pause 是 owner', defaultCommandPermissions.pause);
check(defaultCommandPermissions.preset === 'owner', '默认权限表里 preset 是 owner', defaultCommandPermissions.preset);
check(OWNER_PERMISSION_POLICY.pause.defaultPermissionRole === 'owner', 'pause 的元数据默认角色是 owner');
check(OWNER_PERMISSION_POLICY.preset.defaultPermissionRole === 'owner', 'preset 的元数据默认角色是 owner');

// 2. 群管理员调用全局开关：拒绝，且状态不变。
const pausedByAdmin = await handleOwnerCommand(event('/w pause'), undefined, admin);
check(String(pausedByAdmin.reason || '').includes('需要'), '群管理员 /w pause 被拒绝', String(pausedByAdmin.reason || ''));
check(readDb().settings.globalPaused === false, '群管理员 /w pause 没有改动 globalPaused');

const presetByAdmin = await handleOwnerCommand(event('/w preset sleep'), undefined, admin);
check(String(presetByAdmin.reason || '').includes('所有者'), '群管理员 /w preset sleep 被拒绝，且提示的是所有者', String(presetByAdmin.reason || ''));
check(readDb().settings.globalPaused === false, '群管理员 /w preset 没有改动 globalPaused');
check(readDb().settings.onlyMentionMode === true, '群管理员 /w preset 没有改动 onlyMentionMode');

// 3. 权限函数本身的行为。
const db = readDb();
check(hasCommandPermission(db, { policy: 'normal' }, admin, 'pause') === false, 'hasCommandPermission：群管理员没有 pause');
check(hasCommandPermission(db, { policy: 'normal' }, { isOwner: false, isAdmin: false }, 'pause') === false, 'hasCommandPermission：普通群员没有 pause');
check(hasCommandPermission(db, { policy: 'owner' }, owner, 'pause') === true, 'hasCommandPermission：owner 有 pause');

// 4. 真正群内的设置仍然对群管理员开放（别一刀切过头）。
check(hasCommandPermission(db, { policy: 'normal' }, admin, 'mode') === true, '群管理员仍有 mode 权限');
check(hasCommandPermission(db, { policy: 'normal' }, admin, 'rate') === true, '群管理员仍有 rate 权限');
const modeResult = await handleOwnerCommand(event('/w mode silent'), undefined, admin);
check(readDb().groups.find((g) => g.groupId === 'g1').mode === 'silent', '群管理员 /w mode silent 只改了本群', String(modeResult.reason || ''));
check(readDb().groups.find((g) => g.groupId === 'g2').mode === 'natural', '另一个群没有被波及');

// 5. owner 依然能停和恢复。
const pausedByOwner = await handleOwnerCommand(event('/w pause', 'owner'), undefined, owner);
check(readDb().settings.globalPaused === true, 'owner /w pause 生效', String(pausedByOwner.reason || ''));
const resumedByOwner = await handleOwnerCommand(event('/w resume', 'owner'), undefined, owner);
check(readDb().settings.globalPaused === false, 'owner /w resume 生效', String(resumedByOwner.reason || ''));

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('');
if (failed) {
  console.log('失败 ' + failed + ' 项');
  process.exit(1);
}
console.log('全部通过：全局开关只认 owner，群内设置仍归群管理员');
