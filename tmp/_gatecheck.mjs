import { validateStickerCatalog, stickerCount } from '../server/bot/stickers/index.ts';
const r = validateStickerCatalog();
console.log('  ok = ' + r.ok);
console.log('  结果 = ' + JSON.stringify(r).slice(0, 600));
console.log('  条目数 = ' + stickerCount());