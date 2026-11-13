// Preparation for the conversation model turn: tool guidance only. Kept
// separate from generation so the call order and prompt text stay observable.
import { buildAgentAutonomyGuidance } from '../bots/agentToolContracts.js';
import { buildToolGuidance } from '../bots/toolGuidance.js';
import { osuSearchGuidance } from '../osu/search.js';

export interface ConversationGuidanceInput {
  modelFirstRuntime: boolean;
  osuSearchEnabled: boolean;
  hasBotTools: boolean;
  requiredCapability?: string | null;
}

export function conversationGuidance(input: ConversationGuidanceInput): string {
  const blocks: string[] = [];
  if (input.modelFirstRuntime) {
    blocks.push(buildAgentAutonomyGuidance({ osuSearchEnabled: input.osuSearchEnabled }));
  } else if (input.hasBotTools) {
    blocks.push(input.requiredCapability
      ? buildToolGuidance({ exposedCapabilities: [input.requiredCapability] })
      : buildToolGuidance());
  }
  if (input.osuSearchEnabled) blocks.push(osuSearchGuidance());
  return blocks.filter(Boolean).join('\n\n');
}
