// Typed owner-command handler registry.
// runOwnerCommand resolves a route and indexes this record; there is no
// runtime fallback handler.
import type { OwnerHandler, OwnerHandlerKey } from './types.js';
import {
  ownerHelpHandler,
  ownerMyHandler,
} from './help.js';
import {
  ownerExpHandler,
  ownerLvHandler,
  ownerMeHandler,
  ownerNickHandler,
  ownerStyleHandler,
  ownerTopHandler,
} from './experience.js';
import {
  ownerNoteHandler,
  ownerProfileHandler,
  ownerRelationHandler,
} from './profile.js';
import {
  ownerGroupHandler,
  ownerGroupSettingsHandler,
  ownerPresetHandler,
} from './group.js';
import {
  ownerModelHandler,
  ownerPauseHandler,
  ownerPingHandler,
  ownerPromptHandler,
  ownerRecalcHandler,
  ownerRefreshHandler,
  ownerSearchHandler,
  ownerSummarizeHandler,
  ownerSysfactsHandler,
  ownerThinkingHandler,
  ownerUsageHandler,
  ownerWhyHandler,
} from './system.js';
import { ownerOsuHandler } from './osu.js';
import { ownerMemberPolicyHandler } from './memberPolicy.js';
import { ownerSkillFeedbackHandler, ownerSkillHandler } from './skill.js';

export const OWNER_HANDLER_REGISTRY: Record<OwnerHandlerKey, OwnerHandler> = {
  lv: ownerLvHandler,
  exp: ownerExpHandler,
  top: ownerTopHandler,
  nick: ownerNickHandler,
  style: ownerStyleHandler,
  me: ownerMeHandler,
  memberPolicy: ownerMemberPolicyHandler,
  note: ownerNoteHandler,
  profile: ownerProfileHandler,
  promptShow: ownerPromptHandler,
  promptEdit: ownerPromptHandler,
  promptSavebase: ownerPromptHandler,
  groupAdd: ownerGroupHandler,
  groupProfileShow: ownerGroupHandler,
  groupProfileEdit: ownerGroupHandler,
  rate: ownerGroupSettingsHandler,
  cooldown: ownerGroupSettingsHandler,
  mode: ownerGroupSettingsHandler,
  status: ownerGroupSettingsHandler,
  modelShow: ownerModelHandler,
  modelSet: ownerModelHandler,
  search: ownerSearchHandler,
  thinking: ownerThinkingHandler,
  sysfacts: ownerSysfactsHandler,
  summarize: ownerSummarizeHandler,
  preset: ownerPresetHandler,
  usage: ownerUsageHandler,
  pause: ownerPauseHandler,
  resume: ownerPauseHandler,
  why: ownerWhyHandler,
  help: ownerHelpHandler,
  ping: ownerPingHandler,
  my: ownerMyHandler,
  recalc: ownerRecalcHandler,
  refresh: ownerRefreshHandler,
  skill: ownerSkillHandler,
  skillFeedback: ownerSkillFeedbackHandler,
  'osu.help': ownerOsuHandler,
  'osu.bind': ownerOsuHandler,
  'osu.analyze': ownerOsuHandler,
  'osu.clear.bind': ownerOsuHandler,
  'osu.clear.history': ownerOsuHandler,
  'osu.clear.cooldown': ownerOsuHandler,
  'osu.clear.recommend': ownerOsuHandler,
  'osu.clear.cache': ownerOsuHandler,
  relationShow: ownerRelationHandler,
  relationEdit: ownerRelationHandler,
};
