const ADMIN_PASSWORD_KEY = 'wuxinAdminPassword';

let authPromptActive = false;
let authPromptCancelled = false;

export function resetAdminAuthPrompt() {
  authPromptCancelled = false;
}

export async function api(path, options = {}, allowAuthRetry = true) {
  const savedPassword = window.sessionStorage.getItem(ADMIN_PASSWORD_KEY) || '';
  const headers = {
    'Content-Type': 'application/json',
    ...(savedPassword ? { 'X-Wuxin-Admin-Password': savedPassword } : {}),
    ...(options.headers || {})
  };
  const response = await fetch(path, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let data;
  try { data = await response.json(); } catch { throw new Error(`服务器错误 (${response.status})`); }
  if (response.status === 401 && allowAuthRetry && !authPromptActive && !authPromptCancelled) {
    authPromptActive = true;
    const password = window.prompt('控制台已启用管理密码，请输入：');
    authPromptActive = false;
    if (password === null) {
      authPromptCancelled = true;
      throw new Error('需要管理密码');
    }
    window.sessionStorage.setItem(ADMIN_PASSWORD_KEY, password);
    return api(path, options, false);
  }
  if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

export function rememberAdminPassword(password) {
  if (password && password !== '已设置') window.sessionStorage.setItem(ADMIN_PASSWORD_KEY, password);
}
