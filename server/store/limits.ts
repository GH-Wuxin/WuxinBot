// Retention limits shared by the store and the default-data normalizer.
// These values are storage policy, not runtime tuning knobs.
export const MAX_MESSAGES = 12_000;
export const MAX_DECISIONS = 30_000;
export const MAX_COMMAND_LOGS = 2_000;
export const MAX_TOOL_LOGS = 5_000;
export const MAX_UNMET_LOGS = 2_000;
export const MAX_ADMIN_ACTIONS = 1_000;
