import { getCodexAccountStatus, getCodexRateLimits, listCodexModels, shutdownCodexAppServer } from '../server/codexAppServer.ts';

try {
  const settings = { codexExecutable: process.env.CODEX_EXECUTABLE || 'codex' };
  const status = await getCodexAccountStatus(settings);
  const models = await listCodexModels(settings);
  const limits = status.authenticated ? await getCodexRateLimits(settings) : null;
  console.log(JSON.stringify({
    running: status.running,
    authenticated: status.authenticated,
    accountType: status.account?.type || null,
    planType: status.account?.planType || null,
    modelCount: models.length,
    defaultModel: models.find((model) => model.isDefault)?.model || null,
    primaryUsedPercent: limits?.rateLimits?.primary?.usedPercent ?? null,
    secondaryUsedPercent: limits?.rateLimits?.secondary?.usedPercent ?? null,
    error: status.error || null,
  }, null, 2));
} finally {
  shutdownCodexAppServer();
}
