import { Activity, BookOpen, Bot, Cable, DatabaseBackup, FileText, GitBranch, KeyRound, MessageCircle, Shield, SlidersHorizontal, Sparkles, UserCog, UsersRound } from 'lucide-react';

export const navigationGroups = [
  { label: 'Overview', items: [
    { id: 'overview', label: '总览', description: '运行健康、用量与关键状态', icon: Activity }
  ] },
  { label: 'Runtime', items: [
    { id: 'groups', label: '群聊', description: '群配置、画像与 Bot 路由', icon: MessageCircle },
    { id: 'agent', label: 'Agent', description: '决策沙盒与运行控制', icon: Bot },
    { id: 'osu', label: 'osu!', description: '绑定、查询与玩家分析', icon: Sparkles }
  ] },
  { label: 'Context', items: [
    { id: 'members', label: '成员', description: '成员策略与权限身份', icon: UserCog },
    { id: 'persona', label: '人设', description: 'pippi 的表达与名字', icon: UsersRound },
    { id: 'memory', label: '记忆', description: '长期画像与近期动态', icon: BookOpen },
    { id: 'relationships', label: '关系', description: '群友关系画像', icon: GitBranch },
    { id: 'profileLogs', label: '画像日志', description: '画像流水与证据记录', icon: FileText }
  ] },
  { label: 'System', items: [
    { id: 'model', label: '模型', description: 'LLM 与搜索配置', icon: SlidersHorizontal },
    { id: 'integrations', label: '集成', description: 'OneBot 与外部服务', icon: Cable },
    { id: 'permissions', label: '权限', description: '指令用户组与授权', icon: KeyRound },
    { id: 'logs', label: '日志', description: '消息、决策与诊断', icon: Shield },
    { id: 'maintenance', label: '维护', description: '备份与画像重算', icon: DatabaseBackup }
  ] }
];

export const navigationItems = navigationGroups.flatMap((group) => group.items);
export const pageMeta = (pageId) => navigationItems.find((item) => item.id === pageId) || navigationItems[0];

