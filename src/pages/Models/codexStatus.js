export function codexLoginView(status) {
  if (!status) return { description: '尚未检查登录状态，请刷新状态', canLogin: false };
  if (status.error || status.authStatus === 'unknown') return {
    description: status.running ? 'Codex 状态读取失败，登录状态未知；不代表账号已退出' : 'Codex 服务启动失败，登录状态未知；请检查程序路径',
    canLogin: false,
  };
  if (status.authenticated) return {
    description: `${status.account?.email || '已登录'} · ${status.account?.planType || 'ChatGPT'} 计划`, canLogin: false,
  };
  return { description: '尚未登录 ChatGPT；通过官方授权登录，凭据由 Codex 保存并自动续期', canLogin: true };
}
