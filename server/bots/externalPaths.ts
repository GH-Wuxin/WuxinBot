// Wuxin-original helper (MIT). Resolves deployment-dependent paths for the
// optional external bots bridge. Everything is overridable through
// environment variables so the repository contains no machine-specific paths.
// See .env.example and docs/EXTERNAL_INTEGRATION.md.
import path from 'node:path';

/**
 * Root of the external bots deployment (Yumu/Kanon/Hydrant/LazyBot and their
 * shared configs). Override with BOTS_ROOT. Defaults to ./external-bots next
 * to the project.
 */
export function botsRoot(): string {
  return process.env.BOTS_ROOT || path.join(process.cwd(), 'external-bots');
}

/** LazyBot MariaDB application config (binding sync). */
export function lazybotConfigPath(): string {
  return process.env.LAZYBOT_CONFIG_PATH
    || path.join(botsRoot(), 'configs/private/lazybot/application.yaml');
}

/** Hydrant appsettings.json (server access token for the local bridge). */
export function hydrantConfigPath(): string {
  return process.env.HYDRANT_CONFIG_PATH
    || path.join(botsRoot(), 'configs/private/hydrant/appsettings.json');
}

/** Shared group-bot-config.json written by the control-panel API. */
export function sharedGroupBotConfigPath(): string {
  return process.env.GROUP_BOT_CONFIG_PATH
    || path.join(botsRoot(), 'configs/group-bot-config.json');
}
