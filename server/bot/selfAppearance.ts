import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { LlmTool, ToolResult } from '../bots/types.js';

/**
 * Pippi 的固定外观。这里只写已经由现有立绘/表情包确认的部分，不补身高、
 * 体型、年龄等没有依据的设定。模型被问到外观、评估画像 / tag 时以这段为准。
 */
export const PIPPI_APPEARANCE_FACTS = [
  '黑色短发波波头，前发和刘海是粉色，形成黑粉双色；',
  '头顶有一撮翘起的呆毛，眼睛是绿色；',
  '平时穿白色短袖衬衫，领口系深蓝色领结（缎带结）；',
  '头上没有蝴蝶结或其它发饰。',
].join('');

export const SELF_APPEARANCE_TOOL = 'inspect_self_appearance';

export function pippiSelfReferenceFile(): string {
  return fileURLToPath(new URL('./self/assets/pippi-reference.png', import.meta.url));
}

export function selfAppearanceTool(): LlmTool {
  return {
    type: 'function',
    function: {
      name: SELF_APPEARANCE_TOOL,
      description: '查看自己的外观参考图。需要确认自己的发色、眼睛、发型、服装，或判断一张画像 / 一组 tag 像不像自己时调用；参考图只给模型自己看，不会直接发到群里。',
      parameters: { type: 'object', properties: {} },
    },
  };
}

export function selfAppearanceResult(toolCallId: string, options: { canSee: boolean }): ToolResult {
  const file = pippiSelfReferenceFile();
  const fileAvailable = fs.existsSync(file);
  const available = options.canSee && fileAvailable;
  const content = available
    ? `已加载你的外观参考图。你的固定外观：${PIPPI_APPEARANCE_FACTS} 参考图只用于确认你自己的外观，不要把它当成群友发来的图片，也不要直接转发。`
    : options.canSee
      ? `外观参考图暂时读不到。你的固定外观：${PIPPI_APPEARANCE_FACTS} 不要凭印象补发饰或颜色。`
      : `当前模型不能看图。你的固定外观：${PIPPI_APPEARANCE_FACTS} 不要凭印象补发饰或颜色。`;
  return {
    toolCallId,
    ok: true,
    content,
    ...(available
      ? { metadata: { provider: 'pippi-self-appearance', visionImages: [{ file }] } }
      : { metadata: { provider: 'pippi-self-appearance' } }),
  };
}
