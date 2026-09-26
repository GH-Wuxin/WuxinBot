// Owner command handler for /w osu. Decomposed from server/bot/ownerCommands.ts;
// permission key resolution is handled by dispatch.
import { handleOsuCommand } from '../../osu/commands.js';
import type { OwnerHandlerContext, OwnerCommandResult } from './types.js';

export async function ownerOsuHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const result: any = await handleOsuCommand(ctx.event, ctx.sendMessage, ctx.permissions, ctx.subCommand, ctx.commandArgs);
  return result as OwnerCommandResult;
}
